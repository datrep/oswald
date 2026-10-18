// trading/agent/stopPolicy.js — TRD-102 (2026-09-19): ONE stop distance, and the cost floor that guards it.
//
// WHY THIS MODULE EXISTS. TRD-98 put the adverse-exit cap in `wakePipeline` (to shape the venue stop) while
// `risk.js` kept SIZING against the uncapped declared distance. Two distances for one position is fine as
// arithmetic and wrong as accounting: `maxRiskPerTradePct` is applied to the declared distance, so the
// risk it reports is not the risk the venue will ever take. Measured on the first live entry under it
// (#1066, Oil): the label said 0.25% of equity, the position risked 0.026% — 11x less — and the error was
// PER SYMBOL, because the declared:capped ratio is Oil 4.7x and Gold 1.9x. That is the same defect class
// as TRD-96 and TRD-101: a number that does not mean what it says.
//
// So the cap is computed in ONE place and both callers use it: `risk.js` sizes against the capped
// distance, and the entry path sets the venue stop from the same capped distance. The declared distance is
// still carried, because the TAKE-PROFIT stays at 1.5 x declared — capping the stop and leaving the target
// where it was is what raises the reward:risk, and tightening both sides would only scale the trade down.
'use strict';

// The adverse cap must clear the symbol's own measured round trip, or it is a cost trap wearing a risk
// control's clothes. The costs are the calibration of record, read from the same model the backtester
// charges (`agent/backtest.costCfgFor` -> `venueComparability.roundTripBpsFromCfg`): Gold 11.94 bps,
// Oil 17.28, Bitcoin 25.00. A 0.30% cap is 2.5x Gold's round trip, 1.7x Oil's and only 1.2x Bitcoin's —
// and Bitcoin proved the point: rsi2's average favourable excursion was +0.038% against a 0.250% round
// trip, i.e. the charge was 6.6x the entire move the strategy ever made in its favour.
//
// FAILS SAFE in the only direction that adds no new risk: no cap means the DECLARED 2xATR stop, which is
// the behaviour that existed before this setting. `cost_unknown` is REPORTED, never assumed to be zero.
//
// ---------------------------------------------------------------------------------------------------
// TRD-114 (2026-09-21): THE COST FLOOR IS A SHARE OF R, AND IT ONLY EVER REFUSES — IT NEVER WIDENS.
//
// WHAT THIS GUARD ALWAYS MEANT: the venue round trip must not be a large part of the risk unit. WHAT IT
// SAID: `cap >= 1.5 x costPct`. Those are the same inequality (costPct/stopPct <= 1/1.5), so this dial
// ALREADY WAS a cost-share ceiling — of 66.7% — and nobody chose that number: it fell out of reading
// "1.5x" as a margin. Measured on the live book 2026-09-21, with maxAdversePct 0.30 the implied share of R
// is Gold 39.8%, Oil 57.6%, Bitcoin 83.3%, and trades 1066/1067 actually ran at 60.8% / 68.3% — the round
// trip was most of what those positions risked, and NOTHING read the number.
//
// ⚠ WHY THE CEILING REFUSES RATHER THAN FORCING A WIDER STOP, WHICH IS THE WHOLE DESIGN. Tightening the
// stop RAISES the cost share (the round trip is a fixed % of price, so it is a bigger % of a smaller R),
// so "keep cost share low" pulls in the OPPOSITE direction to TRD-98's cap. Both directions were measured
// on the recorded excursions (temp/sweep-stop-cap.js, temp/sweep-cost-share.js):
//     cap 0.30%  (live)  net -28.89   E -0.932/trade   payoff 0.719   <- the measured best
//     cap 0.40%          net -46.93   E -1.514/trade   payoff 0.612   <- a 30% ceiling's implied stop
//     no cap             net -72.15   E -2.327/trade   payoff 0.566
// Widening Gold's stop from 0.30% to the 0.398% a 30% ceiling demands would give back ~18 of the 43 the
// cap is worth. So the ceiling may NOT widen a stop: it can only refuse a trade whose risk unit is mostly
// cost, and the stop the venue receives stays exactly what TRD-98/TRD-102 decided.
//
// THE LEVEL IS THEREFORE BOUNDED BY THE MEASURED OPTIMUM, NOT CHOSEN FREELY: any ceiling below Oil's ~58%
// either refuses Oil outright or forces the wider stop above. `maxCostShareOfR` defaults to 0.65 — clear
// of every instrument on the book (Gold 39.8%, Oil ~60% capped) and therefore a guard against a cost basis
// BLOWING OUT (a widened spread, a mispriced instrument — the Sugar/Bitcoin class) rather than a filter.
// The derivation is in temp/sweep-cost-share.js; tightening it is a strategy decision, not a tuning one.
'use strict';

// The ceiling, as a share of the risk unit, and WHICH dial supplied it.
function costCeiling(settings) {
  const r = (settings && settings.risk) || {};
  const share = Number(r.maxCostShareOfR);
  if (Number.isFinite(share) && share > 0) return { share, from: 'maxCostShareOfR' };
  const mult = Number(r.maxAdverseCostMultiple ?? 1.5);
  const m = Number.isFinite(mult) && mult > 0 ? mult : 1.5;
  return { share: 1 / m, from: 'maxAdverseCostMultiple (legacy)' };
}

// The cost share of a stop, as a pure function of two percentages. Size does not appear — the notional
// cancels — which is why no amount of resizing can change this number, and why the only honest action on
// a breach is a refusal.
//
// ⚠⚠ PRESENCE IS CHECKED BEFORE COERCION, AND THAT IS THE WHOLE POINT OF THESE SIX LINES. `Number(null)`
// is 0, so coercing first turns "no cost basis" into a cost of ZERO — a 0% cost share, which passes every
// ceiling there is. The permissive direction is the wrong way to fail, and this is the FIFTH time this
// codebase has hit the same trap: TRD-108's `Number(null) === 0` invented a perfect fill, and
// expectancy.num, exitLevels and venueComparability each carry the same shape. Written by me, caught by
// the test that exists for exactly this case.
function costShareOf({ costPct, stopPct }) {
  if (costPct == null || costPct === '') return null; // "no basis" is a state, not a zero
  if (stopPct == null || stopPct === '') return null;
  const c = Number(costPct), s = Number(stopPct);
  if (!Number.isFinite(c) || !(s > 0)) return null;
  return c / s;
}

// The verdict, pure, so the ceiling's truth table is pinned by tests rather than inferred from a wake.
// `over: false` with a number is a fact worth recording; `null` means the cost basis was unknown.
function costShareCheck({ costPct, stopPct, settings }) {
  const ceiling = costCeiling(settings);
  const share = costShareOf({ costPct, stopPct });
  if (share == null) return null;
  return {
    share: +share.toFixed(4),
    ceiling: ceiling.share,
    from: ceiling.from,
    over: share > ceiling.share + 1e-9,
  };
}

function adverseStopCap(settings, symbol) {
  const cap = Number(settings && settings.risk && settings.risk.maxAdversePct);
  if (!Number.isFinite(cap) || cap <= 0) return { pct: null, costPct: null, floor: null, note: null };
  const mult = Number((settings.risk && settings.risk.maxAdverseCostMultiple) ?? 1.5);
  const m = Number.isFinite(mult) && mult > 0 ? mult : 1.5;
  let rtBps = null;
  try {
    const cfg = require('./backtest').costCfgFor(symbol);
    rtBps = require('./venueComparability').roundTripBpsFromCfg(cfg);
  } catch { rtBps = null; }
  if (!Number.isFinite(rtBps)) {
    return {
      pct: null, costPct: null, floor: null,
      note: `stop cap ${cap}% REFUSED for ${symbol}: no round-trip cost basis, so the cap cannot be shown to clear cost — using the declared stop`,
    };
  }
  const costPct = rtBps / 100;
  const floor = costPct * m;
  if (cap < floor) {
    return {
      pct: null, costPct, floor,
      note: `stop cap ${cap}% REFUSED for ${symbol}: round trip is ${costPct.toFixed(4)}% and the floor is ${m}x that (${floor.toFixed(4)}%) — using the declared stop`,
    };
  }
  return {
    pct: cap, costPct, floor,
    note: `${cap}% cap clears ${symbol}'s ${costPct.toFixed(4)}% round trip by ${(cap / costPct).toFixed(2)}x`,
  };
}

// The single place the declared distance becomes the stop the venue will actually receive.
// Returns BOTH, so a caller can size against `stopDist` (the real risk unit) and still place the
// take-profit at 1.5 x `declaredStopDist`.
//
// TRD-114: `costShare` (the round trip as a share of the effective risk unit) and the `ceiling` it must
// stay under travel with the distance, so the risk gate refuses on the SAME number this function produced
// and the two cannot drift — the lesson TRD-102 was written for.
function cappedStopDistance({ declaredStopDist, price, settings, symbol } = {}) {
  const declared = Number(declaredStopDist);
  const px = Number(price);
  const cap = adverseStopCap(settings, symbol);
  const ceil = costCeiling(settings);
  const share = (stopDist) => (cap.costPct != null && px > 0 && stopDist > 0
    ? +(cap.costPct / ((stopDist / px) * 100)).toFixed(4) : null);
  if (!cap.pct || !(declared > 0) || !(px > 0)) {
    return {
      stopDist: declared, declaredStopDist: declared, cappedBy: null, capPct: null, costPct: cap.costPct,
      ceiling: ceil.share, ceilingFrom: ceil.from, costShare: share(declared), note: cap.note,
    };
  }
  const ceilingDist = (px * cap.pct) / 100;
  const stopDist = Math.min(declared, ceilingDist);
  return {
    stopDist, declaredStopDist: declared,
    cappedBy: stopDist < declared ? 'max_adverse_pct' : null,
    capPct: cap.pct, costPct: cap.costPct, note: cap.note,
    ceiling: ceil.share, ceilingFrom: ceil.from,
    // cost as a share of the risk unit — the number the sweep showed has an interior optimum, and the one
    // TRD-114 found NO rule reading. It is returned whether or not the cap bound, so a study can read it.
    costShare: share(stopDist),
  };
}

module.exports = { adverseStopCap, cappedStopDistance, costCeiling, costShareOf, costShareCheck };
