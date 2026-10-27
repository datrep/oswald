'use strict';
// test/blackswan-verdict.test.js — 2026-10-23.
//
// THE DEFECT THIS PINS. The detector read yahoo 1h only and fired 29 times in 3h38m on 2026-10-23 announcing a
// Natural Gas crash. Measured: yahoo said +10.02% day-on-day while the venue's own series said -2.98% and its chart
// series -3.05% — and those two series were already 13% apart on 2026-10-22. A 10% threshold on a 13%-adrift series
// fires forever on nothing, and each firing attempted three white-paper regenerations.
//
// The rule is now: measure per venue, take the median, and treat two venues that disagree by more than the
// threshold as UNMEASURABLE rather than alarming. Silence beats a guess.
const test = require('node:test');
const assert = require('node:assert');
const { blackSwanVerdict } = require('../trading/agent/whitepaper');

const g = (gapPct) => ({ gapPct });

test('the measured case: yahoo says crash, the venue says nothing happened', () => {
  const v = blackSwanVerdict({ yahoo: g(10.02), plus500: g(-2.98), plus500_chart: g(-3.05) }, 10);
  assert.strictEqual(v.fire, false, 'a single misaligned source must not fabricate an alert');
  assert.strictEqual(v.reason, 'venues_disagree');
  assert.strictEqual(v.verified, false);
});

test('a real gap agreed by two venues DOES fire', () => {
  const v = blackSwanVerdict({ plus500: g(12.4), plus500_chart: g(11.9), yahoo: g(12.1) }, 10);
  assert.strictEqual(v.fire, true);
  assert.strictEqual(v.verified, true);
  assert.ok(Math.abs(v.gapPct - 12.1) < 0.001, `median expected 12.1, got ${v.gapPct}`);
});

test('one bad source does not outvote two good ones', () => {
  // yahoo alone screams; the two venue series agree just under the threshold and therefore do not alarm.
  const v = blackSwanVerdict({ yahoo: g(25), plus500: g(2.1), plus500_chart: g(2.3) }, 10);
  assert.strictEqual(v.fire, false);
  assert.strictEqual(v.reason, 'venues_disagree');
});

test('two venues that agree just over the threshold fire, and say they are unverified only if alone', () => {
  assert.strictEqual(blackSwanVerdict({ plus500: g(10.5), yahoo: g(10.4) }, 10).fire, true);
  const alone = blackSwanVerdict({ plus500: g(10.5) }, 10);
  assert.strictEqual(alone.fire, true, 'a single venue is all we have on some symbols — it may still fire');
  assert.strictEqual(alone.verified, false, 'but it must not claim verification it does not have');
});

test('no data is not an alarm, and an absent gap is not a zero', () => {
  assert.strictEqual(blackSwanVerdict({}, 10).fire, false);
  assert.strictEqual(blackSwanVerdict({}, 10).reason, 'no_data');
  assert.strictEqual(blackSwanVerdict({ yahoo: g(-18.2) }, 10).fire, true, 'a crash downwards counts too');
});

test('the threshold is the settings value, not a literal', () => {
  const q = { plus500: g(6), yahoo: g(6.2) };
  assert.strictEqual(blackSwanVerdict(q, 10).fire, false);
  assert.strictEqual(blackSwanVerdict(q, 5).fire, true, 'a 5% setting must fire on a 6% agreed gap');
});
