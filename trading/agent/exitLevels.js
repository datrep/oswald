// trading/agent/exitLevels.js — the desk's venue-native stop / take-profit geometry.
//
// Extracted 2026-09-13 from wakePipeline.js so the RULE has ONE implementation and
// can be reconciled against what the venue actually received. Report S5: the venue
// TP/stop decided 4 of 7 day-one closes, so a reconciliation test that covers only
// the trailing rule covers 2 of 7 exits — the majority were decided by these levels.
//
// THE CONTRACT (verified exactly against all 7 day-one trades):
//     stop = anchor -/+ stopDist
//     TP   = anchor +/- 1.5 x stopDist
//   and therefore        |TP - stop| = 2.5 x stopDist
// The invariant is non-circular: it uses only the recorded levels plus the
// decision-time stop distance, so it pins both the 1.5 ratio AND that both levels
// share one anchor.
//
// 2026-09-19 (TRD-97): the 2.5x span holds while the stop is UNCAPPED. When
// `maxAdversePct` caps the stop, the span becomes cappedStopDist + 1.5 x declared,
// so the invariant must be evaluated against `declaredStopDist`, which the return
// value carries. A capped ticket still shares ONE anchor — only the down side moved.
//
// THE ANCHOR IS THE DECISION PRICE, NOT THE FILL — and that is the whole problem.
// Orders land 13-142 s later (measured 2026-09-11, including 45 s page.goto
// timeouts), so the fill re-prices both sides. The intended 1.5:1 became:
//     0.979 (Gold sell, filled 5.9 adverse: stop further, TP closer)
//     2.138 (Gold sell, filled favourable: stop closer, TP further)
// across the seven trades. Direction decides which way it drifts. So "the TP is at
// 1.5R" is true only at the decision price, and any exit-policy reasoning that
// assumes 1.5R geometry is reasoning about a number the trade never had.
'use strict';

// TP distance / stop distance. The desk's declared reward:risk.
const LEVEL_RR = 1.5;

// Venue-native levels from an anchor price. stopDist = 2xATR widened to the
// min-stop-to-spread floor by risk.js.
function entryLimits(direction, stopDist, px, tpDist) {
  if (!direction || !stopDist || !px) return { stopPrice: null, takeProfitPrice: null };
  const sign = direction === 'buy' ? 1 : -1;
  const reward = Number(tpDist) > 0 ? Number(tpDist) : LEVEL_RR * stopDist;
  return {
    stopPrice: +(px - sign * stopDist).toFixed(4),
    takeProfitPrice: +(px + sign * reward).toFixed(4),
  };
}

// The distance between the two levels, given a stop distance. The test invariant.
function levelSpan(stopDist, rr = LEVEL_RR) {
  const d = Number(stopDist);
  return Number.isFinite(d) ? (1 + rr) * d : null;
}

// GOTCHA (2026-09-13): Number(null) === 0 and Number('') === 0, so a plain
// Number.isFinite() guard ACCEPTS a missing fill and silently computes a geometry
// from a zero price. Reject absent values explicitly before coercing.
function num(v) { return v == null || v === '' ? NaN : Number(v); }

// Normalise an INBOUND exit level — the values on their way INTO the ledger — as opposed to the
// geometry helpers above, which read values already stored.
//
// TRD-43 (2026-09-14). Before this, `executor.openTrade` stored whatever the caller passed with
// `stopPrice != null ? Number(stopPrice) : null`. Two ways that lies:
//   * a level of 0 is FINITE and non-null, so it was stored as a real stop at zero. On a 4400
//     Gold position that makes the risk denominator 4400 x size, so every R-multiple comes out
//     ~0 and the desk reports a confident, meaningless risk metric;
//   * a non-numeric level became NaN and reached a SQL decimal column to fail there instead of
//     at the caller.
// Absent (null/undefined/'') -> { ok: true, value: null }, i.e. legitimately no level.
// Present but not a positive finite number -> { ok: false }, and the caller must refuse the order.
function level(v) {
  if (v == null || v === '') return { ok: true, value: null };
  // Booleans and objects are refused BEFORE coercion, because coercion accepts them for the wrong
  // reason: `Number(true) === 1`, so a JSON body of `{"stopPrice": true}` would otherwise be
  // stored as a stop at price 1 — finite, positive, and meaningless.
  if (typeof v === 'boolean' || typeof v === 'object') return { ok: false, value: null };
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? { ok: true, value: n } : { ok: false, value: null };
}

// THE AGENT ENTRY CONTRACT (TRD-43, 2026-09-14): an automated entry is only placeable when its
// levels can be expressed. `ok: false` is not a warning — the caller MUST refuse, because the
// alternative is an order with no stop and no take-profit, and `webtrader.placeOrder` only issues a
// venue SL/TP when at least one of them is non-null. That is not a wide stop; it is no stop.
//
// WHY THIS EXISTS RATHER THAN AN `if (atr && px)` AT THE CALL SITE: the old call-site guard left
// stopPrice null on the else path and placed the order anyway, so a data gap silently became an
// unbounded position and a ledger row that `rMultiple` returns null for — invisible to every
// R-based metric. A guard that leaves a usable-looking default behind is not a guard. This returns
// a REASON instead, so the caller has to say why it refused and the refusal is recorded.
//
// The `2 * atr` fallback matches risk.js exactly, so the distance used here is the distance the
// risk gate sized against.
// TRD-97 (2026-09-19): THE ASYMMETRIC LOSS CAP. `maxAdversePct` caps the STOP at that percentage of
// the decision price while leaving the TAKE-PROFIT at the declared 1.5 x (2xATR) distance.
//
// WHY ASYMMETRIC, AND WHY IT IS NOT A RETUNE. Measured 2026-09-18 over the 28 agent trades whose
// excursions were recorded: the average WINNER's worst adverse excursion is -0.079% and only 1 of 11
// winners ever went past -0.30%, while the average LOSER's best favourable excursion is +0.010% — i.e.
// the losers never go up at all. The population separates almost perfectly at -0.30%: 13 of 17 losers
// crossed it, 10 of 11 winners did not. So a 0.30% stop truncates the losers and keeps the winners, and
// leaving the TP where it is keeps the reward intact — which is the ONLY way the payoff ratio moves.
// Tightening both sides would just scale the trade down and change nothing.
//
// ⚠ WHAT THIS COSTS: these levels are part of a FROZEN forward-validation candidate (TRD-29 — survgold
// and survoil declare `params: []` and their §16.9 contract says any retuning voids the candidate), so a
// capped entry is annotated with `cappedBy` and logged as its own event. The forward track can therefore
// be split at the date this setting was enabled rather than quietly redefined.
//
// The declared distance is still what SIZING used (`risk.js`), so the dollar risk per trade FALLS by the
// same ratio instead of being re-levered back up by a smaller stop.
function entryLevels({ direction, atr14, price, stopDistance, maxAdversePct, takeProfitOffsetPct = 0, takeProfitAnchor = 'declared' } = {}) {
  const dir = direction === 'buy' || direction === 'sell' ? direction : null;
  if (!dir) return { ok: false, reason: 'direction_missing', stopPrice: null, takeProfitPrice: null, stopDist: null };
  const px = num(price);
  if (!(px > 0)) return { ok: false, reason: 'price_missing', stopPrice: null, takeProfitPrice: null, stopDist: null };
  const atr = num(atr14);
  if (!(atr > 0)) return { ok: false, reason: 'atr_missing', stopPrice: null, takeProfitPrice: null, stopDist: null };
  const requested = num(stopDistance);
  const declared = requested > 0 ? requested : 2 * atr;
  const capPct = num(maxAdversePct);
  const ceiling = capPct > 0 ? (px * capPct) / 100 : null;
  const stopDist = ceiling != null && ceiling > 0 ? Math.min(declared, ceiling) : declared;
  const cappedBy = stopDist < declared ? 'max_adverse_pct' : null;
  // ★★ THE TAKE-PROFIT OFFSET (owner ask 2026-09-25): GIVE UP A LITTLE REWARD TO BE FILLED.
  //
  // WHY IT EXISTS. The target sits at `LEVEL_RR x DECLARED` — 1.5R of the 2xATR the strategy declared — while
  // the STOP the venue receives is the capped one. So capping the stop does not just shrink the stop: it moves
  // the target from 1.5R to `LEVEL_RR x declared / stopDist` R, which on Gold is ~2.0R. A 2R target is reached
  // far less often than a 1.5R one, and the owner observed exactly that on a live Gold short: price came within
  // a hair of `close at profit` TWICE (about 18:00 and again around 23:00) without touching it, then bounced.
  // A booked win a few tenths short of the line beats a near-miss that becomes a loss.
  //
  // ⚠ ANNOTATED AND CARRIED, NOT APPLIED SILENTLY, for the reason the `cappedBy` annotation above exists: these
  // levels belong to a FROZEN forward-validation candidate (TRD-29), so a level change must be visible in the
  // record or the candidate's track is silently redefined. `takeProfitOffsetPct` travels on the result, and the
  // wake logs it when it binds, so the track can be split at the date the setting was enabled.
  //
  // ⚠ DEFAULT 0 — OFF. Switching it on changes the geometry of the two strategies the desk has a forward
  // record for, and that record is the reason they are trusted. It is a one-line settings change, deliberately
  // left to the owner rather than taken as a side effect of implementing it.
  const requestedOffset = num(takeProfitOffsetPct);
  const offsetPct = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.min(requestedOffset, 90) : 0;
  // ★★ ROUTE (2) — ANCHOR THE TARGET TO THE STOP THAT IS ACTUALLY PLACED (TRD-TP-1, 2026-09-28).
  //
  // THE DEFECT THIS ADDRESSES, measured on the desk's own trades and written into TRD-TP-1. Capping the stop
  // while the take-profit keeps `LEVEL_RR x DECLARED` does not merely shrink the stop — it moves the TARGET.
  // On Gold a capped ticket goes from 1.5R to ~2.0R, on Oil to 4.6-7.3R, and the measured consequence is a
  // target that is never reached: post-cap, the tickets at 3.0R or wider touched their target **0 times in 10**,
  // and 24 of 27 carried MORE than the 1.5R the strategy declared. Replayed on the 25 trades that actually ran
  // past 1.6R: at their real target (mean 3.63R) 16% touched, expectancy **-0.2598R**; at a true 1.5R target 48%
  // touched, expectancy **+0.2000R** — a **+0.46R per-trade swing**, on the trades where the cap is binding.
  //
  // ⚠ WHY THIS IS AN OPTION AND NOT THE NEW DEFAULT, IN THE CODE RATHER THAN IN A MESSAGE. These levels belong to
  // a FROZEN forward-validation candidate (TRD-29: survgold/survoil declare `params: []` and their contract says
  // any retuning VOIDS the candidate) — and that forward track is the only reason those two strategies are trusted.
  // So the switch ships OFF, exactly as the 5% offset did, and `takeProfitAnchor` travels on the result so the
  // track can be split at the date it was enabled. Flipping `risk.takeProfitAnchor` to `'placed'` is a one-line
  // settings change and it is the OWNER's to make, as TRD-TP-1 records.
  //
  // ⚠ AND NOTE WHAT ROUTE (2) MAKES OF THE OFFSET: the offset exists because the cap pushed the target out, and
  // that is the reason recorded above it. Under `'placed'` every ticket already carries the declared 1.5R, so the
  // offset becomes the patch-for-the-wrong-dial the measurement says it is (at k=1.5 it moves expectancy from
  // +0.1607R to +0.1259R, i.e. it makes it WORSE). The two are independent settings on purpose — turning this on
  // does not silently switch the offset off, because a silent change is the failure both of them guard against.
  const tpAnchor = takeProfitAnchor === 'placed' ? 'placed' : 'declared';
  const anchorDist = tpAnchor === 'placed' ? stopDist : declared;
  const declaredTpDist = LEVEL_RR * anchorDist;
  const tpDist = offsetPct > 0 ? declaredTpDist * (1 - offsetPct / 100) : declaredTpDist;
  const limits = entryLimits(dir, stopDist, px, tpDist);
  if (limits.stopPrice == null || limits.takeProfitPrice == null) {
    return { ok: false, reason: 'stop_distance_invalid', stopPrice: null, takeProfitPrice: null, stopDist: null };
  }
  return {
    ok: true, reason: null, stopPrice: limits.stopPrice, takeProfitPrice: limits.takeProfitPrice,
    stopDist, declaredStopDist: declared, cappedBy,
    capPct: cappedBy ? capPct : null,
    // The offset as APPLIED (0 when off, and clamped like the cap is), plus both target distances, so a reader
    // can recompute the geometry instead of inferring it from the RR alone.
    takeProfitOffsetPct: offsetPct,
    // ★ The ANCHOR the target was measured from, and the distance that gave. `declared` = the historic
    // behaviour; `placed` = route (2). Carried because the forward track has to be separable at the date the
    // setting changed, or TRD-29's candidate is quietly redefined — the same reason `cappedBy` above exists.
    takeProfitAnchor: tpAnchor,
    // ⚠ EXACT, not rounded — it is a COPY of either `stopDist` or `declaredStopDist`, both of which are published
    // exact. Rounding it made the record say the target was measured from 0.9581 while the stop beside it said
    // 0.95808, i.e. two numbers for one quantity, which is the defect class this file already documents twice.
    takeProfitAnchorDist: anchorDist,
    takeProfitDist: +tpDist.toFixed(4),
    declaredTakeProfitDist: +declaredTpDist.toFixed(4),
    // The realised reward:risk this ticket actually carries. Uncapped and unoffset it is LEVEL_RR; a capped stop
    // RAISES it and an offset LOWERS it, and the net number is what the chair should be reasoning about.
    // ⚠ Under `takeProfitAnchor: 'placed'` a capped stop NO LONGER raises it — that is the entire point of
    // route (2), and `effectiveRR` is the field that shows it moving back to LEVEL_RR.
    effectiveRR: +(tpDist / stopDist).toFixed(3),
  };
}

// What the geometry ACTUALLY was, measured from the fill rather than the anchor.
// Returns null when the levels are missing; rr is null when the stop is on the
// wrong side of the fill (a fill beyond the stop — a gap or a bad placement).
function realisedRR(direction, fillPrice, stopPrice, takeProfitPrice, intendedRR = LEVEL_RR) {
  const fill = num(fillPrice), stop = num(stopPrice), tp = num(takeProfitPrice);
  if (![fill, stop, tp].every(Number.isFinite)) return null;
  const sign = direction === 'buy' ? 1 : -1;
  const stopDist = (fill - stop) * sign;
  const tpDist = (tp - fill) * sign;
  if (!(stopDist > 0)) return { stopDist, tpDist, rr: null, intendedRR, driftPct: null };
  const rr = tpDist / stopDist;
  return {
    stopDist: +stopDist.toFixed(4),
    tpDist: +tpDist.toFixed(4),
    rr: +rr.toFixed(3),
    intendedRR,
    driftPct: +(((rr - intendedRR) / intendedRR) * 100).toFixed(2),
  };
}

// F20 (18/09): anchor at SUBMIT, not at the snapshot.
//
// The levels are computed from the price the DECISION used, at the top of a wake that can run two
// minutes, and the venue then fills at whatever price it finds. Both levels are ABSOLUTE, so a move of
// `shift` between decision and submit arrives in the position as a mis-anchored geometry: the stop
// distance and the reward distance are both measured from a price this position never had. #1046 came
// in at 0.22 R:R against a declared 1.5 because its anchor was 16 hours old (F1).
//
// Shifting BOTH levels by `shift = fresh - decision` is the whole fix, and it is exact: the span is
// preserved, so the geometry measured from the price the order will actually be priced from is the
// declared R:R again. No ATR read, no re-derivation, and the risk the desk sized for is unchanged.
//
// The one bound: once the market has travelled a FULL stop distance since the decision, this is no
// longer the trade that was deliberated — the desk refuses it rather than re-anchoring into a position
// whose stop is already at the money. Refusal is the available output here; repair is not.
//
// Direction is deliberately NOT a parameter: the shift is symmetric, and an operation that does not
// need to know which way the trade points cannot get it wrong.
function reanchorLevels({ stopPrice, takeProfitPrice, decisionPrice, freshPrice }) {
  const stop = level(stopPrice), tp = level(takeProfitPrice);
  const dec = level(decisionPrice), fresh = level(freshPrice);
  const nulls = { ok: false, stopPrice: null, takeProfitPrice: null, shift: null, shiftPct: null, stopDist: null, shiftInStops: null };
  // `level()` reports `ok:true, value:null` for an absent level (executor reads that as "no stop
  // declared", which is legitimate for a manual order). Here a null level is simply nothing to shift,
  // so it must be caught by VALUE and not by `ok` — the same `Number(null) === 0` trap TRD-43 named.
  if (!stop.ok || !tp.ok || stop.value == null || tp.value == null) return { ...nulls, reason: 'levels_missing' };
  if (!dec.ok || !fresh.ok || dec.value == null || fresh.value == null) return { ...nulls, reason: 'prices_missing' };
  const stopDist = Math.abs(dec.value - stop.value);
  if (!(stopDist > 0)) return { ...nulls, reason: 'stop_dist_zero' };
  const shift = fresh.value - dec.value;
  const shiftInStops = Math.abs(shift) / stopDist;
  const shiftPct = +((shift / dec.value) * 100).toFixed(4);
  if (Math.abs(shift) >= stopDist) return { ...nulls, reason: 'anchor_stale', shift, shiftInStops, shiftPct, stopDist };
  const nextStop = stop.value + shift, nextTp = tp.value + shift;
  if (!(nextStop > 0) || !(nextTp > 0)) return { ...nulls, reason: 'levels_non_positive', shift, shiftInStops, shiftPct, stopDist };
  return { ok: true, reason: null, stopPrice: nextStop, takeProfitPrice: nextTp, shift, shiftInStops, shiftPct, stopDist };
}

// TRD-ANC-1 (2026-09-25): THE GEOMETRY THE TICKET ACTUALLY CARRIES, MEASURED FROM THE VENUE'S FILL.
//
// The levels are anchored to the DECISION price, but the position opens at the venue's FILL. Both levels
// are ABSOLUTE, so the fill lands somewhere BETWEEN them and the reward:risk the trade carries is not the
// declared one. Measured 2026-09-25 on the 30 entries that recorded both: realised R:R ran 1.21 to 9.97
// against a declared 1.5, and no ticket carried 1.5R.
//
// READ-ONLY BY CONSTRUCTION. It returns numbers; it changes no level. That matters because these levels
// belong to a FROZEN forward-validation candidate (TRD-29) and moving them would void the track — so the
// observation has to be possible WITHOUT the change.
//
// ★ SIGN, DONE TWICE BECAUSE IT WAS GOT WRONG TWICE. `driftPct` is signed on PRICE, so its meaning flips
// with direction. `betterThanDecided` is the normalised one and POSITIVE ALWAYS MEANS FAVOURABLE.
// `slippagePct` elsewhere in this codebase does NOT mean that: its comment claims "positive = filled
// better", while its formula yields positive = ADVERSE for both directions (verified by evaluating it on
// a favourable buy and a favourable sell — both come out negative). Prefer this function's normalised
// field over that convention.
//
// `worseEntry` is the expensive direction: a fill WORSE than the anchor WIDENS the realised stop, because
// the stop is absolute — so the trade risks more than the size was computed against.
function fillDrift({ direction, anchorPrice, fillPrice, stopPrice, takeProfitPrice, intendedStopDist = null, driftWarnPct = 0.05 } = {}) {
  const dir = direction === 'buy' ? 1 : direction === 'sell' ? -1 : null;
  const anchor = num(anchorPrice), fill = num(fillPrice);
  const stop = num(stopPrice), tp = num(takeProfitPrice);
  if (!dir) return { ok: false, reason: 'direction_missing' };
  if (!(anchor > 0) || !(fill > 0)) return { ok: false, reason: 'prices_missing' };
  const drift = fill - anchor;
  const driftPct = (drift / anchor) * 100;
  // ★ FAVOURABLE IS DIRECTION-DEPENDENT AND THE MULTIPLIER IS `-dir`, NOT `dir`. A BUY wants to fill LOWER;
  // a SELL wants to fill HIGHER. Writing this as `drift * dir` — which is what the first draft of this
  // function did, and what `slippagePct` in executor.js does — inverts the sign on the sell side and makes
  // a favourable sell read as adverse. The unit test pins both directions for exactly this reason.
  const favourableDrift = dir > 0 ? -drift : drift;
  const betterThanDecided = (favourableDrift / anchor) * 100;
  const out = {
    ok: true, reason: null,
    anchorPrice: anchor, fillPrice: fill,
    drift: +drift.toFixed(6),
    driftPct: +driftPct.toFixed(6),
    betterThanDecided: +betterThanDecided.toFixed(6),
    worseEntry: betterThanDecided < 0,
    // The codebase's own WARN threshold for anchored_off_fill, so the two agree on what "drifted" means.
    beyondWarn: Math.abs(driftPct) > driftWarnPct,
    driftWarnPct,
  };
  const intended = num(intendedStopDist);
  // Without both levels the geometry is simply not measurable — reported as ABSENT rather than as zero.
  if (!(stop > 0) || !(tp > 0)) {
    return { ...out, realisedStopDist: null, realisedTpDist: null, realisedRR: null,
      stopDistPct: null, intendedStopDist: intended > 0 ? intended : null, stopDistRatio: null,
      stopOnWrongSide: null };
  }
  const realisedStopDist = (fill - stop) * dir;
  const realisedTpDist = (tp - fill) * dir;
  const rr = realisedStopDist > 0 ? realisedTpDist / realisedStopDist : null;
  return {
    ...out,
    realisedStopDist: +realisedStopDist.toFixed(6),
    realisedTpDist: +realisedTpDist.toFixed(6),
    // null and not 0 when the stop sits on the WRONG SIDE of the fill: the position is then not the one
    // that was decided on at all, and a ratio here would be meaningless — the same rule `realisedRR` uses.
    realisedRR: rr == null ? null : +rr.toFixed(4),
    stopDistPct: +((realisedStopDist / fill) * 100).toFixed(6),
    intendedStopDist: intended > 0 ? intended : null,
    stopDistRatio: intended > 0 && realisedStopDist > 0 ? +(realisedStopDist / intended).toFixed(4) : null,
    stopOnWrongSide: !(realisedStopDist > 0),
  };
}

// TRD-ANC-1 (2026-09-25): HOW OLD IS THE PRICE THE LEVELS WERE BUILT FROM?
//
// The levels are anchored to a snapshot price; the position opens at the venue's fill. Measured on the 30
// entries that recorded both: the anchor is **1-3 seconds old** when the snapshot is taken, but the fill
// lands a **median of 65s** later (max **524s**) — and the drift grows with that lag (|drift| median 0.016%
// in the youngest half against 0.043% in the oldest, Spearman rho +0.305, n=30).
//
// ★ AND THE RE-ANCHOR CANNOT HELP, because the series it reads has NO WRITER during that window: measured,
// **0 venue ticks were available between the anchor price and the fill in 30 of 30 entries**. The tick
// series is frozen between wakes, so "a later reading of the same series" does not exist to be taken.
//
// ★ ABSENCE IS GUARDED BEFORE COERCION. `Number(null) === 0` would report a zero-age anchor — the freshest
// possible price — for a trade with no timestamp at all. Absence is `null`, never 0.
function anchorAgeSec({ asOf, nowMs = Date.now() } = {}) {
  if (asOf == null || asOf === '') return null;
  const t = asOf instanceof Date ? asOf.getTime() : new Date(asOf).getTime();
  if (!Number.isFinite(t)) return null;
  const age = (Number(nowMs) - t) / 1000;
  // A NEGATIVE age means the clocks disagree, which is not a measurement of freshness — reported as absent.
  return age >= 0 ? +age.toFixed(3) : null;
}

// THREE-VALUED, deliberately the same shape `quant.pickTick` states for `allowedVenues`:
//   * absent / non-positive  -> **NOT GATED**. Exactly the pre-existing behaviour, which is what a flag
//     being off means. "A flag that is off must not change a single price."
//   * a positive number      -> gated at that many seconds.
// It REFUSES rather than clamping, because `risk.js`'s stated principle is that the desk vetoes rather
// than clamps — clamping "would quietly exceed the risk `riskPerTradePct` promised".
function anchorAgeGate({ anchorAgeSec: age, maxAgeSec } = {}) {
  const rawMax = maxAgeSec;
  const max = rawMax == null || rawMax === '' ? NaN : Number(rawMax);
  const rawAge = age;
  const a = rawAge == null || rawAge === '' ? NaN : Number(rawAge);
  if (!(max > 0)) return { gated: false, refuse: false, maxAgeSec: null, anchorAgeSec: Number.isFinite(a) ? a : null, reason: null };
  if (!Number.isFinite(a)) return { gated: true, refuse: false, maxAgeSec: max, anchorAgeSec: null, reason: 'age_unknown' };
  return { gated: true, refuse: a > max, maxAgeSec: max, anchorAgeSec: a, reason: a > max ? 'anchor_too_old' : null };
}

// TRD-EXE-15 (2026-10-01): IS THE TICK THE RE-ANCHOR CALLS "FRESH" ACTUALLY NEWER THAN THE DECISION?
//
// `reanchorLevels` shifts both levels by `freshPrice - decisionPrice`. That is correct arithmetic and it is why
// the control looks sound. The defect was never in the arithmetic — it is in the INPUT: `quant.js` builds the
// decision price from `ticks.latestTick`, and the executor then reads `latestTick` AGAIN for the "fresh" price.
// For an instrument the desk does not hold, no new tick is written in between (plus500's ticks come from
// `position_poll`, so they only exist for positions the desk already has), so both reads return the SAME ROW and
// the shift is 0 BY CONSTRUCTION. Measured 2026-10-01: 73 `entry_reanchored` events, 73 with `shift = 0`, against
// 74% adverse fills and a 1.083x realised/sized risk on the same entries.
//
// ⚠ UNKNOWN IS NOT STALE, AND THAT ASYMMETRY IS DELIBERATE. Only the positive case — a tick that is provably not
// newer — returns true. A missing `capturedAt`, a missing decision timestamp, or an unparseable date all return
// FALSE, which preserves the existing behaviour exactly. A helper that manufactured a refusal out of an absent
// field would turn a data gap into a failed entry path, which is a larger defect than the one it describes.
function staleTickForDecision(freshTick, decisionAsOf) {
  const raw = freshTick && freshTick.capturedAt ? new Date(freshTick.capturedAt) : null;
  const dec = decisionAsOf == null || decisionAsOf === '' ? null : new Date(decisionAsOf);
  if (!raw || !dec) return false;
  if (Number.isNaN(raw.getTime()) || Number.isNaN(dec.getTime())) return false;
  return raw.getTime() <= dec.getTime();
}

module.exports = { entryLevels, entryLimits, realisedRR, reanchorLevels, levelSpan, level, fillDrift, anchorAgeSec, anchorAgeGate, staleTickForDecision, LEVEL_RR };
