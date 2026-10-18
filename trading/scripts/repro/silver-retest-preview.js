// trading/scripts/repro/silver-retest-preview.js - READ-ONLY preview of what a Silver re-test would say.
//
// WHY THIS EXISTS. Silver's two frozen lab pairs (#9 regturtle, #19 mtftrend) both carry verdict
// INSUFFICIENT-DATA. The guess on the table was that this was a WINDOW-SIZING artifact - Silver's stored
// 1h history was half of Gold's (5,954 bars from 2025-09-10 against 11,696 from 2024-09-11), so if the
// freeze had been a bar-count decision, a deeper series would lift the lockbox n over its floor of 20.
// The 729-day repull has since been applied (`trading/scripts/deep-backfill.js`), so the guess is now
// TESTABLE. This script tests it and writes NOTHING.
//
// ⚠ WHAT THE STORED SCORE ALREADY REFUTES. The stored rows read `bars 5699, spanDays 365.1` for BOTH
// pairs - i.e. the advisory stages already had a COMPLETE one-year window, not a truncated one, because
// every scoring path loads `range:'1y'`. The shortfall is `LOCKBOX n = 9` and `n = 12` against a floor of
// 20: a TRADE-COUNT shortfall, not a bar-depth one. So this script has to answer a different question
// than the one that was asked - does a longer series produce MORE lockbox trades, and if so, is the
// resulting window still a valid fresh-data window?
//
// ⚠ THE VALIDITY QUESTION IS NOT THE SAME AS THE SAMPLE QUESTION. W4 is the last 10% of BARS, so a longer
// series makes W4 longer in absolute time and therefore collects more trades. But a 729-day series puts
// W4's START at ~73 days back, which lands BEFORE the development end (the family freeze, 2026-09-10) -
// i.e. the "fresh" window would contain data the candidates were developed on. This script reports both
// numbers together, because a bigger n on a contaminated window is not evidence of anything.
//
// USAGE
//   node trading/scripts/repro/silver-retest-preview.js
//   node trading/scripts/repro/silver-retest-preview.js --symbol Silver --ids 9,19

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const store = require('../../store');
const backtest = require('../../agent/backtest');
const strategies = require('../../agent/strategies');
const wf = require('../../agent/lab/walkforward');

const USER = 1;
const SEED_BASE = 0xABCD; // must match lab/scoreboard.js seedFor()
const LOADER_BAR_CAP = 12000; // must match backtest.loadSeries()'s load(12000)
const PROVIDER_DEPTH_DAYS = 729; // must match providers/yahoo.js MAX_SPAN_DAYS['1h']
const LOCKBOX_FLOOR = 20; // lab/walkforward.js screen(): n < 20 => INSUFFICIENT-DATA

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined;
}

const iso = (d) => (d ? new Date(d).toISOString().replace('.000Z', 'Z') : null);
const day = (ms) => Math.round((ms / 86400000) * 10) / 10;

async function previewCandidate(id) {
  const cand = await store.getLabCandidate(USER, id);
  if (!cand) {
    console.log(`  #${id}: not found`);
    return;
  }
  const strat = strategies.get(cand.strategy);
  if (!strat || !strat.backtest) {
    console.log(`  #${id} ${cand.strategy}/${cand.symbol}: no backtest`);
    return;
  }
  const venue = cand.venue || 'yahoo';
  const seed = SEED_BASE + Number(cand.registrationNo);
  const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(cand.symbol), ...(cand.params || {}) };

  const loaded = await backtest.loadSeries(USER, { symbol: cand.symbol, venue, timeframe: '1h', range: null, refreshData: false, });
  if (loaded.error) {
    console.log(`  #${id} ${cand.strategy}/${cand.symbol}: ${loaded.error}`);
    return;
  }
  const all = loaded.series;

  // The family freeze IS the development end: it is the instant the pair stopped being trainable.
  const devEnd = cand.frozenAt ? new Date(cand.frozenAt) : null;

  console.log(`\n=== #${id} ${cand.strategy} / ${cand.symbol} (reg ${cand.registrationNo}, seed ${seed}, venue ${venue})`);
  console.log(`  status ${cand.status}, stored verdict ${cand.verdict || 'NULL'}, releaseId ${cand.releaseId ?? 'NULL'}`);
  console.log(`  dev end (frozenAt)      ${iso(devEnd)}`);
  console.log(`  deep series available   ${all.length} bars, ${iso(all[0].time)} .. ${iso(all[all.length - 1].time)} (${loaded.spanDays}d)`);
  console.log(`  same rows the stored score saw: bars ${JSON.parse(cand.score || '{}').bars ?? '-'}, spanDays ${JSON.parse(cand.score || '{}').spanDays ?? '-'}`);

  // ---- STEP 1: reproduce the STORED result. A preview that cannot reproduce a known number is not a
  // measurement, it is a second opinion. The stored run loaded `range:'1y'` at the freeze instant.
  const reproStart = new Date(devEnd.getTime() - 366 * 86400000);
  const repro = all.filter((b) => new Date(b.time) >= reproStart && new Date(b.time) <= devEnd);
  if (repro.length >= 25) {
    const st = wf.runStage({ series: repro, strat, cfg, stage: 'LOCKBOX', seed, w4Split: true });
    console.log(`  REPRODUCE (as of freeze, 366d ending ${iso(devEnd)}): ${repro.length} bars -> LOCKBOX n=${st.n} pf=${st.pf} p=${st.p} verdict=${st.n < LOCKBOX_FLOOR ? 'INSUFFICIENT-DATA' : 'measured'}`);
  } else {
    console.log(`  REPRODUCE skipped: only ${repro.length} bars end at/before the freeze (provider history is a rolling window)`);
  }

  // ---- STEP 2: what each candidate window size actually produces, ENDING TODAY (the re-test basis).
  const now = Date.now();
  const barDays = all.length / Math.max(loaded.spanDays, 1);
  const windows = [
    { days: 129, label: 'freshness cap today 10x(elapsed-1)' },
    { days: 200, label: 'TRD-26 sizing for rate 1.0/d' },
    { days: 365, label: 'stored basis (1y)' },
    { days: 500, label: 'mid depth' },
    { days: 729, label: 'provider ceiling' },
    { days: null, label: 'all stored bars' },
  ];
  console.log('  --- re-test windows (ending today) ---');
  console.log('  window            bars  span  W4 start             W4 end               W4d   n   pf       p        fresh?');
  for (const w of windows) {
    const cutoff = w.days ? now - w.days * 86400000 : 0;
    const sl = all.filter((b) => new Date(b.time).getTime() >= cutoff);
    if (sl.length < 25) {
      console.log(`  ${String(w.days ?? 'all').padEnd(8)}  ${String(sl.length).padStart(6)}  (below the 25-bar loader floor)`);
      continue;
    }
    const st = wf.runStage({ series: sl, strat, cfg, stage: 'LOCKBOX', seed, w4Split: true });
    const w4Start = sl[Math.floor(sl.length * 0.9)].time;
    const w4End = sl[sl.length - 1].time;
    const w4d = day(new Date(w4End).getTime() - new Date(w4Start).getTime());
    const fresh = new Date(w4Start) >= devEnd ? 'YES' : `NO (${day(devEnd.getTime() - new Date(w4Start).getTime())}d pre-dev)`;
    console.log(`  ${String(w.days ?? 'all').padEnd(8)}  ${String(sl.length).padStart(6)}  ${String(loaded && w.days ? w.days : 'all').padStart(4)}  ${iso(w4Start).padEnd(20)} ${iso(w4End).padEnd(20)} ${String(w4d).padStart(4)}  ${String(st.n).padStart(3)} ${String(st.pf).padEnd(8)} ${String(st.p).padEnd(8)} ${fresh}`);
  }

  // ---- STEP 3: the ceiling question, answered by SEARCH rather than by extrapolation.
  // ⚠ The lockbox trade rate is NOT constant per day - measured, it rose from 0.155/day on a 129d series
  // to 0.240/day on a 729d one, because the trades cluster in time. So inverting a single observed rate
  // (`seriesDays = 20 / rate`) UNDERSTATES the length actually required and would have printed "129d"
  // while a 129d series yields n=2. Scan the length and report what each one actually produces.
  const capBars = Math.floor(LOADER_BAR_CAP / Math.max(barDays, 0.01));
  const hardCap = Math.min(PROVIDER_DEPTH_DAYS, capBars);
  console.log(`  --- smallest series reaching lockbox n>=${LOCKBOX_FLOOR} (scan 150..${hardCap}d, step 25) ---`);
  console.log('  seriesDays   W4d     n   pf        fresh?');
  let reach = null;
  for (let d = 150; d <= hardCap; d += 25) {
    const sl = all.filter((b) => new Date(b.time).getTime() >= now - d * 86400000);
    if (sl.length < 25) continue;
    const st = wf.runStage({ series: sl, strat, cfg, stage: 'LOCKBOX', seed, w4Split: true });
    const w4Start = sl[Math.floor(sl.length * 0.9)].time;
    const w4d = day(new Date(sl[sl.length - 1].time).getTime() - new Date(w4Start).getTime());
    const isFresh = new Date(w4Start) >= devEnd;
    if (st.n >= LOCKBOX_FLOOR && !reach) reach = { d, n: st.n, pf: st.pf, w4d, isFresh };
    console.log(`  ${String(d).padStart(10)} ${String(w4d).padStart(6)} ${String(st.n).padStart(5)}  ${String(st.pf).padEnd(9)} ${isFresh ? 'YES' : 'no'}`);
  }
  if (!reach) {
    console.log(`  VERDICT: the floor n>=${LOCKBOX_FLOOR} is NOT reached at ANY series length up to ${hardCap}d`
      + ` (provider ceiling ${PROVIDER_DEPTH_DAYS}d, loader cap ${capBars}d at ${barDays.toFixed(1)} bars/day).`);
  } else {
    console.log(`  VERDICT: floor first reached at seriesDays=${reach.d} (W4 ${reach.w4d}d, n=${reach.n}, pf=${Number(reach.pf).toFixed(4)}).`
      + ` Window fresh? ${reach.isFresh ? 'YES' : 'NO - it reaches back before the development end, so a verdict here is NOT a fresh-data verdict.'}`);
  }
}

(async () => {
  const symbol = arg('--symbol') || 'Silver';
  const idsArg = arg('--ids');
  let ids = idsArg ? idsArg.split(',').map((s) => Number(s.trim())).filter(Number.isFinite) : null;
  if (!ids) {
    const all = await store.listLabCandidates(USER, {});
    ids = all.filter((c) => c.symbol === symbol).map((c) => c.id);
  }
  console.log(`silver-retest-preview  symbol=${symbol}  ids=${ids.join(',')}  (READ-ONLY: writes nothing, books no release)`);
  for (const id of ids) await previewCandidate(id);
})().catch((e) => {
  console.error(`silver-retest-preview FAILED: ${e.stack || e.message}`);
  process.exit(1);
});
