// trading/agent/strategies/mtfTrend.js — Multi-TF Trend (TRD-19, LAB-3).
// Hypothesis: regime PERSISTENCE — a 1h Donchian breakout continues when the
// higher timeframe (4h) trend already points the same way. Uses the TRD-13
// harness's completed-4h-block series (bar-causal: only blocks ending at or
// before the current 1h bar are visible). Exits/stops match the turtle family
// (2xATR trailing). Deep symbols only per the plan (Bitcoin, Gold, Oil, Silver).
// Hyperparameters were fixed on W1 ONLY (TRD-19 dev run, 2026-09-10: grid
// momBlocks {3,5,10} x donchian {20,30}; winner 10/30 — 2/4 deep symbols
// W1 PF>1: Gold 1.10, Silver 1.56 (Bitcoin 0.91, Oil 0.76 fail), median
// 1.104. Marginal but alive — goes to the formal stages as-is.
'use strict';

const { donchian } = require('../indicators');
const { nightsFor } = require('../time'); // TRD-25 nights; TRD-49 venue funding clock via cfg
const session = require('../lab/session'); // TRD-18 entry-time filter (frozen: not usable)

const DEFAULTS = {
  donchianPeriod: 30,   // FROZEN on W1 only (dev grid 20 vs 30)
  momBlocks: 10,        // FROZEN on W1 only: 4h blocks of momentum (dev grid 3/5/10)
  blocksPerBar: 4,      // 4h blocks from 1h bars (harness k)
  atrPeriod: 14,
  atrStopMultiple: 2,
  riskPerTradePct: 1,
};

const PARAMS = [
  { key: 'donchianPeriod', label: 'Donchian period (1h)', type: 'number', def: 20, min: 5, max: 100, step: 1, tightens: 'higher' },
  { key: 'momBlocks', label: '4h momentum blocks', type: 'number', def: 5, min: 1, max: 50, step: 1 },
  { key: 'blocksPerBar', label: 'Hours per higher-TF block', type: 'number', def: 4, min: 2, max: 24, step: 1 },
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

// Direction of the trend across a completed-block list (last close vs
// `momBlocks` earlier). Used by liveSignal (list = visible blocks).
function dirOfBlocks(blocks, momBlocks) {
  if (!blocks || blocks.length < momBlocks + 1) return null;
  const a = Number(blocks[blocks.length - 1].close);
  const b = Number(blocks[blocks.length - 1 - momBlocks].close);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return a > b ? 'up' : 'down';
}

// Direction at 1h index i from the causal block list:
// last COMPLETED block's close vs the close `momBlocks` blocks earlier.
// blocks = labCtx.blocks, counts = per-1h completed-block counts (labCtx.counts).
function blockDirAt(blocks, counts, i, momBlocks) {
  const cnt = counts[Math.min(i, counts.length - 1)];
  const last = cnt - 1;
  const prev = cnt - 1 - momBlocks;
  if (last < 0 || prev < 0) return null;
  const a = Number(blocks[last].close);
  const b = Number(blocks[prev].close);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return a > b ? 'up' : 'down';
}

// LIVE signal. ctx.lab.barsK = completed higher-TF blocks visible now.
function liveSignal({ highs, lows, closes: _closes, atr14, adx14: _adx14, price, prevPrice, params, openTrade, lab }) {
  const p = paramsWith(params);
  const dc = highs.length >= p.donchianPeriod + 1
    ? donchian(highs.slice(0, -1), lows.slice(0, -1), p.donchianPeriod)
    : null;
  const dcOut = dc ? { upper: round4(dc.upper), lower: round4(dc.lower) } : null;
  if (atr14 == null || !dc) return { type: null, donchian: dcOut };

  if (openTrade && openTrade.peak != null && openTrade.trough != null) {
    const stop = openTrade.direction === 'buy'
      ? openTrade.peak - p.atrStopMultiple * atr14
      : openTrade.trough + p.atrStopMultiple * atr14;
    const hit = openTrade.direction === 'buy' ? price <= stop : price >= stop;
    if (hit) {
      return { type: 'exit', direction: openTrade.direction, basis: `${p.atrStopMultiple}xATR trailing stop ${round4(stop)} hit`, donchian: dcOut };
    }
  }

  const blocks = lab && lab.barsK ? lab.barsK : null;
  const dir = dirOfBlocks(blocks, p.momBlocks);
  if (!dir) return { type: null, donchian: dcOut };
  const breakoutUp = price > dc.upper && prevPrice <= dc.upper;
  const breakoutDown = price < dc.lower && prevPrice >= dc.lower;
  if (breakoutUp && dir === 'up') {
    return { type: 'entry', direction: 'buy', basis: `1h donchian${p.donchianPeriod} breakout up + ${blocks.length ? '4h' : ''} trend up`, donchian: dcOut };
  }
  if (breakoutDown && dir === 'down') {
    return { type: 'entry', direction: 'sell', basis: `1h donchian${p.donchianPeriod} breakout down + 4h trend down`, donchian: dcOut };
  }
  return { type: null, donchian: dcOut };
}

// BACKTEST: 1h breakout + higher-TF block-trend agreement; 2xATR trailing
// exit; turtle-family sizing/hygiene (0.05% stop floor, ruin guard).
function backtest(bars, cfg, labCtx) {
  const p = paramsWith(cfg);
  const c = { ...cfg, ...p };
  const heights = bars.map((b) => b.high);
  const lowsArr = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time || b.barStart);
  const period = p.atrPeriod;
  const blocks = labCtx && labCtx.blocks ? labCtx.blocks : null;
  const counts = labCtx && labCtx.counts ? labCtx.counts : null;
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
    if (!blocks || !counts) continue;
    const dir = blockDirAt(blocks, counts, i, p.momBlocks);
    if (!dir) continue;
    if (!session.entryAllowed(times[i], sFilter)) continue; // TRD-18 gate
    const dc = donchian(heights.slice(i - p.donchianPeriod, i), lowsArr.slice(i - p.donchianPeriod, i), p.donchianPeriod);
    if (!dc) continue;
    const prev = closes[i - 1] ?? closes[i];
    const stopDist = Math.max(p.atrStopMultiple * atrNow, closes[i] * 0.0005);
    if (closes[i] > dc.upper && prev <= dc.upper && dir === 'up') {
      const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
      pos = { direction: 'buy', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    } else if (closes[i] < dc.lower && prev >= dc.lower && dir === 'down') {
      const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
      pos = { direction: 'sell', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    }
  }
  if (pos) closePos(closes[closes.length - 1], bars.length - 1, 'end_of_data');

  return { trades, finalCapital: round4(capital), maxDrawdown, start: times[0], end: times[times.length - 1] };
}

module.exports = {
  id: 'mtftrend',
  name: 'Multi-TF Trend (LAB)',
  description: '1h Donchian breakout gated by the completed-4h-block trend direction (regime persistence). TRD-19 candidate.',
  params: PARAMS,
  DEFAULTS,
  paramsWith,
  blockDirAt,
  dirOfBlocks,
  liveSignal,
  backtest,
};
