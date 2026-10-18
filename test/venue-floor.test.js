// test/venue-floor.test.js — TRD-45 Phase 1: the sizing floor the desk has never had.
//
// `risk.js` computed `size = equity x riskPct / stopDist` and stopped. Phase 0 measured the real
// minimums on one chain — Gold spot from 0.025 Troy Ounces, the options around the same underlying
// from 1.5 to 15 "Options" — so the formula could and did produce sizes the venue will not accept.
//
// THE DECISION PINNED HERE is that the floor VETOES rather than clamping upward. Clamping would
// exceed the risk `riskPerTradePct` promised, and it would do it on exactly the tightest-stop
// proposals. The alternative reading (raise the size, take the trade) is one line shorter and
// silently breaks the one dial the owner sets.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { floorVerdict } = require('../trading/agent/instruments');

test('below the venue minimum is a VETO, and names both numbers', () => {
  // The real Phase 0 case: 15 minimum units of `Gold | Put 4225 | Sep W3`.
  const v = floorVerdict({ size: 0.4, minUnits: 15, unitKind: 'Options' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'below_venue_minimum');
  assert.match(v.detail, /computed 0\.4 < venue minimum 15 Options/);
  assert.equal(v.minUnits, 15);
  // No clamping: the size is NOT rewritten anywhere in the verdict, because raising it would take
  // more risk than the dial allows.
  assert.equal('size' in v, false);
});

test('at or above the minimum passes, and equality is not below it', () => {
  assert.equal(floorVerdict({ size: 15, minUnits: 15 }).ok, true);
  assert.equal(floorVerdict({ size: 15.0001, minUnits: 15 }).ok, true);
  assert.equal(floorVerdict({ size: 0.025, minUnits: 0.025, unitKind: 'Troy Ounces' }).reason, 'above_venue_minimum');
  assert.equal(floorVerdict({ size: 14.9999, minUnits: 15 }).ok, false);
});

test('an UNKNOWN minimum allows the trade and says so — it does not invent a floor', () => {
  // The registry starts empty. Refusing every entry until 20 instruments have been browsed by hand
  // would be a bigger intervention than the defect, but the absence must be VISIBLE, because a
  // missing fact that looks like a satisfied one is the failure this phase exists to end.
  for (const absent of [null, undefined, '']) {
    const v = floorVerdict({ size: 1, minUnits: absent });
    assert.equal(v.ok, true, `${absent} must not block trading`);
    assert.equal(v.reason, 'venue_minimum_unknown');
  }
  assert.equal(floorVerdict({ size: 1, minUnits: 0 }).reason, 'venue_minimum_unknown', 'a zero minimum is not a floor');
  assert.equal(floorVerdict({ size: 1, minUnits: -5 }).reason, 'venue_minimum_unknown');
  assert.equal(floorVerdict({ size: 1, minUnits: 'abc' }).reason, 'venue_minimum_unknown');
});

test('THE INVERSION: an explicitly-known but absent minimum must NOT read as satisfied', () => {
  // `Number(null) === 0`, so a naive guard sees a finite minimum of 0 and every size passes it —
  // "checked, and fine" for a check that never happened. The guard rejects absence BEFORE coercing,
  // and there is no separate `known` flag that could disagree with the value (an earlier draft had
  // one, and { known: true, minUnits: null } fell through every comparison against NaN and returned
  // `above_venue_minimum`). Anything vs NaN is false, which is how an absent floor becomes a pass.
  const v = floorVerdict({ size: 0.0001, minUnits: null, unitKind: 'Options' });
  assert.equal(v.reason, 'venue_minimum_unknown');
  assert.notEqual(v.reason, 'above_venue_minimum');
  assert.equal(v.minUnits, null, 'and it must not report a minimum of zero');
  // A boolean is not a minimum either: `Number(true) === 1` would set a floor of one unit.
  assert.equal(floorVerdict({ size: 0.5, minUnits: true }).reason, 'venue_minimum_unknown');
});

test('a size that is not a usable number is reported, never passed as below-minimum', () => {
  // Distinguishing "the size is too small" from "there is no size" matters: the first is a dead
  // trade, the second is a bug upstream in the sizing arithmetic.
  for (const bad of [null, undefined, '', 'abc', 0, -3]) {
    const v = floorVerdict({ size: bad, minUnits: 1 });
    assert.equal(v.reason, 'size_unavailable', `size=${JSON.stringify(bad)}`);
    assert.equal(v.ok, true, 'the sizing formula already refused it; this layer must not double-report');
  }
});

test('the verdict is a pure function of its arguments', () => {
  const a = floorVerdict({ size: 0.4, minUnits: 15, unitKind: 'Options' });
  const b = floorVerdict({ size: 0.4, minUnits: 15, unitKind: 'Options' });
  assert.deepEqual(a, b);
  assert.deepEqual(floorVerdict({}), { ok: true, reason: 'venue_minimum_unknown', detail: null, minUnits: null, unitKind: null });
});
