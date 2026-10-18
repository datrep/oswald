// test/supervise-policy.test.js — pins for the supervisor auto-restart policy (trading/scripts/supervise-policy.js).
//
// THE CLAIM: the supervisor may restart the desk ONLY when the desk is provably gone. The two cases that
// must NEVER restart are the ones where a live process could be mid-order; and report-only must remain the
// default without the flag. Before 2026-10-06 the flag changed only the alert TEXT (restartTrading() was
// never called) — these pins exist so the control cannot go inert again without a failure.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { decideAutoRestart, decideHungRestart } = require('../trading/scripts/supervise-policy');

test('report-only without the flag — even when down with no process', () => {
  const r = decideAutoRestart({ restartFlag: false, state: 'down', pidAlive: false });
  assert.equal(r.act, false);
  assert.match(r.reason, /report-only/);
});

test('down + process gone -> RESTART (the silent-death case)', () => {
  const r = decideAutoRestart({ restartFlag: true, state: 'down', pidAlive: false });
  assert.equal(r.act, true);
  assert.match(r.reason, /no live process/);
});

test('down + pid ALIVE (wedged) -> HOLD — killing a live desk can strand an order', () => {
  const r = decideAutoRestart({ restartFlag: true, state: 'down', pidAlive: true });
  assert.equal(r.act, false);
  assert.match(r.reason, /ALIVE/);
});

test('hung (port up, heartbeat stale, process alive) -> HOLD', () => {
  const r = decideAutoRestart({ restartFlag: true, state: 'hung', pidAlive: true });
  assert.equal(r.act, false);
  assert.match(r.reason, /hung/);
});

test('hung with claimed dead pid still HOLD — hung is always operator-decided', () => {
  // (A hung reading with a dead pid is a transient/oddity; the conservative branch wins.)
  const r = decideAutoRestart({ restartFlag: true, state: 'hung', pidAlive: false });
  assert.equal(r.act, false);
});

test('up -> nothing', () => {
  const r = decideAutoRestart({ restartFlag: true, state: 'up', pidAlive: true });
  assert.equal(r.act, false);
});

test('10-minute backoff after a recent auto-restart', () => {
  const r = decideAutoRestart({ restartFlag: true, state: 'down', pidAlive: false, recentAutoRestart: true });
  assert.equal(r.act, false);
  assert.match(r.reason, /backing off/);
});

test('unknown state -> never acts', () => {
  const r = decideAutoRestart({ restartFlag: true, state: 'weird', pidAlive: false });
  assert.equal(r.act, false);
});

// ── stale-heartbeat escalation lane (decideHungRestart, added 2026-10-07) ─────────────────────────────

test('hung lane: OFF by default — hung desks stay operator-decided', () => {
  const r = decideHungRestart({ restartHungFlag: false, hbAgeMs: 20 * 60000, pidAlive: true });
  assert.equal(r.act, false);
  assert.match(r.reason, /OFF/);
});

test('hung lane: stale below threshold -> hold', () => {
  const r = decideHungRestart({ restartHungFlag: true, hbAgeMs: 3 * 60000, pidAlive: true });
  assert.equal(r.act, false);
  assert.match(r.reason, /below/);
});

test('hung lane: stale >= 10 min with a live pid -> RESTART (opted in)', () => {
  const r = decideHungRestart({ restartHungFlag: true, hbAgeMs: 12 * 60000, pidAlive: true });
  assert.equal(r.act, true);
  assert.match(r.reason, /live pid/);
});

test('hung lane: honours the 10-minute backoff', () => {
  const r = decideHungRestart({ restartHungFlag: true, hbAgeMs: 12 * 60000, pidAlive: true, recentAutoRestart: true });
  assert.equal(r.act, false);
  assert.match(r.reason, /backing off/);
});

test('hung lane: dead pid is the down lane\'s case, not this one', () => {
  const r = decideHungRestart({ restartHungFlag: true, hbAgeMs: 12 * 60000, pidAlive: false });
  assert.equal(r.act, false);
  assert.match(r.reason, /down lane/);
});
