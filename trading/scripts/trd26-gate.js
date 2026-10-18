#!/usr/bin/env node
// trading/scripts/trd26-gate.js — TRD-26 fresh-data gate executor (Lab plan Section 14).
//
// The three frozen turtle survivors (candidates #20/#21/#22) may be re-scored on
// a fresh series (later-pulled yahoo 1h, post-development). The gate books a
// familyType=fresh release with a fresh k-prime; acceptance = rule L ONLY.
//
// Two conditions must hold at invocation (both verified from live bar data):
//   (a) W4 (last 10% of the evaluated series) is fully post-development
//       → seriesDays <= 10 * (post-dev elapsed days)   [1-day safety margin];
//   (b) W4 carries n >= 20 trades at the variant's rate
//       → seriesDays >= 200 / rate   (rate = conservative MIN of the W4 and W25
//         windows — smaller rate = longer wait, per the TRD-26 note).
//
// usage:
//   node trading/scripts/trd26-gate.js           # CHECK conditions (no writes)
//   node trading/scripts/trd26-gate.js --run     # fire retests for READY candidates
//
// Do NOT run --run before CHECK reports READY — each call books a fresh release
// row and would otherwise score a contaminated W4. One fire per candidate; a
// re-fire is allowed only after an INSUFFICIENT-DATA verdict.
'use strict';
const store = require('../store');
const backtest = require('../agent/backtest');
const strategies = require('../agent/strategies');
const lab = require('../agent/lab');                   // TRD-13 harness (labContext)
const scoreboard = require('../agent/lab/scoreboard'); // retestCandidate

const USER = 1;
const DEV_END = Date.parse('2026-09-11T00:00:00Z'); // data is "post-2026-09-10"
const SAFETY_DAYS = 1;                              // freshness margin
const CAND_IDS = [20, 21, 22];
const RUN = process.argv.includes('--run');
const R = (x, dp = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** dp) / 10 ** dp : null);
const fmtDate = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'n/a');

async function measure(cand) {
  const loaded = await backtest.loadSeries(USER, { symbol: cand.symbol, venue: cand.venue || 'yahoo', timeframe: '1h', range: null, refreshData: true });
  if (loaded.error) return { error: loaded.error };
  const series = loaded.series;
  const strat = strategies.get(cand.strategy);
  const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(cand.symbol), ...(cand.params || {}) };
  const raw = strat.backtest(series, cfg, lab.labContext(series));
  const n = series.length;
  const windowStats = (frac) => {
    const start = series[Math.floor(n * (1 - frac))].time;
    const end = series[n - 1].time;
    const count = (raw.trades || []).filter((t) => t.entryTime >= start && t.entryTime <= end).length;
    const days = (new Date(end) - new Date(start)) / 86400000;
    return { n: count, rate: days > 0 ? count / days : 0 };
  };
  const w4 = windowStats(0.1);
  const w25 = windowStats(0.25);
  return { bars: n, spanDays: loaded.spanDays, w4, w25 };
}

async function priorRelease(candId) {
  const releases = await store.listLabReleases(USER, { familyType: 'fresh', limit: 100 }).catch(() => []);
  let last = null;
  for (const r of releases) {
    const s = Array.isArray(r.summary) ? r.summary.find((x) => x && x.id === candId) : null;
    if (s) last = { at: r.createdAt, verdict: s.verdict, lockbox: s.lockbox };
  }
  return last;
}

(async () => {
  const now = Date.now();
  const elapsed = (now - DEV_END) / 86400000;
  const maxSeriesDays = Math.floor((elapsed - SAFETY_DAYS) * 10); // condition (a)
  console.log(`TRD-26 gate — ${new Date(now).toISOString()}`);
  console.log(`post-dev elapsed: ${R(elapsed)}d | max seriesDays (freshness, condition a): ${maxSeriesDays}${maxSeriesDays < 0 ? ' — NOT OPEN YET' : ''}\n`);
  for (const id of CAND_IDS) {
    const cand = await store.getLabCandidate(USER, id);
    if (!cand) { console.log(`#${id}: candidate not found`); continue; }
    const m = await measure(cand);
    if (m.error) { console.log(`#${id} ${cand.symbol}: measure error — ${m.error}`); continue; }
    const rate = Math.min(m.w4.rate, m.w25.rate); // conservative (smaller)
    const needed = rate > 0 ? Math.ceil(200 / rate) : Infinity;
    const earliest = Number.isFinite(needed) ? DEV_END + (needed / 10 + SAFETY_DAYS) * 86400000 : Infinity;
    const ready = needed <= maxSeriesDays;
    const prior = await priorRelease(id);
    const canRefire = !prior || prior.verdict === 'INSUFFICIENT-DATA';
    console.log(`#${id} ${cand.symbol} — ${cand.strategy} ${JSON.stringify(cand.params || {})} [status=${cand.status || '?'}]`);
    console.log(`   bars=${m.bars} span=${m.spanDays}d | W4: n=${m.w4.n} (${R(m.w4.rate, 3)}/d) | W25: n=${m.w25.n} (${R(m.w25.rate, 3)}/d) → rate=${R(rate, 3)}/d`);
    console.log(`   needs seriesDays=${needed} (W4≈${R(needed / 10, 1)}d for n≈20) | earliest ≈ ${fmtDate(earliest)}`);
    console.log(`   READY=${ready ? 'YES' : 'no'} | prior fresh release: ${prior ? `${prior.verdict} @ ${String(prior.at).slice(0, 10)}` : 'none'}`);
    if (RUN) {
      if (!ready) console.log('   → skipped (conditions not met — never run before READY)');
      else if (!canRefire) console.log(`   → skipped (already gated: ${prior.verdict} — owner review stands)`);
      else {
        const r = await scoreboard.retestCandidate(USER, id, { seriesDays: needed });
        const s = r.release && r.release.summary && r.release.summary[0];
        console.log(`   → FIRED: verdict=${s && s.verdict} n=${s && s.lockbox && s.lockbox.n} pf=${s && s.lockbox && s.lockbox.pf} p=${s && s.lockbox && s.lockbox.p}`);
      }
    }
    console.log('');
  }
  console.log('Acceptance = rule L ONLY. If fewer than 5 pairs reach n>=20: fdrAvailable:false — descriptive p + owner review, NO FDR claim. No promotion without paper-forward (n>=50) + owner approval.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
