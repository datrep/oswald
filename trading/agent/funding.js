// trading/agent/funding.js — TRD-45 Phase 3: is the venue's STATED carry what it actually charged?
//
// WHY. Phase 1 captured the venue's own overnight-funding rates (Gold spot: buy -0.0319%/night, sell
// -0.0120%/night). Phase 2 put them into the cost model and in front of the chairs. Neither of those
// checked them against reality, because reality was recorded nowhere: `grossPnl` is the venue's NetPL,
// which arrives ALREADY reduced by its "Actual adjustments" (funding), so the carry was folded into
// the P&L and the number itself was lost.
//
// The sign convention was settled from eleven venue-closed trades and the MAGNITUDE from exactly one,
// which is corroboration, not validation. This module is the validation: it predicts the charge from
// (nights held x the venue's stated per-side rate x notional) and compares it with what the venue
// actually took.
//
// WHAT A DISAGREEMENT MEANS, AND WHAT IT DOES NOT. The rate is set per instrument PER DAY, so a
// prediction made from a rate captured on a different day is EXPECTED to differ — #1027 realised
// 1.246x its stated-rate prediction and that is not a defect, it is a rate that moved. So the
// verdicts are deliberately coarse:
//   convention_violation   nights = 0 but the venue charged something (or vice versa) — the NIGHTS
//                          model is wrong for this row, which is a hard error because the whole
//                          model is "carry accrues per calendar night".
//   sign_mismatch          a charge predicted from a positive rate, or a credit from a negative one.
//                          A SIGN error is the one failure that silently inverts every cost.
//   magnitude_off          |actual / predicted| outside [0.2, 5]. A rate that moved is 1.2x; a
//                          misparse or a wrong notional basis is 10x or 100x.
//   within_range           everything else — and the RATIO is reported anyway, because the right use
//                          of many small imbalances is a bias estimate, not a verdict per row.
// The ratios accumulate into a running bias (see `fundingVariance().bias`) so the stated rate can be
// corrected from evidence rather than assumed. That is the point of storing the actual: not to score
// each row, but to stop the rate being taken on faith.
'use strict';

const { nightsBetween, crossingsOfDailyInstant, parseFundingTimeLocal } = require('./time');
// The one absent-rejecting coercion (plus500/instrumentSpec). `Number(null) === 0` would make an
// absent rate a FREE night and an absent notional a zero charge — both of which look like clean data.
const { num } = require('../plus500/instrumentSpec');

const VERDICT = {
  NO_CARRY: 'no_carry',
  EXEMPT: 'exempt',
  CONVENTION_VIOLATION: 'convention_violation',
  SIGN_MISMATCH: 'sign_mismatch',
  MAGNITUDE_OFF: 'magnitude_off',
  WITHIN_RANGE: 'within_range',
  UNTESTABLE: 'untestable',
};

const MAG_LOW = 0.2;
const MAG_HIGH = 5;
// The venue states adjustments in MONEY TO 2 DECIMALS, so any charge below half a cent is literally
// indistinguishable from no charge. Without this floor a small position (0.001 BTC held one night is
// about 2.5 cents at the stated rate) reports a CONVENTION_VIOLATION for a charge the venue rounded
// away, and the ratio tests divide by a number the venue cannot display. Falsely calling a correct
// row a defect is worse than not testing it: it teaches the operator to ignore the check.
const MATERIAL = 0.005;

// The notional the venue charges on. It bills a percentage of POSITION VALUE, and the two candidate
// bases (entry fill, exit fill) differ by the trade's own excursion — for #1027 that is 802.5 vs
// 806.6, i.e. 0.5%, which is far inside the noise. The ENTRY fill is used because it is the one the
// position was sized on and the one the desk records first.
function notionalOf(row) {
  const size = num(row && row.size);
  const open = num(row && row.openPrice);
  if (!Number.isFinite(size) || !Number.isFinite(open)) return null;
  return Math.abs(size * open);
}

// nights held, from the row itself rather than from a caller's clock: `swapNights` is written at close
// time under the convention in force THEN, and recomputing it now would silently re-interpret history
// if the convention changes again (it already did once — TRD-25).
//
// BUT the stored count is only as good as the convention that produced it, and the FIRST real row this
// validator could test showed the stored convention was wrong: Trades #29 crosses no UTC midnight yet
// the venue charged 0.31, because the venue bills at ITS OWN overnight-funding clock time (5:00 AM,
// published per instrument) rather than at midnight. So when the caller knows that instant, it wins
// over the stored count — the stored number is a historical record, not a better answer.
function nightsOf(row, { fundingMinuteUtc = null } = {}) {
  if (Number.isFinite(Number(fundingMinuteUtc)) && row && row.openAt && row.closeAt) {
    return crossingsOfDailyInstant(row.openAt, row.closeAt, Number(fundingMinuteUtc));
  }
  const stored = num(row && row.swapNights);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  if (!row || !row.openAt || !row.closeAt) return null;
  return nightsBetween(row.openAt, row.closeAt);
}

// What the venue SHOULD charge, as a POSITIVE cost (a credit comes back negative). Null when there is
// no rate to predict from — which is not the same as zero, and the caller's verdicts depend on the
// difference.
function predictFunding({ direction, nights, notional, ratePct } = {}) {
  const n = num(nights);
  const v = num(ratePct);
  const notionalN = num(notional);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return 0; // zero nights is exactly zero carry, whatever the rate says
  if (!Number.isFinite(v) || !Number.isFinite(notionalN)) return null;
  return notionalN * (v / 100) * n;
}

// One row in, one verdict out. Pure.
function fundingCheck(row, { ratePct = null, fundingMinuteUtc = null } = {}) {
  const r = row || {};
  const nights = nightsOf(r, { fundingMinuteUtc });
  const notional = notionalOf(r);
  const actualRaw = num(r.fundingCost);
  // ABSENT `fundingCost` IS NOT A ZERO CHARGE. A row the desk closed itself has no venue adjustment to
  // read, and treating that as "cost nothing" would report the desk's own closes as free to hold.
  const hasActual = Number.isFinite(actualRaw);
  // The venue displays funding as a NEGATIVE number meaning "you paid", so the COST is its negation.
  const actualCost = hasActual ? -actualRaw : null;
  const rate = Number.isFinite(num(ratePct)) ? num(ratePct) : null;
  const predicted = predictFunding({ direction: r.direction, nights, notional, ratePct: rate });

  const base = {
    tradeId: r.id != null ? r.id : null,
    symbol: r.symbol || null,
    direction: r.direction || null,
    source: r.fundingSource || null,
    nights,
    notional,
    ratePct: rate,
    predictedCost: predicted,
    actualCost,
  };

  if (hasActual && r.fundingSource && r.fundingSource !== 'venue_actual') {
    // An ESTIMATE must never validate the rate it was computed from — that is circular. Only the
    // venue's own adjustments can.
    return { ...base, verdict: VERDICT.UNTESTABLE, reason: `fundingSource=${r.fundingSource} is not a venue measurement`, ratio: null };
  }
  if (!hasActual) return { ...base, verdict: VERDICT.UNTESTABLE, reason: 'no recorded funding', ratio: null };

  // AN EXEMPT INSTRUMENT IS A CHECK, NOT A SKIP. The venue states 0.0000% on BOTH sides of an option
  // (all twenty on the Gold chain), so "charged nothing" is CORRECT there and the night count is
  // irrelevant — an option is the one row class where crossing the funding time costs nothing. The
  // mirror case is the real defect: an instrument the venue advertises as free that charged anyway.
  if (rate === 0) {
    return Math.abs(actualCost) < MATERIAL
      ? { ...base, verdict: VERDICT.EXEMPT, reason: 'venue states zero funding on this side — charged nothing', ratio: null }
      : { ...base, verdict: VERDICT.MAGNITUDE_OFF, reason: `venue states ZERO funding but charged ${round6(actualCost)}`, ratio: null };
  }

  // The nights model is the load-bearing assumption: the entire carry prediction is "per calendar
  // night crossed". Zero nights with a non-zero charge (or the reverse) falsifies it directly, so it
  // is checked BEFORE anything that depends on it.
  if (nights === 0 && Math.abs(actualCost) > MATERIAL) {
    return { ...base, verdict: VERDICT.CONVENTION_VIOLATION, reason: `charged ${actualCost} over ZERO nights`, ratio: null };
  }
  if (nights > 0 && Math.abs(actualCost) < MATERIAL && predicted != null && predicted > MATERIAL) {
    return { ...base, verdict: VERDICT.CONVENTION_VIOLATION, reason: `${nights} night(s) held, charged nothing (predicted ${round6(predicted)})`, ratio: null };
  }
  if (nights === 0 && Math.abs(actualCost) < MATERIAL) {
    return { ...base, verdict: VERDICT.NO_CARRY, reason: 'no nights, no charge — confirms the per-night convention', ratio: null };
  }
  if (predicted == null) {
    return { ...base, verdict: VERDICT.UNTESTABLE, reason: rate == null ? 'no stated rate for this instrument (never captured)' : 'notional unavailable', ratio: null };
  }
  // Too small to compare against 2dp money on either side: a ratio here measures the venue's display
  // precision, not its pricing.
  if (predicted < MATERIAL || Math.abs(actualCost) < MATERIAL) {
    return { ...base, verdict: VERDICT.UNTESTABLE, reason: `charge below the venue's 2dp display precision (predicted ${round6(predicted)}, actual ${round6(actualCost)})`, ratio: null };
  }
  if (Math.abs(predicted) > 1e-9 && Math.abs(actualCost) > 1e-9 && Math.sign(predicted) !== Math.sign(actualCost)) {
    return { ...base, verdict: VERDICT.SIGN_MISMATCH, reason: `predicted ${round6(predicted)} but charged ${round6(actualCost)}`, ratio: null };
  }
  const ratio = predicted !== 0 ? actualCost / predicted : null;
  if (ratio != null && (ratio < MAG_LOW || ratio > MAG_HIGH)) {
    return { ...base, verdict: VERDICT.MAGNITUDE_OFF, reason: `actual/predicted = ${round4(ratio)} (outside ${MAG_LOW}-${MAG_HIGH})`, ratio };
  }
  return { ...base, verdict: VERDICT.WITHIN_RANGE, reason: null, ratio };
}

// Aggregate the population. `bias` is the median ratio over the rows that could be compared, which is
// the number to correct the stated rate with — a mean would let one mispriced row dominate.
function fundingVariance(rows, { rateFor = null, fundingMinuteFor = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const checks = list.map((r) => fundingCheck(r, {
    ratePct: rateFor ? rateFor(r) : null,
    fundingMinuteUtc: fundingMinuteFor ? fundingMinuteFor(r) : null,
  }));
  const byVerdict = {};
  for (const c of checks) byVerdict[c.verdict] = (byVerdict[c.verdict] || 0) + 1;
  const ratios = checks.map((c) => c.ratio).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const median = ratios.length
    ? (ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2)
    : null;
  const withActual = checks.filter((c) => c.actualCost != null);
  return {
    rows: checks.length,
    measured: withActual.length,
    comparable: ratios.length,
    byVerdict,
    bias: median == null ? null : round4(median),
    ratios: ratios.map(round4),
    // A defect list, not a count: a sign mismatch or a convention violation is a bug to fix, whereas
    // `within_range` at 1.25x is a rate that moved and needs no action at all.
    defects: checks.filter((c) => [VERDICT.SIGN_MISMATCH, VERDICT.CONVENTION_VIOLATION, VERDICT.MAGNITUDE_OFF].includes(c.verdict)),
    checks,
  };
}

function round4(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 10000) / 10000 : null; }
function round6(n) { return Number.isFinite(Number(n)) ? Math.round(Number(n) * 1e6) / 1e6 : null; }

// The write-side helper: what to persist for a close the DESK made, where there is no venue
// adjustment to read. Returns null fundingCost when there is no rate — the caller stores
// `fundingSource: 'not_available'` rather than a zero, because a position it could not price must not
// be recorded as free to hold.
function estimateOwnClose(row, { ratePct = null, fundingMinuteUtc = null } = {}) {
  const nights = nightsOf(row, { fundingMinuteUtc });
  const notional = notionalOf(row);
  const rate = Number.isFinite(num(ratePct)) ? num(ratePct) : null;
  // ZERO NIGHTS IS A CONVENTION, NOT AN ESTIMATE. The charge is exactly zero whatever the rate is, so
  // recording it as `estimated_from_registry` would claim a source that contributed nothing — and the
  // first draft wrote `-0` here, which is === 0 but a different value and reads as a charge in a log.
  if (nights === 0) {
    return { swapNights: 0, fundingRatePct: rate, fundingCost: 0, fundingSource: 'no_carry_nights' };
  }
  const cost = predictFunding({ nights, notional, ratePct: rate });
  return {
    swapNights: nights,
    fundingRatePct: rate,
    fundingCost: cost == null ? null : (cost === 0 ? 0 : -cost),
    fundingSource: cost == null ? 'not_available' : 'estimated_from_registry',
  };
}

module.exports = { VERDICT, MAG_LOW, MAG_HIGH, MATERIAL, notionalOf, nightsOf, parseFundingTimeLocal, predictFunding, fundingCheck, fundingVariance, estimateOwnClose };
