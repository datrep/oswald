// trading/agent/strategies/macd.js — MACD cross trend strategy (implied goal).
// Trend-following complement to the turtle: enter on a MACD(12,26,9) signal
// cross (up = long, down = short) confirmed by an ADX trend floor, exit on
// the opposite cross. Catches trends earlier than the Donchian breakout and
// churns less than pure-cross systems thanks to the ADX gate.
'use strict';

const { macd } = require('../indicators');
const { nightsFor } = require('../time'); // TRD-25 nights; TRD-49 venue funding clock via cfg

const DEFAULTS = {
  fast: 12,
  slow: 26,
  signal: 9,
  adxGate: 15, // looser than the turtle's 20 -> catches earlier trends
  riskPerTradePct: 1,
};

const PARAMS = [
  { key: 'fast', label: 'MACD fast EMA', type: 'number', def: 12, min: 3, max: 30, step: 1 },
  { key: 'slow', label: 'MACD slow EMA', type: 'number', def: 26, min: 10, max: 60, step: 1 },
  { key: 'signal', label: 'Signal EMA', type: 'number', def: 9, min: 3, max: 20, step: 1 },
  { key: 'adxGate', label: 'ADX trend floor', type: 'number', def: 15, min: 0, max: 50, step: 1, tightens: 'higher' },
  { key: 'riskPerTradePct', label: 'Risk per trade %', type: 'number', def: 1, min: 0.1, max: 5, step: 0.1, tightens: 'lower' },
];

function paramsWith(cfg) {
  const out = {};
  for (const p of PARAMS) out[p.key] = cfg && cfg[p.key] != null ? Number(cfg[p.key]) : p.def;
  return out;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// LIVE signal. ctx from quant.js (bar series + computed indicators).
function liveSignal({ closes, atr14: _atr14, adx14, params, openTrade }) {
  const p = paramsWith(params);
  if (closes.length < p.slow + p.signal + 5) return { type: null };
  const m = macd(closes, p.fast, p.slow, p.signal);
  const mPrev = macd(closes.slice(0, -1), p.fast, p.slow, p.signal);
  if (!m || !mPrev) return { type: null };
  const snap = { line: round4(m.macd), signal: round4(m.signal), hist: round4(m.hist) };

  if (openTrade && openTrade.peak != null && openTrade.trough != null) {
    const crossedDown = mPrev.macd >= mPrev.signal && m.macd < m.signal;
    if (crossedDown) return { type: 'exit', direction: openTrade.direction, basis: `MACD crossed below signal (${snap.line}/${snap.signal})`, macd: snap };
  }

  const crossedUp = mPrev.macd <= mPrev.signal && m.macd > m.signal;
  const crossedDown = mPrev.macd >= mPrev.signal && m.macd < m.signal;
  if (adx14 == null || adx14 <= p.adxGate) return { type: null, macd: snap };
  if (crossedUp) return { type: 'entry', direction: 'buy', basis: `MACD cross up, ADX ${round4(adx14)}`, macd: snap };
  if (crossedDown) return { type: 'entry', direction: 'sell', basis: `MACD cross down, ADX ${round4(adx14)}`, macd: snap };
  return { type: null, macd: snap };
}

// BACKTEST: incremental EMAs (O(n)), entry on cross + ADX gate, exit on the
// opposite cross. Trade shape matches the turtle backtester.
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

  const kF = 2 / (p.fast + 1), kS = 2 / (p.slow + 1), kSig = 2 / (p.signal + 1);
  let fEma = null, sEma = null, sigEma = null, prevM = null, prevS = null;
  const macdStep = (price) => {
    fEma = fEma == null ? price : fEma + kF * (price - fEma);
    sEma = sEma == null ? price : sEma + kS * (price - sEma);
    const m = fEma - sEma;
    sigEma = sigEma == null ? m : sigEma + kSig * (m - sigEma);
    return { m, s: sigEma };
  };

  // Wilder ADX (rolling, same as the live path).
  let sTr = 0, sP = 0, sM2 = 0, adxNow = null, dxPrev = null;
  const adxStep = (i) => {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    const dp = up > down && up > 0 ? up : 0;
    const dm = down > up && down > 0 ? down : 0;
    if (i <= 14) {
      sTr += tr; sP += dp; sM2 += dm;
      if (i === 14) adxNow = null;
    } else {
      sTr = sTr - sTr / 14 + tr;
      sP = sP - sP / 14 + dp;
      sM2 = sM2 - sM2 / 14 + dm;
      const pdi = sTr === 0 ? 0 : (sP / sTr) * 100;
      const mdi = sTr === 0 ? 0 : (sM2 / sTr) * 100;
      const dx = pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
      dxPrev = dxPrev == null ? dx : (dxPrev * 13 + dx) / 14;
      adxNow = i >= 28 ? dxPrev : null;
    }
  };

  for (let i = 1; i < bars.length; i++) {
    adxStep(i);
    const cur = macdStep(closes[i]);
    // Ruin guard (2026-09-10): stop when capital is exhausted — negative
    // capital would flip the size sign and compound fake P&L.
    if (capital <= 0) break;
    if (i < p.slow + p.signal + 5) { prevM = cur.m; prevS = cur.s; continue; }
    const crossUp = prevM != null && prevS != null && prevM <= prevS && cur.m > cur.s;
    const crossDown = prevM != null && prevS != null && prevM >= prevS && cur.m < cur.s;
    if (pos) {
      if (crossDown) closePos(closes[i], i, 'macd_cross_down');
      prevM = cur.m; prevS = cur.s;
      continue;
    }
    if (adxNow != null && adxNow > p.adxGate && (crossUp || crossDown)) {
      const dir = crossUp ? 'buy' : 'sell';
      // ATR-less sizing: risk budget / (2 * 1-bar range) as the stop proxy,
      // floored at 0.05% of price (2026-09-10) so flat bars can't explode size.
      const range = Math.max(highs[i] - lows[i], closes[i] * 0.0005);
      const size = (capital * (p.riskPerTradePct / 100)) / (2 * range);
      pos = { direction: dir, size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    }
    prevM = cur.m; prevS = cur.s;
  }
  if (pos) closePos(closes[closes.length - 1], bars.length - 1, 'end_of_data');

  return { trades, finalCapital: round4(capital), maxDrawdown, start: times[0], end: times[times.length - 1] };
}

module.exports = {
  id: 'macd',
  name: 'MACD Cross Trend',
  description: 'MACD(12,26,9) signal-line cross with an ADX trend floor; exits on the opposite cross. Complements the turtle with earlier trend entries.',
  params: PARAMS,
  DEFAULTS,
  paramsWith,
  liveSignal,
  backtest,
};
