// test/trail-engage-commit-gate.test.js — 2026-10-19: the bridge gate belongs on the WRITE, not on the sample.
//
// WHAT HAPPENED. The engage loop early-returned unless the bridge was RESTING/OPERATIONAL and no wake was running.
// The first armed engage (Silver #1336) then sat on its +0.75R lock for three minutes, crossing above it four
// times, and the loop never sampled: one `missed_window` at 22:13:04, nothing else, and the bridge only reported
// RESTING again at 22:55:40Z. A phase sweep over the same ticks says the engage condition is reachable in 88% of
// phases overall and 100% for that trade — so the policy was never too tight, the sampler was not running.
//
// The decision half reads only `PriceTicks` from the database. Only the venue write needs the bridge. So the gate
// moved to immediately before `setPositionTrail`, it records WHY it blocked, and it retries on the next tick.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { commitGate } = require('../trading/agent/trailEngage');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'trailEngage.js'), 'utf8');

test('★ a busy bridge BLOCKS the commit, and says so by name', () => {
  const g = commitGate({ bridgeState: 'NAVIGATING' });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'bridge_busy');
  assert.strictEqual(g.state, 'NAVIGATING', 'the state is carried so the event can name it');
});

test('★ a wake in progress blocks the commit', () => {
  const g = commitGate({ bridgeState: 'RESTING', wakeInProgress: true });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'wake_in_progress');
});

test('★ an idle bridge allows it — both states the loop accepts', () => {
  assert.deepStrictEqual(commitGate({ bridgeState: 'RESTING' }), { ok: true, reason: null });
  assert.deepStrictEqual(commitGate({ bridgeState: 'OPERATIONAL' }), { ok: true, reason: null });
});

test('★ no state file is NOT a block — an unreadable state must not stop the venue write', () => {
  assert.deepStrictEqual(commitGate({ bridgeState: null }), { ok: true, reason: null });
});

test('★ the loop no longer skips the whole SAMPLE on bridge state or wake progress', () => {
  // The early returns are what starved the sampler. Their absence is the fix, so it is pinned.
  const tickBody = SRC.slice(SRC.indexOf('const tick = async () => {'), SRC.indexOf('// FIRE'));
  assert.ok(!/if \(waker\.status\(\)\.inProgress\) return;/.test(tickBody),
    'the tick must not early-return on a wake — the decision needs no bridge');
  assert.ok(!/!\['RESTING', 'OPERATIONAL'\]\.includes\(bs\.state\)\) return;/.test(tickBody),
    'the tick must not early-return on bridge state — only the commit is gated');
});

test('★ the gate is applied immediately before the venue write, and a block is recorded', () => {
  const at = SRC.indexOf('setPositionTrail(page, settings, t, {');
  const gateAt = SRC.indexOf('const gate = commitGate(');
  assert.ok(gateAt > -1 && at > -1 && gateAt < at, 'commitGate must run before setPositionTrail');
  assert.match(SRC, /store\.logEvent\(userId, 'trail_engage_blocked'/, 'a blocked commit is a named event');
});
