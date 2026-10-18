// trading/agent/lab.js — Strategy Lab harness (TRD-13, 2026-09-10).
// Three primitives, delivered in the EXISTING trade shape (the
// {time, open, high, low, close} series quant.js and backtest.js already
// share), so LAB candidates consume the same objects as the classic
// strategies:
//   1. multi-TF inputs      — k-hour (default 4h) aggregation, bar-causal:
//      at 1h index i only COMPLETED k-blocks (block end <= i) are visible;
//   2. causal regime flags  — rolling Wilder ADX (float-identical math to
//      indicators.js adx()) + 50-bar momentum direction, computed from
//      bars[0..i] only (no lookahead), one flag per 1h index;
//   3. derived series       — bar-start-aligned ratio of two instruments
//      (Gold/Silver close ratio), with the same causal visibility rule.
// Pure, deterministic, no I/O. TRD-14 (scoreboard) and the LAB candidates
// (TRD-15/16/17/19/23) build on this module.
'use strict';

function timeMs(t) {
  if (t == null) return 0;
  if (typeof t === 'number') return t;
  const d = new Date(t);
  const v = d.getTime();
  return Number.isFinite(v) ? v : 0;
}

// Completed k-bar blocks from bars (oldest -> newest). A partial trailing
// block is EXCLUDED — it is still forming, and using it would be lookahead.
function toKBar(bars, k = 4) {
  const n = k >= 2 ? Math.floor(k) : 4;
  const blocks = [];
  for (let i = 0; i + n <= bars.length; i += n) {
    const seg = bars.slice(i, i + n);
    let high = -Infinity;
    let low = Infinity;
    for (const b of seg) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
    }
    blocks.push({
      time: timeMs(seg[0].time),
      open: Number(seg[0].open),
      high,
      low,
      close: Number(seg[n - 1].close),
    });
  }
  return blocks;
}

// Number of series elements with time <= t (series sorted by time ascending).
function visibleUpTo(series, t) {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (timeMs(series[mid].time) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Bar-causal per-bar regime flags. At 1h index i the flag uses bars[0..i]
// ONLY. Rolling Wilder math mirrors indicators.js adx()/atr() exactly
// (same operation order -> float-identical), so the final flag equals what
// quant.js's live snapshot computes on the same window. Warmup: adx is null
// until bar index `adxPeriod` (the first smoothed DX); direction is null
// until `momPeriod` bars exist.
function regimeSeries(bars, { adxPeriod = 14, trendGate = 25, momPeriod = 50 } = {}) {
  const n = adxPeriod >= 2 ? Math.floor(adxPeriod) : 14;
  const gate = trendGate;
  const mom = momPeriod >= 2 ? Math.floor(momPeriod) : 50;
  const out = bars.map(() => ({ adx: null, regime: null, dir: null }));
  let sTr = 0;
  let sP = 0;
  let sM = 0;
  let dxPrev = null;

  const dxOf = (trS, pS, mS) => {
    const pdi = trS === 0 ? 0 : (pS / trS) * 100;
    const mdi = trS === 0 ? 0 : (mS / trS) * 100;
    return pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100;
  };
  const setFlag = (i) => {
    const adxNow = dxPrev;
    let dir = null;
    if (i >= mom) {
      const c0 = Number(bars[i].close);
      const cM = Number(bars[i - mom].close);
      dir = c0 > cM ? 'up' : c0 < cM ? 'down' : null;
    }
    out[i] = { adx: adxNow, regime: adxNow == null ? null : adxNow >= gate ? 'trend' : 'range', dir };
  };

  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i].high);
    const l = Number(bars[i].low);
    const pc = Number(bars[i - 1].close);
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - Number(bars[i - 1].high);
    const down = Number(bars[i - 1].low) - l;
    const dp = up > down && up > 0 ? up : 0;
    const dm = down > up && down > 0 ? down : 0;
    if (i <= n) {
      sTr += tr;
      sP += dp;
      sM += dm;
      if (i === n) {
        // First smoothed DX (indicators.js smooth() seeds with the raw sum).
        dxPrev = dxOf(sTr, sP, sM);
        setFlag(i);
      }
    } else {
      sTr = sTr - sTr / n + tr;
      sP = sP - sP / n + dp;
      sM = sM - sM / n + dm;
      dxPrev = (dxPrev * (n - 1) + dxOf(sTr, sP, sM)) / n;
      setFlag(i);
    }
  }
  return out;
}

// Bar-start-aligned ratio series: primary close / other close, only on
// timestamps present in BOTH series (sorted by time ascending).
function buildRatio(primaryBars, otherBars) {
  const other = new Map();
  for (const b of otherBars) {
    const t = timeMs(b.time);
    if (t > 0 && !other.has(t)) other.set(t, Number(b.close));
  }
  const out = [];
  for (const b of primaryBars) {
    const t = timeMs(b.time);
    if (t <= 0) continue;
    const o = other.get(t);
    const a = Number(b.close);
    if (o != null && Number.isFinite(o) && o > 0 && Number.isFinite(a)) {
      out.push({ time: t, a, b: o, ratio: a / o });
    }
  }
  return out;
}

// One-call harness context for a series. Returns the primitives plus
// ctxAt(i): the bar-causal view at 1h index i (completed k-blocks, the
// regime flag at i, and the ratio values visible at or before i).
function labContext(bars, opts = {}) {
  const k = opts.k && opts.k >= 2 ? Math.floor(opts.k) : 4;
  const blocks = toKBar(bars, k);
  const counts = bars.map((_, i) => Math.floor((i + 1) / k));
  const regime = regimeSeries(bars, opts);
  let ratio = null;
  let ratioCounts = null;
  if (Array.isArray(opts.ratioBars) && opts.ratioBars.length) {
    ratio = buildRatio(bars, opts.ratioBars);
    ratioCounts = bars.map((b) => visibleUpTo(ratio, timeMs(b.time)));
  }
  const ctxAt = (i) => {
    const j = Math.max(0, Math.min(bars.length - 1, Math.floor(i)));
    return {
      barsK: blocks.slice(0, counts[j]),
      regime: regime[j],
      ratio: ratio ? ratio.slice(0, ratioCounts[j]) : null,
    };
  };
  return { k, blocks, counts, regime, ratio, ratioCounts, ctxAt };
}

// Store rows ({barStart, openPrice?, high, low, closePrice}) -> trade shape.
function normalize(rows) {
  return (rows || []).map((b) => ({
    time: timeMs(b.barStart != null ? b.barStart : b.time),
    open: Number(b.openPrice != null ? b.openPrice : b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.closePrice != null ? b.closePrice : b.close),
  }));
}

module.exports = { timeMs, toKBar, visibleUpTo, regimeSeries, buildRatio, labContext, normalize };
