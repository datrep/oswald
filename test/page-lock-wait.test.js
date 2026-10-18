// test/page-lock-wait.test.js — TRD-83 (2026-09-22).
//
// ★ THE ROW'S TWO QUESTIONS, and both are now answered with measurements rather than inference.
//
// (a) WHY is the capture step ~100x every other wake step (106,472ms against a next-slowest of 1,160ms)?
//     IT IS A WAIT, NOT WORK. `captureOnce` parks on `pageLock.acquire('capture', {waitMs: 120000})` and the
//     step's duration folds in that wait. Measured from the desk's own `capture_lock_wait` telemetry since the
//     report was added: 21 events, average 12,532ms, maximum 28,513ms — and the holder was `mirror` on every
//     one of them. `"waitedOn":["mirror"]`. So a wake's quote capture waits behind the POSITION MIRROR's 60s
//     cycle, and the wait is not proportional to anything the capture does.
//
// (b) Are the wake path and `POST /capture` even the same code? YES.
//     `connector/browser.js:209` is literally `return capture.captureOnce(userId, settings);` and
//     `routes.js` calls `bridgeCapture.captureOnce(...)` directly. One frozen bridge starves both equally —
//     which is why a hand-run `POST /capture` returned 36 ticks in well under a second while a wake five
//     seconds later spent 106 seconds in the same function. Same code, different contention. The row's
//     hypothesis that they might be different code paths is REFUTED.
//
// And the second half of the row — "can hang forever when the page maps to no instruments" — is bounded by the
// same `waitMs`, which is why the two assertions below are about the LOCK rather than about the capture: if
// the lock stopped reporting who it waited on, the only actionable part of the number would be gone again, and
// if the budget were ever removed, "survivable" would stop being true.
//
// ⚠ Tested against the REAL lock module. It is in-process module state, so these tests acquire and release it;
// each releases what it takes, and the timeouts are short (a few hundred ms).
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pageLock = require('../trading/plus500/pageLock');

test('the premise: the lock is free at the start and can be taken', () => {
  // If a previous test leaked a claim, everything below would pass or fail for the wrong reason.
  assert.equal(pageLock.held(), false, 'the lock must be free — a leaked holder invalidates every assertion here');
  assert.equal(pageLock.tryAcquire('watchdog'), true);
  pageLock.release('watchdog');
  assert.equal(pageLock.held(), false, 'release must clear the claim');
});

test('★ acquire names the holder it waited on — the only actionable part of the number', async () => {
  // This is what the capture_lock_wait event stores as `waitedOn`. Without it the telemetry says "capture
  // waited 28.5s" and nothing can be done about it; with it, the answer is "behind the mirror" — an
  // OPPORTUNISTIC flow that is policy-bound to SKIP rather than hold, which is a different conversation.
  await pageLock.acquire('mirror');
  const pending = pageLock.acquire('capture', { waitMs: 5000 });
  // Release mid-wait so `waitedOn` is populated but the test does not sit for the full budget.
  setTimeout(() => pageLock.release('mirror'), 400);
  const lock = await pending;
  assert.deepEqual(lock.waitedOn, ['mirror'], 'the lock must report WHO held it while parked');
  assert.ok(lock.waitedMs >= 350, `expected a real wait, got ${lock.waitedMs}ms`);
  assert.equal(lock.acquired, true);
  assert.equal(pageLock.held(), true);
  assert.equal(pageLock.status().holder, 'capture');
  pageLock.release('capture');
  assert.equal(pageLock.held(), false);
});

test('★ the wait is BOUNDED — a held lock cannot hang a caller forever', async () => {
  // The row's hang: "can hang forever when the page maps to no instruments". Whatever wedges the tab, the
  // CALLER is bounded by its budget, and the failure is a named error rather than a silence. This is the
  // property that makes the per-step deadline (TRD-82) sufficient rather than merely helpful.
  await pageLock.acquire('mirror');
  await assert.rejects(
    () => pageLock.acquire('capture', { waitMs: 300 }),
    /lock wait exceeded/,
    'an exhausted budget must throw a named error naming the holder',
  );
  pageLock.release('mirror');
  assert.equal(pageLock.held(), false, 'a failed acquire must not leave a claim behind');
});

test('★ release is owner-checked, so a foreign flow cannot free someone else claim', async () => {
  // Policy depends on this: `mirror` and `watchdog` SKIP when the lock is held, so a mis-owned release would
  // silently unpark a waiting ticket and let two flows navigate one tab — the original 2026-09-11 defect that
  // killed an Oil entry ticket mid set-limits.
  await pageLock.acquire('ticket');
  pageLock.release('mirror');
  assert.equal(pageLock.held(), true, 'a foreign release must not clear the claim');
  assert.equal(pageLock.status().holder, 'ticket');
  pageLock.release('ticket');
  assert.equal(pageLock.held(), false);
});
