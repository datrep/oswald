// test/pause-alert-verdict.test.js — 2026-10-27.
//
// THE FAILURE THIS PINS, measured: the desk sat behind a latched UI Fallback Pause from 15:13 to 21:14 — nearly six
// hours, 7 entries refused — after ONE alert at the transition. The rule was deliberately transition-only, on the
// sound reasoning that per-poll alerting becomes noise. The reasoning was right and the outcome was silence, because
// a rule that fires once for a condition that persists is a receipt, not a notification.
//
// And `bridge.pausedAt` was being rewritten on every failure — 12 writes against 2 changes of `paused` — so the
// field `selfHealth` uses to print the pause AGE was a moving number. That is why the panel never looked alarming.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pauseAlertVerdict, REALERT_AFTER_MS } = require('../trading/plus500/health');

const T0 = Date.parse('2026-10-25T15:13:11Z');
const at = (mins) => T0 + mins * 60000;

test('the transition pages exactly once', () => {
  assert.strictEqual(pauseAlertVerdict({ wasPaused: false, nowPaused: true, pausedSince: new Date(T0).toISOString(), now: at(0) }), 'transition');
});

test('a NOT-paused gate never pages', () => {
  assert.strictEqual(pauseAlertVerdict({ wasPaused: false, nowPaused: false, now: at(0) }), null);
  assert.strictEqual(pauseAlertVerdict({ wasPaused: true, nowPaused: false, pausedSince: new Date(T0).toISOString(), now: at(0) }), null);
});

test('THE SIX-HOUR SILENCE: a held pause re-pages once an hour, not on every poll', () => {
  const held = { wasPaused: true, nowPaused: true, pausedSince: new Date(T0).toISOString(), pausedAlertAt: new Date(T0).toISOString() };
  // inside the first hour: silent, however many polls happen
  for (const m of [1, 5, 15, 30, 59]) {
    assert.strictEqual(pauseAlertVerdict({ ...held, now: at(m) }), null, `minute ${m} must be silent`);
  }
  // at and past the hour: one page
  assert.strictEqual(pauseAlertVerdict({ ...held, now: at(61) }), 're_alert');
  // and then silent again for the next hour, because the caller records pausedAlertAt
  assert.strictEqual(pauseAlertVerdict({ ...held, pausedAlertAt: new Date(at(61)).toISOString(), now: at(90) }), null);
  assert.strictEqual(pauseAlertVerdict({ ...held, pausedAlertAt: new Date(at(61)).toISOString(), now: at(122) }), 're_alert');
});

test('a held pause with NO recorded alert re-pages immediately rather than staying silent for ever', () => {
  // the legacy row: latched from a code path that never wrote pausedAlertAt
  assert.strictEqual(pauseAlertVerdict({ wasPaused: true, nowPaused: true, pausedSince: new Date(T0).toISOString(), pausedAlertAt: null, now: at(61) }), 're_alert');
});

test('the re-alert window is an hour and is a parameter, not a literal in the caller', () => {
  assert.strictEqual(REALERT_AFTER_MS, 3600000);
  const held = { wasPaused: true, nowPaused: true, pausedSince: new Date(T0).toISOString(), pausedAlertAt: new Date(T0).toISOString() };
  assert.strictEqual(pauseAlertVerdict({ ...held, now: at(5), reAlertAfterMs: 60000 }), 're_alert');
});
