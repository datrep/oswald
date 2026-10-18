// trading/agent/indicators.js — pure deterministic technical-indicator math.
// No I/O. Input series are ordered oldest -> newest arrays of numbers.
// These are the "quant" brains that run INSTANTLY (amendment A2) — the LLM never
// does this math.
'use strict';

function trueRange(highs, lows, closes) {
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return tr;
}

// Wilder's ATR (EMA smoothing of TR)
function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const tr = trueRange(highs, lows, closes);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  for (let i = period; i < tr.length; i++) prev = (prev * (period - 1) + tr[i]) / period;
  return prev;
}

// Wilder's ADX (directional movement index)
function adx(highs, lows, closes, period = 14) {
  if (closes.length < period * 2 + 1) return null;
  const dmPlus = [];
  const dmMinus = [];
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    dmPlus.push(up > down && up > 0 ? up : 0);
    dmMinus.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const smooth = (arr, n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    let prev = sum;
    const out = [prev];
    for (let i = n; i < arr.length; i++) {
      prev = prev - prev / n + arr[i];
      out.push(prev);
    }
    return out;
  };
  const sTr = smooth(trs, period);
  const sP = smooth(dmPlus, period);
  const sM = smooth(dmMinus, period);
  const adxVals = [];
  let dxPrev = 0;
  for (let i = 0; i < sTr.length; i++) {
    const pdi = sTr[i] === 0 ? 0 : (sP[i] / sTr[i]) * 100;
    const mdi = sTr[i] === 0 ? 0 : (sM[i] / sTr[i]) * 100;
    const dx = pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
    if (i === 0) dxPrev = dx;
    else dxPrev = (dxPrev * (period - 1) + dx) / period;
    adxVals.push(dxPrev);
  }
  return adxVals[adxVals.length - 1];
}

// Donchian channel: highest high / lowest low over `period` bars.
function donchian(highs, lows, period = 20) {
  if (highs.length < period) return null;
  let upper = -Infinity;
  let lower = Infinity;
  for (let i = highs.length - period; i < highs.length; i++) {
    if (highs[i] > upper) upper = highs[i];
    if (lows[i] < lower) lower = lows[i];
  }
  return { upper, lower, mid: (upper + lower) / 2 };
}

// Pearson correlation of two equal-length series.
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  let sa = 0, sb = 0;
  for (let i = a.length - n; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = a.length - n; i < a.length; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

// --- TRD-9 H: classic indicators for the deliberation bundle ---
// Same convention as atr/adx: input oldest->newest arrays, return the LATEST
// value (or null when there isn't enough data).

// Simple moving average (last value).
function sma(values, period) {
  const p = Math.max(1, Number(period) || 20);
  if (!values || values.length < p) return null;
  let sum = 0;
  for (let i = values.length - p; i < values.length; i++) sum += values[i];
  return sum / p;
}

// Exponential moving average (last value, seeded at the first bar).
function ema(values, period) {
  const p = Math.max(1, Number(period) || 20);
  if (!values || !values.length) return null;
  const k = 2 / (p + 1);
  let prev = values[0];
  for (let i = 1; i < values.length; i++) prev = values[i] * k + prev * (1 - k);
  return prev;
}

// Bollinger Bands (middle = SMA, upper/lower = mid ± mult * population sd).
function bollinger(values, period = 20, mult = 2) {
  const p = Math.max(1, Number(period) || 20);
  if (!values || values.length < p) return null;
  const mid = sma(values, p);
  let variance = 0;
  for (let i = values.length - p; i < values.length; i++) variance += (values[i] - mid) ** 2;
  const sd = Math.sqrt(variance / p);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  return { upper, mid, lower, bandwidth: mid !== 0 ? ((upper - lower) / mid) * 100 : null };
}

// Relative Strength Index (Wilder smoothing).
function rsi(values, period = 14) {
  const p = Math.max(1, Number(period) || 14);
  if (!values || values.length < p + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / p, avgL = loss / p;
  for (let i = p + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (p - 1) + Math.max(d, 0)) / p;
    avgL = (avgL * (p - 1) + Math.max(-d, 0)) / p;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// MACD (EMA-based line, signal, histogram).
function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const f = Math.max(1, Number(fast) || 12);
  const s = Math.max(1, Number(slow) || 26);
  const sp = Math.max(1, Number(signalPeriod) || 9);
  if (!values || values.length < s) return null;
  let ef = values[0], es = values[0];
  const line = [];
  for (let i = 0; i < values.length; i++) {
    if (i > 0) {
      ef = values[i] * (2 / (f + 1)) + ef * (1 - 2 / (f + 1));
      es = values[i] * (2 / (s + 1)) + es * (1 - 2 / (s + 1));
    }
    line.push(ef - es);
  }
  const kS = 2 / (sp + 1);
  let sig = line[0];
  for (let i = 1; i < line.length; i++) sig = line[i] * kS + sig * (1 - kS);
  return { macd: line[line.length - 1], signal: sig, hist: line[line.length - 1] - sig };
}

// Stochastic oscillator (%K raw + %D smoothed, latest values).
function stochastic(highs, lows, closes, period = 14, smooth = 3) {
  const p = Math.max(1, Number(period) || 14);
  const sm = Math.max(1, Number(smooth) || 3);
  if (!closes || closes.length < p || !highs || !lows) return null;
  const ks = [];
  const start = Math.max(0, closes.length - p - sm + 1);
  for (let i = start; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    const end = Math.min(i + p - 1, closes.length - 1);
    for (let j = i; j <= end; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    ks.push(hh === ll ? 50 : ((closes[end] - ll) / (hh - ll)) * 100);
  }
  const d = ks.slice(-sm).reduce((a, b) => a + b, 0) / Math.min(sm, ks.length);
  return { k: ks[ks.length - 1], d };
}

// Rate of change (%) over `period` bars (latest).
function roc(values, period = 20) {
  const p = Math.max(1, Number(period) || 20);
  if (!values || values.length < p + 1) return null;
  const prev = values[values.length - 1 - p];
  if (!prev) return null;
  return ((values[values.length - 1] - prev) / prev) * 100;
}

// Momentum (latest - N bars ago).
function momentum(values, period = 10) {
  const p = Math.max(1, Number(period) || 10);
  if (!values || values.length < p + 1) return null;
  return values[values.length - 1] - values[values.length - 1 - p];
}

// Commodity Channel Index (latest).
function cci(highs, lows, closes, period = 20) {
  const p = Math.max(2, Number(period) || 20);
  if (!closes || closes.length < p) return null;
  const tp = closes.map((c, i) => (c + highs[i] + lows[i]) / 3).slice(-p);
  const smaTp = tp.reduce((a, b) => a + b, 0) / p;
  const md = tp.reduce((a, b) => a + Math.abs(b - smaTp), 0) / p;
  if (md === 0) return 0;
  return (tp[tp.length - 1] - smaTp) / (0.015 * md);
}

// Williams %R (latest): -100..0.
function williamsR(highs, lows, closes, period = 14) {
  const p = Math.max(1, Number(period) || 14);
  if (!closes || closes.length < p) return null;
  let hh = -Infinity, ll = Infinity;
  for (let i = closes.length - p; i < closes.length; i++) {
    if (highs[i] > hh) hh = highs[i];
    if (lows[i] < ll) ll = lows[i];
  }
  if (hh === ll) return -50;
  return ((hh - closes[closes.length - 1]) / (hh - ll)) * -100;
}

// Aroon up/down (latest, -1 if not enough data).
function aroon(highs, lows, period = 25) {
  const p = Math.max(1, Number(period) || 25);
  if (!highs || !lows || highs.length < p + 1) return null;
  let hiIdx = -1, loIdx = -1;
  let hh = -Infinity, ll = Infinity;
  for (let i = highs.length - p - 1; i < highs.length; i++) {
    if (highs[i] > hh) { hh = highs[i]; hiIdx = i; }
    if (lows[i] < ll) { ll = lows[i]; loIdx = i; }
  }
  const last = highs.length - 1;
  return {
    up: ((p - (last - hiIdx)) / p) * 100,
    down: ((p - (last - loIdx)) / p) * 100,
  };
}

// On-Balance Volume (latest cumulative value). Returns null when the series carries no USABLE volume:
// absent, all-zero, or constant (see the guard below — "present" has to mean "varies"). The 20-bar slope
// is a reserved parameter (TODO: emit slope alongside the cumulative OBV).
//
// ⚠⚠ ZERO AND ABSENT SHARE ONE VALUE IN THIS DATA, SO A FINITENESS TEST IS NOT A PRESENCE TEST
// (2026-09-23). `Number.isFinite(Number(0))` is TRUE, so the original guard ACCEPTED an all-zero series
// and published `{ obv: 0 }` — a CONSTANT rendered as an indicator, which is worse than a blank because a
// blank reads as missing. It is not a rare branch: measured 2026-09-23 on `plus500_chart`, the venue's
// chart feed carries no volume at all for Gold (0 of 1,142 bars), Silver (0 of 1,134), Bitcoin (0 of
// 1,207) and BNB (0 of 504), and `capture.bankChartBars` writes 0 whether the feed OMITTED volume or the
// instrument had none. A single DISTINCT value is degenerate for the same reason: with constant volume OBV
// is a count of up bars minus down bars, i.e. a price-direction tally wearing a volume label.
function obv(closes, volumes, _slopePeriod = 20) {
  if (!closes || !volumes || closes.length !== volumes.length) return null;
  const finite = volumes.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (!finite.length) return null;
  if (new Set(finite).size <= 1) return null;
  let cum = 0;
  for (let i = 1; i < closes.length; i++) {
    const v = Number(volumes[i]) || 0;
    if (closes[i] > closes[i - 1]) cum += v;
    else if (closes[i] < closes[i - 1]) cum -= v;
  }
  return { obv: cum };
}

module.exports = { trueRange, atr, adx, donchian, correlation, sma, ema, bollinger, rsi, macd, stochastic, roc, momentum, cci, williamsR, aroon, obv };
