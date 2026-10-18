// trading/agent/geometryReplay.js — the geometry question, answered on PRICE PATHS instead of on outcomes.
//
// WHY THIS EXISTS. Measured 2026-09-28 (TRD-TP-1 #1412): the desk's realised payoff ratio is not a parameter
// at all. It chooses (a) a target at 1.5 x the DECLARED stop distance, pulled in 5% (= 1.425 x declared), and
// (b) a cap expressed as a % of PRICE that shortens the STOP ONLY. Their ratio IS the payoff ratio, so it is
// an OUTPUT — and across 10 live tickets the INTENDED ratio took five distinct values (1.425 when the cap was
// inert; 2.5-4.6 when it bound). Cost-inclusive break-even (p = (1 + c/r) / (1 + RR)) was 35.4% under the cap
// and 62.9% with it inert, against a realised win rate of 50%. So the desk is under its own break-even at the
// setting live now, and nothing in the record names the quantity doing it.
//
// WHY THE EXISTING EVIDENCE CANNOT SETTLE IT, AND WHY THIS CAN. `temp/sweep-stop-cap.js` realises the RECORDED
// P&L for every trade whose MAE sat inside the candidate cap, which means it HOLDS THE TARGET FIXED while
// varying the stop. Its "+18 to +20 from the cap" is therefore conditional on today's emergent geometry: move
// the target (option (b) below) and every trade's outcome changes, not just the stopped ones. The two dials
// are not independently tunable on that evidence.
//
// This module answers the joint question directly by walking the RECORDED PRICE PATH from the entry and asking
// which level was TOUCHED FIRST. The intra-bar order of high and low is not a modelling choice here — it is
// read off the ticks. MAE/MFE columns cannot do this (they are unordered extremes, and on some rows they are
// sourced from the close rather than the path — TRD-117's circularity).
//
//   (a) TARGET ON THE DECLARED DISTANCE    the current design. R:R emergent.
//   (b) TARGET ON THE EFFECTIVE DISTANCE   targetMultiple x the stop the venue actually got. R:R is a real,
//                                          named, stable parameter and the cap reverts to a pure risk dial.
//   (c) NO CAP AS A GEOMETRY DIAL          stop width and target multiple as two independent named dials.
//
// All three are the same call with different arguments: (a) is `targetOn: 'declared'`, (b) is
// `targetOn: 'risk'`, and (c) is (b) with `capPct: null`.
//
// PURE ON PURPOSE. No database, no clock, no I/O — so the ordering rules are pinned by tests instead of being
// inferred from a live run. The runner that loads real ticks is `trading/scripts/repro/geometry-grid.js`.
'use strict';

// A trade that touches neither level has to be closed eventually, and the horizon must be the SAME for every
// geometry under test — a longer path favours the target, so a per-geometry horizon would rig the comparison.
const DEFAULT_MAX_HOLD_MIN = 720; // 12h

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The two levels, from the four numbers a geometry is actually made of. `riskPct` is the stop as a % of the
// ENTRY PRICE (so it is symbol-independent); `targetMultiple` is the reward as a multiple of THAT SAME risk
// when targetOn='risk', or of the declared risk when targetOn='declared'.
//
// ⚠ THE DIRECTION SIGN IS APPLIED HERE AND NOWHERE ELSE. A short's target sits BELOW the entry and its stop
// ABOVE. Computing both as "entry +/- distance" and flipping later is how a replay silently becomes long-only.
function levels({ direction, entryPx, riskPct, targetMultiple, declaredRiskPct = null, targetOn = 'risk' }) {
  const dir = direction === 'buy' ? 1 : direction === 'sell' ? -1 : null;
  const entry = num(entryPx), r = num(riskPct), k = num(targetMultiple);
  if (!dir) return { ok: false, reason: 'direction_must_be_buy_or_sell' };
  if (!(entry > 0)) return { ok: false, reason: 'entry_must_be_positive' };
  if (!(r > 0)) return { ok: false, reason: 'risk_pct_must_be_positive' };
  if (!(k > 0)) return { ok: false, reason: 'target_multiple_must_be_positive' };
  if (targetOn !== 'risk' && targetOn !== 'declared') return { ok: false, reason: 'target_on_must_be_risk_or_declared' };
  // The reward base. Under (a) it is the DECLARED distance, which is exactly why capping the stop raises the
  // payoff ratio: the denominator shrinks and the numerator does not. That is the defect this module measures.
  const rewardBasePct = targetOn === 'declared' ? num(declaredRiskPct) : r;
  if (!(rewardBasePct > 0)) return { ok: false, reason: 'declared_risk_pct_required_when_target_is_declared' };
  const riskDist = (entry * r) / 100;
  const rewardDist = (entry * (rewardBasePct * k)) / 100;
  return {
    ok: true,
    dir,
    entryPx: entry,
    riskDist,
    rewardDist,
    riskPct: r,
    rewardPct: (rewardBasePct * k),
    targetOn,
    stopPx: entry - dir * riskDist,
    targetPx: entry + dir * rewardDist,
    payoffRatio: rewardDist / riskDist,
  };
}

// Walk one path and report which level was touched first.
//
// `path` is ascending by time: [{ at, mid }]. Points at or before `entryAt` are ignored — the position does not
// exist yet, and letting pre-entry ticks decide the outcome is the same class of error as measuring an
// excursion outside the holding window.
//
// ⚠ AND THE COARSE-STEP RULE IS NOT A BIAS TO BE PICKED SILENTLY. A step wider than the distance between the
// levels COULD have crossed both between samples, and their order is then unrecoverable. But a step from 100 to
// 108 with levels 3 apart DID cross the target and gives no evidence of a dip to the stop, so resolving every
// such step to the stop would systematically convert wins into losses and make the target look worse than it is
// — which is exactly as misleading as the permissive error, in the other direction. So the behaviour is a
// PARAMETER (`coarsePolicy`), the coarse count is always reported, and the runner measures BOTH. If a ranking
// survives both policies, the sampling cadence is not what produced it.
//
// ⚠ AND A LEVEL EXECUTES AT ITS LEVEL. The exit price is the stop or the target, not the mid of the sample that
// reported the breach: a 10s tick can sit well past the level, and booking that as the fill turns a stop into a
// smaller loss (or a gain) purely from sampling luck. Slippage is a separate question and is not modelled here.
function replayPath({
  direction, entryPx, entryAt, path, riskPct, targetMultiple,
  declaredRiskPct = null, targetOn = 'risk',
  costPct = null, maxHoldMin = DEFAULT_MAX_HOLD_MIN, coarsePolicy = 'observed',
} = {}) {
  const L = levels({ direction, entryPx, riskPct, targetMultiple, declaredRiskPct, targetOn });
  if (!L.ok) return { ok: false, reason: L.reason };
  if (!Array.isArray(path)) return { ok: false, reason: 'path_required' };

  const t0 = entryAt == null ? null : new Date(entryAt).getTime();
  if (t0 != null && !Number.isFinite(t0)) return { ok: false, reason: 'entry_at_unreadable' };
  const horizonMs = maxHoldMin == null ? null : Number(maxHoldMin) * 60000;

  const pts = [];
  for (const p of path) {
    if (!p) continue;
    const at = new Date(p.at).getTime();
    const mid = num(p.mid);
    if (!Number.isFinite(at) || !(mid > 0)) continue;
    if (t0 != null && at < t0) continue;
    if (horizonMs != null && t0 != null && at > t0 + horizonMs) break;   // path is ascending
    pts.push({ at, mid });
  }

  const crossedGap = L.riskDist + L.rewardDist;
  let ambiguous = 0;
  let prev = null;
  let last = null;
  for (const p of pts) {
    last = p;
    const hitStop = L.dir > 0 ? p.mid <= L.stopPx : p.mid >= L.stopPx;
    const hitTarget = L.dir > 0 ? p.mid >= L.targetPx : p.mid <= L.targetPx;
    if (hitStop) return finish('stop', p, false);
    if (hitTarget) {
      const coarse = prev != null && Math.abs(p.mid - prev.mid) >= crossedGap;
      if (coarse) {
        ambiguous++;
        if (coarsePolicy === 'stop') return finish('stop', p, true);
      }
      return finish('target', p, coarse);
    }
    prev = p;
  }
  // Nothing touched. The desk has a holding cap, and the horizon is the same for every geometry so a longer
  // path cannot favour a further target.
  if (!pts.length) {
    return { ok: true, outcome: 'no_data', ticks: 0, ambiguous: 0, coarse: false, holdMin: null, exitAt: null, exitPx: null, movePct: null, grossR: null, costR: null, netR: null, levels: L };
  }
  return finish('timeout', last, false);

  function finish(outcome, at, coarse) {
    const exitPx = outcome === 'stop' ? L.stopPx : outcome === 'target' ? L.targetPx : at.mid;
    const movePct = ((exitPx - L.entryPx) / L.entryPx) * 100 * L.dir;
    const grossR = movePct / L.riskPct;
    // The venue round trip is a fixed % of PRICE, so in R terms it is costPct/riskPct — the tighter the stop,
    // the more of the unit each trade costs. Charged ON EVERY TRADE, win or lose, which is why break-even is
    // not simply 1/(1+R).
    const costR = costPct == null ? null : Number(costPct) / L.riskPct;
    return {
      ok: true,
      outcome,
      coarse,
      ambiguous,
      ticks: pts.length,
      exitAt: new Date(at.at).toISOString(),
      exitPx,
      holdMin: t0 == null ? null : Math.round((at.at - t0) / 60000),
      movePct: +movePct.toFixed(6),
      grossR: +grossR.toFixed(6),
      costR: costR == null ? null : +costR.toFixed(6),
      netR: costR == null ? +grossR.toFixed(6) : +(grossR - costR).toFixed(6),
      levels: L,
    };
  }
}

// Break-even win rate including cost: a win pays k, a loss costs 1, and the round trip costs costPct/riskPct
// whichever way it goes.   E = p*k - (1-p)*1 - c/r = 0   =>   p = (1 + c/r) / (1 + k)
// Returned as a fraction. `null` when the inputs cannot support the question (a missing cost basis is
// IGNORANCE, not a zero cost — the permissive direction).
function breakevenWinRate({ targetMultiple, costShareOfR } = {}) {
  const k = num(targetMultiple), cr = num(costShareOfR);
  if (!(k > 0) || cr == null || cr < 0) return null;
  return (1 + cr) / (1 + k);
}

// The full cross product over one path. `stopScales` multiply the trade's DECLARED stop width, because that is
// the desk's own control (`atrStopMultiple`) and it keeps the grid symbol-independent; `capPct` applies the
// adverse-exit cap the way `stopPolicy` does — by SHORTENING the risk, never the reward.
function grid({ direction, entryPx, entryAt, path, declaredRiskPct, stopScales = [1], targetMultiples = [1], targetOn = 'risk', capPct = null, costPct = null, maxHoldMin = DEFAULT_MAX_HOLD_MIN, coarsePolicy = 'observed' } = {}) {
  const out = [];
  for (const scale of stopScales) {
    const declared = num(declaredRiskPct);
    if (!(declared > 0)) continue;
    let riskPct = declared * Number(scale);
    let cappedBy = null;
    if (capPct != null && Number(capPct) > 0 && riskPct > Number(capPct)) {
      riskPct = Number(capPct);
      cappedBy = 'cap';
    }
    for (const k of targetMultiples) {
      const v = replayPath({
        direction, entryPx, entryAt, path, riskPct, targetMultiple: k,
        // Under (a) the reward base is the DECLARED distance — with the cap applied to the STOP only, which is
        // the whole mechanism under test. Under (b) it is the risk the venue actually got.
        declaredRiskPct: declared, targetOn, costPct, maxHoldMin, coarsePolicy,
      });
      out.push({ stopScale: Number(scale), declaredRiskPct: declared, riskPct: +riskPct.toFixed(6), cappedBy, targetMultiple: k, ...v });
    }
  }
  return out;
}

// --- HOW MUCH OF A RANKING SURVIVES THE SAMPLE? ------------------------------------------------------
//
// WHY THIS IS HERE RATHER THAN IN THE RUNNER. A grid sweep picks the best of N cells on M trades, and on a
// sample of ~37 the argmax is substantially a maximum over noise. The fix is not a caveat in a comment: it is
// to resample the TRADES and report how often each cell actually wins, and how wide the interval around each
// mean is. That is arithmetic, so it belongs beside the arithmetic it summarises, where it can be tested.
//
// SEEDED ON PURPOSE. An unseeded bootstrap gives a different answer every run, which makes it impossible to
// tell a real change from a re-roll — the same defect the runner had when its horizon came from the clock.
// mulberry32 is a 3-line PRNG; the seed is an argument and the result is reproducible from it.

function seededRandom(seed) {
  let a = (Number(seed) || 1) | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values) {
  const v = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(Number(x)));
  if (!v.length) return null;
  return v.reduce((a, b) => a + Number(b), 0) / v.length;
}

// Linear-interpolated percentile of an ASCENDING array. `p` in [0,1].
function percentile(sorted, p) {
  const v = Array.isArray(sorted) ? sorted : [];
  if (!v.length) return null;
  const idx = (v.length - 1) * Math.min(Math.max(Number(p) || 0, 0), 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

// The bootstrap distribution of the MEAN of `values`, resampling the observations with replacement.
// Returns the observed mean beside the interval, because a CI without its point estimate invites the reader to
// treat the bound as the answer. `lo`/`hi` are the 100*alpha/2 and 100*(1-alpha/2) percentiles.
function bootstrapMeanCI(values, { trials = 4000, seed = 1, alpha = 0.05 } = {}) {
  const v = (Array.isArray(values) ? values : []).filter((x) => Number.isFinite(Number(x)));
  if (v.length < 2) return { n: v.length, mean: mean(v), lo: null, hi: null, trials: 0, seed };
  const rnd = seededRandom(seed);
  const means = new Array(trials);
  for (let t = 0; t < trials; t++) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[(rnd() * v.length) | 0];
    means[t] = s / v.length;
  }
  means.sort((a, b) => a - b);
  return {
    n: v.length,
    mean: mean(v),
    lo: percentile(means, alpha / 2),
    hi: percentile(means, 1 - alpha / 2),
    trials,
    seed,
  };
}

// WHICH CELL WINS, over and over. `entries` is [{ key, values }]. Each trial resamples the SAME trade indices
// across every entry — a PAIRED bootstrap — because the cells are not independent: they are the same trades
// under different geometry, and resampling them independently would throw away the pairing and widen the
// winner distribution into meaninglessness.
function bootstrapWinner(entries, { trials = 4000, seed = 1 } = {}) {
  const clean = (Array.isArray(entries) ? entries : [])
    .map((e) => ({ key: e && e.key, values: (e && Array.isArray(e.values) ? e.values : []).filter((x) => Number.isFinite(Number(x))) }))
    .filter((e) => e.values.length >= 2);
  if (!clean.length) return [];
  const n = Math.min(...clean.map((e) => e.values.length));
  const rnd = seededRandom(seed);
  const wins = new Map(clean.map((e) => [e.key, 0]));
  for (let t = 0; t < trials; t++) {
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = (rnd() * n) | 0;
    let bestKey = null, bestMean = -Infinity;
    for (const e of clean) {
      let s = 0;
      for (const i of idx) s += e.values[i];
      const m = s / n;
      if (m > bestMean) { bestMean = m; bestKey = e.key; }
    }
    wins.set(bestKey, wins.get(bestKey) + 1);
  }
  return clean
    .map((e) => ({ key: e.key, mean: mean(e.values.slice(0, n)), share: wins.get(e.key) / trials }))
    .sort((a, b) => b.share - a.share);
}

module.exports = { DEFAULT_MAX_HOLD_MIN, levels, replayPath, grid, breakevenWinRate, mean, percentile, bootstrapMeanCI, bootstrapWinner };
