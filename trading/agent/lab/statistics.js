// trading/agent/lab/statistics.js — Strategy Lab statistics (TRD-14).
// The exact procedures from docs/trading-strategy-lab-plan-2026-09-10.md
// §Validation 5-6 + 10:
//   - trade-level CIRCULAR block bootstrap, block = 5 trades, 2,000 seeded
//     resamples (mulberry32, seed = 0xABCD + registration number);
//   - H0: PF <= 1; p-value = the BCa-adjusted fraction of resamples with
//     PF <= 1 (equivalently the level alpha at which the one-sided BCa lower
//     bound reaches 1); zero-loss resamples count as PF = +infinity; zero-trade
//     resamples are discarded and replaced;
//   - Benjamini-Hochberg, applied ONCE per release over the frozen family,
//     q = 0.10, plus the PRDS cross-correlation check recorded on the
//     scoreboard.
// Pure, deterministic, no I/O. Unit-tested against a synthetic edge/no-edge
// pair in test/lab-statistics.test.js.
'use strict';

// Seeded PRNG (identical to backtest.js monteCarlo's mulberry32).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal CDF (Abramowitz-Stegun 7.1.26 erf approximation).
function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

// Inverse normal CDF (Acklam's rational approximation, ~1e-9 accuracy).
function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  const pHigh = 1 - pl;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Cost-adjusted profit factor of a trade P&L list.
// Zero losses -> +Infinity (favors H1); no wins AND no losses -> null.
function profitFactor(nets) {
  let grossWin = 0;
  let grossLoss = 0;
  for (const v of nets) {
    if (v > 0) grossWin += v;
    else if (v < 0) grossLoss += -v;
  }
  if (grossLoss === 0) {
    if (grossWin > 0) return { pf: Infinity, grossWin, grossLoss };
    return { pf: null, grossWin: 0, grossLoss: 0 };
  }
  return { pf: grossWin / grossLoss, grossWin, grossLoss };
}

// Circular block bootstrap over trade P&L. Returns the observed PF, the
// resampled PFs, and the counts the BCa step needs.
function bootstrapPF(nets, { block = 5, resamples = 2000, seed = null } = {}) {
  const n = nets.length;
  if (!n) return { pfObs: null, pfs: [], countLe: 0, countLess: 0, discarded: 0, usedSeed: seed == null ? null : Number(seed) };
  const rng = mulberry32(seed == null ? Math.floor(Math.random() * 2 ** 31) : Number(seed));
  const { pf: pfObs } = profitFactor(nets);
  const b = Math.max(1, Math.min(Math.floor(block) || 5, n));
  const pfs = [];
  let countLe = 0;
  let countLess = 0;
  let discarded = 0;
  for (let r = 0; r < resamples; r++) {
    const sample = [];
    while (sample.length < n) {
      const start = Math.floor(rng() * n);
      for (let j = 0; j < b && sample.length < n; j++) sample.push(nets[(start + j) % n]);
    }
    const { pf } = profitFactor(sample);
    if (pf == null) { discarded++; continue; } // zero-trade outcome: discard + replace
    pfs.push(pf);
    if (pf <= 1) countLe++;
    if (pfObs != null && Number.isFinite(pfObs) && pf < pfObs) countLess++;
  }
  return { pfObs, pfs, countLe, countLess, discarded, usedSeed: seed == null ? null : Number(seed) };
}

// BCa-corrected one-sided p-value for H0: PF <= 1 (per §Validation 6).
// p = BCa-adjusted fraction of resamples with PF <= 1. Also returns the
// reported one-sided 5% BCa lower bound (readability, not a second gate)
// and the small-sample flag (20 <= n < 30).
function bcaPvalue(nets, opts = {}) {
  const n = nets.length;
  if (!n) return { p: null, n: 0, smallSample: false, pfObs: null, z0: null, a: null, f: null, ciLower: null, resamples: 0, note: 'no_trades' };
  const boot = bootstrapPF(nets, opts);
  const B = boot.pfs.length;
  if (!B) return { p: null, n, smallSample: n >= 20 && n < 30, pfObs: boot.pfObs, z0: null, a: null, f: null, ciLower: null, resamples: 0, note: 'no_valid_resamples' };
  const clip = (x) => Math.min(B / (B + 1), Math.max(1 / (B + 1), x));
  // f = P(PF* <= 1); p0 = P(PF* < PF_obs) -> bias correction z0.
  const f = clip(B ? boot.countLe / B : 0.5);
  const p0 = clip(boot.countLess / B);
  const z0 = normInv(p0);
  const zf = normInv(f);
  // Acceleration a from a delete-one jackknife over the candidate's trades.
  let a = 0;
  const jk = [];
  for (let i = 0; i < n; i++) {
    const rest = nets.slice(0, i).concat(nets.slice(i + 1));
    const { pf } = profitFactor(rest);
    if (pf != null && Number.isFinite(pf)) jk.push(pf);
  }
  if (jk.length > 1) {
    const mean = jk.reduce((s, x) => s + x, 0) / jk.length;
    const s2 = jk.reduce((s, x) => s + (x - mean) ** 2, 0);
    const s3 = jk.reduce((s, x) => s + (x - mean) ** 3, 0);
    const denom = 6 * s2 ** 1.5;
    if (denom > 0) a = s3 / denom;
  }
  // BCa-adjusted fraction of resamples with PF <= 1 (the p-value).
  const z = z0 + zf;
  const denom = 1 - a * z;
  const zAdj = Math.abs(denom) < 1e-6 ? z : z0 + z / denom;
  const p = Math.min(1, Math.max(1 / (B + 1), normCdf(zAdj)));
  // Reported one-sided 5% BCa lower bound (inverted form of the same test).
  const z05 = normInv(0.05);
  const a1 = clip(normCdf(z0 + (z0 + z05) / (1 - a * (z0 + z05) + 1e-12)));
  const sorted = [...boot.pfs].sort((x, y) => x - y);
  const idx = Math.min(B - 1, Math.max(0, Math.floor(a1 * (B - 1))));
  return { p, n, smallSample: n >= 20 && n < 30, pfObs: boot.pfObs, z0, a, f, ciLower: sorted[idx], resamples: B, note: null };
}

// Benjamini-Hochberg, one pass over a frozen family (q = 0.10).
// Returns the significant original indices plus each rank's threshold.
function bh(pValues, q = 0.10) {
  const m = pValues.length;
  const ranked = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  let cut = 0;
  const ranks = ranked.map((x, r) => {
    const threshold = ((r + 1) / m) * q;
    if (x.p <= threshold) cut = r + 1;
    return { p: x.p, i: x.i, rank: r + 1, threshold };
  });
  return { m, q, significant: ranked.slice(0, cut).map((x) => x.i), ranks };
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0; let sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n; const my = sy / n;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

// PRDS proxy check (per §Validation 8): pairs share the same calendar W4, so
// each pair's net P&L on the two halves of W4 are the cross-sectional
// replicates. Positive correlation = pairs that win in W4a also win in W4b ->
// consistent with PRDS. Weak/negative -> flag for owner review before BH.
function prdsCheck(pairs) {
  const xs = [];
  const ys = [];
  for (const p of pairs) {
    if (p && Number.isFinite(p.a) && Number.isFinite(p.b)) { xs.push(p.a); ys.push(p.b); }
  }
  const r = pearson(xs, ys);
  if (r == null) return { r: null, n: xs.length, flagged: false, note: 'insufficient pairs for the cross-correlation check' };
  return {
    r: Math.round(r * 10000) / 10000,
    n: xs.length,
    flagged: r <= 0,
    note: r > 0 ? 'positive cross-correlation across W4 halves — consistent with PRDS' : 'weak/negative cross-correlation across W4 halves — OWNER REVIEW required before BH',
  };
}

module.exports = { mulberry32, normCdf, normInv, profitFactor, bootstrapPF, bcaPvalue, bh, pearson, prdsCheck };
