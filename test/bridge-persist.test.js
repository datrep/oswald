'use strict';
// bridge-persist.test.js — a failure streak does not need a SETTINGS WRITE to be counted.
//
// Measured 2026-10-27 from the settings journal: `bridge.consecutiveFails` was written **22 times in 4 days** against
// 2 actual changes of `bridge.paused`. The number is only consumed to decide whether it has reached `MAX_FAILS` (3),
// so 22 MERGEs + 22 journal rows + 22 dead-scope scans existed to record one integer.
const { test } = require('node:test');
const assert = require('node:assert');
const { shouldPersistBridge, MAX_FAILS } = require('../trading/plus500/health');

test('a change of the LATCH always persists — that is the safety-critical fact', () => {
  assert.equal(shouldPersistBridge({ prevCount: 2, nextCount: 3, wasPaused: false, nowPaused: true }), true);
  assert.equal(shouldPersistBridge({ prevCount: 0, nextCount: 0, wasPaused: true, nowPaused: false }), true);
});

test('the first failure of a streak persists, and the recovery to zero persists', () => {
  assert.equal(shouldPersistBridge({ prevCount: 0, nextCount: 1 }), true);
  assert.equal(shouldPersistBridge({ prevCount: 4, nextCount: 0 }), true);
});

test('an INTERMEDIATE count below MAX_FAILS does not persist — this is the churn that was removed', () => {
  // 1 -> 2 with the latch unchanged: nothing a reader or a restart needs.
  assert.equal(shouldPersistBridge({ prevCount: 1, nextCount: 2, wasPaused: false, nowPaused: false }), false);
});

test('a long outage still leaves a checkpoint once per MAX_FAILS', () => {
  assert.equal(shouldPersistBridge({ prevCount: MAX_FAILS - 1, nextCount: MAX_FAILS, wasPaused: true, nowPaused: true }), true);
  assert.equal(shouldPersistBridge({ prevCount: MAX_FAILS + 1, nextCount: MAX_FAILS + 2, wasPaused: true, nowPaused: true }), false);
  assert.equal(shouldPersistBridge({ prevCount: 2 * MAX_FAILS - 1, nextCount: 2 * MAX_FAILS, wasPaused: true, nowPaused: true }), true);
});

test('a re-alert must persist, or the retry page repeats every poll', () => {
  assert.equal(shouldPersistBridge({ prevCount: 5, nextCount: 5, wasPaused: true, nowPaused: true, reAlert: true }), true);
});

test('the write count over a 20-failure outage is bounded, not linear', () => {
  let writes = 0;
  let prev = 0;
  let paused = false;
  for (let n = 1; n <= 20; n++) {
    const nextPaused = paused || n >= MAX_FAILS;
    if (shouldPersistBridge({ prevCount: prev, nextCount: n, wasPaused: paused, nowPaused: nextPaused })) writes++;
    prev = n;
    paused = nextPaused;
  }
  // Was 20. Expected: the latch transition, the first failure, and one per MAX_FAILS afterwards.
  assert.ok(writes <= 9, `expected a bounded number of writes, got ${writes} for 20 failures`);
  assert.ok(writes >= 3, `the latch transition and checkpoints must still be recorded, got ${writes}`);
});
