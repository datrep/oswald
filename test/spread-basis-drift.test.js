'use strict';
// test/spread-basis-drift.test.js — 2026-10-27. Does the curated cost table still match the venue?
//
// ⚠ THE TABLE IS WHAT THE DESK CHARGES. `CALIBRATED_SPREAD_HALF_PCT` feeds `costCfgFor` → `stopPolicy.adverseStopCap`
// → the cost-share ceiling → the chair's cost line. Nothing re-checked it until 2026-10-27, when Silver came back at
// 1.27x against 39 of the desk's own fills.
const { test } = require('node:test');
const assert = require('node:assert');
const { driftVerdict, actionable, MIN_SAMPLE, TOLERANCE_PCT } = require('../trading/agent/spreadBasisDrift');

test('★ the comparison DOUBLES the curated half-spread — the unit trap that has already bitten once', () => {
  // `cfdSpreadPct` is a HALF-spread per side; `spreadSubmitPct` is a ROUND TRIP. `agent/spreadDerivation.js` records
  // the first TRD-79 measurement comparing full-spread to half and concluding "the table is twice the derived value"
  // — an artefact of the divisor. Without the x2 this same row reads 2.11x and gets called drift.
  const v = driftVerdict({ symbol: 'Gold', curatedHalfPct: 0.0097, measuredRoundTripPct: 0.02047, n: 23 });
  assert.equal(v.curatedRoundTripPct, 0.0194);
  assert.equal(v.ratio, 1.055);
  assert.equal(v.verdict, 'agrees');
});

test('★ a real drift is called one', () => {
  const v = driftVerdict({ symbol: 'Silver', curatedHalfPct: 0.0468, measuredRoundTripPct: 0.118467, n: 39 });
  assert.equal(v.verdict, 'drift');
  assert.equal(v.driftPct, 26.6);
});

test('★ a small sample is a VERDICT, not a pass', () => {
  // Three fills cannot show a 27% drift. Reporting them as agreement is the failure this repo keeps paying for.
  const v = driftVerdict({ symbol: 'SGX', curatedHalfPct: 0.2507, measuredRoundTripPct: 0.501277, n: 3 });
  assert.equal(v.verdict, 'insufficient_sample');
  assert.equal(v.n, 3);
  assert.equal(v.minSample, MIN_SAMPLE);
  assert.deepStrictEqual(actionable([v]), [], 'an unjudged row is not actionable');
});

test('the tolerance boundary is inclusive, and stated rather than tuned after the fact', () => {
  // curated 0.05 -> round trip 0.10. 0.12 is exactly +20% and must NOT fire; 0.1201 must.
  assert.equal(driftVerdict({ symbol: 'X', curatedHalfPct: 0.05, measuredRoundTripPct: 0.12, n: 10 }).verdict, 'agrees');
  assert.equal(driftVerdict({ symbol: 'X', curatedHalfPct: 0.05, measuredRoundTripPct: 0.1201, n: 10 }).verdict, 'drift');
  assert.equal(TOLERANCE_PCT, 20);
});

test('a curated entry with no fills is UNMEASURED, not agreeing', () => {
  const v = driftVerdict({ symbol: 'Natural Gas', curatedHalfPct: 0.1, measuredRoundTripPct: null, n: 0 });
  assert.equal(v.verdict, 'insufficient_sample');
});

test('a symbol with fills but no table entry says so instead of inventing a comparison', () => {
  const v = driftVerdict({ symbol: 'X', curatedHalfPct: null, measuredRoundTripPct: 0.05, n: 12 });
  assert.equal(v.verdict, 'no_curated_value');
});

test('a zero or negative measurement is refused rather than read as agreement', () => {
  // A single-sided feed derives a ZERO spread, which would make every symbol "cheaper than the table".
  assert.equal(driftVerdict({ symbol: 'X', curatedHalfPct: 0.05, measuredRoundTripPct: 0, n: 10 }).verdict, 'no_measurement');
  assert.equal(driftVerdict({ symbol: 'X', curatedHalfPct: 0.05, measuredRoundTripPct: -1, n: 10 }).verdict, 'no_measurement');
});

test('actionable() returns drift rows only, and tolerates junk', () => {
  const rows = [
    driftVerdict({ symbol: 'A', curatedHalfPct: 0.05, measuredRoundTripPct: 0.1, n: 10 }),
    driftVerdict({ symbol: 'B', curatedHalfPct: 0.05, measuredRoundTripPct: 0.2, n: 10 }),
    { symbol: 'C', verdict: 'insufficient_sample', n: 2 },
  ];
  assert.deepStrictEqual(actionable(rows).map((r) => r.symbol), ['B']);
  assert.deepStrictEqual(actionable(null), []);
  assert.deepStrictEqual(actionable([]), []);
});
