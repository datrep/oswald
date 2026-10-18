// The risk-unit auditor must be able to tell ARITHMETIC DRIFT from a RECORDING GAP, because it returned `bad`
// for five rows whose arithmetic was CORRECT (2026-10-02).
//
// THE DEFECT. `sizeCalc.baseSize` began carrying a scale at 2026-10-01T16:51, but `sizeCalc.fx`/`pointValue` only
// began being EMITTED at 2026-10-02T08:24 — so five decisions in between were sized with a scale the record does
// not carry. `scaleOf` documents its `1` default as the era rule ("rows before the change carry neither key, and
// they were sized WITHOUT a scale"), and that rule is FALSE for exactly those rows: they were sized WITH one.
// The auditor then found they matched neither formula and announced "sizing arithmetic drifted" — a false alarm
// on correct sizing, which is precisely what makes a real regression invisible when it arrives.
//
// So the two findings are now separated, and these tests pin the separation in BOTH directions. A test that only
// proved the false alarm is gone would also pass if the auditor had simply stopped checking.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { riskUnitArithmetic } = require('../trading/agent/fieldContracts');

// Measured live, decision #170359 (Soybeans, 2026-10-02T00:26:38): equity 3939.7, risk 3.6%, atr 2.1937,
// recorded baseSize 2085.595. The unscaled formula gives 32.327, and 2085.595 / 32.327 = 64.52 = 1/0.0155,
// which is Soybeans' scale (fx 1.55 x pointValue 0.01).
const SOY = { equity: 3939.7, riskPct: 3.6, atr: 2.1937, baseSize: 2085.595 };
const SOY_SCALE = { fx: 1.55, pointValue: 0.01 };

test('★ a scaled row that does NOT record its scale is a RECORDING GAP, not arithmetic drift', () => {
  const { arithmetic, unrecorded } = riskUnitArithmetic([SOY]);
  assert.deepEqual(arithmetic, [], 'correct arithmetic must never be reported as drift');
  assert.equal(unrecorded.length, 1, 'and the gap must still be reported — a desk that cannot reproduce its own size has one');
  assert.match(unrecorded[0], /ratio 64\.5/, 'the ratio is stated so a reader can see it is ONE constant');
});

test('the same row WITH its scale keys AGREES, so the fix removes the alarm rather than widening the tolerance', () => {
  const { arithmetic, unrecorded } = riskUnitArithmetic([{ ...SOY, ...SOY_SCALE }]);
  assert.deepEqual(arithmetic, [], 'with the scale recorded the arithmetic matches exactly');
  assert.deepEqual(unrecorded, [], 'and there is no gap to report — this is the state the desk is moving to');
});

test('★ real drift is STILL bad, and is still caught when the record carries the scale', () => {
  // The record says one scale, the size used another: this is the regression the check exists for.
  const { arithmetic } = riskUnitArithmetic([{ ...SOY, ...SOY_SCALE, baseSize: 32.327 }]);
  assert.equal(arithmetic.length, 1, 'a row that records its scale and still disagrees is genuine drift');
  assert.match(arithmetic[0], /baseSize 32\.327 vs 2085\.5/, 'and it names both numbers');
});

test('an UNSCALED row is untouched — the era rule still holds where it is actually true', () => {
  const unscaled = { ...SOY, baseSize: 32.327 };
  const { arithmetic, unrecorded } = riskUnitArithmetic([unscaled]);
  assert.deepEqual(arithmetic, []);
  assert.deepEqual(unrecorded, [], 'a key-less row that matches the unscaled formula is pre-era or scale-1, and is fine');
});

test('an fx of 1 is a RECORDED scale, so its row must not be relabelled a gap', () => {
  // `carriesScale` tests the KEYS, not `scaleOf(...) !== 1`. Reading a recorded `fx: 1` as "unrecorded" would
  // relabel an auditable row as a gap — the mirror of the defect being fixed.
  const { arithmetic, unrecorded } = riskUnitArithmetic([{ ...SOY, baseSize: 32.327, fx: 1, pointValue: 1 }]);
  assert.deepEqual(unrecorded, [], 'fx:1 IS recorded');
  assert.deepEqual(arithmetic, [], 'and scale 1 x 1 means the unscaled formula is the right one');
});

test('an unmeasurable row is skipped, never counted as agreement', () => {
  // atr missing, atr zero, equity zero and a null row must all fall out rather than silently pass.
  const rows = [
    { equity: 3939.7, riskPct: 3.6, atr: 0, baseSize: 1 },
    { equity: 0, riskPct: 3.6, atr: 2, baseSize: 1 },
    { equity: 3939.7, riskPct: 3.6, atr: null, baseSize: 1 },
    null,
  ];
  const { arithmetic, unrecorded } = riskUnitArithmetic(rows);
  assert.deepEqual(arithmetic, []);
  assert.deepEqual(unrecorded, []);
});

test('an empty or absent window is not an error', () => {
  assert.deepEqual(riskUnitArithmetic([]), { arithmetic: [], unrecorded: [] });
  assert.deepEqual(riskUnitArithmetic(null), { arithmetic: [], unrecorded: [] });
});
