// trading/agent/strategies/turtleUltimate.js — Turtle Ultimate (extracted TRD-10).
// The same deterministic math as before (Donchian breakout excl. current bar,
// ADX trend gate, 2xATR trailing stop, Turtle sizing) — now behind the
// strategy registry interface so it can be enabled/disabled + parameterized
// from settings without a redeploy. No behavior change at defaults.
'use strict';

const { donchian } = require('../indicators');
const { nightsFor } = require('../time'); // TRD-25 nights; TRD-49 venue funding clock via cfg

const DEFAULTS = {
  donchianPeriod: 20,
  adxPeriod: 14,
  adxGate: 20,
  atrPeriod: 14,
  atrStopMultiple: 2,
  riskPerTradePct: 1,
};

const PARAMS = [
  { key: 'donchianPeriod', label: 'Donchian period', type: 'number', def: 20, min: 5, max: 100, step: 1, tightens: 'higher' },
  { key: 'adxPeriod', label: 'ADX period', type: 'number', def: 14, min: 5, max: 50, step: 1 },
  { key: 'adxGate', label: 'ADX trend gate', type: 'number', def: 20, min: 0, max: 60, step: 1, tightens: 'higher' },
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

// LIVE signal on the latest bar(s). ctx from quant.js (ticks + computed
// indicators + optional open position). Returns {type, direction, basis,
// donchian}. Entry and exit are both expressed here (exit wins upstream).
function liveSignal({ highs, lows, closes: _closes, atr14, adx14, price, prevPrice, params, openTrade }) {
  const p = paramsWith(params);
  const dc = highs.length >= p.donchianPeriod + 1
    ? donchian(highs.slice(0, -1), lows.slice(0, -1), p.donchianPeriod)
    : null;
  const dcOut = dc ? { upper: round4(dc.upper), lower: round4(dc.lower) } : null;
  if (adx14 == null || atr14 == null || !dc) return { type: null, donchian: dcOut };

  // Exit first: 2xATR trailing stop on the open position.
  if (openTrade && openTrade.peak != null && openTrade.trough != null) {
    const stop = openTrade.direction === 'buy'
      ? openTrade.peak - p.atrStopMultiple * atr14
      : openTrade.trough + p.atrStopMultiple * atr14;
    const hit = openTrade.direction === 'buy' ? price <= stop : price >= stop;
    if (hit) {
      return { type: 'exit', direction: openTrade.direction, basis: `${p.atrStopMultiple}xATR trailing stop ${round4(stop)} hit`, donchian: dcOut };
    }
  }

  const breakoutUp = price > dc.upper && prevPrice <= dc.upper;
  const breakoutDown = price < dc.lower && prevPrice >= dc.lower;
  if (breakoutUp && adx14 > p.adxGate) {
    return { type: 'entry', direction: 'buy', basis: `donchian${p.donchianPeriod} breakout up, ADX ${round4(adx14)}`, donchian: dcOut };
  }
  if (breakoutDown && adx14 > p.adxGate) {
    return { type: 'entry', direction: 'sell', basis: `donchian${p.donchianPeriod} breakout down, ADX ${round4(adx14)}`, donchian: dcOut };
  }
  return { type: null, donchian: dcOut };
}

// BACKTEST: same rolling-Wilder implementation as the pre-registry runTurtle.
function backtest(bars, cfg, lab, opts = {}) {
  const p = paramsWith(cfg);
  const c = { ...cfg, ...p };
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time || b.barStart);
  const period = p.atrPeriod;

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

  let sTr = 0, sP = 0, sM = 0, atrNow = null, adxNow = null, dxPrev = null;
  const indicatorAt = (i) => {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    const dp = up > down && up > 0 ? up : 0;
    const dm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      sTr += tr; sP += dp; sM += dm;
      if (i === period) { atrNow = sTr / period; dxPrev = null; }
    } else {
      sTr = sTr - sTr / period + tr;
      sP = sP - sP / period + dp;
      sM = sM - sM / period + dm;
      atrNow = sTr / period;
      const pdi = sTr === 0 ? 0 : (sP / sTr) * 100;
      const mdi = sTr === 0 ? 0 : (sM / sTr) * 100;
      const dx = pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
      dxPrev = dxPrev == null ? dx : (dxPrev * (period - 1) + dx) / period;
    }
    adxNow = i >= period * 2 ? dxPrev : null;
  };

  for (let i = 1; i < bars.length; i++) {
    indicatorAt(i);
    if (i < 25) continue;
    // Ruin guard (2026-09-10): stop when capital is exhausted — negative
    // capital would flip the size sign and compound fake P&L.
    if (capital <= 0) break;
    if (atrNow == null || adxNow == null || !(atrNow > 0)) {
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
    const dc = donchian(highs.slice(i - p.donchianPeriod, i), lows.slice(i - p.donchianPeriod, i), p.donchianPeriod);
    if (!dc) continue;
    const prev = closes[i - 1] ?? closes[i];
    // ★ OPTIONAL ENTRY FILTER (S3, 2026-09-23). ABSENT FOR EVERY EXISTING STRATEGY, so this is a no-op for
    // turtle, survgold and survoil — their behaviour is unchanged BY CONSTRUCTION, not merely by test.
    //
    // It exists so a gated clone of a strategy can apply its gate in the SAME loop that decides the entry,
    // rather than reimplementing the loop (which would drift) or filtering the trade list afterwards (which
    // would gate the OUTCOME instead of the DECISION, and would not reproduce live behaviour at all).
    // Per-branch, so the filter is told the direction it is being asked abou && allowed('sell')t.
    const allowed = (direction) => !opts.entryFilter || opts.entryFilter({ bars, i, direction }) !== false;
    // Stop distance floored at 0.05% of price (2026-09-10): flat/gapped bars
    // can shrink ATR to near zero and explode position size.
    const stopDist = Math.max(2 * atrNow, closes[i] * 0.0005);
    if (closes[i] > dc.upper && prev <= dc.upper && adxNow > p.adxGate && allowed('buy')) {
      const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
      pos = { direction: 'buy', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    } else if (closes[i] < dc.lower && prev >= dc.lower && adxNow > p.adxGate) {
      const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
      pos = { direction: 'sell', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    }
  }
  if (pos) closePos(closes[closes.length - 1], bars.length - 1, 'end_of_data');

  return { trades, finalCapital: round4(capital), maxDrawdown, start: times[0], end: times[times.length - 1] };
}

module.exports = {
  id: 'turtle',
  name: 'Turtle Ultimate',
  description: 'Donchian breakout with ADX trend gate, 2xATR trailing stop, Turtle sizing.',
  params: PARAMS,
  DEFAULTS,
  paramsWith,
  liveSignal,
  backtest,
};
