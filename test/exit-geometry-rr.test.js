// test/exit-geometry-rr.test.js — 2026-10-24.
//
// `LEVEL_RR` was a literal 1.5 for the whole life of the desk, so the declared reward:risk was not a setting at
// all. Making it one has exactly three ways to go wrong, and each is pinned here:
//
//   1. THE DEFAULT MOVES. It must not — `risk.takeProfitRR` is absent on every historic settings row, and a
//      resolver that treated "absent" as anything other than 1.5 would silently re-geometry the whole trade
//      record and void the TRD-29 candidates the frozen forward track rests on.
//   2. THE RATIO DOES NOT REACH THE LEVELS. `entryLevels` computes `declaredTpDist` from the ratio; if the
//      setting is threaded in but not used, the desk "declares 3R" and ships 1.5R. So the price is checked, not
//      just the returned field.
//   3. THE AUDIT CHECKS AGAINST ITS OWN CONSTANT. `fieldContracts.venueLevelGeometry` measures the tickets
//      against the declaration and computes the F20 floor as a percentage of it. If it kept reading the literal,
//      every correct 3R ticket would report as a geometry violation — a check that lies is worse than no check.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { entryLevels, resolveTakeProfitRR, LEVEL_RR } = require('../trading/agent/exitLevels');

// 4,000 with an 80-wide stop, and a 2.5% adverse cap of 100 that does NOT bind, so the placed stop is the
// declared one and the two anchors coincide. A binding cap is a separate case below.
const BASE = { direction: 'buy', atr14: 10, price: 4000, stopDistance: 80, maxAdversePct: 2.5 };

test('the constant is still 1.5 and an absent setting resolves to it', () => {
  assert.strictEqual(LEVEL_RR, 1.5);
  assert.strictEqual(resolveTakeProfitRR(undefined), 1.5);
  assert.strictEqual(resolveTakeProfitRR(null), 1.5);
  assert.strictEqual(resolveTakeProfitRR({}), 1.5);
  assert.strictEqual(resolveTakeProfitRR(1.5), 1.5); // a bare number is accepted, for the audit paths
});

test('a value the desk cannot express resolves back to the default instead of becoming NaN in a price', () => {
  // Number(null) === 0 and Number('') === 0, so a plain isFinite guard accepts a MISSING value. Absent and
  // zero both mean "no declaration", and both must land on LEVEL_RR rather than on zero.
  for (const bad of [0, -1, '', 'abc', null, undefined, NaN, Infinity]) {
    assert.strictEqual(resolveTakeProfitRR({ takeProfitRR: bad }), 1.5, `takeProfitRR=${String(bad)}`);
  }
  assert.strictEqual(resolveTakeProfitRR({ takeProfitRR: 3 }), 3);
  assert.strictEqual(resolveTakeProfitRR({ takeProfitRR: '3' }), 3); // settings JSON may carry a string
});

test('the default path is byte-identical to the pre-2026-10-24 geometry', () => {
  const before = entryLevels(BASE);
  const after = entryLevels({ ...BASE, takeProfitRR: undefined });
  assert.deepStrictEqual(after.stopPrice, before.stopPrice);
  assert.deepStrictEqual(after.takeProfitPrice, before.takeProfitPrice);
  // 1.5R of the 80-wide stop, on a long from 4,000
  assert.strictEqual(before.takeProfitPrice, 4120);
  assert.strictEqual(before.takeProfitRR, 1.5);
  assert.strictEqual(before.effectiveRR, 1.5);
});

test('the ratio REACHES THE PRICE, not only the result object', () => {
  const r = entryLevels({ ...BASE, takeProfitAnchor: 'placed', takeProfitRR: 3 });
  // 3R of an 80-wide stop = 240 above 4,000. If the setting were threaded but unused this would read 4,120.
  assert.strictEqual(r.takeProfitPrice, 4240);
  assert.strictEqual(r.stopPrice, 3920);
  assert.strictEqual(r.takeProfitRR, 3);
  assert.strictEqual(r.effectiveRR, 3);
  assert.strictEqual(r.takeProfitDist, 240);
});

test('anchor placed + a binding cap: the target follows the stop that is actually placed', () => {
  // A 1.2% cap on 4,000 is 48, below the declared 80. Under 'placed' the target is 3 x 48; under 'declared' it
  // would be 3 x 80, i.e. 5R of the ticket's real risk — the exact mismatch TRD-TP-1 route (2) exists to stop.
  const placed = entryLevels({ ...BASE, maxAdversePct: 1.2, takeProfitAnchor: 'placed', takeProfitRR: 3 });
  assert.strictEqual(placed.stopDist, 48);
  assert.strictEqual(placed.cappedBy, 'max_adverse_pct');
  assert.strictEqual(placed.takeProfitPrice, 4144);
  assert.strictEqual(placed.effectiveRR, 3);

  const declared = entryLevels({ ...BASE, maxAdversePct: 1.2, takeProfitAnchor: 'declared', takeProfitRR: 3 });
  assert.strictEqual(declared.takeProfitPrice, 4240);
  assert.strictEqual(declared.effectiveRR, 5); // 240 / 48 — the label-vs-reality gap, measured not assumed
});

test('the offset multiplies the declared ratio, and the desk effective target is 2.82R at rr 3 / offset 6', () => {
  // The desk runs takeProfitOffsetPct: 6. It is the reason the old 1.5R declaration measured 1.41R in the
  // record (1.5 x 0.94), and it is why setting rr to 3 ships 2.82R rather than 3.00R. Pinned so the epoch
  // entry cannot drift from the arithmetic.
  const r = entryLevels({ ...BASE, takeProfitAnchor: 'placed', takeProfitRR: 3, takeProfitOffsetPct: 6 });
  assert.strictEqual(r.effectiveRR, 2.82);
  assert.strictEqual(r.takeProfitPrice, 4225.6); // 4000 + 225.6

  const old = entryLevels({ ...BASE, takeProfitAnchor: 'placed', takeProfitRR: 1.5, takeProfitOffsetPct: 6 });
  assert.strictEqual(old.effectiveRR, 1.41); // the measured baseline the replay was run against
});
