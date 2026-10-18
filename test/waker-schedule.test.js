// test/waker-schedule.test.js — the wake loop must not be STRANDABLE (2026-09-15).
//
// THE OUTAGE THIS PINS. The scheduler used to be one async setInterval callback whose LAST
// statement re-armed the loop, with `await store.getSettings()` above that statement and OUTSIDE
// the try — and the timer was already cleared BEFORE the await. One rejected settings read
// therefore left the desk with no timer, no deadline and no re-arm; and because the rejection
// escaped an async callback, it left no error record either.
//
// The live signature, 2026-09-15: the last wake COMPLETED normally at 10:18:26 (action none,
// llmCalled false), telemetry was still landing at 10:30:24, and no wake ever fired again. The
// process was healthy, every other loop kept writing, and /healthz answered `ok`.
//
// WHY THE ASSERTIONS ARE ON THE TIMER AND THE DEADLINE, and not on "is the loop running": that is
// exactly the question a stranded loop cannot answer. `status().running` reads `state.running`,
// which the old code left set to `true` precisely while it was dead. The only observations
// independent of the control are the timer it lost and the deadline it lost.
//
// Mutation check: move `scheduleNext(s || {})` out of the `finally` in `waker.tick()` and the
// first test fails on `state.loopTimer === null`.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const waker = require('../trading/agent/waker');
const pipe = require('../trading/agent/wakePipeline');
const log = require('../trading/agent/log');

// A tick may not reach SQL Server in a unit test — neither through the micro-wake probe nor
// through the failure log — or this file would depend on the database being up.
const noMicro = async () => {};

function quiet(t) {
  const original = log.error;
  log.error = async () => {};
  t.after(() => { log.error = original; });
  t.after(() => waker.stop());
}

// Arm a loop that is DUE right now: the state a stranded scheduler is found in is simply a
// deadline in the past with no timer.
function due() {
  waker.stop();
  waker.state.agentUserId = 1;
  waker.state.running = true;
  waker.state.loopTimer = null;
  waker.state.nextWakeAt = new Date(Date.now() - 1000).toISOString();
}

// --- the defect -------------------------------------------------------------

test('a FAILED settings read cannot strand the wake loop', async (t) => {
  quiet(t);
  due();

  await waker.tick({
    micro: noMicro,
    readSettings: async () => { throw new Error('Timeout: Request failed to complete in 15000ms'); },
  });

  assert.ok(waker.state.loopTimer, 'the loop must be RE-ARMED even though the read failed');
  assert.ok(waker.state.nextWakeAt, 'a fresh deadline must be set, not left null');
  assert.ok(Date.parse(waker.state.nextWakeAt) > Date.now(), 'the new deadline is in the future');
});

test('a failed read is RECORDED, not swallowed as an unhandled rejection', async (t) => {
  t.after(() => waker.stop());
  const original = log.error;
  const seen = [];
  log.error = async (uid, where, e) => { seen.push({ where, message: String(e && e.message) }); };
  t.after(() => { log.error = original; });
  due();

  await waker.tick({ micro: noMicro, readSettings: async () => { throw new Error('ETIMEOUT'); } });

  assert.strictEqual(seen.length, 1, 'exactly one failure record');
  assert.strictEqual(seen[0].where, 'wake_loop');
  assert.match(seen[0].message, /ETIMEOUT/);
});

// --- the behaviour that must NOT change -------------------------------------

test('a paused desk STOPS the loop instead of re-arming it', async (t) => {
  quiet(t);
  due();

  await waker.tick({
    micro: noMicro,
    readSettings: async () => ({ wake: { enabled: true, paused: true, intervalMinutes: 10 } }),
  });

  assert.strictEqual(waker.state.loopTimer, null, 'paused must not re-arm');
  assert.strictEqual(waker.state.running, false, 'paused clears the running flag, which the finally reads');
});

test('a tick BEFORE the deadline does no work and leaves the deadline alone', async (t) => {
  quiet(t);
  due();
  waker.state.nextWakeAt = new Date(Date.now() + 600000).toISOString();
  const deadline = waker.state.nextWakeAt;

  let read = false;
  await waker.tick({ micro: noMicro, readSettings: async () => { read = true; return {}; } });

  assert.strictEqual(read, false, 'an un-due tick must not read settings or wake the desk');
  assert.strictEqual(waker.state.nextWakeAt, deadline, 'the pending deadline is untouched');
});

test('a tick while a wake is IN FLIGHT keeps the overdue deadline for the next tick', async (t) => {
  quiet(t);
  t.after(() => pipe.finishWake({}, {}));
  due();
  const deadline = waker.state.nextWakeAt;
  pipe.beginWake(1, 'manual'); // pipelineStatus().running === true

  let read = false;
  await waker.tick({ micro: noMicro, readSettings: async () => { read = true; return {}; } });

  assert.strictEqual(read, false, 'no second wake may start while one is in flight');
  assert.strictEqual(waker.state.nextWakeAt, deadline, 'the overdue deadline survives for the next tick');
});

// --- the cadence the fallback uses ------------------------------------------

test('the fallback cadence is the default interval, not "never"', (t) => {
  quiet(t);
  waker.stop();
  waker.state.running = true;
  waker.scheduleNext({}); // what tick() passes when the settings read failed

  assert.ok(waker.state.loopTimer, 'a settings-less re-arm still arms');
  const inMin = (Date.parse(waker.state.nextWakeAt) - Date.now()) / 60000;
  // interval 10m with 30% jitter => 7..13 minutes.
  assert.ok(inMin > 6.5 && inMin < 13.5, `expected ~7-13 min, got ${inMin.toFixed(2)}`);
});

test('the LOGGED cadence is the SCHEDULED cadence - one implementation, not two', (t) => {
  t.after(() => waker.stop());
  // `|| 30` treats an explicit jitterPct of 0 as ABSENT. The startup log used to print the raw
  // setting, so it announced "jitter 0%" while the scheduler jittered by 30% - and an operator
  // reading "0%" expects a wake at exactly +10m, then diagnoses a stall at +11m that isn't one.
  assert.deepStrictEqual(waker.cadence({ wake: {} }), { intervalMin: 10, jitterPct: 0.3 });
  assert.deepStrictEqual(waker.cadence({ wake: { jitterPct: 0 } }), { intervalMin: 10, jitterPct: 0.3 });
  assert.deepStrictEqual(waker.cadence({ wake: { intervalMinutes: 5, jitterPct: 50 } }), { intervalMin: 5, jitterPct: 0.5 });
  assert.deepStrictEqual(waker.cadence(null), { intervalMin: 10, jitterPct: 0.3 });
});
