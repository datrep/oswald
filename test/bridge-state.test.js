// test/bridge-state.test.js — pins for the bridge state machine v0 (TRD-BRG-1 #1511).
// Design: trading/docs/bridge-state-machine-REPORT-FOR-REFINEMENT-2026-10-03.md Rev 2.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { deriveBridgeState } = require('../trading/plus500/bridgeState');

const NOW = '2026-10-05T10:00:00.000Z';
const ago = (ms) => new Date(new Date(NOW).getTime() - ms).toISOString();

test('no chrome, no intent -> OFF, category DEAD', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: false, attached: false }, null);
  assert.equal(r.state, 'OFF');
  assert.equal(r.category, 'DEAD');
});

test('fresh launch intent, not yet attached -> LAUNCHING (DEGRADED while in flight)', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: true, attached: false, launchIntentAt: ago(30000) }, null);
  assert.equal(r.state, 'LAUNCHING');
  assert.equal(r.category, 'DEGRADED');
});

test('stale launch intent with no attach -> WEDGED (attach_timeout), DEAD', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: true, attached: false, launchIntentAt: ago(120000) }, null);
  assert.equal(r.state, 'WEDGED');
  assert.equal(r.cause, 'attach_timeout');
  assert.equal(r.category, 'DEAD');
});

test('attached and quiet -> RESTING, OPERATIONAL, healthySince set', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true, pageUrl: '/open-positions' }, null);
  assert.equal(r.state, 'RESTING');
  assert.equal(r.category, 'OPERATIONAL');
  assert.equal(r.healthySince, NOW);
});

test('fresh watchdog logout verdict -> LOGGED_OUT, DEAD', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true, loginVerdict: 'false', lastLoginCheckAt: ago(60000) }, null);
  assert.equal(r.state, 'LOGGED_OUT');
  assert.equal(r.category, 'DEAD');
});

test('stale logout verdict is ignored (15 min bound)', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true, loginVerdict: 'false', lastLoginCheckAt: ago(16 * 60000) }, null);
  assert.equal(r.state, 'RESTING');
});

test('fresh capture timeout -> WEDGED(capture_timeout); with recovery in flight -> DEGRADED, not DEAD', () => {
  const base = { now: NOW, chromeAlive: true, attached: true, lastCaptureErr: { kind: 'capture_timeout', at: ago(60000) } };
  const cold = deriveBridgeState(base, null);
  assert.equal(cold.state, 'WEDGED');
  assert.equal(cold.category, 'DEAD');
  const recovering = deriveBridgeState({ ...base, recovery: { active: true, cause: 'page_swap', startedAt: ago(30000) } }, null);
  assert.equal(recovering.state, 'WEDGED');
  assert.equal(recovering.category, 'DEGRADED');
  assert.equal(recovering.modifiers.recoveryCause, 'page_swap');
});

test('navigation within the settle window -> NAVIGATING', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true, lastNavAt: ago(3000) }, null);
  assert.equal(r.state, 'NAVIGATING');
});

test('parked wins every category: parked + logged out stays QUIET', () => {
  const r = deriveBridgeState({
    now: NOW, chromeAlive: true, attached: true, parked: true, parkedAt: ago(600000),
    loginVerdict: 'false', lastLoginCheckAt: ago(60000),
  }, null);
  assert.equal(r.category, 'QUIET');
});

test('health pause -> DEGRADED', () => {
  const r = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true, healthPaused: true, pausedAt: ago(60000) }, null);
  assert.equal(r.category, 'DEGRADED');
});

test('healthySince carries while OPERATIONAL and resets on exit', () => {
  const first = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true }, null);
  const still = deriveBridgeState({ now: '2026-10-05T10:01:00.000Z', chromeAlive: true, attached: true }, first);
  assert.equal(still.healthySince, NOW, 'carried while operational');
  const gone = deriveBridgeState({ now: '2026-10-05T10:02:00.000Z', chromeAlive: false, attached: false }, still);
  assert.equal(gone.healthySince, null, 'reset on exit');
  const back = deriveBridgeState({ now: '2026-10-05T10:03:00.000Z', chromeAlive: true, attached: true }, gone);
  assert.equal(back.healthySince, '2026-10-05T10:03:00.000Z', 're-entered now');
});

test('changed flag drives the transition journal', () => {
  const a = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true }, null);
  const b = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true }, a);
  assert.equal(b.changed, false);
  const c = deriveBridgeState({ now: NOW, chromeAlive: true, attached: true, parked: true }, b);
  assert.equal(c.changed, true);
  assert.equal(c.prevState, 'RESTING');
});
