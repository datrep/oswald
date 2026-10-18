// test/exit-classification.test.js — TRD-EXI-1 (#1490).
//
// The classification exists because an exit rule was argued about twice on unmeasurable evidence. The tests below
// are anchored on the REAL closed rows that caused the argument, so the classes cannot drift into meaning
// something convenient.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyClose, COUNTERFACTUAL_HORIZON_HOURS } = require('../trading/agent/autopsy');

test('the horizon is declared, not chosen after the numbers were seen', () => {
  assert.strictEqual(COUNTERFACTUAL_HORIZON_HOURS, 24);
});

test('#1137 is a near_stop_cut, and its R is negative but better than a full stop-out', () => {
  // Gold sell: entry 4,169.81, stop 4,184.7868 (R = 14.9768), target 4,145.5944, closed 4,181.55
  const c = classifyClose({ direction: 'sell', entry: 4169.81, stopPrice: 4184.7868, takeProfitPrice: 4145.5944, closePrice: 4181.55 });
  assert.strictEqual(c.closeClass, 'near_stop_cut');
  assert.ok(Math.abs(c.pnlR - -0.7839) < 0.001); // cut at 0.78R rather than the stop's 1.0R
  assert.ok(Math.abs(c.stopDistR - 0.2161) < 0.001); // 3.24 away = 0.22R inside the stop
  assert.strictEqual(c.targetDistR > 2, true);
});

test('#1097 is target_booked, NOT a cut - the row that contaminated the first tally', () => {
  // Gold sell: entry 4,224.41, stop 4,232.4494, target 4,187.8646, closed 4,187.55
  // The close sits ON the target. Counting this as a "forfeited winner" is what inflated the HURT column.
  const c = classifyClose({ direction: 'sell', entry: 4224.41, stopPrice: 4232.4494, takeProfitPrice: 4187.8646, closePrice: 4187.55 });
  assert.strictEqual(c.closeClass, 'target_booked');
  assert.ok(c.pnlR > 4); // a big winner on a small R - the R here is only 8.04
  assert.ok(c.stopDistR > 5);
});

test('a stop-out is named as the venue doing its job, not as a desk decision', () => {
  const c = classifyClose({ direction: 'sell', entry: 100, stopPrice: 102, takeProfitPrice: 97.6, closePrice: 102 });
  assert.strictEqual(c.closeClass, 'venue_stop');
  assert.strictEqual(c.pnlR, -1);
  assert.strictEqual(c.stopDistR, 0);
});

test('a discretionary exit away from BOTH levels is its own class', () => {
  // Oil #1134 closed at 89.83 against a stop of 90.9704 and a target of 88.3141 - neither level was involved
  const c = classifyClose({ direction: 'sell', entry: 89.76, stopPrice: 90.9704, takeProfitPrice: 88.3141, closePrice: 89.83 });
  assert.strictEqual(c.closeClass, 'mid_range_exit');
  assert.ok(Math.abs(c.pnlR - -0.0578) < 0.001);
});

test('a BUY uses the opposite excursions', () => {
  // buy: stop below, target above. Closing just under the target is near_target_cut; at the stop is venue_stop.
  const nearT = classifyClose({ direction: 'buy', entry: 100, stopPrice: 98, takeProfitPrice: 104, closePrice: 103.5 });
  assert.strictEqual(nearT.closeClass, 'near_target_cut');
  assert.ok(Math.abs(nearT.pnlR - 1.75) < 0.001);
  const atStop = classifyClose({ direction: 'buy', entry: 100, stopPrice: 98, takeProfitPrice: 104, closePrice: 98 });
  assert.strictEqual(atStop.closeClass, 'venue_stop');
});

test('a row that cannot be classified says so rather than guessing a class', () => {
  assert.strictEqual(classifyClose({ direction: 'sell', entry: 100, stopPrice: null, takeProfitPrice: 98, closePrice: 99 }).closeClass, 'unclassifiable');
  assert.strictEqual(classifyClose({ direction: 'sell', entry: 100, stopPrice: 100, takeProfitPrice: 98, closePrice: 99 }).closeClass, 'unclassifiable'); // zero R
  assert.strictEqual(classifyClose({ direction: 'sell', entry: null, stopPrice: 102, takeProfitPrice: 98, closePrice: 99 }).closeClass, 'unclassifiable');
  // a missing target is fine: the stop side can still be classified
  assert.strictEqual(classifyClose({ direction: 'sell', entry: 100, stopPrice: 102, takeProfitPrice: null, closePrice: 102 }).closeClass, 'venue_stop');
});
