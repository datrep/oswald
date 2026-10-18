// trading/scripts/repro/geometry-bootstrap.js — HOW MUCH OF THE GEOMETRY RANKING SURVIVES THE SAMPLE?
//
// WHY. `geometry-grid.js` ranks stop width x target multiple on 37 real trades and returns a monotone surface.
// But a grid picks the best of N cells on M trades, and on M=37 the argmax is partly a maximum over noise. This
// resamples the TRADES and asks two questions the point estimate cannot:
//   1. how wide is the interval around each cell's mean, and
//   2. how often does each cell actually WIN a resample?
//
// It also WIDENS THE PAYOFF RANGE. The grid stops at k=3, which binds harder on the risk anchor (its target base
// is the capped risk, so the same k reaches a much nearer price) — so the grid could not see whether the risk
// anchor is better at a higher k, and said so. This tests k up to 8.
//
// ⚠ PAIRED, NOT INDEPENDENT. The cells are the SAME trades under different geometry, so every trial resamples
// one set of trade indices and applies it to every cell. Resampling the cells independently would discard the
// pairing and widen the winner distribution into meaninglessness.
//
// WRITES NOTHING. Read-only by construction.
//
// Usage: node trading/scripts/repro/geometry-bootstrap.js [--user 1] [--horizon 720] [--trials 4000]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { getPool } = require('../../../shared/db');
const ticksRepo = require('../../store/ticks');
const { grid, mean, bootstrapMeanCI, bootstrapWinner } = require('../../agent/geometryReplay');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const USER = Number(arg('--user', 1)) || 1;
const HORIZON = Number(arg('--horizon', 720)) || 720;
const TRIALS = Number(arg('--trials', 4000)) || 4000;
const SEED = Number(arg('--seed', 20260929)) || 20260929;
const SINCE = arg('--since', '2026-09-21');
const UNTIL = arg('--until', '2026-09-28T12:00:00Z');
const UNTIL_MS = Date.parse(UNTIL);
const MIN_HORIZON_MIN = 120;
const VENUE = 'plus500';

// The wide range. 1.425 is the DESIGN value and is kept in the set so every comparison has a fixed reference.
const KS = [0.5, 0.75, 1, 1.425, 2, 3, 4, 6, 8];
const SCALES = [0.5, 0.75, 1.0, 1.5];
const CAPS = [null, 0.3];
const ANCHORS = ['declared', 'risk'];

const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };
const sgn = (v, d = 3) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : (v >= 0 ? '+' : '') + Number(v).toFixed(d));
const pct = (v) => (v == null ? 'n/a' : (v * 100).toFixed(1) + '%');

function costPctFor(symbol) {
  try {
    const bps = require('../../agent/venueComparability')
      .roundTripBpsFromCfg(require('../../agent/backtest').costCfgFor(symbol));
    return Number.isFinite(bps) ? bps / 100 : null;
  } catch { return null; }
}

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  if (!Number.isFinite(UNTIL_MS)) { console.error(`--until ${UNTIL} is not readable`); process.exit(1); }

  // ---- the sample ---------------------------------------------------------------------------------
  const trades = await q(`SELECT id, symbol, direction, openPrice, openAt, decisionId FROM Trades
      WHERE userId = ${USER} AND openPrice IS NOT NULL AND stopPrice IS NOT NULL AND openAt >= '${SINCE}' ORDER BY openAt`);
  const sample = [];
  const skipped = [];
  for (const t of trades) {
    const horizon = Math.min(HORIZON, Math.floor((UNTIL_MS - t.openAt.getTime()) / 60000));
    if (horizon < MIN_HORIZON_MIN) { skipped.push(`#${t.id} ${t.symbol}: only ${horizon}m of path`); continue; }
    if (!t.decisionId) { skipped.push(`#${t.id} ${t.symbol}: no decisionId`); continue; }
    const d = (await q(`SELECT TOP 1 payload FROM TradingEvents WHERE kind='decision'
        AND JSON_VALUE(payload,'$.promptId') = ${t.decisionId}
        AND JSON_VALUE(payload,'$.symbol') = '${String(t.symbol).replace(/'/g, "''")}'`))[0];
    if (!d) { skipped.push(`#${t.id} ${t.symbol}: decision not resolvable on promptId+symbol`); continue; }
    const p = J(d.payload);
    const declaredRiskPct = Number(p.stopDistance) > 0 ? (Number(p.stopDistance) / Number(t.openPrice)) * 100 : null;
    if (!(declaredRiskPct > 0)) { skipped.push(`#${t.id} ${t.symbol}: no declared distance`); continue; }
    const rows = await ticksRepo.ticksSince(USER, t.symbol, VENUE, t.openAt, new Date(t.openAt.getTime() + horizon * 60000)).catch(() => []);
    const path = rows.map((r) => ({ at: r.capturedAt, mid: ticksRepo.midOf(r) })).filter((x) => x.mid > 0);
    if (path.length < 10) { skipped.push(`#${t.id} ${t.symbol}: only ${path.length} ticks`); continue; }
    sample.push({ symbol: t.symbol, direction: t.direction, entryPx: Number(t.openPrice), entryAt: t.openAt, declaredRiskPct, path, horizonMin: horizon, costPct: costPctFor(t.symbol) });
  }
  console.log('\n================ SAMPLE ================');
  console.log(`  ${trades.length} filled trades -> ${sample.length} usable, ${skipped.length} skipped`);
  // ⚠ THE SKIP REASONS ARE PRINTED BECAUSE A COUNT THAT DIFFERS FROM ANOTHER SCRIPT CITING THE SAME SAMPLE IS
  // ITSELF A DEFECT: `geometry-grid.js` builds the same sample with the same filters, so any disagreement has to
  // be explainable from the output rather than from memory. Two trades that filled after the cutoff fell below
  // the minimum path length when the gate was tightened.
  for (const s of skipped) console.log(`    skipped ${s}`);
  console.log(`  payoff multiples tested: ${KS.join(', ')}   (the grid tested only up to 3)`);
  console.log(`  bootstrap: ${TRIALS} resamples of ${sample.length} trades, seed ${SEED} (reproducible)`);
  const noCost = sample.filter((s) => s.costPct == null).length;
  if (noCost) { console.log(`  ⚠ ${noCost} trade(s) have NO cost basis — refusing, net figures would mix gross and net`); await pool.close(); return; }
  if (sample.length < 20) { console.log('  too few trades to bootstrap.'); await pool.close(); return; }

  // ---- precompute every (trade, cell) outcome ONCE, then resample indices only -----------------------
  // 37 x 2 x 2 x 4 x 9 replays is cheap; the bootstrap then touches no paths at all.
  const cells = new Map();
  const cellKey = (anchor, cap, scale, k) => `${anchor}|${cap == null ? 'none' : cap}|${scale}|${k}`;
  for (const s of sample) {
    for (const anchor of ANCHORS) {
      for (const cap of CAPS) {
        const rows = grid({
          direction: s.direction, entryPx: s.entryPx, entryAt: s.entryAt, path: s.path,
          declaredRiskPct: s.declaredRiskPct, stopScales: SCALES, targetMultiples: KS,
          targetOn: anchor, capPct: cap, costPct: s.costPct, maxHoldMin: s.horizonMin,
        });
        for (const r of rows) {
          const key = cellKey(anchor, cap, r.stopScale, r.targetMultiple);
          if (!cells.has(key)) cells.set(key, { anchor, cap, scale: r.stopScale, k: r.targetMultiple, netR: [], win: 0, timeout: 0, stop: 0, n: 0 });
          const c = cells.get(key);
          if (!r.ok || r.outcome === 'no_data') continue;
          c.netR.push(r.netR);
          c.n++;
          if (r.outcome === 'target') c.win++;
          else if (r.outcome === 'stop') c.stop++;
          else c.timeout++;
        }
      }
    }
  }
  for (const c of cells.values()) {
    c.meanNetR = mean(c.netR);
    c.winRate = c.n ? c.win / c.n : null;
    c.timeoutRate = c.n ? c.timeout / c.n : null;
    // CONCENTRATION. A mean carried by one observation is not an estimate, and a big winner is exactly how a
    // far target looks in a small sample — so it is reported beside every mean rather than left to the reader.
    const tot = c.netR.reduce((a, b) => a + b, 0);
    const top = Math.max(...c.netR);
    c.topShare = tot !== 0 ? top / tot : null;
    const sorted = [...c.netR].sort((a, b) => a - b);
    c.ci = bootstrapMeanCI(c.netR, { trials: TRIALS, seed: SEED, alpha: 0.05 });
    c.sorted = sorted;
  }
  const get = (anchor, cap, scale, k) => cells.get(cellKey(anchor, cap, scale, k));

  // ---- 1. the wide k curve, with intervals ----------------------------------------------------------
  console.log('\n================ THE k CURVE, WITH 95% INTERVALS ================');
  console.log('  mean netR/trade after cost, [lo..hi] from a paired trade bootstrap. "top" = the share of the');
  console.log('  cell\'s total netR contributed by its SINGLE BEST trade — a mean carried by one trade is not an estimate.');
  for (const cap of CAPS) {
    for (const anchor of ANCHORS) {
      for (const scale of [0.75, 1.0]) {
        console.log(`\n  --- ${anchor === 'declared' ? '(a) DECLARED' : '(b) RISK'} anchor · cap ${cap == null ? 'NONE' : cap + '%'} · stopScale ${scale} ---`);
        console.log('      k      mean      [95% lo .. hi]      win%   time%   top-trade share');
        for (const k of KS) {
          const c = get(anchor, cap, scale, k);
          if (!c) continue;
          console.log(`   ${String(k).padStart(5)} ${sgn(c.meanNetR).padStart(9)}   [${String(sgn(c.ci.lo)).padStart(8)} .. ${String(sgn(c.ci.hi)).padStart(8)}] ` +
            `${String(pct(c.winRate)).padStart(8)} ${String(pct(c.timeoutRate)).padStart(7)} ${String(pct(c.topShare)).padStart(12)}`);
        }
      }
    }
  }

  // ---- 2. which k WINS a resample? ------------------------------------------------------------------
  console.log('\n================ WHICH k WINS A RESAMPLE? (paired, over the whole stop-width grid) ================');
  const winnerRows = [];
  for (const cap of CAPS) {
    for (const anchor of ANCHORS) {
      const entries = [];
      for (const scale of SCALES) for (const k of KS) {
        const c = get(anchor, cap, scale, k);
        if (c && c.netR.length >= 2) entries.push({ key: `${scale}|${k}`, values: c.netR });
      }
      const out = bootstrapWinner(entries, { trials: TRIALS, seed: SEED });
      const top = out[0];
      const ci = get(anchor, cap, Number(top.key.split('|')[0]), Number(top.key.split('|')[1])).ci;
      console.log(`\n  --- ${anchor === 'declared' ? '(a) DECLARED' : '(b) RISK'} · cap ${cap == null ? 'NONE' : cap + '%'} · ${entries.length} cells ---`);
      for (const r of out.slice(0, 5)) {
        const [s, k] = r.key.split('|');
        console.log(`    stopScale ${String(s).padStart(4)} x k ${String(k).padStart(5)}   wins ${String((r.share * 100).toFixed(1)).padStart(5)}% of resamples   mean ${sgn(r.mean)}`);
      }
      console.log(`    -> most likely winner takes ${(top.share * 100).toFixed(1)}% of resamples; its interval is [${sgn(ci.lo)} .. ${sgn(ci.hi)}]`);
      winnerRows.push({ anchor, cap, top, ci, nCells: entries.length });
    }
  }

  // ---- 3. THE QUESTION THAT MATTERS: is a higher k robustly better than the DESIGN value? -----------
  console.log('\n================ IS HIGHER k ROBUSTLY BETTER THAN THE DESIGN VALUE (1.425)? ================');
  console.log('  paired over the same resamples: P(mean(k) > mean(1.425)), at stopScale 0.75 with the cap live.');
  console.log('  "interval clears zero" is the test; "better on N% of TRADES" alone is not evidence.');
  // ⚠⚠ MULTIPLE COMPARISONS ARE COUNTED, NOT IGNORED. This sweep makes 2 anchors x 8 k values = 16 tests at
  // 95%. Under a null of no effect, ~0.8 of them are EXPECTED to clear zero by chance alone, so "one test
  // cleared" is not a finding until it is compared against that number. Reporting the winner without it is how
  // a grid becomes a story.
  let cleared = 0, comparisons = 0;
  for (const anchor of ANCHORS) {
    const base = get(anchor, 0.3, 0.75, 1.425);
    console.log(`\n  ${anchor === 'declared' ? '(a) DECLARED' : '(b) RISK'} anchor:`);
    for (const k of KS) {
      if (k === 1.425) continue;
      const c = get(anchor, 0.3, 0.75, k);
      if (!c || !base) continue;
      // The paired difference, resampled on the SAME indices — so this is a test of the DIFFERENCE, not of two
      // independent means, which is the only version that answers "should the dial move".
      const diff = c.netR.map((v, i) => v - base.netR[i]);
      const ci = bootstrapMeanCI(diff, { trials: TRIALS, seed: SEED });
      const better = diff.filter((d) => d > 0).length / diff.length;
      comparisons++;
      const clears = ci.lo != null && ci.lo > 0;
      if (clears) cleared++;
      console.log(`    k ${String(k).padStart(5)}: difference ${sgn(ci.mean)}  [${sgn(ci.lo)} .. ${sgn(ci.hi)}]   ` +
        `${better >= 0.5 ? 'better' : 'worse'} on ${(better * 100).toFixed(0)}% of TRADES  ${clears ? '  <== interval clears zero' : ''}`);
    }
  }
  console.log(`\n  of ${comparisons} comparisons, ${cleared} clear zero. At 95% and no real effect, ${(comparisons * 0.05).toFixed(1)} are EXPECTED to clear zero by chance.`);

  // ---- 4. verdict -----------------------------------------------------------------------------------
  console.log('\n================ VERDICT ================');
  const anyIdentified = winnerRows.filter((r) => r.top.share >= 0.5);
  console.log(`  configurations where one cell wins a MAJORITY of resamples: ${anyIdentified.length} of ${winnerRows.length}`);
  for (const r of winnerRows) {
    const [s, k] = r.top.key.split('|');
    console.log(`    ${String(r.anchor).padEnd(9)} cap ${String(r.cap == null ? 'none' : r.cap).padEnd(5)} best cell ${(r.top.share * 100).toFixed(1)}%  ` +
      `(stopScale ${s} x k ${k})  interval [${sgn(r.ci.lo)} .. ${sgn(r.ci.hi)}]`);
  }
  const kRow = get('declared', 0.3, 0.75, 8);
  console.log(`\n  ⚠ AS k GROWS THE HORIZON BITES, AND AT THE FAR END IT IS NOT MEASURING GEOMETRY AT ALL: at stopScale 0.75,
    cap 0.3%, the timeout share goes ${pct(get('declared', 0.3, 0.75, 1.425).timeoutRate)} at k=1.425 to ${pct(kRow.timeoutRate)} at k=8.
    Worse, the WIN rate hits ${pct(kRow.winRate)} by k=6 — no trade ever reaches the target, so those cells are a
    measure of the ${HORIZON}m holding cap, and of whatever the price happened to do while nothing happened.`);
  console.log('\n  ⇒ NO CELL IS IDENTIFIED. Read the verdict as: the point estimates ordered the cells, and resampling the');
  console.log('    trades does not support that ordering. The dial may well be too low, but THIS SAMPLE does not show it,');
  console.log('    and no cell here is safe to tune to.');

  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
