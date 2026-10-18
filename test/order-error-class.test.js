// test/order-error-class.test.js — the `other` bucket must stop hiding real conditions.
//
// Every string below is quoted from the desk's own TradingEvents (2026-09-10/11). The original
// classifier returned 'other' for all of them except the page.goto ones, which is why `other`
// was the largest failure bucket and why the 41% reject rate could not be acted on.
//
// The acceptance test is the last one: for the OBSERVED population, `other` is now EMPTY.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyBridgeError, isRetryable, NEEDS_RECONCILIATION } = require('../trading/connector/errorClass');

const err = (message, code) => {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
};

// --- the four real conditions hidden inside `other` -----------------------------
test('a close of something the venue no longer has is state_stale, not a bridge failure', () => {
  // observed x4: "open position not found for Bitcoin buy" — and corroborated by 38
  // phantom_fill events with missing_on_venue
  assert.equal(classifyBridgeError(err('open position not found for Bitcoin buy')), 'state_stale');
  assert.equal(classifyBridgeError(err('close: open position not found for Bitcoin buy')), 'state_stale');
});

test('a dead ticket field is dom_state', () => {
  assert.equal(classifyBridgeError(err('set-limits field did not enable: #close-at-loss-rate')), 'dom_state');
  assert.equal(classifyBridgeError(err('instrument row not visible for Sugar (category page missing too)')), 'dom_state');
});

test('an unknown submit outcome is its OWN class and needs reconciliation', () => {
  const cls = classifyBridgeError(err('position row did not appear after submit (order may have failed)'));
  assert.equal(cls, 'ambiguous');
  assert.ok(NEEDS_RECONCILIATION.has(cls), 'the one class that can leave an unmanaged position');
  assert.equal(isRetryable(cls), false, 'never blindly retry an unknown outcome — that is how you get two positions');
});

test('lifecycle stays retryable and is the ONLY retryable class', () => {
  const pg = err('page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to "https://app.plus500.com/trade"');
  assert.equal(classifyBridgeError(pg), 'lifecycle');
  assert.equal(isRetryable('lifecycle'), true);
  for (const c of ['state_stale', 'dom_state', 'ambiguous', 'preflight', 'policy', 'other']) {
    assert.equal(isRetryable(c), false, `${c} must not be retried`);
  }
  assert.equal(classifyBridgeError(err('page.goto: net::ERR_ABORTED at https://app.plus500.com/trade')), 'lifecycle');
  assert.equal(classifyBridgeError(err('page.evaluate: Execution context was destroyed, most likely because of a navigation')), 'lifecycle');
});

// --- precedence ------------------------------------------------------------------
test('an explicit err.code beats the message, because the caller knows more', () => {
  // These were being journalled as `other` even though the caller had already set a code.
  assert.equal(classifyBridgeError(err('preflight: instrument row visible but buy/sell buttons missing', 'preflight')), 'preflight');
  assert.equal(classifyBridgeError(err('ui_fallback_pause: entries are blocked until the bridge pause is resumed', 'policy_violation')), 'policy');
  // an unknown code must not be invented
  assert.equal(classifyBridgeError(err('something odd', 'weird_code')), 'other');
});

test('ambiguous outranks dom_state, and state_stale outranks lifecycle', () => {
  // "row did not appear" alone is a selector problem; "did not appear after submit" is not.
  assert.equal(classifyBridgeError(err('order row did not appear')), 'dom_state');
  assert.equal(classifyBridgeError(err('order row did not appear after submit')), 'ambiguous');
  // a stale-position message that also mentions a navigation is still a state problem
  assert.equal(classifyBridgeError(err('open position not found (page.goto navigated away)')), 'state_stale');
});

test('nonsense still lands in other — the residual stays honest', () => {
  assert.equal(classifyBridgeError(err('')), 'other');
  assert.equal(classifyBridgeError(null), 'other');
  assert.equal(classifyBridgeError(err('quantum flux')), 'other');
});

// --- TRD-42: the reconciliation contract, now load-bearing -----------------------
// executor.closeTrade forces a mirror reconcile when the class says the LEDGER DIVERGED. That set is
// deliberately tiny, and this pin exists so it cannot quietly grow: a reconcile costs a bridge
// navigation, and doing it for an execution or transport failure re-learns a state that never
// disagreed — while holding the lock a ticket would need.
test('only a diverged ledger forces a reconcile; a transport failure must not', () => {
  // The venue no longer holds the position, so the local open row is wrong.
  assert.ok(NEEDS_RECONCILIATION.has('state_stale'), 'a stale close means our ledger is lying');
  // The submit outcome is unknown, so we may hold something we do not know about.
  assert.ok(NEEDS_RECONCILIATION.has('ambiguous'), 'an unknown outcome is the dangerous one');
  for (const c of ['lifecycle', 'dom_state', 'preflight', 'policy', 'other']) {
    assert.equal(NEEDS_RECONCILIATION.has(c), false, `${c} must NOT force a reconcile`);
  }
});

// --- THE ACCEPTANCE TEST ---------------------------------------------------------
test('every failure text observed in the desk log now maps to a NAMED class, not other', () => {
  const observed = [
    'open position not found for Bitcoin buy',
    'close: open position not found for Bitcoin buy',
    'instrument row not visible for Sugar (category page missing too)',
    'page.goto: net::ERR_ABORTED at https://app.plus500.com/trade',
    'set-limits field did not enable: #close-at-loss-rate',
    'page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to "https://app.plus500.com/trade"',
    'position row did not appear after submit (order may have failed)',
    'page.evaluate: Execution context was destroyed, most likely because of a navigation',
  ];
  const classes = observed.map((m) => classifyBridgeError(err(m)));
  assert.ok(!classes.includes('other'), `unclassified in the observed population: ${observed.filter((m, i) => classes[i] === 'other').join(' | ')}`);
  assert.deepEqual(classes, ['state_stale', 'state_stale', 'dom_state', 'lifecycle', 'dom_state', 'lifecycle', 'ambiguous', 'lifecycle']);
});
