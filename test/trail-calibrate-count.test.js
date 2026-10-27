// test/trail-calibrate-count.test.js — 2026-10-20: the count is not a distance, so measure the ticket.
//
// WHAT HAPPENED. The first armed engage (Gold #1338, 2026-10-20T01:33Z) asked the venue for 305 pips, the card
// read a distance of 3.216 against the 3.84 the desk intended, and `setPositionTrail` refused — correctly — 61
// times over two hours. The fitted offset for Gold (0.79, measured 2026-09-30) no longer described the venue's
// arithmetic; the ticket implied ~0.166. The table's own note says the offset's cause is UNIDENTIFIED, so a new
// constant would go stale exactly the same way.
//
// The control is affine, so ONE read-back at a known count identifies it: observed = pip x count + offset.
// `calibrateCount` solves that for the count that would hit the target, and refuses anything it cannot justify.
const test = require('node:test');
const assert = require('node:assert');
const { calibrateCount } = require('../trading/agent/trailingStop');

test('★ the live Gold case calibrates in one step', () => {
  // 305 pips read as 3.216; the target was 3.8364 at pip 0.01.
  const r = calibrateCount({ count: 305, pip: 0.01, observedDistance: 3.216, targetDistance: 3.8364 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.corrected, 367, '305 + round((3.8364 - 3.216)/0.01)');
  assert.ok(Math.abs(r.predictedDistance - 3.8364) < 0.011, `predicted ${r.predictedDistance} must land on the target`);
  assert.ok(Math.abs(r.impliedOffset - 0.166) < 0.011, `the ticket's own offset was ~0.166, not the table's 0.79`);
});

test('★ it is symmetric — a venue that reads WIDE is corrected down', () => {
  // The table's own worst documented case: "asked for at 800 arrives at ~927, 16% wider".
  const r = calibrateCount({ count: 800, pip: 0.01, observedDistance: 9.27, targetDistance: 8.0 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.corrected < 800, `corrected ${r.corrected} must be below the requested 800`);
  assert.ok(Math.abs(r.predictedDistance - 8.0) < 0.011);
});

test('★ an exact read-back is left alone rather than nudged', () => {
  const r = calibrateCount({ count: 500, pip: 0.01, observedDistance: 4.9, targetDistance: 4.9 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_change');
});

test('★ a correction outside the venue window is REFUSED, never clamped', () => {
  const below = calibrateCount({ count: 30, pip: 0.01, observedDistance: 0.02, targetDistance: 0.10, minCount: 40 });
  assert.strictEqual(below.ok, false);
  assert.strictEqual(below.reason, 'corrected_below_venue_minimum', `corrected ${below.corrected} is under the venue floor of 40`);
  const above = calibrateCount({ count: 900, pip: 0.01, observedDistance: 8.2, targetDistance: 9.0, maxCount: 950 });
  assert.strictEqual(above.ok, false);
  assert.strictEqual(above.reason, 'corrected_above_venue_maximum');
});

test('★ unmeasured inputs are refused rather than guessed', () => {
  assert.strictEqual(calibrateCount({ count: 100, pip: 0.01 }).reason, 'unmeasured');
  assert.strictEqual(calibrateCount({ count: 100, pip: 0, observedDistance: 1, targetDistance: 2 }).reason, 'bad_inputs');
  // a target far below what the control already reads would imply a count of zero: refused, not clamped to 1
  assert.strictEqual(calibrateCount({ count: 2, pip: 100, observedDistance: 250, targetDistance: 50 }).reason, 'corrected_not_positive');
});
