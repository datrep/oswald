// trading/agent/expectancy.js — the retirement/accepance decision, as a pure function.
//
// WHY THIS REPLACES THE OLD RULE. `analytics.parityCheck` used to retire a strategy when
// `expectancy <= 0` OR when its win rate lagged the backtest by 20pp. Measured against the
// desk's own distribution (EVIDENCE_THRESHOLDS.md rev 2.2, §4):
//
//   * `expectancy <= 0` is a POINT ESTIMATE with no error control. For a strategy with exactly
//     zero edge the sample mean is negative about HALF the time — at every n, forever. It is not
//     a weak test, it is the absence of a test.
//   * the win-rate branch is not even reachable: parityCheck joins Trades.strategyId to
//     BacktestRuns.strategy by exact name, and both enabled strategies have no run (TRD-44).
//   * inside that branch, the false-fire rate is non-monotonic in backtest quality — a 55%
//     reference fires MORE often than a 50% one, because the win-count boundary is an integer.
//
// The union of the two came to ~51% false-retire at n=10 and stayed ~50% at n=50.
//
// WHAT THIS DOES INSTEAD. Tests the EDGE (mean R) with an explicit error budget, and has three
// states rather than two:
//
//   retire      the one-sided 95% UPPER bound on mean R is below zero — the data rules out a
//               non-negative edge and the strategy is removed
//   accept      the one-sided 95% LOWER bound is above zero — a positive edge survives
//   undecided   neither; keep observing. THIS STATE IS THE POINT: the old design had only
//               "live" and "retired", which is the same missing-middle that let
//               `parityValidated: true` sit there as a hand-set flag with nothing behind it.
//
// ALPHA SPENDING. The harness looks every ISO week, so a per-look 5% compounds against a
// strategy that stays break-even. The budget is therefore divided across the looks actually
// taken: z = normInv(1 - alpha/looks). This is Bonferroni over looks — CONSERVATIVE relative to
// Pocock or O'Brien-Fleming (which exploit the correlation between accumulating looks), so the
// practical effect is slightly stronger evidence required than those would demand. That
// direction is deliberate: an unknown-but-bounded conservative boundary is safer than an
// asserted table of constants nobody here has verified. As the desk ages, `looks` grows and the
// boundary tightens, which is exactly what repeated testing should do.
'use strict';

// --- inverse normal CDF (Acklam's rational approximation, |err| < 1.15e-9) -----
const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];

function normInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
}

// One-sided 95% Student-t quantiles, df = 1..30, then a sparse extension. At n=10 the normal z
// (1.645) is materially permissive versus t(9) = 1.833, and every boundary in
// EVIDENCE_THRESHOLDS.md was derived with t — so the implementation has to use t or it will not
// reproduce the numbers the report publishes.
const T1 = [NaN, 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753, 1.746, 1.740, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
const T1_EXT = { 31: 1.696, 32: 1.694, 35: 1.690, 40: 1.684, 45: 1.680, 49: 1.677, 50: 1.676, 60: 1.671, 80: 1.664, 99: 1.660, 100: 1.660, 120: 1.658, 199: 1.653, 200: 1.653 };
function tOneSided95(df) {
  if (!(df >= 1)) return NaN;
  if (df <= 30) return T1[df];
  return T1_EXT[df] != null ? T1_EXT[df] : 1.645;   // normal limit
}

// Sample sd (n-1). Returns NaN below 2 samples: dispersion is undefined, not zero.
function sampleSd(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
}

// GOTCHA, and the reason this helper exists: `Number(null) === 0` and `Number('') === 0`, so a
// bare `Number.isFinite(Number(v))` guard ACCEPTS a missing value. Here that would turn a trade
// with no stop into `risk = |100 - 0| * size`, a fabricated denominator that yields a confident
// but meaningless R. Reject absent values BEFORE coercing (same guard as agent/exitLevels.js).
function num(v) { return v == null || v === '' ? NaN : Number(v); }

// The R-multiple: pnl divided by the risk the trade ACTUALLY took (the fill-to-stop distance,
// not the intended one). Trades without a usable stop cannot produce an R at all and must be
// excluded and COUNTED — 11 of the desk's 25 closed trades are in that state (TRD-43), so any
// R-based test silently omits almost half the population unless it says so.
function rMultiple(t) {
  const pnl = num(t.grossPnl);
  const size = num(t.size);
  const open = num(t.openPrice);
  const stop = num(t.stopPrice);
  if (![pnl, size, open, stop].every(Number.isFinite)) return null;
  const risk = Math.abs(open - stop) * size;
  if (!(risk > 0)) return null;
  return pnl / risk;
}

function rStats(trades) {
  const rs = [];
  let noStop = 0;
  for (const t of trades) {
    const r = rMultiple(t);
    if (r == null) noStop += 1; else rs.push(r);
  }
  const meanR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN;
  return { n: rs.length, excluded: noStop, meanR, sdR: sampleSd(rs), rs };
}

// The verdict. `looks` = total planned/observed looks (see the alpha-spending note above).
//
// The critical value blends the two things that matter: the SMALL-SAMPLE quantile (t, exact for
// the n the desk actually has) and the SPENDING ratio from the repeated-look correction.
//
//   zEff = t(1-alpha, n-1) x [ normInv(1 - alpha/looks) / normInv(1 - alpha) ]
//
// At looks = 1 the ratio is 1, so zEff is exactly t — which is why this reproduces the published
// boundaries: n=10 -> -0.526R and n=50 -> -0.215R at sd 0.907R (asserted in
// test/expectancy.test.js). At looks > 1 the ratio tightens the boundary by the spending factor.
// That composition is an APPROXIMATION — proper repeated-look boundaries need the joint
// distribution of the sequential statistics, which is what Pocock/O'Brien-Fleming tabulate — but
// it errs conservative and, unlike an unverified table of constants, it is derived from two
// quantities that are exact here.
function expectancyVerdict({ n, meanR, sdR }, { alpha = 0.05, looks = 1, minTrades = 10 } = {}) {
  const L = Math.max(1, Math.floor(Number(looks) || 1));
  const zBase = normInv(1 - alpha);
  const spending = normInv(1 - alpha / L) / zBase;
  const tQ = tOneSided95(n - 1);
  const z = tQ * spending;
  if (!(n >= minTrades)) {
    return { state: 'insufficient', n, minTrades, looks: L, z, reason: `n=${n} below minTrades=${minTrades}` };
  }
  if (!Number.isFinite(meanR) || !Number.isFinite(sdR) || !(sdR > 0)) {
    return { state: 'insufficient', n, minTrades, looks: L, z, reason: 'no dispersion in the sample — sd is 0 or undefined' };
  }
  const se = sdR / Math.sqrt(n);
  const lower = meanR - z * se;
  const upper = meanR + z * se;
  const state = upper < 0 ? 'retire' : lower > 0 ? 'accept' : 'undecided';
  return {
    state, n, meanR, sdR, se, z, lower, upper, looks: L, alpha,
    // "retire if mean R < boundary" — the same quantity the thresholds doc tabulates.
    boundary: -z * se,
  };
}

// HOW MUCH DATA UNTIL THIS STRATEGY WOULD BE ACCEPTED OR RETIRED?
//
// TRD-41 asked the question this answers: not "what is the verdict today" but "would the evidence ever
// reach a verdict, and at what n". The scan RE-RUNS THE REAL VERDICT at each candidate n, using the
// observed mean and sd as if they were the population values, rather than solving a closed form that
// could drift from the rule the desk actually applies. The critical value depends on n (t does), so a
// formula would be the wrong tool anyway.
//
// WHAT THIS IS NOT. It is not a forecast. mean and sd estimated from 3-4 trades are themselves wildly
// uncertain, and holding them fixed is the strongest possible assumption: it says "IF this strategy's
// true edge and volatility are exactly what we have seen so far, THEN here is the n". The honest
// reading is a SCALE — "is this 30 trades away or 3000" — and the reason both directions are reported
// is that a strategy with a negative observed mean is approaching RETIREMENT, not acceptance.
//
// Monotonicity is why the scan can stop at the first hit: with mean and sd fixed, the interval
// tightens as sqrt(n), so once the lower bound clears zero it stays cleared, and likewise for the
// upper bound. If that ever stops holding, the returned n is simply the first crossing.
function requiredSample({ meanR, sdR }, { alpha = 0.05, looks = 1, minTrades = 10, cap = 5000 } = {}) {
  const m = num(meanR);
  const s = num(sdR);
  const start = Math.max(2, Math.floor(Number(minTrades) || 10));
  if (!Number.isFinite(m) || !Number.isFinite(s) || !(s > 0)) {
    return { acceptAt: null, retireAt: null, reason: 'mean R and a positive sd are both required' };
  }
  let acceptAt = null;
  let retireAt = null;
  for (let n = start; n <= cap; n += 1) {
    const v = expectancyVerdict({ n, meanR: m, sdR: s }, { alpha, looks, minTrades: start });
    if (acceptAt == null && v.state === 'accept') acceptAt = n;
    if (retireAt == null && v.state === 'retire') retireAt = n;
    if (acceptAt != null || retireAt != null) break;
  }
  return {
    acceptAt, retireAt,
    // 0 is not a special case, it is the dividing line: a non-positive mean can never clear a
    // positive lower bound, so acceptance is not merely far away, it is unreachable at ANY n.
    unreachable: m <= 0,
    reason: null,
    // The level at which a verdict (either way) is first reached, for a one-line summary.
    verdictAt: acceptAt != null ? acceptAt : retireAt,
    verdictKind: acceptAt != null ? 'accept' : retireAt != null ? 'retire' : null,
  };
}

// Win-rate lag is a DRIFT FLAG, not a retirement trigger (EVIDENCE_THRESHOLDS §5.2): it says the
// live regime is not the backtest regime, which is worth reporting and not worth acting on by
// itself. Returns null when there is no reference to compare against, and refuses DEGENERATE
// references — a run with 0 or 1 trades records winRate 0% / 100%, and against a 100% reference
// a strategy that genuinely wins 70% of the time would be "lagging" 61.7% of the time.
function driftFlag(liveWinRate, ref, { lagPp = 20, minRefTrades = 20 } = {}) {
  const refWin = num(ref && ref.winRate);
  const refTrades = num(ref && ref.trades);
  if (!ref || !Number.isFinite(refWin)) return { comparable: false, reason: 'no backtest reference found' };
  if (!Number.isFinite(refTrades) || refTrades < minRefTrades) {
    return { comparable: false, reason: `reference has only ${Number.isFinite(refTrades) ? refTrades : '?'} trade(s) — a rate from fewer than ${minRefTrades} cannot support a comparison` };
  }
  const live = num(liveWinRate);
  const lagging = Number.isFinite(live) && live < refWin - lagPp;
  return { comparable: true, refWinRate: refWin, refTrades, lagging, gapPp: Number.isFinite(live) ? live - refWin : NaN };
}

module.exports = { normInv, tOneSided95, sampleSd, num, rMultiple, rStats, expectancyVerdict, requiredSample, driftFlag };
