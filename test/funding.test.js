// test/funding.test.js — TRD-45 Phase 3: validating the venue's stated carry against what it charged.
//
// THE FINDING THIS PINS. The first real row the validator could test was Trades #29 (Oil buy, opened
// 2026-09-10 18:02 UTC, closed 22:00 UTC). It crosses NO UTC midnight, so `nightsBetween` predicted a
// free hold — and the venue charged 0.31. The model was wrong, not the venue: the venue bills once per
// crossing of ITS OWN overnight-funding clock time, published per instrument ("5:00 AM", captured in
// Phase 1 and consumed by nothing). Re-scored against that instant, and with the option exemption the
// venue states (0.0000% on both sides), all ten venue-charged rows agree and there are ZERO defects.
//
// The three tests that matter most:
//   1. `the venue bills at its clock time, not at midnight` — #29 and #27, the pair that separates
//      the two conventions.
//   2. `a false violation is worse than no check` — the 2dp money floor, without which a sub-cent
//      predicted charge reports a violation the venue cannot even display.
//   3. `an option is a CHECK, not a skip` — the exemption must still fail if an advertised-free
//      instrument charges.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { crossingsOfDailyInstant, fundingMinuteUtc, nightsBetween } = require('../trading/agent/time');
const f = require('../trading/agent/funding');
const { VERDICT } = f;

// Real rows from the ledger (the ten venue-charged closes). `charged` is the venue's own adjustment,
// stored as a NEGATIVE number meaning "you paid".
const rows = {
  option1: { id: 1, symbol: 'Oil | Call 94 | Sep W2', direction: 'buy', size: 300, openPrice: 1.48, openAt: '2026-09-08T10:27:53Z', closeAt: '2026-09-09T07:22:00Z', fundingCost: 0, fundingSource: 'venue_actual', swapNights: 1 },
  sgx2: { id: 2, symbol: 'SGX', direction: 'buy', size: 200, openPrice: 25.008, openAt: '2026-09-08T10:27:53Z', closeAt: '2026-09-10T02:02:00Z', fundingCost: -4, fundingSource: 'venue_actual', swapNights: 2 },
  soybean8: { id: 8, symbol: 'Soybean Oil', direction: 'buy', size: 1500, openPrice: 70.67, openAt: '2026-09-09T07:55:28Z', closeAt: '2026-09-10T02:02:00Z', fundingCost: -0.43, fundingSource: 'venue_actual', swapNights: 1 },
  btc22: { id: 22, symbol: 'Bitcoin', direction: 'buy', size: 0.0082, openPrice: 78134.36, openAt: '2026-09-10T08:07:00Z', closeAt: '2026-09-10T12:30:00Z', fundingCost: 0, fundingSource: 'venue_actual', swapNights: 0 },
  gold27: { id: 27, symbol: 'Gold', direction: 'sell', size: 0.1836, openPrice: 4355.21, openAt: '2026-09-10T17:56:42Z', closeAt: '2026-09-10T19:02:00Z', fundingCost: 0, fundingSource: 'venue_actual', swapNights: 0 },
  oil29: { id: 29, symbol: 'Oil', direction: 'buy', size: 7.8476, openPrice: 102.09, openAt: '2026-09-10T18:02:32Z', closeAt: '2026-09-10T22:00:00Z', fundingCost: -0.31, fundingSource: 'venue_actual', swapNights: 0 },
  gold1027: { id: 1027, symbol: 'Gold', direction: 'sell', size: 0.1856, openPrice: 4324.04, openAt: '2026-09-10T19:10:07Z', closeAt: '2026-09-11T05:46:00Z', fundingCost: -0.12, fundingSource: 'venue_actual', swapNights: 1 },
};
const GOLD_RATE = 0.012; // the venue's stated sell-side rate, as a COST (positive)
// 05:00 Singapore = 21:00 UTC.
const CLOCK = fundingMinuteUtc({ hourLocal: 5, utcOffsetMinutes: 480 });

// --- the convention ------------------------------------------------------------------
test('fundingMinuteUtc converts the venue clock to a UTC instant', () => {
  assert.equal(CLOCK, 1260, '05:00 SGT is 21:00 UTC');
  assert.equal(fundingMinuteUtc({ hourLocal: 0, utcOffsetMinutes: 0 }), 0);
  // Wrapping forward past UTC midnight must stay in [0, 1440).
  assert.equal(fundingMinuteUtc({ hourLocal: 5, utcOffsetMinutes: 480 }) + 1440 >= 1440, true);
  assert.equal(fundingMinuteUtc({ hourLocal: 1, utcOffsetMinutes: 480 }), 1020, '01:00 SGT = 17:00 UTC');
  assert.equal(fundingMinuteUtc({ hourLocal: 20, utcOffsetMinutes: -300 }), 60, '20:00 UTC-5 = 01:00 UTC next day');
});

test('the venue bills at its clock time, not at midnight', () => {
  // #29 is the row that separates the two rules: held 18:02 -> 22:00 UTC, so it crosses NO midnight,
  // yet the venue charged. It DOES cross 21:00 UTC.
  assert.equal(nightsBetween(rows.oil29.openAt, rows.oil29.closeAt), 0, 'the old midnight model says free');
  assert.equal(crossingsOfDailyInstant(rows.oil29.openAt, rows.oil29.closeAt, CLOCK), 1, 'the clock model says one night');
  // #27 is the mirror: it crosses neither, and the venue charged nothing.
  assert.equal(nightsBetween(rows.gold27.openAt, rows.gold27.closeAt), 0);
  assert.equal(crossingsOfDailyInstant(rows.gold27.openAt, rows.gold27.closeAt, CLOCK), 0);
  // A multi-day hold counts every crossing.
  assert.equal(crossingsOfDailyInstant(rows.sgx2.openAt, rows.sgx2.closeAt, CLOCK), 2);
  // Degenerate windows are zero, never negative.
  assert.equal(crossingsOfDailyInstant(rows.oil29.closeAt, rows.oil29.openAt, CLOCK), 0);
  assert.equal(crossingsOfDailyInstant(rows.oil29.openAt, rows.oil29.openAt, CLOCK), 0);
  // An unusable minute falls back to the midnight model rather than silently returning zero.
  assert.equal(crossingsOfDailyInstant(rows.sgx2.openAt, rows.sgx2.closeAt, NaN), 2);
  assert.equal(crossingsOfDailyInstant(rows.sgx2.openAt, rows.sgx2.closeAt, 9999), 2);
});

test('parseFundingTimeLocal reads the venue text and refuses the placeholder', () => {
  assert.deepEqual(f.parseFundingTimeLocal('5:00 AM'), { hour: 5, minute: 0 });
  assert.deepEqual(f.parseFundingTimeLocal('12:00 AM'), { hour: 0, minute: 0 }, '12 AM is midnight');
  assert.deepEqual(f.parseFundingTimeLocal('12:30 PM'), { hour: 12, minute: 30 });
  assert.deepEqual(f.parseFundingTimeLocal(' 7:15 pm '), { hour: 19, minute: 15 });
  // '--' is what the venue shows on an instrument with no funding. It means UNKNOWN, not midnight.
  assert.equal(f.parseFundingTimeLocal('--'), null);
  assert.equal(f.parseFundingTimeLocal(null), null);
  assert.equal(f.parseFundingTimeLocal(''), null);
});

test('#29 is no longer a false convention violation', () => {
  // Under the midnight convention this row was reported as "charged 0.31 over ZERO nights". That was
  // a defect report against a correct charge — the most expensive kind of wrong answer, because it
  // would have sent someone to fix the venue's arithmetic.
  const wrong = f.fundingCheck(rows.oil29, { ratePct: 0.0319 });
  assert.equal(wrong.nights, 0, 'the stored count is 0 because it was written under the old rule');
  assert.equal(wrong.verdict, VERDICT.CONVENTION_VIOLATION);
  const right = f.fundingCheck(rows.oil29, { ratePct: 0.0319, fundingMinuteUtc: CLOCK });
  assert.equal(right.nights, 1);
  assert.notEqual(right.verdict, VERDICT.CONVENTION_VIOLATION);
});

// --- verdicts -------------------------------------------------------------------------
test('an option is a CHECK, not a skip', () => {
  // The venue states 0.0000% on both sides of every option, so "charged nothing" is correct AND the
  // night count is irrelevant (row #1 crosses the funding time once and is still free).
  const ok = f.fundingCheck(rows.option1, { ratePct: 0, fundingMinuteUtc: CLOCK });
  assert.equal(ok.verdict, VERDICT.EXEMPT);
  assert.equal(ok.nights, 1, 'it did cross the funding instant — the exemption is the rate, not the nights');
  // The mirror case is a real defect: an advertised-free instrument that charged.
  const bad = f.fundingCheck({ ...rows.option1, fundingCost: -7.5 }, { ratePct: 0, fundingMinuteUtc: CLOCK });
  assert.equal(bad.verdict, VERDICT.MAGNITUDE_OFF);
  assert.match(bad.reason, /ZERO funding but charged 7\.5/);
});

test('the real population scores with zero defects', () => {
  const facts = [
    [rows.option1, 0],
    [rows.sgx2, null],
    [rows.soybean8, null],
    [rows.btc22, null],
    [rows.gold27, GOLD_RATE],
    [rows.oil29, null],
    [rows.gold1027, GOLD_RATE],
  ];
  const report = f.fundingVariance(facts.map(([r]) => r), {
    rateFor: (r) => (facts.find(([x]) => x === r) || [])[1],
    fundingMinuteFor: () => CLOCK,
  });
  assert.equal(report.rows, 7);
  assert.deepEqual(report.defects, [], 'no sign inversion, no charge over zero nights, nothing order-of-magnitude out');
  assert.equal(report.byVerdict[VERDICT.EXEMPT], 1);
  // #27 and #22 cross the funding instant zero times and are charged nothing. #29 also crosses it
  // zero times under the MIDNIGHT rule — but once under the venue's clock, which is why it is not in
  // this bucket and why it was previously reported as a violation.
  assert.equal(report.byVerdict[VERDICT.NO_CARRY], 2);
  assert.equal(report.byVerdict[VERDICT.WITHIN_RANGE], 1, '#1027, the one row with a rate on both sides');
  // The bias is the number to correct the stated rate with: the venue charged 1.246x what its own
  // stated sell rate predicts. A median, so one mispriced row cannot dominate.
  assert.equal(report.bias, 1.246);
  assert.equal(report.comparable, 1);
});

test('a sign mismatch is the failure that matters', () => {
  // Predicted a charge, charged a credit (or the reverse) — the one error that silently inverts every
  // cost. A 20% disagreement is a rate that moved; an inverted sign is a bug.
  const flip = f.fundingCheck(
    { ...rows.gold1027, fundingCost: +0.12 },
    { ratePct: GOLD_RATE, fundingMinuteUtc: CLOCK },
  );
  assert.equal(flip.verdict, VERDICT.SIGN_MISMATCH);
});

test('a false violation is worse than no check (the 2dp money floor)', () => {
  // The venue states adjustments in money to 2dp. A sub-cent predicted charge is indistinguishable
  // from no charge, and scoring it would report a defect against a correct row — training the
  // operator to ignore the check.
  const tiny = f.fundingCheck(
    { id: 900, symbol: 'Bitcoin', direction: 'buy', size: 0.0001, openPrice: 78000, openAt: '2026-09-10T20:00:00Z', closeAt: '2026-09-11T02:00:00Z', fundingCost: 0, fundingSource: 'venue_actual' },
    { ratePct: 0.0319, fundingMinuteUtc: CLOCK },
  );
  assert.equal(tiny.nights, 1);
  // 7.8 notional x 0.0319%/night = 0.0025, which the venue would display as "0.00".
  assert.ok(tiny.predictedCost < f.MATERIAL, `predicted ${tiny.predictedCost} should be sub-cent`);
  assert.equal(tiny.verdict, VERDICT.UNTESTABLE);
  assert.match(tiny.reason, /2dp display precision/);
  // And a charge BELOW the floor over zero nights is not a violation either.
  const nearZero = f.fundingCheck({ ...rows.gold27, fundingCost: -0.004 }, { ratePct: GOLD_RATE, fundingMinuteUtc: CLOCK });
  assert.equal(nearZero.verdict, VERDICT.NO_CARRY);
});

test('an absent funding amount is NOT a zero charge, and an estimate cannot validate itself', () => {
  // A row the desk closed itself has no venue adjustment. Treating absent as zero would report the
  // desk's own closes as free to hold.
  assert.equal(f.fundingCheck({ ...rows.gold27, fundingCost: null }, { ratePct: GOLD_RATE }).verdict, VERDICT.UNTESTABLE);
  assert.equal(f.fundingCheck({ ...rows.gold27, fundingCost: null }).reason, 'no recorded funding');
  // An ESTIMATE must never validate the rate it was computed from — that is circular. Only the
  // venue's own adjustments can.
  const est = f.fundingCheck({ ...rows.gold1027, fundingSource: 'estimated_from_registry' }, { ratePct: GOLD_RATE, fundingMinuteUtc: CLOCK });
  assert.equal(est.verdict, VERDICT.UNTESTABLE);
  assert.match(est.reason, /not a venue measurement/);
});

// --- the arithmetic ---------------------------------------------------------------------
test('notional and the prediction use the same pieces the venue does', () => {
  assert.equal(f.notionalOf(rows.gold1027), 0.1856 * 4324.04);
  assert.equal(f.notionalOf({ size: null, openPrice: 100 }), null, 'absent size is not a zero notional');
  // #1027: 802.54 x 0.012%/night x 1 night.
  const predicted = f.predictFunding({ nights: 1, notional: 0.1856 * 4324.04, ratePct: 0.012 });
  assert.ok(Math.abs(predicted - 0.0963) < 1e-4, `got ${predicted}`);
  // Zero nights is exactly zero, whatever the rate says — that is the convention, stated once.
  assert.equal(f.predictFunding({ nights: 0, notional: 1000, ratePct: 5 }), 0);
  // No rate, or no notional, is UNKNOWN rather than zero.
  assert.equal(f.predictFunding({ nights: 1, notional: 1000, ratePct: null }), null);
  assert.equal(f.predictFunding({ nights: 1, notional: null, ratePct: 0.01 }), null);
});

test('estimateOwnClose records a source, and refuses to invent a free night', () => {
  const withRate = f.estimateOwnClose({ ...rows.gold1027, swapNights: null }, { ratePct: GOLD_RATE, fundingMinuteUtc: CLOCK });
  assert.equal(withRate.fundingSource, 'estimated_from_registry');
  assert.equal(withRate.swapNights, 1);
  assert.equal(withRate.fundingRatePct, GOLD_RATE);
  // The cost is stored with the venue's SIGN (negative = charged), so the column means one thing on
  // both write paths.
  assert.ok(Math.abs(withRate.fundingCost + 0.0963) < 1e-4, `got ${withRate.fundingCost}`);
  assert.equal(Object.is(withRate.fundingCost, -0), false, 'never write -0 — it reads as a charge');
  // No rate on file -> `not_available`, NOT a zero. A position the desk cannot price must not be
  // recorded as free to hold.
  const noRate = f.estimateOwnClose(rows.oil29, { ratePct: null, fundingMinuteUtc: CLOCK });
  assert.equal(noRate.nights === undefined, true);
  assert.equal(noRate.fundingCost, null);
  assert.equal(noRate.fundingSource, 'not_available');
  // A ZERO-NIGHT hold is a different statement: the charge is exactly zero by the convention, and the
  // source says so rather than crediting an estimate that contributed nothing.
  const zeroNights = f.estimateOwnClose(rows.gold27, { ratePct: null, fundingMinuteUtc: CLOCK });
  assert.equal(zeroNights.fundingCost, 0);
  assert.equal(Object.is(zeroNights.fundingCost, -0), false);
  assert.equal(zeroNights.fundingSource, 'no_carry_nights');
});

test('nightsOf prefers the venue clock over the stored count when told', () => {
  // The stored count was written under the old convention, so a caller that knows the funding instant
  // must be able to override it. The stored number stays as the historical record.
  assert.equal(f.nightsOf(rows.oil29), 0);
  assert.equal(f.nightsOf(rows.oil29, { fundingMinuteUtc: CLOCK }), 1);
  // With no clock, a row lacking a stored count falls back to the midnight model rather than to null.
  assert.equal(f.nightsOf({ openAt: rows.sgx2.openAt, closeAt: rows.sgx2.closeAt }), 2);
  assert.equal(f.nightsOf({}), null);
});
