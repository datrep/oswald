'use strict';
// trading/agent/slipDerivation.js — TRD-114: the slippage term, DERIVED from the desk's own fills.
//
// ★★ THE DEFECT THIS REPLACES. `CALIBRATED_SLIP_PCT = 0.05` is a FLAT placeholder charged per side on top of the
// spread, for every symbol, with the comment "placeholder until fill telemetry matures". It is **84% of Gold's
// modelled round-trip budget** (10.00 bps of 11.94) and it has never been measured.
//
// ★ THE MEASUREMENT THAT SETTLES IT. `executor.js` records `slippagePct = (fill - decisionPrice)/decisionPrice`,
// signed POSITIVE = adverse, and `quant.js` records whether `decisionPrice` was a mid (`priceSource: 'tick'`) or a
// bar close. Comparing that field against the venue's own ticket spread (`spreadSubmitPct`, a ROUND TRIP) over 120
// days of real entries:
//
//   symbol      n    slip med%   half-spread med%   slip / half-spread
//   Gold       21      0.0100          0.0097              0.96
//   Silver     37      0.0600          0.0592              0.96
//   Ethereum   30      0.1100          0.1250              0.88
//   Sugar       8      0.0700          0.0718              0.98
//   Soybeans    6      0.0700          0.0476              1.47
//   Oil        30      0.0200          0.0397              0.52
//   Bitcoin     5      0.0100          0.0750              0.13
//
// THE RATIO IS ~1. So the "slippage" the desk measures IS THE SPREAD CROSSING. The decision price is a mid, the
// fill lands at the touch, and the distance between them is exactly the half-spread the model already charges.
// There is no second, independent cost — which means the flat 0.05 is charged for a movement that the spread term
// has already been charged for.
//
// ⚠⚠ SO THE TWO TERMS MUST NOT SIMPLY BE SWAPPED. Charging the measured 0.01 for Gold as `cfdSlippagePct` would
// charge the half-spread TWICE, on top of a spread term that already contains it. What the model wants is the
// residual BEYOND the touch:
//
//     residual = measured_slippage - half_spread
//
// and, when that is negative, the fill landed INSIDE the spread: the cost is ZERO, not negative. A negative cost is
// the most permissive budget this codebase can express — the `Number(null) === 0` failure arriving by subtraction.
// The raw median is retained on every result so the zeroing is visible rather than silent.
//
// ⚠ AND IT IS SCOPED TO SYMBOLS THE DESK ACTUALLY TRADES. `n` here is per symbol and small (Gold 21, Soybeans 6), so
// the floor is 20 and a symbol below it is REFUSED by name rather than priced from six fills. A refusal keeps the
// curated 0.05, which is wrong but STATED; a thin measurement silently promoted to a constant is how 0.05 got here.
//
// PURE: no DB, no clock, no settings. A caller passes fill rows; a caller applies the result.

const UNIT = 'pct_of_price_per_side';
const COVERS = 'slippage_beyond_the_spread';
const MIN_FILLS = 20;

// ⚠ `Number(null) === 0` AND `Number('') === 0`. This helper exists because a FIRST version of this file used the
// plain coercion and turned an ABSENT `slippagePct` into a measured 0.00, which then subtracted a half-spread and
// produced a NEGATIVE cost — the most permissive budget this codebase can express, arriving through the helper that
// was supposed to guard it. The test caught it; the guard is the `v == null` check.
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round6 = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);
function median(values) {
  const s = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ONE fill -> the cost the model has NOT already charged. `spreadRoundTripPct` is `spreadSubmitPct`, which is a round
// trip, so the half is `/2`. Null when either side is absent — an unmeasured fill is not a zero.
function residualPct({ slippagePct, spreadRoundTripPct } = {}) {
  const slip = num(slippagePct);
  const rt = num(spreadRoundTripPct);
  if (slip == null || rt == null || rt <= 0) return null;
  return slip - rt / 2;
}

// MANY symbols: group, compute the median residual per symbol, floor at zero, refuse thin samples by name.
function deriveSlipBasis(rows, { minN = MIN_FILLS } = {}) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const s = r && r.symbol != null ? String(r.symbol) : null;
    if (!s) continue;
    const res = residualPct(r);
    if (res == null) continue;
    if (!by.has(s)) by.set(s, []);
    by.get(s).push(res);
  }
  const basis = {};
  const results = [];
  const refused = {};
  for (const [symbol, residuals] of by) {
    const rawMedianPct = round6(median(residuals));
    const base = { symbol, n: residuals.length, rawMedianPct, unit: UNIT, covers: COVERS, minN };
    if (residuals.length < minN) {
      results.push({ ...base, ok: false, reason: 'below_min_fills', pct: null });
      if (!refused.below_min_fills) refused.below_min_fills = [];
      refused.below_min_fills.push(symbol);
      continue;
    }
    // A NEGATIVE RESIDUAL IS A REAL OBSERVATION (the fill landed inside the spread) AND CANNOT BE A COST.
    const pct = Math.max(0, rawMedianPct);
    basis[symbol] = { pct, n: residuals.length, rawMedianPct };
    results.push({ ...base, ok: true, pct });
  }
  results.sort((a, b) => b.n - a.n);
  return { minN, basis, results, refused };
}

module.exports = { UNIT, COVERS, MIN_FILLS, residualPct, deriveSlipBasis, median };
