// trading/agent/lab/walkforward.js — rolling walk-forward engine (TRD-14).
// Per §Validation 1-3: W1 = [0,60%) · W2 = [60,80%) · W3 = [80,90%) ·
// W4 = [90,100%) of the series. Each stage retrains the candidate on its
// designated train window (Stage A: W1 · Stage B: W1∪W2 · Lockbox:
// W1∪W2∪W3) by running the strategy backtest over the prefix, and scores
// only trades whose ENTRY time falls inside the test window. Every PF is
// CFD-cost-adjusted via backtest.worksheet (single-charged per side since the
// 2026-09-10 erratum fix; stage metrics recorded before that date are on the
// old, ~2x cost basis). Bar-causal lab context is rebuilt per stage (TRD-13).
'use strict';

const lab = require('../lab'); // TRD-13 harness (trading/agent/lab.js)
const backtest = require('../backtest');
const stats = require('./statistics');

const WINDOWS = { A: { start: 0.6, end: 0.8 }, B: { start: 0.8, end: 0.9 }, LOCKBOX: { start: 0.9, end: 1.0 } };
const STAGE_PREFIX_END = { A: 0.8, B: 0.9, LOCKBOX: 1.0 };

function windowIndices(n, stage) {
  const w = WINDOWS[stage];
  return { start: Math.floor(n * w.start), end: Math.floor(n * w.end) };
}

// Run ONE stage over a prefix and return the test-window result.
// Returns { stage, n, pf, p, pSmallSample, metrics, w4Split }.
// w4Split (lockbox only): net P&L of the two time-halves of the window, for
// the PRDS cross-correlation check at release.
function runStage({ series, strat, cfg, stage, seed, labOpts = {}, w4Split = false }) {
  const n = series.length;
  const win = windowIndices(n, stage);
  const endIdx = Math.floor(n * STAGE_PREFIX_END[stage]);
  const prefix = series.slice(0, endIdx);
  const labCtx = lab.labContext(prefix, labOpts);
  const raw = strat.backtest(prefix, cfg, labCtx);
  const startTime = series[win.start] && series[win.start].time;
  const endTime = series[win.end - 1] && series[win.end - 1].time;
  const inWindow = (t) => t.entryTime != null && t.entryTime >= startTime && t.entryTime <= endTime;
  const trades = (raw.trades || []).filter(inWindow);
  const sheet = backtest.worksheet(trades, cfg, 'cfd');
  const nets = sheet.rows.map((r) => r.netPnl);
  const { pf } = stats.profitFactor(nets);
  const p = nets.length >= 20 ? stats.bcaPvalue(nets, { seed }) : null;
  let split = null;
  if (w4Split && trades.length) {
    const pnlByTrade = trades.map((t, i) => (sheet.rows[i] ? sheet.rows[i].netPnl : 0));
    const times = trades.map((t) => new Date(t.entryTime).getTime());
    const midT = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    let a = 0;
    let b = 0;
    for (let i = 0; i < trades.length; i++) {
      if (times[i] < midT) a += pnlByTrade[i];
      else b += pnlByTrade[i];
    }
    split = { a, b };
  }
  return {
    stage, n: nets.length, pf: pf == null ? null : pf,
    p: p ? p.p : null, pSmallSample: p ? p.smallSample : null,
    ciLower: p ? p.ciLower : null,
    metrics: sheet.metrics,
    w4Split: split,
  };
}

// Run the requested stages for a candidate over the loaded series.
// stageList defaults to all three; /lab/score uses ['A','B'] so the lockbox
// stays UNTOUCHED until the single release (§Validation 13).
function runWalkForward({ series, strat, cfg, seed, labOpts = {}, stageList = ['A', 'B', 'LOCKBOX'] }) {
  const stages = {};
  for (const s of stageList) {
    stages[s] = runStage({ series, strat, cfg, stage: s, seed, labOpts, w4Split: s === 'LOCKBOX' });
  }
  // Advisory stage screens (per §Validation 7): PF > 1 AND n >= 20 AND
  // uncorrected BCa p < 0.05 — screens gate NOTHING; the lockbox + BH at
  // release are the only inference.
  const screen = (r) => (r.n < 20 ? 'INSUFFICIENT-DATA' : r.pf != null && r.pf > 1 && r.p != null && r.p < 0.05 ? 'PASS' : 'FAIL');
  for (const s of stageList) stages[s].verdict = screen(stages[s]);
  return stages;
}

module.exports = { WINDOWS, windowIndices, runStage, runWalkForward };
