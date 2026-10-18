// trading/agent/strategies/regimeTurtle.js — Regime Turtle (TRD-15, LAB-2).
// Hypothesis (measured 2026-09-10): plain turtle mostly traded chop — the
// 28-cell audit scored 27 FAIL, and the 324-config hunt had zero passes.
// FRAMING CORRECTION (post-Lab): the original motivation quoted the 77/23
// range/trend base rate, but that figure is DESK-META (2 days, 88 events);
// the per-ticker bar-causal ADX≥25 split is ~50/50. The gate reads as
// 'trend-only entries', not 'fixing a 77% chop bias'. Regime-turtle keeps
// turtle's Donchian breakout math UNCHANGED but takes entries ONLY when the
// TRD-13 harness says this ticker is in a bar-causal TREND (ADX(14) >= 25)
// and the 50-bar momentum direction AGREES with the breakout direction.
// Hyperparameters were fixed on W1 ONLY (TRD-15 dev run, 2026-09-10: grid
// donchian {20,30,40} x stop {2,3}; winner 20/2 with 6/7 symbols W1 PF>1,
// median PF 1.030 — no test window was viewed).
// Promotion scope: registered on all 7 watchlist symbols; only the 4 deep
// symbols (Bitcoin, Gold, Oil, Silver) can earn promotion per the plan.
'use strict';

const { donchian } = require('../indicators');
const { nightsFor } = require('../time'); // TRD-25 nights; TRD-49 venue funding clock via cfg
const session = require('../lab/session'); // TRD-18 entry-time filter (frozen: not usable)

const DEFAULTS = {
  donchianPeriod: 20,     // FROZEN on W1 only (dev run 2026-09-10: 6/7 symbols W1 PF>1, median 1.030)
  adxPeriod: 14,          // regime flag period (TRD-13 harness)
  adxGate: 25,            // HYPOTHESIS: ADX >= 25 = trend on THIS ticker
  dirPeriod: 50,          // regime direction: 50-bar momentum (harness)
  atrPeriod: 14,
  atrStopMultiple: 2,     // FROZEN on W1 only (same dev run; grid 2 vs 3)
  riskPerTradePct: 1,
};

const PARAMS = [
  { key: 'donchianPeriod', label: 'Donchian period', type: 'number', def: 20, min: 5, max: 100, step: 1, tightens: 'higher' },
  { key: 'adxPeriod', label: 'Regime ADX period', type: 'number', def: 14, min: 5, max: 50, step: 1 },
  { key: 'adxGate', label: 'Regime ADX gate', type: 'number', def: 25, min: 0, max: 60, step: 1, tightens: 'higher' },
  { key: 'dirPeriod', label: 'Regime direction period', type: 'number', def: 50, min: 5, max: 200, step: 1 },
  { key: 'atrPeriod', label: 'ATR period', type: 'number', def: 14, min: 5, max: 50, step: 1 },
  { key: 'atrStopMultiple', label: 'Trailing stop (xATR)', type: 'number', def: 2, min: 1, max: 6, step: 0.5 },
  { key: 'riskPerTradePct', label: 'Risk per trade %', type: 'number', def: 1, min: 0.1, max: 5, step: 0.1, tightens: 'lower' },
];

function paramsWith(cfg) {
  const out = {};
  for (const p of PARAMS) out[p.key] = cfg && cfg[p.key] != null ? Number(cfg[p.key]) : p.def;
  return out;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// LIVE signal. ctx.lab comes from the TRD-13 harness (quant.js):
//   lab = { barsK, regime: { adx, regime: 'trend'|'range', dir: 'up'|'down'|null }, ratio }
// Fail-secure: no harness regime -> no signal (the candidate REQUIRES it).
function liveSignal({ highs, lows, closes: _closes, atr14, adx14: _adx14, price, prevPrice, params, openTrade, lab }) {
  const p = paramsWith(params);
  const dc = highs.length >= p.donchianPeriod + 1
    ? donchian(highs.slice(0, -1), lows.slice(0, -1), p.donchianPeriod)
    : null;
  const dcOut = dc ? { upper: round4(dc.upper), lower: round4(dc.lower) } : null;
  const reg = lab && lab.regime ? lab.regime : null;
  if (atr14 == null || !dc) return { type: null, donchian: dcOut };

  // Exit first: 2xATR trailing stop on the open position (identical to turtle).
  if (openTrade && openTrade.peak != null && openTrade.trough != null) {
    const stop = openTrade.direction === 'buy'
      ? openTrade.peak - p.atrStopMultiple * atr14
      : openTrade.trough + p.atrStopMultiple * atr14;
    const hit = openTrade.direction === 'buy' ? price <= stop : price >= stop;
    if (hit) {
      return { type: 'exit', direction: openTrade.direction, basis: `${p.atrStopMultiple}xATR trailing stop ${round4(stop)} hit`, donchian: dcOut };
    }
  }

  // Entries require: trend regime + direction agreement + breakout.
  if (!reg || reg.regime !== 'trend') return { type: null, donchian: dcOut };
  const breakoutUp = price > dc.upper && prevPrice <= dc.upper;
  const breakoutDown = price < dc.lower && prevPrice >= dc.lower;
  if (breakoutUp && reg.dir === 'up') {
    return { type: 'entry', direction: 'buy', basis: `regime-trend up (ADX ${reg.adx == null ? '?' : round4(reg.adx)}), donchian${p.donchianPeriod} breakout up`, donchian: dcOut };
  }
  if (breakoutDown && reg.dir === 'down') {
    return { type: 'entry', direction: 'sell', basis: `regime-trend down (ADX ${reg.adx == null ? '?' : round4(reg.adx)}), donchian${p.donchianPeriod} breakout down`, donchian: dcOut };
  }
  return { type: null, donchian: dcOut };
}

// BACKTEST: turtle's loop with the regime gate applied at each bar from the
// bar-causal lab context (labCtx.regime[i]). Sizing stop distance uses
// atrStopMultiple x ATR floored at 0.05% of price (turtle parity at the
// default multiple); ruin guard stops the run at exhausted capital.
function backtest(bars, cfg, labCtx) {
  const p = paramsWith(cfg);
  const c = { ...cfg, ...p };
  const heights = bars.map((b) => b.high);
  const lowsArr = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time || b.barStart);
  const period = p.atrPeriod;
  const regime = labCtx && labCtx.regime ? labCtx.regime : null;
  // TRD-18: entry-time session filter (re-train semantics — never post-hoc).
  const sFilter = (cfg && cfg.sessionFilter) || session.SESSION_FILTER;

  let capital = c.capital;
  const trades = [];
  let pos = null;
  let peakEquity = capital;
  let maxDrawdown = 0;

  const closePos = (price, idx, reason) => {
    const pnl = pos.direction === 'buy' ? (price - pos.entryPrice) * pos.size : (pos.entryPrice - price) * pos.size;
    capital += pnl;
    trades.push({
      direction: pos.direction, size: round4(pos.size),
      entryTime: pos.entryTime, entryPrice: pos.entryPrice,
      exitTime: times[idx], exitPrice: price,
      nights: nightsFor(pos.entryTime, times[idx], c.cfdSwapClockMinuteUtc),
      pnlMid: round4(pnl), reason,
    });
    const dd = capital < peakEquity ? ((peakEquity - capital) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = round4(dd);
    if (capital > peakEquity) peakEquity = capital;
    pos = null;
  };

  let sTr = 0;
  let atrNow = null;
  const indicatorAt = (i) => {
    const tr = Math.max(heights[i] - lowsArr[i], Math.abs(heights[i] - closes[i - 1]), Math.abs(lowsArr[i] - closes[i - 1]));
    if (i <= period) {
      sTr += tr;
      if (i === period) atrNow = sTr / period;
    } else {
      sTr = sTr - sTr / period + tr;
      atrNow = sTr / period;
    }
  };

  for (let i = 1; i < bars.length; i++) {
    indicatorAt(i);
    if (i < 25) continue;
    if (capital <= 0) break;
    if (atrNow == null || !(atrNow > 0)) {
      if (pos) closePos(closes[i], i, 'data_gap');
      continue;
    }
    const reg = regime ? regime[i] : null;
    if (pos) {
      if (pos.direction === 'buy') {
        if (closes[i] > pos.peak) pos.peak = closes[i];
        const stop = pos.peak - p.atrStopMultiple * atrNow;
        if (closes[i] <= stop) closePos(stop, i, 'trailing_stop');
      } else {
        if (closes[i] < pos.trough) pos.trough = closes[i];
        const stop = pos.trough + p.atrStopMultiple * atrNow;
        if (closes[i] >= stop) closePos(stop, i, 'trailing_stop');
      }
      continue;
    }
    const dc = donchian(heights.slice(i - p.donchianPeriod, i), lowsArr.slice(i - p.donchianPeriod, i), p.donchianPeriod);
    if (!dc || !reg || reg.regime !== 'trend') continue;
    if (!session.entryAllowed(times[i], sFilter)) continue; // TRD-18 gate
    const prev = closes[i - 1] ?? closes[i];
    const stopDist = Math.max(p.atrStopMultiple * atrNow, closes[i] * 0.0005);
    if (closes[i] > dc.upper && prev <= dc.upper && reg.dir === 'up') {
      const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
      pos = { direction: 'buy', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    } else if (closes[i] < dc.lower && prev >= dc.lower && reg.dir === 'down') {
      const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
      pos = { direction: 'sell', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    }
  }
  if (pos) closePos(closes[closes.length - 1], bars.length - 1, 'end_of_data');

  return { trades, finalCapital: round4(capital), maxDrawdown, start: times[0], end: times[times.length - 1] };
}

module.exports = {
  id: 'regturtle',
  name: 'Regime Turtle (LAB)',
  description: 'Turtle Donchian breakout with a bar-causal per-ticker TREND gate (ADX>=25 + direction agreement). TRD-15 candidate.',
  params: PARAMS,
  DEFAULTS,
  paramsWith,
  liveSignal,
  backtest,
};
