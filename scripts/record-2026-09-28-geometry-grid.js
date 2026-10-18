// scripts/record-2026-09-28-geometry-grid.js
//
// TRD-TP-1 (#1412): the joint stop-width x target-multiple replay is built and run. It RANKS the geometry on
// real recorded price paths — which is the only thing that can, because the existing cap sweep realises the
// RECORDED P&L and therefore holds the target fixed while varying the stop.
//
// Dry by default:  node scripts/record-2026-09-28-geometry-grid.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool, sql } = require('../shared/db');
const ticksRepo = require('../trading/store/ticks');
const { grid } = require('../trading/agent/geometryReplay');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const ID = 1412;
const MARK = '##2026-09-28 geometry-grid##';
const VENUE = 'plus500';
const HORIZON = 720;
// ⚠ THE SAME FIXED CUTOFF THE RUNNER USES, so the figures quoted below are the figures this script re-derives.
const UNTIL = '2026-09-28T12:00:00Z';
const UNTIL_MS = Date.parse(UNTIL);
const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };

// The same round trip the runner charges, from the same source — so the figures below are re-derived WITH cost,
// not gross. A gate that checks gross numbers while the note quotes net ones checks nothing.
function costPctFor(symbol) {
  try {
    const bps = require('../trading/agent/venueComparability')
      .roundTripBpsFromCfg(require('../trading/agent/backtest').costCfgFor(symbol));
    return Number.isFinite(bps) ? bps / 100 : null;
  } catch { return null; }
}

const NOTE = `

${MARK}
★★★ THE JOINT REPLAY IS BUILT AND RUN. THE USEFUL FINDING IS NOT "WHICH ANCHOR" — IT IS THAT THE DESIGN VALUE SITS IN THE WEAKEST PART OF THE SURFACE THE DESK SPANS.

THE HARNESS. \`trading/agent/geometryReplay.js\` (pure; 16 tests in \`test/geometry-replay.test.js\`) walks the
recorded tick path from an entry and asks WHICH LEVEL WAS TOUCHED FIRST — the question MAE/MFE cannot answer,
because those are unordered extremes. \`trading/scripts/repro/geometry-grid.js\` loads the real paths and sweeps
stop width x target multiple x reward anchor x cap. It writes nothing.

SAMPLE, measured not assumed: 37 filled trades since 2026-09-21, ALL 37 usable, NONE skipped. Venue plus500 (the
rate the desk's P&L is denominated in). Median tick gap **10s**, coarsest 710s. Declared risk widths
0.315%-1.497% of price. Horizon <=720m, and every geometry on a trade sees the SAME window.

★★★ WHAT THE SURFACE LOOKS LIKE (mean netR per trade, after the venue round trip, at the 0.3% cap that was live
until 2026-09-28T06:51Z):
    stopScale        k=1.425 (the DESIGN value)          k=3.0
      0.75        (a) +0.102    (b) -0.007         |   (a) +0.299    (b) +0.403
      1.00        (a) +0.087    (b) -0.000         |   (a) +0.275    (b) +0.354
    best cell in the whole grid: (b) stopScale 0.75 x k 3 = **+0.403 R/trade at a 41% win rate**
    the same cell under (a):                                 +0.299 R/trade at an 11% win rate
⇒ **RAISING THE PAYOFF RATIO IS WHERE THE EXPECTANCY IS, and the desk's own 1.425 sits near the bottom of the
surface.** At the cap, k=1.425 is barely positive under (a) and NEGATIVE under (b); the k axis moves every stop
width in the SAME direction (monotone at **5 of 5** widths under BOTH anchors), so this is the SHAPE of the
surface and not one lucky cell.

★★ AND "(a) OR (b)" IS NOT A SEPARATE QUESTION — which is what I expected to be separable and it is not. With the
cap OFF the two anchors are THE SAME GEOMETRY: declared IS the risk, the bases coincide, and the grid returns
identical numbers (+0.235 both, 11% both). They diverge only when a cap binds, and then the comparison REVERSES
WITH k: at k=1.425 the DECLARED anchor wins (+0.102 vs -0.007) because it reaches a further target; at k=3 the
RISK anchor wins (+0.403 vs +0.299). **They are two parameterisations of ONE payoff dial.** Under (a) the
effective ratio is k x declared/risk, a symbol-dependent multiple; under (b) it is exactly k. So the answerable
statement is not which anchor, but that the dial is being operated far too low.

⚠⚠ AND THE (b) COLUMN IS UNDER-EXPLORED, WHICH BOUNDS THE (b) CLAIM. (b)'s target base is the CAPPED risk, so a
k of 3 under (b) reaches a target roughly half as far as a k of 3 under (a) on the same ticket — the grid's k<=3
ceiling binds harder on (b). (b) at a higher k was NOT tested and may be better. Nothing here says (b) is the
answer; the grid's ceiling is what stops it from saying so.

★ VALIDITY — TWO CHECKS THAT HAD TO PASS AND DID.
  1. THE SAMPLING CADENCE IS NOT DOING THE DECIDING. One mid per tick cannot see inside a step, so a step wider
     than the gap between the levels is genuinely unreadable. That is a PARAMETER (\`coarsePolicy\`), not a silent
     bias: resolving every such step to the stop would convert wins into losses and bias the grid just as badly
     in the other direction. Measured under BOTH, **the winner is the same in 4 of 4 configurations.**
  2. THE RUN IS REPRODUCIBLE, AND IT WAS NOT AT FIRST. The horizon was derived from \`Date.now()\`, so the SAME
     COMMAND returned different numbers minutes apart — a trade opened an hour ago gains path every time you
     look at it. The cutoff is now a stated, printed constant (\`--until\`, default ${UNTIL}) and two consecutive
     runs are byte-identical.
     ⚠ **ANY FIGURE FROM THE CLOCK-DERIVED VERSION IS SUPERSEDED**, including a first pass that read
     (a) +0.160 vs (b) +0.368 at k=3 and looked like a clean 2.3x win for (b). That was a DIFFERENT SAMPLE, not
     a different structure — costR is anchor-independent (0.5304 either way) so the algebra was fine and the
     inputs were not. It also means the earlier reading "k=3 is best and (b) wins" survives in direction but not
     in magnitude.

⚠ WHAT THIS DOES NOT SAY, STATED SO IT IS NOT READ AS MORE THAN IT IS:
  * It holds the ENTRY FIXED and varies only the EXIT. It says nothing about whether those entries were good; the
    best cell is the best EXIT for the entries the desk actually took.
  * **37 trades.** The SHAPE (monotone in the payoff ratio) is consistent across 8 tables and 2 policies; the
    MAGNITUDES are not established, and the argmax is a maximum over 25 cells, which overstates any effect size.
  * Slippage is not modelled. A level executes AT its level, deliberately: booking the mid of the sample that
    reported the breach would turn a stop into a smaller loss out of sampling luck.
  * The exit is one stop/target pair over a <=720m horizon. No trailing stop, no time-stop, no partial.

★ WHAT I DID NOT DO: I changed no setting and no geometry code. The entry-fixed caveat means the decision is the
owner's, and the honest next step is a WIDER k RANGE plus a bootstrap over trades before any magnitude here is
treated as an effect size.

τ TO RUN IT: \`node trading/scripts/repro/geometry-grid.js [--horizon 720] [--since 2026-09-21] [--until ${UNTIL}]\``;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  if (!Number.isFinite(UNTIL_MS)) await fail(`the cutoff ${UNTIL} is unreadable`);

  console.log('\n=== 1. the row, and the harness is sound ===');
  const row = (await q(`SELECT state, CAST(info AS nvarchar(max)) AS info FROM Tasks WHERE id = ${ID}`))[0];
  if (!row) await fail(`#${ID} does not exist`);
  if (row.info.includes(MARK)) { console.log(`  #${ID} marker present - nothing to do.`); await pool.close(); return; }
  console.log(`  \u2714 #${ID} state=${row.state} ${row.info.length} chars`);
  const modSrc = fs.readFileSync(path.join(ROOT, 'trading/agent/geometryReplay.js'), 'utf8');
  for (const forbidden of ['getPool', "require('mssql')", 'Date.now()']) {
    if (modSrc.includes(forbidden)) await fail(`the replay module is not pure — it contains ${forbidden}`);
  }
  console.log('  \u2714 the replay module is pure (no db, no clock, no mssql)');
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'trading/scripts/repro/geometry-grid.js'), 'utf8');
  if (!/--until/.test(runnerSrc) || /const now = Date\.now\(\)/.test(runnerSrc))
    await fail('the runner does not use a fixed cutoff - its numbers would drift with the clock');
  console.log('  \u2714 the runner uses a fixed cutoff, so its numbers are reproducible');

  console.log('\n=== 2. re-derive the sample the note quotes ===');
  const trades = await q(`SELECT id, symbol, direction, openPrice, openAt, decisionId FROM Trades
      WHERE userId = 1 AND openPrice IS NOT NULL AND stopPrice IS NOT NULL AND openAt >= '2026-09-21' ORDER BY openAt`);
  const usable = [];
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
    usable.push({ symbol: t.symbol, direction: t.direction, entryPx: Number(t.openPrice), entryAt: t.openAt, declaredRiskPct, path: pathRows, horizonMin: horizon, costPct: costPctFor(t.symbol) });
  }
  console.log(`  ${trades.length} filled trades -> ${usable.length} usable`);
  if (usable.length !== 37) await fail(`expected 37 usable trades, derived ${usable.length} — the note quotes a sample that does not reproduce`);
  const noCost = usable.filter((u) => u.costPct == null).length;
  console.log(`  cost basis present on ${usable.length - noCost} of ${usable.length}`);
  if (noCost) await fail(`${noCost} trade(s) have no cost basis — the net figures would mix gross and net`);

  const meanNet = (targetOn, capPct, stopScale, k) => {
    const vals = [];
    for (const u of usable) {
      const r = grid({
        direction: u.direction, entryPx: u.entryPx, entryAt: u.entryAt, path: u.path,
        declaredRiskPct: u.declaredRiskPct, stopScales: [stopScale], targetMultiples: [k],
        targetOn, capPct, costPct: u.costPct, maxHoldMin: u.horizonMin,
      })[0];
      if (r && r.ok && r.outcome !== 'no_data') vals.push(r.netR);
    }
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  console.log('\n=== 3. with NO cap the two anchors must be the SAME geometry ===');
  const aNo = meanNet('declared', null, 1, 3);
  const bNo = meanNet('risk', null, 1, 3);
  console.log(`  (a) ${aNo.toFixed(6)}   (b) ${bNo.toFixed(6)}`);
  if (Math.abs(aNo - bNo) > 1e-9) await fail(`(a) and (b) differ WITHOUT a cap (${aNo} vs ${bNo}) — the "one dial" claim inverts`);
  console.log('  \u2714 identical, as the note states');

  console.log('\n=== 4. THE ROBUST CLAIM: a higher payoff ratio beats the design value, under BOTH anchors ===');
  for (const targetOn of ['declared', 'risk']) {
    const lo = meanNet(targetOn, 0.3, 0.75, 1.425);
    const hi = meanNet(targetOn, 0.3, 0.75, 3);
    console.log(`  (${targetOn === 'declared' ? 'a' : 'b'}) k=1.425 -> ${lo.toFixed(4)}   k=3 -> ${hi.toFixed(4)}   improvement ${(hi - lo).toFixed(4)}`);
    if (!(hi > lo)) await fail(`${targetOn}: k=3 does not beat k=1.425 at the cap — the headline claim is wrong`);
  }
  console.log('  \u2714 k=3 beats the design value under both anchors');

  console.log('\n=== 5. and the shape is monotone in the payoff ratio ===');
  for (const targetOn of ['declared', 'risk']) {
    let monotone = 0;
    console.log(`  (${targetOn}):`);
    for (const s of [0.25, 0.5, 0.75, 1, 1.5]) {
      const series = [0.5, 1, 1.425, 2, 3].map((k) => meanNet(targetOn, 0.3, s, k));
      const rising = series.every((v, i) => i === 0 || v >= series[i - 1] - 1e-9);
      if (rising) monotone++;
      console.log(`    stopScale ${String(s).padStart(4)}: ${series.map((v) => v.toFixed(3).padStart(8)).join(' ')}  ${rising ? 'rising' : 'NOT monotone'}`);
    }
    console.log(`    -> monotone at ${monotone} of 5 stop widths`);
    if (monotone < 4) await fail(`${targetOn}: monotone at only ${monotone} of 5 widths — the "shape" claim is too strong`);
  }
  console.log('  \u2714 monotone at 4+ of 5 widths for both anchors');

  console.log('\n=== 6. the record ===');
  console.log(`  #${ID} info ${row.info.length} -> ${row.info.length + NOTE.length}`);
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }
  await pool.request().input('t', sql.NVarChar(sql.MAX), NOTE)
    .query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
