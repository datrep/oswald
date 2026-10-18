// trading/agent/strategies/meanrev.js — mean-reversion voter (implied goal).
// Counter-trend strategy for ranging regimes: enter when RSI(14) is extreme
// AND price is outside the Bollinger(20,2) band (mean overshoot), exit when
// price returns to the mid-band (SMA20). Gated upstream: the quant engine
// only lets it vote when the meta regime is 'range' (trend regimes belong to
// the turtle). Sized at HALF the turtle's risk budget.
'use strict';

const { rsi, bollinger } = require('../indicators');
const { nightsFor } = require('../time'); // TRD-25 nights; TRD-49 venue funding clock via cfg

const DEFAULTS = {
  rsiPeriod: 14,
  rsiLow: 30,
  rsiHigh: 70,
  bbPeriod: 20,
  bbStd: 2,
  riskPerTradePct: 0.5, // half the turtle's risk budget
};

const PARAMS = [
  { key: 'rsiPeriod', label: 'RSI period', type: 'number', def: 14, min: 5, max: 50, step: 1 },
  { key: 'rsiLow', label: 'RSI oversold', type: 'number', def: 30, min: 5, max: 45, step: 1, tightens: 'lower' },
  { key: 'rsiHigh', label: 'RSI overbought', type: 'number', def: 70, min: 55, max: 95, step: 1, tightens: 'higher' },
  { key: 'bbPeriod', label: 'Bollinger period', type: 'number', def: 20, min: 10, max: 100, step: 1 },
  { key: 'bbStd', label: 'Bollinger stddev', type: 'number', def: 2, min: 1, max: 4, step: 0.5, tightens: 'higher' },
  { key: 'riskPerTradePct', label: 'Risk per trade %', type: 'number', def: 0.5, min: 0.1, max: 2, step: 0.1, tightens: 'lower' },
];

function paramsWith(cfg) {
  const out = {};
  for (const p of PARAMS) out[p.key] = cfg && cfg[p.key] != null ? Number(cfg[p.key]) : p.def;
  return out;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// LIVE signal on the latest bars. ctx from quant.js (bar series + computed
// indicators + optional open position). Returns {type, direction, basis}.
function liveSignal({ highs: _highs, lows: _lows, closes, atr14: _atr14, adx14: _adx14, price, prevPrice: _prevPrice, params, openTrade }) {
  const p = paramsWith(params);
  if (closes.length < p.bbPeriod + p.rsiPeriod) return { type: null };
  const bb = bollinger(closes, p.bbPeriod, p.bbStd);
  const r = rsi(closes, p.rsiPeriod);
  if (!bb || r == null) return { type: null };
  const mid = bb.mid;
  const over = { rsi: round4(r), bbUpper: round4(bb.upper), bbLower: round4(bb.lower), mid: round4(mid) };

  // Exit first: price returned to the mid-band.
  if (openTrade && openTrade.peak != null && openTrade.trough != null) {
    const back = openTrade.direction === 'buy' ? price >= mid : price <= mid;
    if (back) {
      return { type: 'exit', direction: openTrade.direction, basis: `mean reversion: back to mid-band ${round4(mid)}`, meanrev: over };
    }
  }

  if (r < p.rsiLow && price < bb.lower) {
    return { type: 'entry', direction: 'buy', basis: `mean reversion: RSI ${round4(r)} < ${p.rsiLow}, price below BB lower ${round4(bb.lower)}`, meanrev: over };
  }
  if (r > p.rsiHigh && price > bb.upper) {
    return { type: 'entry', direction: 'sell', basis: `mean reversion: RSI ${round4(r)} > ${p.rsiHigh}, price above BB upper ${round4(bb.upper)}`, meanrev: over };
  }
  return { type: null, meanrev: over };
}

// BACKTEST: same entry/exit rules on 1h bars; trade shape matches the turtle
// backtester so worksheet()/sweep/walk-forward all work unchanged.
function backtest(bars, cfg) {
  const p = paramsWith(cfg);
  const c = { ...cfg, ...p };
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time || b.barStart);

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

  let sTr = 0, atrNow = null;
  const rolling = (i) => {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    if (i <= p.rsiPeriod) {
      sTr += tr;
      if (i === p.rsiPeriod) atrNow = sTr / p.rsiPeriod;
    } else {
      sTr = sTr - sTr / p.rsiPeriod + tr;
      atrNow = sTr / p.rsiPeriod;
    }
  };

  for (let i = 1; i < bars.length; i++) {
    rolling(i);
    if (i < p.bbPeriod + p.rsiPeriod) continue;
    // Ruin guard (2026-09-10): stop when capital is exhausted — negative
    // capital would flip the size sign and compound fake P&L.
    if (capital <= 0) break;
    if (atrNow == null || !(atrNow > 0)) {
      if (pos) closePos(closes[i], i, 'data_gap');
      continue;
    }
    const win = closes.slice(0, i + 1);
    const bb = bollinger(win, p.bbPeriod, p.bbStd);
    const r = rsi(win, p.rsiPeriod);
    if (!bb || r == null) { if (pos) closePos(closes[i], i, 'data_gap'); continue; }
    if (pos) {
      const back = pos.direction === 'buy' ? closes[i] >= bb.mid : closes[i] <= bb.mid;
      if (back) closePos(closes[i], i, 'mid_band_exit');
      continue;
    }
    // Stop distance floored at 0.05% of price (2026-09-10): flat/gapped bars
    // can shrink ATR to near zero and explode position size.
    const stopDist = Math.max(2 * atrNow, closes[i] * 0.0005);
    const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
    if (r < p.rsiLow && closes[i] < bb.lower) {
      pos = { direction: 'buy', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    } else if (r > p.rsiHigh && closes[i] > bb.upper) {
      pos = { direction: 'sell', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    }
  }
  if (pos) closePos(closes[closes.length - 1], bars.length - 1, 'end_of_data');

  return { trades, finalCapital: round4(capital), maxDrawdown, start: times[0], end: times[times.length - 1] };
}

module.exports = {
  id: 'meanrev',
  name: 'Mean Reversion',
  description: 'Range-regime counter-trend: RSI extreme + outside Bollinger band -> fade; exit at mid-band. Half turtle risk.',
  // TRD-89 (2026-09-18): see rsi2.exitThesis — the review loop judged these with trend tools and closed
  // them on "trend broken", which is the entry condition for a fade. Same defect, same family.
  exitThesis: 'MEAN REVERSION — this position fades an extreme, so it is deliberately positioned against the recent move and a trend indicator agreeing with that move is the ENTRY CONDITION, not a break. The thesis completes when price returns to the mid-band; closing there is the exit, not a reason to wait. Judge the fade staying stalled, not the trend continuing.',
  // TRD-89: advisory only — see rsi2.reviewAuthority.
  reviewAuthority: 'advisory',
  params: PARAMS,
  DEFAULTS,
  paramsWith,
  liveSignal,
  backtest,
};
