// trading/agent/strategies/squeezeMeanRev.js — Squeeze Mean-Reversion
// (TRD-16, LAB-2). Hypothesis (measured 2026-09-10): the desk's original
// mean-reversion variants died in chop-churn (audit: meanrev cells FAIL,
// 324-config hunt zero passes) because they faded extremes in UNCOMPRESSED
// conditions. Squeeze mean-reversion adds ONE precondition: the Bollinger
// bandwidth must sit in the bottom `squeezePct` of its `squeezeLookback`
// distribution (volatility COMPRESSION, measured BEFORE the trigger bar —
// the overshoot bar itself widens the band) AND the bar-causal harness regime
// must be 'range'. THEN fade the band overshoot back to the mid-band.
// Two separate hypotheses per the plan: squeeze-in-commodities (Oil) and
// squeeze-in-metals (Gold); Coffee/Sugar are Stage-A-only diagnostics.
// Hyperparameters were fixed on W1 ONLY (TRD-16 dev run, 2026-09-10: grid
// bbStd {2,2.5} x squeezePct {0.2,0.3} x stop {1.5,2.5} with the pre-trigger
// compression fix; winner 2.5/0.3/1.5). DEV VERDICT (recorded): the winner
// passes 2/4 symbols on W1 — both Stage-A-only diagnostics (Coffee 2.58,
// Sugar 1.03) — while the promotion targets FAIL their own development
// window (Oil 0.48, Gold 0.17). The squeeze precondition does NOT rescue
// mean-reversion on its target instruments; this candidate goes to the
// formal stages EXPECTED to fail.
'use strict';

const { bollinger } = require('../indicators');
const { nightsFor } = require('../time'); // TRD-25 nights; TRD-49 venue funding clock via cfg
const session = require('../lab/session'); // TRD-18 entry-time filter (frozen: not usable)

const DEFAULTS = {
  bbPeriod: 20,
  bbStd: 2.5,          // FROZEN on W1 only (dev grid 2 vs 2.5)
  squeezeLookback: 100,
  squeezePct: 0.3,     // FROZEN on W1 only: bottom 30% of pre-trigger bandwidth
  stopAtrMult: 1.5,    // FROZEN on W1 only: hard stop = 1.5xATR beyond entry
  atrPeriod: 14,
  riskPerTradePct: 0.5, // half the turtle's risk budget (meanrev parity)
};

const PARAMS = [
  { key: 'bbPeriod', label: 'Bollinger period', type: 'number', def: 20, min: 10, max: 100, step: 1 },
  { key: 'bbStd', label: 'Bollinger stddev', type: 'number', def: 2, min: 1, max: 4, step: 0.5, tightens: 'higher' },
  { key: 'squeezeLookback', label: 'Squeeze lookback (bars)', type: 'number', def: 100, min: 30, max: 500, step: 10 },
  { key: 'squeezePct', label: 'Squeeze percentile', type: 'number', def: 0.25, min: 0.05, max: 0.5, step: 0.05, tightens: 'lower' },
  { key: 'stopAtrMult', label: 'Hard stop (xATR)', type: 'number', def: 2, min: 0.5, max: 5, step: 0.5 },
  { key: 'atrPeriod', label: 'ATR period', type: 'number', def: 14, min: 5, max: 50, step: 1 },
  { key: 'riskPerTradePct', label: 'Risk per trade %', type: 'number', def: 0.5, min: 0.1, max: 2, step: 0.1, tightens: 'lower' },
];

function paramsWith(cfg) {
  const out = {};
  for (const p of PARAMS) out[p.key] = cfg && cfg[p.key] != null ? Number(cfg[p.key]) : p.def;
  return out;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// Bandwidth percentile rank of the LATEST bandwidth within the last
// `lookback` bandwidths (1.0 = the widest, 0.0 = the most compressed).
function bandwidthSeries(closes, bbPeriod, bbStd) {
  const bw = [];
  for (let i = bbPeriod - 1; i < closes.length; i++) {
    const bb = bollinger(closes.slice(i - bbPeriod + 1, i + 1), bbPeriod, bbStd);
    bw.push(bb && bb.mid > 0 ? bb.bandwidth / bb.mid : null);
  }
  return bw; // index j corresponds to closes index j + bbPeriod - 1
}

function squeezeRank(bw, lookback) {
  const cur = bw[bw.length - 1];
  if (cur == null) return null;
  const from = Math.max(0, bw.length - lookback);
  let le = 0;
  let count = 0;
  for (let j = from; j < bw.length; j++) {
    if (bw[j] == null) continue;
    count++;
    if (bw[j] <= cur) le++;
  }
  if (count < 20) return null;
  return le / count;
}

// LIVE signal. ctx.lab from the TRD-13 harness supplies the bar-causal
// regime; fail-secure: no regime -> no signals.
function liveSignal({ highs: _highs, lows: _lows, closes, atr14, adx14: _adx14, price, prevPrice: _prevPrice, params, openTrade, lab }) {
  const p = paramsWith(params);
  const reg = lab && lab.regime ? lab.regime : null;
  if (closes.length < p.bbPeriod + p.squeezeLookback) return { type: null };
  const bb = bollinger(closes, p.bbPeriod, p.bbStd);
  if (!bb) return { type: null };
  const bw = bandwidthSeries(closes, p.bbPeriod, p.bbStd);
  const rank = squeezeRank(bw, p.squeezeLookback);
  const over = { rank: rank == null ? null : round4(rank), bbUpper: round4(bb.upper), bbLower: round4(bb.lower), mid: round4(bb.mid), regime: reg ? reg.regime : null };

  // Exit first: price returned to the mid-band (mean-reversion target).
  if (openTrade && openTrade.peak != null && openTrade.trough != null) {
    const back = openTrade.direction === 'buy' ? price >= bb.mid : price <= bb.mid;
    if (back) {
      return { type: 'exit', direction: openTrade.direction, basis: `squeeze mean-reversion: back to mid-band ${round4(bb.mid)}`, squeeze: over };
    }
  }

  if (!reg || reg.regime !== 'range') return { type: null, squeeze: over };
  // Compression is measured BEFORE the trigger bar: the overshoot bar itself
  // widens the band, so the rank uses the previous bar's bandwidth series.
  const rankPrev = squeezeRank(bw.slice(0, -1), p.squeezeLookback);
  if (rankPrev == null || rankPrev > p.squeezePct) return { type: null, squeeze: { ...over, rank: rankPrev == null ? null : round4(rankPrev) } };
  if (price < bb.lower) {
    return { type: 'entry', direction: 'buy', basis: `squeeze mean-reversion: pre-trigger bandwidth rank ${round4(rankPrev)} <= ${p.squeezePct}, price below BB lower ${round4(bb.lower)}`, squeeze: { ...over, rank: round4(rankPrev) } };
  }
  if (price > bb.upper) {
    return { type: 'entry', direction: 'sell', basis: `squeeze mean-reversion: pre-trigger bandwidth rank ${round4(rankPrev)} <= ${p.squeezePct}, price above BB upper ${round4(bb.upper)}`, squeeze: { ...over, rank: round4(rankPrev) } };
  }
  return { type: null, squeeze: over };
}

// BACKTEST: range-regime + squeeze-gated fade, mid-band exit, hard
// stopAtrMult x ATR stop, ruin guard, 0.05%-of-price stop floor for sizing.
function backtest(bars, cfg, labCtx) {
  const p = paramsWith(cfg);
  const c = { ...cfg, ...p };
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.time || b.barStart);
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
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    if (i <= p.atrPeriod) {
      sTr += tr;
      if (i === p.atrPeriod) atrNow = sTr / p.atrPeriod;
    } else {
      sTr = sTr - sTr / p.atrPeriod + tr;
      atrNow = sTr / p.atrPeriod;
    }
  };

  // Rolling bandwidth array (computed once; causal by construction).
  const bwAll = bandwidthSeries(closes, p.bbPeriod, p.bbStd);
  const bwAt = (i) => bwAll[i - (p.bbPeriod - 1)]; // null before the first window

  const minIdx = Math.max(p.bbPeriod + p.squeezeLookback, 30);
  for (let i = 1; i < bars.length; i++) {
    indicatorAt(i);
    if (i < minIdx) continue;
    if (capital <= 0) break;
    if (atrNow == null || !(atrNow > 0)) {
      if (pos) closePos(closes[i], i, 'data_gap');
      continue;
    }
    const reg = regime ? regime[i] : null;
    const bb = bollinger(closes.slice(i - p.bbPeriod + 1, i + 1), p.bbPeriod, p.bbStd);
    if (!bb || !reg) { if (pos) closePos(closes[i], i, 'data_gap'); continue; }

    if (pos) {
      // Mid-band target, then the hard stop (stop wins if both hit — fail-safe).
      const stop = pos.direction === 'buy' ? pos.entryPrice - p.stopAtrMult * atrNow : pos.entryPrice + p.stopAtrMult * atrNow;
      const stopHit = pos.direction === 'buy' ? closes[i] <= stop : closes[i] >= stop;
      if (stopHit) { closePos(stop, i, 'hard_stop'); continue; }
      const back = pos.direction === 'buy' ? closes[i] >= bb.mid : closes[i] <= bb.mid;
      if (back) closePos(closes[i], i, 'mid_band_exit');
      continue;
    }

    if (reg.regime !== 'range') continue;
    if (!session.entryAllowed(times[i], sFilter)) continue; // TRD-18 gate
    // Pre-trigger compression: rank of the bandwidth series up to i-1.
    const curBw = bwAt(i - 1);
    if (curBw == null) continue;
    const from = Math.max(p.bbPeriod - 1, i - 1 - p.squeezeLookback + 1);
    let le = 0;
    let count = 0;
    for (let j = from; j <= i - 1; j++) {
      const v = bwAt(j);
      if (v == null) continue;
      count++;
      if (v <= curBw) le++;
    }
    if (count < 20) continue;
    const rank = le / count;
    if (rank > p.squeezePct) continue;

    const stopDist = Math.max(p.stopAtrMult * atrNow, closes[i] * 0.0005);
    const size = (capital * (p.riskPerTradePct / 100)) / stopDist;
    if (closes[i] < bb.lower) {
      pos = { direction: 'buy', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    } else if (closes[i] > bb.upper) {
      pos = { direction: 'sell', size, entryPrice: closes[i], entryIdx: i, peak: closes[i], trough: closes[i], entryTime: times[i] };
    }
  }
  if (pos) closePos(closes[closes.length - 1], bars.length - 1, 'end_of_data');

  return { trades, finalCapital: round4(capital), maxDrawdown, start: times[0], end: times[times.length - 1] };
}

module.exports = {
  id: 'squeezerev',
  name: 'Squeeze Mean-Reversion (LAB)',
  description: 'Range-regime counter-trend gated by Bollinger bandwidth compression (bottom percentile) -> fade band overshoot, exit at mid-band, 2xATR hard stop. TRD-16 candidate.',
  // TRD-89 (2026-09-18): the compression precondition is part of the thesis and must be given to the
  // reviewer, or a widening band reads as "trend broken" when it is the squeeze failing to hold.
  exitThesis: 'SQUEEZE MEAN REVERSION — the entry fades a band overshoot inside a volatility squeeze, so this position is deliberately on the other side of the recent move: that overshoot is the ENTRY CONDITION, not a broken thesis. The thesis completes when price returns to the mid-band. A widening band is the SQUEEZE failing, which is a reason to respect the stop, not to reinterpret the position as a trend trade.',
  // TRD-89: advisory only — see rsi2.reviewAuthority.
  reviewAuthority: 'advisory',
  params: PARAMS,
  DEFAULTS,
  paramsWith,
  liveSignal,
  backtest,
};
