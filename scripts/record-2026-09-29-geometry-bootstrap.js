// scripts/record-2026-09-29-geometry-bootstrap.js
//
// TRD-TP-1 (#1412): the wider payoff range and the bootstrap over trades are run. The point-estimate ranking
// from the grid does NOT survive them.
//
// Dry by default:  node scripts/record-2026-09-29-geometry-bootstrap.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool, sql } = require('../shared/db');
const ticksRepo = require('../trading/store/ticks');
const { grid, bootstrapMeanCI, bootstrapWinner } = require('../trading/agent/geometryReplay');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const ID = 1412;
const MARK = '##2026-09-29 geometry-bootstrap##';
const VENUE = 'plus500';
const HORIZON = 720;
const UNTIL = '2026-09-28T12:00:00Z';
const UNTIL_MS = Date.parse(UNTIL);
const TRIALS = 4000;
const SEED = 20260929;
const KS = [0.5, 0.75, 1, 1.425, 2, 3, 4, 6, 8];
const SCALES = [0.5, 0.75, 1.0, 1.5];
const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };
const sgn = (v, d = 3) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(d));
const pct = (v) => (v == null ? 'n/a' : (v * 100).toFixed(1) + '%');

function costPctFor(symbol) {
  try {
    const bps = require('../trading/agent/venueComparability')
      .roundTripBpsFromCfg(require('../trading/agent/backtest').costCfgFor(symbol));
    return Number.isFinite(bps) ? bps / 100 : null;
  } catch { return null; }
}

const NOTE = `

${MARK}
★★★ THE BOOTSTRAP DOES NOT SUPPORT THE GRID'S RANKING. **NO CELL IS IDENTIFIED**, AND THE ONE COMPARISON THAT CLEARS ZERO IS WHAT CHANCE PREDICTS.

WHAT WAS RUN, per the agreed next step: the payoff range widened from k<=3 to **k<=8**, and the 35 usable trades
were resampled **4,000 times with replacement, seeded (20260929)** so a re-run is not a re-roll — two consecutive
runs are byte-identical. \`trading/scripts/repro/geometry-bootstrap.js\`, built on pure helpers
(\`bootstrapMeanCI\`, \`bootstrapWinner\`) that are unit-tested in \`test/geometry-replay.test.js\`.

⚠⚠ THE GRID'S HEADLINE IS WITHDRAWN. Every cell's 95% interval now SPANS ZERO, at every payoff multiple, in every
configuration tested — e.g. declared anchor, cap 0.3%, stopScale 0.75: k=1.425 carries interval [-0.378 .. +0.486]
and k=3 [-0.380 .. +0.796]. The grid's monotone surface was a property of the POINT ESTIMATES, and the point
estimates do not carry their own uncertainty inside them.

★★★ AND THE REASON IS VISIBLE BESIDE EVERY MEAN: THE SINGLE BEST TRADE CARRIES A CELL. Over the 36-cell grid the
top-trade share reaches **201.7%** at one cell, and at stopScale 0.75 it runs 45-71% across k — a figure above 100%
means one trade is worth more than the whole cell's net result, i.e. the total is small noise beside it. A mean
like that is not an estimate of anything. It is the same concentration the day's book showed (two trades were the
entire day) and it is the honest reason a 35-trade grid cannot rank geometry.

★★ THE WINNER BOOTSTRAP IS FLAT: **0 of 4 configurations has a cell that wins a MAJORITY of resamples.**
    declared  cap none   best cell 17.0%  (stopScale 1 x k 6)    interval [-0.203 .. +0.778]
    risk      cap none   best cell 17.5%  (stopScale 1 x k 6)    interval [-0.203 .. +0.778]
    declared  cap 0.3%   best cell 46.5%  (stopScale 0.75 x k 6) interval [-0.430 .. +1.480]
    risk      cap 0.3%   best cell 23.4%  (stopScale 0.75 x k 3) interval [-0.262 .. +1.019]
With 36 cells per configuration, a winner taking 17-46% is a cell the data cannot separate from its neighbours.

★★★ AND THE ONE COMPARISON THAT LOOKS REAL IS WITHIN CHANCE. The paired test (difference vs the design's 1.425,
resampled on the SAME trade indices, which is the only version that answers "should the dial move") gives:
    risk anchor, k=2:  difference +0.251  [+0.039 .. +0.403]   better on 57% of trades   <-- clears zero
That is 1 of 16 comparisons (2 anchors x 8 multiples). **At 95% with no real effect, 0.8 are EXPECTED to clear
zero by chance.** One cleared. ⇒ The correct reading is that this sample shows NO identifiable geometry effect at
all, not that k=2 is the answer. Reporting the winner without that denominator is exactly how a grid becomes a
story, so the denominator is printed by the tool and recorded here.

★ AND THE FAR END OF THE NEW RANGE IS NOT MEASURING GEOMETRY. As k grows the holding horizon bites: at stopScale
0.75 with the cap, the timeout share goes 17.1% at k=1.425 to 51.4% at k=8, and **the win rate hits 0.0% by k=6**
— NO trade ever reaches the target. Those cells measure the 720m holding cap and whatever the price did while
nothing happened. So the apparent "higher k is better" trend at the top of the range is partly the horizon
refusing to let a distant target be tested at all.

⚠⚠ AND THE SAMPLE ITSELF DECAYS, WHICH THE EARLIER NOTE DID NOT SAY. \`geometry-grid.js\` built 37 usable trades;
this built 35, with two more excluded because their windows are now EMPTY. Verified: Gold's oldest tick has moved
from 2026-09-21T12:12 to **2026-09-21T19:27** and there are now ZERO tick rows before 2026-09-21T12:00Z — tick
RETENTION has pruned them. ⇒ **A fixed cutoff makes a run reproducible within a short window, not across days:**
the earliest trades silently leave the sample as history is pruned. Any future comparison must re-derive the
sample size rather than quoting one, and the harness now prints every skip reason for exactly this reason.
(The six newest trades, #1118-#1123, are excluded correctly: they opened AFTER the fixed cutoff.)

WHAT THIS MEANS FOR THE DECISION, stated plainly: the grid ordered the candidate geometries and the bootstrap
refuses to confirm that order. **The desk's geometry is not tunable from this evidence.** Reaching a verdict needs
more trades, not a better sweep of the same 35 — and the specific number that would settle it is the one the
concentration figure points at: enough trades that no single one is 50% of a cell.

τ TO RUN IT: \`node trading/scripts/repro/geometry-bootstrap.js [--trials 4000] [--seed 20260929] [--until ${UNTIL}]\``;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the row, and the pure helpers are seeded ===');
  const row = (await q(`SELECT state, CAST(info AS nvarchar(max)) AS info FROM Tasks WHERE id = ${ID}`))[0];
  if (!row) await fail(`#${ID} does not exist`);
  if (row.info.includes(MARK)) { console.log(`  #${ID} marker present - nothing to do.`); await pool.close(); return; }
  console.log(`  \u2714 #${ID} state=${row.state} ${row.info.length} chars`);
  const src = fs.readFileSync(path.join(ROOT, 'trading/agent/geometryReplay.js'), 'utf8');
  if (!/function seededRandom/.test(src)) await fail('the bootstrap is not seeded — a re-run would be a re-roll');
  const twice = JSON.stringify(bootstrapMeanCI([1, -1, 2, -2, 3], { trials: 100, seed: 5 })) === JSON.stringify(bootstrapMeanCI([1, -1, 2, -2, 3], { trials: 100, seed: 5 }));
  if (!twice) await fail('the same seed gave two different intervals');
  console.log('  \u2714 seeded and deterministic');

  console.log('\n=== 2. re-derive the sample ===');
  const trades = await q(`SELECT id, symbol, direction, openPrice, openAt, decisionId FROM Trades
      WHERE userId = 1 AND openPrice IS NOT NULL AND stopPrice IS NOT NULL AND openAt >= '2026-09-21' ORDER BY openAt`);
  const sample = [];
  for (const t of trades) {
    const horizon = Math.min(HORIZON, Math.floor((UNTIL_MS - t.openAt.getTime()) / 60000));
    if (horizon < 120 || !t.decisionId) continue;
    const d = (await q(`SELECT TOP 1 payload FROM TradingEvents WHERE kind='decision'
        AND JSON_VALUE(payload,'$.promptId') = ${t.decisionId}
        AND JSON_VALUE(payload,'$.symbol') = '${String(t.symbol).replace(/'/g, "''")}'`))[0];
    if (!d) continue;
    const p = J(d.payload);
    const declaredRiskPct = Number(p.stopDistance) > 0 ? (Number(p.stopDistance) / Number(t.openPrice)) * 100 : null;
    if (!(declaredRiskPct > 0)) continue;
    const rows = await ticksRepo.ticksSince(1, t.symbol, VENUE, t.openAt, new Date(t.openAt.getTime() + horizon * 60000)).catch(() => []);
    const pathRows = rows.map((r) => ({ at: r.capturedAt, mid: ticksRepo.midOf(r) })).filter((x) => x.mid > 0);
    if (pathRows.length < 10) continue;
    sample.push({ direction: t.direction, entryPx: Number(t.openPrice), entryAt: t.openAt, declaredRiskPct, path: pathRows, horizonMin: horizon, costPct: costPctFor(t.symbol) });
  }
  console.log(`  ${trades.length} filled trades -> ${sample.length} usable`);
  if (sample.length < 30) await fail(`only ${sample.length} usable trades — the note's sample does not reproduce`);
  if (sample.some((s) => s.costPct == null)) await fail('a trade has no cost basis — the net figures would mix gross and net');
  console.log(`  \u2714 ${sample.length} usable, all with a cost basis`);

  console.log('\n=== 3. re-derive: no cell wins a majority, and the top trade dominates ===');
  const net = (bound, cap, scale, k) => {
    const v = [];
    for (const s of sample) {
      const r = grid({ direction: s.direction, entryPx: s.entryPx, entryAt: s.entryAt, path: s.path,
        declaredRiskPct: s.declaredRiskPct, stopScales: [scale], targetMultiples: [k],
        targetOn: bound, capPct: cap, costPct: s.costPct, maxHoldMin: s.horizonMin })[0];
      if (r && r.ok && r.outcome !== 'no_data') v.push(r.netR);
    }
    return v;
  };
  // ⚠ THE CLAIM IS ABOUT THE 36-CELL SET (4 stop widths x 9 multiples), SO THE GATE MUST CHECK THE SAME SET. An
  // earlier draft compared only the 9-cell k dimension and the gate refused it: k=6 wins 56.2% there, a MAJORITY,
  // which is a different statement. How flat the winner looks depends on how many cells are competing, so a gate
  // that checks the wrong cell set checks nothing — and the number is meaningless without its cell count.
  const entries = [];
  for (const scale of SCALES) for (const k of KS) entries.push({ key: `${scale}|${k}`, values: net('declared', 0.3, scale, k) });
  const winners = bootstrapWinner(entries, { trials: TRIALS, seed: SEED });
  console.log(`  declared anchor, cap 0.3% — ${entries.length} cells (stopScale x k), share of resamples each wins:`);
  for (const w of winners.slice(0, 5)) console.log(`    stopScale ${String(w.key.split('|')[0]).padStart(4)} x k ${String(w.key.split('|')[1]).padStart(5)}  ${pct(w.share).padStart(6)}   mean ${sgn(w.mean)}`);
  if (winners[0].share >= 0.5) await fail(`a cell wins ${pct(winners[0].share)} of resamples over ${entries.length} cells — "no cell is identified" would be wrong`);
  console.log(`  \u2714 the best cell wins only ${pct(winners[0].share)} of resamples over ${entries.length} cells`);
  // Recorded because it is a DIFFERENT number for the same underlying data, and the difference is the point.
  const kOnly = bootstrapWinner(KS.map((k) => ({ key: String(k), values: net('declared', 0.3, 0.75, k) })), { trials: TRIALS, seed: SEED });
  console.log(`  over the 9-cell k dimension ALONE the best is k=${kOnly[0].key} at ${pct(kOnly[0].share)} — a bare majority, so the cell set must be stated with every number`);
  const big = entries.map((e) => {
    const tot = e.values.reduce((a, b) => a + b, 0);
    return { k: e.key, share: tot !== 0 ? Math.max(...e.values) / tot : null };
  }).filter((x) => x.share != null);
  const worst = big.reduce((a, b) => (b.share > a.share ? b : a));
  console.log(`  worst top-trade share across the ${entries.length} cells: ${pct(worst.share)} (at ${worst.k})`);
  if (!(worst.share > 0.4)) await fail(`the largest top-trade share is ${pct(worst.share)} — the concentration claim is too strong`);
  console.log(`  \u2714 one trade is up to ${pct(worst.share)} of a cell's total`);

  console.log('\n=== 4. re-derive: the horizon binds at the far end ===');
  const late = entries.find((e) => e.key.endsWith('|8'));
  if (!late) await fail('k=8 is missing from the grid');
  const timeoutShare = (k) => {
    let n = 0, t = 0;
    for (const s of sample) {
      const r = grid({ direction: s.direction, entryPx: s.entryPx, entryAt: s.entryAt, path: s.path,
        declaredRiskPct: s.declaredRiskPct, stopScales: [0.75], targetMultiples: [k],
        targetOn: 'declared', capPct: 0.3, costPct: s.costPct, maxHoldMin: s.horizonMin })[0];
      if (!r || !r.ok || r.outcome === 'no_data') continue;
      n++; if (r.outcome === 'timeout') t++;
    }
    return n ? t / n : null;
  };
  const at1425 = timeoutShare(1.425), at8 = timeoutShare(8);
  console.log(`  timeout share at k=1.425: ${pct(at1425)}   at k=8: ${pct(at8)}`);
  if (!(at8 > at1425)) await fail(`the timeout share does not rise with k (${pct(at1425)} -> ${pct(at8)}) — the horizon claim is wrong`);
  console.log('  \u2714 the horizon binds harder as k grows, so the far end is not pure geometry');

  console.log('\n=== 5. the record ===');
  console.log(`  #${ID} info ${row.info.length} -> ${row.info.length + NOTE.length}`);
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }
  await pool.request().input('t', sql.NVarChar(sql.MAX), NOTE)
    .query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
