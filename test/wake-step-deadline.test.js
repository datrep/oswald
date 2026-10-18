// test/wake-step-deadline.test.js — a hung step must not be able to strand the desk (2026-09-15).
//
// THE OUTAGE THIS PINS. Every unit of wake work runs inside `wakePipeline.step()`. If a step never
// settles, `run()` never resolves, `finishWake()` never runs, `live.wake.done` stays false - and the
// scheduler's re-arm sits AFTER `await runWake(...)`, so it is never reached. The desk then stops
// waking while looking entirely healthy.
//
// Measured twice in one afternoon. The `capture` step held the shared Plus500 bridge while the page map
// returned `hrefs: 0`; the mirror poller recorded `mirror_bridge_busy heldBy:capture` at 10:29:14; no
// tick was written and no wake event was recorded; and the desk was silent for 26 minutes. The same
// shape recurred live at 10:52 while this test was being written (`capture` RUNNING for 97s+).
//
// The chain that matters, and the one these tests walk end to end:
//     a step hangs -> the step FAILS with its name -> the wake finishes -> `running` clears
//     -> the scheduler is free to arm again
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pipe = require('../trading/agent/wakePipeline');
const { code } = require('./_source');

const NEVER = () => new Promise(() => {}); // settles only if abandoned

function record(name) {
  const st = pipe.pipelineStatus();
  const w = st.last || st.inFlight;
  return (w && Array.isArray(w.steps) ? w.steps : []).filter((s) => s.name === name).pop();
}

// A wake must be left clean for the next test / the process.
function endWake() {
  pipe.finishWake({}, { failed: true });
}

// --- the defect -------------------------------------------------------------

test('a step that NEVER settles is abandoned with its name, not left to hang the wake', async (t) => {
  t.after(endWake);
  pipe.beginWake(1, 'schedule');

  await assert.rejects(
    () => pipe.step('capture', NEVER, { timeoutMs: 30 }),
    /step 'capture' exceeded its 30ms deadline/,
  );

  const rec = record('capture');
  assert.ok(rec, 'the step is still in the wake record, so the failure is attributable');
  assert.match(rec.error, /exceeded its 30ms deadline/, 'the step names itself and its deadline');
  assert.strictEqual(rec.timeoutMs, 30, 'the deadline used is recorded, never a hidden default');
});

test('the deadline is recorded even though the step never returns a duration', async (t) => {
  t.after(endWake);
  pipe.beginWake(1, 'schedule');
  await assert.rejects(() => pipe.step('bars_build', NEVER, { timeoutMs: 20 }));
  const rec = record('bars_build');
  assert.ok(Number.isFinite(rec.ms), 'a failed step still reports how long it occupied the wake');
  assert.strictEqual(rec.timeoutMs, 20);
});

// --- the chain that unblocks the scheduler ----------------------------------

test('a wake that FAILED on a hung step still clears `running`, which is what frees the loop', () => {
  pipe.beginWake(1, 'schedule');
  assert.strictEqual(pipe.pipelineStatus().running, true, 'a wake is in flight');

  pipe.finishWake({ error: "step 'capture' exceeded its 120000ms deadline" }, { failed: true });

  assert.strictEqual(pipe.pipelineStatus().running, false, 'the scheduler is free to arm again');
  assert.strictEqual(pipe.pipelineStatus().neverSucceeded, true, 'a hung wake is NOT a success');
});

// --- what must NOT change ---------------------------------------------------

test('a step that finishes normally is untouched by the deadline', async (t) => {
  t.after(endWake);
  pipe.beginWake(1, 'schedule');

  const r = await pipe.step('quant', async () => ({ evaluated: 12, withSignal: 0 }), { timeoutMs: 50 });

  assert.deepStrictEqual(r, { evaluated: 12, withSignal: 0 }, 'the step value is returned unchanged');
  const rec = record('quant');
  assert.strictEqual(rec.error, undefined, 'a healthy step records no error');
  assert.ok(rec.ms >= 0);
});

test('a step that REJECTS passes its own error through, not a deadline error', async (t) => {
  t.after(endWake);
  pipe.beginWake(1, 'schedule');

  await assert.rejects(
    () => pipe.step('capture', async () => { throw new Error('ETIMEOUT'); }, { timeoutMs: 5000 }),
    /ETIMEOUT/,
  );
  assert.strictEqual(record('capture').error, 'ETIMEOUT', 'the real cause is preserved verbatim');
});

test('a falsy/absent timeoutMs disables the deadline rather than applying a silent one', async (t) => {
  t.after(endWake);
  pipe.beginWake(1, 'schedule');
  const r = await pipe.step('session', async () => ({ skipped: 'market_closed' }), { timeoutMs: 0 });
  assert.deepStrictEqual(r, { skipped: 'market_closed' });
  assert.strictEqual(record('session').skipped, 'market_closed', 'skip reasons still record');
});

// --- the default ------------------------------------------------------------

test('the default deadline is HALF the wake interval, with headroom over a REAL step', () => {
  const INTERVAL = 10 * 60000;
  // The derivation, not a taste: a step may not consume more than half an interval, or the desk cannot
  // hold its cadence even when every step succeeds.
  assert.strictEqual(pipe.DEFAULT_STEP_TIMEOUT_MS, INTERVAL / 2);
  // And the headroom must clear the slowest step actually measured: `capture` at 109,663ms (2026-09-15
  // 10:52). A deadline BELOW a legitimate step turns normal operation into failed wakes - a worse failure
  // than the hang it was meant to catch.
  assert.ok(pipe.DEFAULT_STEP_TIMEOUT_MS > 109663, 'must clear the slowest measured legitimate step');
});

// --- OPTIONAL steps: a MONITOR's hang must not cost the wake (2026-09-15) ---
//
// Measured live: the `floor` step (the desk's only automatic disaster-floor check) hit the 300s default
// twice in one hour - 18:53 and 19:09 - and each time the ENTIRE wake died: no bars, no quant, no
// deliberation, no execution. The same unreadable equity on the ERROR path kills nothing, because
// `monitorFloor` catches its own read failure and returns `skipped`. One condition, two opposite outcomes,
// decided only by whether the bridge failed fast or slow.

test('an OPTIONAL step degrades on its deadline instead of failing the wake', async (t) => {
  t.after(endWake);
  pipe.beginWake(1, 'schedule');

  const r = await pipe.step('floor', NEVER, { optional: true, timeoutMs: 25 });

  assert.strictEqual(r.skipped, 'timeout', 'the caller is TOLD the floor was not read');
  assert.strictEqual(r.timeoutMs, 25);
  const rec = record('floor');
  assert.strictEqual(rec.timedOut, true, 'the step record marks the timeout, so it stays attributable');
  assert.strictEqual(rec.timeoutMs, 25, 'and still records the deadline it used');
});

test('optional forgives a DEADLINE only - a step that really throws still fails the wake', async (t) => {
  t.after(endWake);
  pipe.beginWake(1, 'schedule');

  await assert.rejects(
    () => pipe.step('floor', async () => { throw new Error('equity read exploded'); }, { optional: true, timeoutMs: 500 }),
    /equity read exploded/,
    'optional must not become a blanket catch that hides real breakage',
  );
});

test('the deadline error is TAGGED, so no caller has to string-match the sentence', async () => {
  await assert.rejects(
    () => pipe.withDeadline(NEVER(), 20, 'floor'),
    (e) => {
      assert.strictEqual(e.deadline, true, 'the flag is what `optional` keys on, not the wording');
      assert.strictEqual(e.step, 'floor');
      return true;
    },
  );
});

test('the floor step is wired optional + bounded, and the bound is DERIVED', () => {
  const src = code('trading/agent/wakePipeline.js');
  assert.match(
    src,
    /const floorRes = await step\('floor',[\s\S]{0,1500}?\}, \{ optional: true, timeoutMs: FLOOR_STEP_TIMEOUT_MS \}\);/,
    'the disaster floor must be optional and carry its own bound',
  );
  assert.match(src, /disaster_floor_unread/, 'a floor that could not be read must leave a trace');
  // The derivation, not a taste: above the 45s `page.goto` timeout the desk already tolerates, and under
  // the step default. A bound BELOW a legitimate bridge read would turn normal operation into timeouts.
  assert.ok(pipe.FLOOR_STEP_TIMEOUT_MS > 45000, 'must clear the 45s page.goto timeout the desk tolerates');
  assert.ok(pipe.FLOOR_STEP_TIMEOUT_MS < pipe.DEFAULT_STEP_TIMEOUT_MS, 'and stay under the step default');
});
