// test/waker-staleness.test.js — TRD-51 fix 3, 2026-09-14.
//
// The dead-man switch watched `waker.status().lastWakeAt`, and finishWake() advances that
// inside a `finally` — so a wake that THREW reset the very clock that exists to notice it.
//
// The live evidence, 2026-09-14: eight consecutive wakes died before reaching the LLM
// (09:37:45 -> 13:05:38 SGT, every one `bars_build` ETIMEOUT, while the desk held a live Gold
// position). TradingPrompts rows in that window: ZERO. The watchdog's staleness age stayed
// around ten minutes throughout and it only paged at 12:07 because ONE pair of consecutive
// ATTEMPTS happened to straddle 86 minutes — so the alert arrived four hours in, on a
// technicality, and understated the outage.
//
// Two clocks, two questions:
//   lastWakeAt    = "when did we last TRY"      (the pipeline mirror wants this)
//   lastSuccessAt = "when did we last WORK"     (the alarm must watch this)
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { wakerStaleness } = require('../trading/agent/watchdog');
const pipe = require('../trading/agent/wakePipeline');

const MIN = 60000;
const NOW = Date.parse('2026-09-14T13:30:00.000Z');
const agoMin = (m) => new Date(NOW - m * MIN).toISOString();

// --- the policy ------------------------------------------------------------

test('TRD-51: the alarm measures the last SUCCESS, not the last attempt', () => {
  // The exact shape of the outage: the loop tried 8 minutes ago and last WORKED 233 minutes
  // ago (09:37:45 -> 13:30). The old clock read 8.
  const clock = wakerStaleness({ lastWakeAt: agoMin(8), lastSuccessAt: agoMin(233), startedAt: agoMin(400), now: NOW });
  assert.strictEqual(Math.round(clock.ageMin), 233, 'ageMin must be the SUCCESS age');
  assert.strictEqual(clock.baselineKind, 'last_success');
  assert.strictEqual(Math.round(clock.attemptAgeMin), 8, 'the attempt age is still reported, as context');
  assert.strictEqual(Math.round(clock.successAgeMin), 233);
  assert.strictEqual(clock.neverSucceeded, false);
});

test('TRD-51: a recent failed attempt cannot soften the verdict', () => {
  // 4 hours of failure with a failed attempt 30 seconds ago: still stale.
  const clock = wakerStaleness({ lastWakeAt: agoMin(0.5), lastSuccessAt: agoMin(240), startedAt: agoMin(300), now: NOW });
  assert.ok(clock.ageMin > 240 - 1);
});

test('TRD-51: a healthy desk reads a small age off the success clock', () => {
  const clock = wakerStaleness({ lastWakeAt: agoMin(3), lastSuccessAt: agoMin(3), startedAt: agoMin(500), now: NOW });
  assert.strictEqual(Math.round(clock.ageMin), 3);
  assert.strictEqual(clock.baselineKind, 'last_success');
});

test('TRD-51: a desk that has NEVER completed a wake is measurable, not "no_wake_yet"', () => {
  // Without the startedAt fallback this desk is silent forever — which is strictly worse than
  // the bug being fixed: every wake fails and the watchdog says "no wake yet".
  const clock = wakerStaleness({ lastWakeAt: agoMin(120), lastSuccessAt: null, startedAt: agoMin(121), now: NOW });
  assert.strictEqual(clock.baselineKind, 'waker_start');
  assert.strictEqual(clock.neverSucceeded, true);
  assert.strictEqual(Math.round(clock.ageMin), 121);
  assert.strictEqual(clock.successAgeMin, null, 'no success has an age of null, not 0');
});

test('TRD-51: nothing to measure reports null — never a healthy-looking 0', () => {
  const clock = wakerStaleness({ lastWakeAt: null, lastSuccessAt: null, startedAt: null, now: NOW });
  assert.strictEqual(clock.ageMin, null);
  assert.strictEqual(clock.baselineKind, 'none');
  // 0 would compare <= maxGapMin and read as healthy; null forces the caller to skip.
  assert.notStrictEqual(clock.ageMin, 0);
});

test('TRD-51: a malformed timestamp is treated as absent rather than as the epoch', () => {
  // new Date('nonsense').getTime() is NaN; NaN <= maxGapMin is false, which would alarm —
  // but NaN arithmetic also poisons the reported age. Absent is the honest reading.
  const clock = wakerStaleness({ lastWakeAt: 'not-a-date', lastSuccessAt: 'not-a-date', startedAt: agoMin(90), now: NOW });
  assert.strictEqual(clock.baselineKind, 'waker_start');
  assert.strictEqual(Math.round(clock.ageMin), 90);
});

// --- the mechanism: finishWake must not advance the success clock on failure ---

test('TRD-51: finishWake advances lastWakeAt on a FAILED wake but NOT lastSuccessAt', () => {
  pipe.beginWake(1, 'schedule');
  pipe.finishWake({ error: 'Timeout: Request failed to complete in 15000ms' }, { failed: true });
  const st = pipe.pipelineStatus();
  assert.ok(st.lastWakeAt, 'the attempt clock records every attempt');
  assert.strictEqual(st.lastSuccessAt, null, 'a failed wake must not look like a successful one');
  assert.strictEqual(st.neverSucceeded, true);
  assert.strictEqual(st.last && st.last.failed, true, 'the wake record carries its own failure flag');
});

test('TRD-51: a later SUCCESS advances lastSuccessAt', () => {
  pipe.beginWake(1, 'schedule');
  pipe.finishWake({ action: 'none', reason: 'no_signal' });
  const st = pipe.pipelineStatus();
  assert.ok(st.lastSuccessAt, 'a completed wake sets the success clock');
  assert.strictEqual(st.neverSucceeded, false);
  assert.strictEqual(st.last && st.last.failed, false);
});

test('TRD-51: the success clock is not moved BACKWARDS by an older failure', () => {
  const before = pipe.pipelineStatus().lastSuccessAt;
  pipe.beginWake(1, 'schedule');
  pipe.finishWake({ error: 'boom' }, { failed: true });
  const after = pipe.pipelineStatus().lastSuccessAt;
  assert.strictEqual(after, before, 'a failure leaves the last known success intact');
});

test('TRD-51: startedAt is stamped on the first attempt and kept', () => {
  const st = pipe.pipelineStatus();
  assert.ok(st.startedAt, 'the first beginWake sets the waker-start baseline');
});

// --- naming the failing step ------------------------------------------------

test('TRD-51: the failing step is the LAST step carrying an error', () => {
  const rec = { steps: [{ name: 'capture' }, { name: 'bars_build', error: 'ETIMEOUT' }, { name: 'wake_loop' }] };
  assert.strictEqual(pipe.failingStep(rec).name, 'bars_build');
});

test('TRD-51: no error anywhere yields null, not the last step recorded', () => {
  // The queue can still be appending when an error unwinds, so "the last step" and "the step
  // that failed" are genuinely different questions. Naming a healthy step would send the
  // operator to the wrong place.
  assert.strictEqual(pipe.failingStep({ steps: [{ name: 'capture' }, { name: 'quant' }] }), null);
  assert.strictEqual(pipe.failingStep({ steps: [] }), null);
  assert.strictEqual(pipe.failingStep(null), null);
  assert.strictEqual(pipe.failingStep({}), null);
});
