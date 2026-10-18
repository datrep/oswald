// test/bars-step-not-fatal.test.js — TRD-BAR-1: a housekeeping failure must not abort a trading wake.
//
// THE MEASUREMENT THAT CHANGED THE DIAGNOSIS. The `bars` step accounted for 51 of 67 failed wakes in 14 days, and
// the obvious reading — "the bars work is too slow" — is WRONG. Through the desk's own endpoint with the venue
// closed the whole step takes **197 ms**; every hot table is indexed (`TradingEvents(userId, createdAt)`,
// `EquityTicks(userId, at)`, and `PriceBars`' unique key matches the MERGE's ON clause column-for-column); and a
// census of the hottest reads returns in **44 ms**. The 60 s error is `shared/db.js`'s deliberate `requestTimeout`
// firing, and that file says of itself: "it is HEADROOM, not a cure... a larger timeout converts 'aborted request'
// into 'slow request'". The bars step is not the disease — it runs on EVERY wake while the other steps run less
// often, so it is simply the most frequent sampler of a database that stalls.
//
// ⚠⚠ AND ITS FAILURE WAS FATAL, WHICH IS THE ACTUAL BUG. A failed wake evaluates NO EXITS and NO POSITION REVIEW,
// so the desk stops managing open positions because a tick-prune did not finish. That is the same asymmetry the
// owner ruled on for the `floor` step on 2026-09-15, and the same reasoning `autoclose`'s budget carries: a wake
// that dies leaves the book unattended.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const PIPE = 'trading/agent/wakePipeline.js';

test('★ a failed bars step no longer rethrows — the wake carries on to exits and position review', () => {
  const src = code(PIPE);
  // Scope the assertion to the bars step's own catch block, so it cannot be satisfied by some other step.
  const at = src.indexOf("await step('bars'");
  assert.ok(at > 0, 'the bars step must still exist');
  const end = src.indexOf('\n    });', src.indexOf('bars_failed', at));
  const block = src.slice(at, end > at ? end : at + 4000);
  assert.match(block, /catch \(e\)/, 'the step must still catch its own failure');
  assert.match(block, /bars_failed/, 'and report it as a skip so the step mirror shows it');
  assert.doesNotMatch(block, /throw e;/, 'IT MUST NOT RETHROW: a tick-prune failure must not abort a trading wake');
  assert.match(block, /barsError = \{/, 'the failure must be recorded for the wake event');
  assert.match(block, /log\.error\(userId, 'bars_build'/, 'and still logged under the same kind, so bars_build readers are unaffected');
});

test('★ the swallowed failure stays VISIBLE — a degraded wake must not look like a clean one', () => {
  const src = code(PIPE);
  assert.match(src, /result\.barsError = barsError;/, 'the failure must be attached to the result');
  assert.match(src, /barsError: result\.barsError \|\| null,/, 'and must reach the wake payload');
  // Non-vacuity: the step must also return a `skipped` value, because that is what the step mirror renders.
  assert.match(src, /return \{ skipped: 'bars_failed', error: barsError\.message \};/);
});

test('the payload carries barsError, so a degraded wake is distinguishable from a clean one', () => {
  const { demoWakePayload } = require('../trading/agent/wakePipeline');
  const withErr = demoWakePayload('schedule', { action: 'none', reason: 'x', barsError: { message: 'Timeout: Request failed to complete in 60000ms', code: 'ETIMEOUT' } }, { symbols: [] }, 'open', 0);
  assert.strictEqual(withErr.barsError.code, 'ETIMEOUT');
  const clean = demoWakePayload('schedule', { action: 'none', reason: 'x' }, { symbols: [] }, 'open', 0);
  assert.strictEqual(clean.barsError, null, 'an absent failure is null, never undefined or a false object');
});

// ⚠ THE GUARD THAT MUST NOT BE WEAKENED WHILE DOING THIS. `step()`'s existing `optional` forgives a DEADLINE ONLY,
// and its own comment forbids widening it into "a blanket catch that hides real breakage". The bars tolerance is
// deliberately local to that step for exactly this reason, so this pins that `optional` was not changed.
//
// ⚠ AND IT CAN ONLY BE PINNED IN CODE: `code()` strips comments, so a comment cannot be asserted on. A first
// version of this test matched the explanatory SENTENCE and failed against a file where the code was perfectly
// correct — the same mistake class as pinning prose, one level down.
test('the `optional` contract is untouched: it still forgives a DEADLINE only', () => {
  const src = code(PIPE);
  assert.match(src, /if \(opts\.optional && e && e\.deadline === true\)/,
    'widening `optional` to any error would make every optional step a silent catch — the tolerance for bars is'
    + ' local to bars on purpose');
  // Non-vacuity: the contract must still exist as an escape hatch for the steps that DO use it.
  assert.match(src, /opts\.optional/, 'the option itself must remain');
  assert.ok(!/opts\.optional && e(?! && e\.deadline)/.test(src), '`optional` must never forgive a non-deadline error');
});
