// test/bridge-state-graph.test.js — pins for the state-machine GRAPH (trading/plus500/bridgeStateGraph.js).
//
// THE CLAIM THESE PINS MAKE: the picture cannot lie about where an arrow goes. For EVERY transition in the
// graph, a fixture drives `deriveBridgeState` and asserts the reducer lands exactly on the declared `to`
// state with the declared `cause` — so editing the reducer without updating the graph (or vice versa)
// fails HERE, not on the dashboard.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { deriveBridgeState, MECHANICAL } = require('../trading/plus500/bridgeState');
const { STATES, TRANSITIONS, MODIFIERS, CATEGORIES } = require('../trading/plus500/bridgeStateGraph');

const NOW = '2026-10-05T10:00:00.000Z';
const ago = (ms) => new Date(new Date(NOW).getTime() - ms).toISOString();

// One fixture per transition id — the minimal signals that must produce it.
const FIXTURES = {
  'launch-intent': { chromeAlive: true, attached: false, launchIntentAt: ago(30000) },
  'attach-ok': { attached: true },
  'attach-timeout': { chromeAlive: true, attached: false, launchIntentAt: ago(120000) },
  'cdp-unattached': { chromeAlive: true, attached: false, launchIntentAt: null },
  'chrome-gone': { chromeAlive: false, attached: false },
  'capture-wedge': { attached: true, lastCaptureErr: { kind: 'capture_timeout', at: ago(60000) } },
  'reads-resume': { attached: true, lastCaptureErr: { kind: 'capture_timeout', at: ago(6 * 60000) } },
  'login-death': { attached: true, loginVerdict: 'false', lastLoginCheckAt: ago(60000) },
  'login-ok': { attached: true, loginVerdict: 'true', lastLoginCheckAt: ago(60000) },
  'nav-start': { attached: true, lastNavAt: ago(5000) },
  'nav-settle': { attached: true, lastNavAt: ago(30000), feedBound: true },
  'nav-blank': { attached: true, lastNavAt: ago(60000), feedBound: false, loginVerdict: null },
  'blank-settle': { attached: true, lastNavAt: ago(500000) },
};

test('every transition has a fixture (the graph cannot grow without a proof)', () => {
  for (const t of TRANSITIONS) {
    assert.ok(FIXTURES[t.id], `no fixture for transition '${t.id}' — add one when adding the edge`);
  }
});

for (const t of TRANSITIONS) {
  test(`transition '${t.id}': ${t.from} -> ${t.to} (cause ${t.cause}) — reducer agrees`, () => {
    const r = deriveBridgeState({ now: NOW, ...FIXTURES[t.id] }, null);
    assert.equal(r.state, t.to, `expected state ${t.to}, got ${r.state}`);
    assert.equal(r.cause, t.cause, `expected cause '${t.cause}', got '${r.cause}'`);
  });
}

test('graph nodes cover exactly the reducer\'s mechanical states', () => {
  const graphIds = STATES.map((s) => s.id).sort();
  assert.deepEqual(graphIds, [...MECHANICAL].sort());
});

test('every edge points at declared states, ids unique, causes/fixtures consistent', () => {
  const ids = new Set();
  const stateIds = new Set(STATES.map((s) => s.id));
  for (const t of TRANSITIONS) {
    assert.ok(!ids.has(t.id), `duplicate transition id ${t.id}`);
    ids.add(t.id);
    assert.ok(stateIds.has(t.from), `${t.id}: unknown from ${t.from}`);
    assert.ok(stateIds.has(t.to), `${t.id}: unknown to ${t.to}`);
    assert.ok(t.cause && typeof t.cause === 'string', `${t.id}: cause required`);
    assert.ok(t.guard && t.guard.length > 10, `${t.id}: guard text required`);
  }
  // every state is reachable in the picture (has at least one inbound edge)
  for (const s of STATES) {
    assert.ok(TRANSITIONS.some((t) => t.to === s.id), `state ${s.id} has no inbound edge — unreachable in the picture`);
  }
});

test('modifier + category display metadata is complete for the page', () => {
  const modIds = MODIFIERS.map((m) => m.id);
  for (const want of ['isParked', 'healthPaused', 'isRecovering']) assert.ok(modIds.includes(want));
  const catIds = CATEGORIES.map((c) => c.id).sort();
  assert.deepEqual(catIds, ['DEAD', 'DEGRADED', 'OPERATIONAL', 'QUIET']);
  for (const c of CATEGORIES) assert.ok(c.rule && c.emoji, `category ${c.id} needs emoji + rule`);
});
