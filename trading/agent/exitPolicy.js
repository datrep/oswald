// trading/agent/exitPolicy.js — TRD-EXI-1 (#1490): the floor under a "cut before the stop" exit.
//
// WHY THIS EXISTS, IN ONE LINE OF ARITHMETIC. The desk closes positions when the price approaches the stop,
// on the reasoning that the stop is about to be hit. Measured over 25 such cuts (2026-09-30, from the records
// `autopsy.classifyClose` now keeps): the cut is RIGHT 14 times and WRONG twice - and it still loses money,
// because a CORRECT cut saves only what the stop has not yet taken, while a WRONG cut forfeits the whole target.
//
//     a correct cut SAVES  ~0.158R     (0.25% proximity band / the trade's R)
//     a wrong cut COSTS    ~2.70R      (the target, which the VENUE would really have booked - it carries the TP)
//     break-even hit rate  2.70/(2.70+0.158) = 94%   against an observed 14/16 = 87.5%
//     expectancy           0.875 x 0.158 - 0.125 x 2.70 = -0.20R per cut
//
// ★ THE FIX IS NOT TO STOP CUTTING, IT IS TO STOP CUTTING WHERE IT BANKS ALMOST NOTHING. A cut that saves `s`
// needs a hit rate of `tpR/(tpR+s)`: at s = 0.158R that is 94% (it loses), at s = 0.50R it is 81% (it wins). So a
// floor on the SAVING converts a losing rule into a paying one without pretending the review has no judgement.
//
// ⚠ AND IT IS NOT A DUPLICATE OF THE STOP. A cut 0.16R inside the stop does not ADD protection - it REPLACES a
// level the position was already sized against, which is the same defect the trailing-stop report describes from
// the other side (a trail tighter than the stop fires first and the recorded R stops meaning what it meant).
'use strict';

// The saving below which a near-stop cut is refused. 0.3 SAT ABOVE the break-even (pooled s* ~= 0.18R) and the
// entire observed range of savingR (0.101-0.299 across 17 refusals => the control was inert): lowered 0.3 -> 0.20
// at the T2 boundary 2026-10-08 per TRD-EXI-1c Sec 3.1. The live settings key is authoritative; this default
// keeps a fresh seed consistent. The Sec 3.3 window (first 25 permitted cuts, or 30 trading days) starts at the
// settings write.
const DEFAULT_MIN_CUT_SAVING_R = 0.2;

// ⚠ `Number(null)` IS 0 and `Number('')` IS 0, so a missing stop would arrive as a plausible ZERO and produce a
// confident verdict from nothing. Third time this class has appeared in this workstream; it is guarded here.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// WHAT A MARKET CUT AT `price` WOULD ACTUALLY BANK, in R.
// The loss taken is `(price - entry)` and letting the stop have it costs exactly 1.0R, so the saving is the gap
// between them - which is simply the price's distance from the stop, over R. Direction-free by construction.
function cutSavingR({ entry, stopPrice, price }) {
  const e = num(entry);
  const s = num(stopPrice);
  const p = num(price);
  if (e == null || s == null || p == null) return null;
  const r = Math.abs(e - s);
  if (!(r > 0)) return null;
  return +(Math.abs(s - p) / r).toFixed(4);
}

// The gate. `unjudged` is a real answer: with no readable price the desk cannot say what the cut saves, so it
// does NOT refuse - but it SAYS it could not judge, because an inert control that reports nothing is the defect
// class this desk keeps re-finding. The suppression is recorded, and `savingR` is recorded with it, so the floor
// itself can be tuned from the same records it produces.
function gateNearStopCut({ entry, stopPrice, price, minSavingR = DEFAULT_MIN_CUT_SAVING_R }) {
  const floor = num(minSavingR) != null && num(minSavingR) >= 0 ? num(minSavingR) : DEFAULT_MIN_CUT_SAVING_R;
  const savingR = cutSavingR({ entry, stopPrice, price });
  // a floor of 0 is an explicit OFF switch, and it must be honoured rather than treated as a missing value
  if (floor === 0) return { refuse: false, savingR, minSavingR: floor, reason: 'disabled' };
  if (savingR == null) return { refuse: false, savingR: null, minSavingR: floor, reason: 'unjudged' };
  if (savingR < floor) return { refuse: true, savingR, minSavingR: floor, reason: 'saving_below_floor' };
  return { refuse: false, savingR, minSavingR: floor, reason: null };
}

// ── TRD-EXI-1b (#1490): THE REFUSAL SIDE OF THE SAME ARITHMETIC ─────────────────────────────────────────────
// Every number in the header above is built from cuts the desk TOOK. A cut the floor REFUSES produces no close,
// so no autopsy, so no counterfactual — which made the refusals the ONE population the floor could never be
// checked against. The floor was therefore justified by the 25 cuts that got through, and said nothing at all
// about the ones it now declines: the same unmeasurable position this task started from, moved one step along.
// The two functions below turn a refusal into a number. The recording and the replay live beside the autopsy,
// because they need the tick feed and these two do not.

// A refusal is identified by the TRADE and the INSTANT, not by the trade. The chair proposes a close on EVERY
// review, so a position that sits near its stop for an hour produces several refusals at different prices — and
// each of those is a separate decision that has to be judged at the price it was actually made at. A trade-level
// id would silently merge them into one and let the earliest price stand for all of them.
function refusalIdFor(tradeId, at) {
  const ms = new Date(at).getTime();
  return `${tradeId}-${Number.isFinite(ms) ? ms : 'invalid'}`;
}

// WHAT THE REFUSAL WAS WORTH, in R.
//
// The cut that was refused would have banked `-(1 - savingR)`: the stop costs 1.0R and the cut stops short of it
// by exactly the saving. Holding then produced whatever it produced — the real close when there is one, the mark
// at the end of the window when there is not. The difference IS the value of the refusal, signed so that a
// POSITIVE number means refusing was right. Two identities are worth stating because they are the sanity check on
// any tally built from this, and both are pinned by a test:
//
//     the venue stopped the position out   -> held = -1     -> value = -savingR       (refusing cost the saving)
//     the venue booked the target          -> held = +tpR   -> value = +tpR + 1 - s   (refusing kept the swing)
//
// ⚠ `savingR` of 0 is a REAL value (the price sitting exactly on the stop), so 0 must survive as 0 and not fall
// back to a default — the same discipline the floor's own OFF switch needs.
function refusalOutcomes({ entry, stopPrice, takeProfitPrice, savingR, heldOutcomeR }) {
  const e = num(entry);
  const s = num(stopPrice);
  const t = num(takeProfitPrice);
  const sv = num(savingR);
  const held = num(heldOutcomeR);
  const r = e != null && s != null ? Math.abs(e - s) : null;
  if (r == null || !(r > 0) || sv == null) return { cutOutcomeR: null, tpR: null, refusalValueR: null };
  const cutOutcomeR = +(-(1 - sv)).toFixed(4);
  const tpR = t != null ? +(Math.abs(t - e) / r).toFixed(4) : null;
  const refusalValueR = held == null ? null : +(held - cutOutcomeR).toFixed(4);
  return { cutOutcomeR, tpR, refusalValueR };
}

module.exports = { cutSavingR, gateNearStopCut, DEFAULT_MIN_CUT_SAVING_R, refusalIdFor, refusalOutcomes };
