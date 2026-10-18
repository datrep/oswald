// test/kill-alert-default.test.js — TRD-OPS-2 (2026-10-01): omitting the alert flag must not mean silence.
//
// THE GAP. `setTier` took `alert = false`, so OMITTING the flag meant silence — the opposite of the rule the SAME
// FILE already states for `resolveAutoClose`: "the destructor is chosen by an explicit opt-out, never by an
// omission". Measured 2026-10-01: two automatic stops inherited that silence. `sim_disaster_floor` is a HARD kill
// (blocks entries AND closes the book), and the UI Fallback Pause had no alert path at all and LATCHES.
//
// ⚠ WHY NOT JUST DEFAULT TO TRUE. That would fire on every resume and on the smoke test, and an alert that cries
// on routine events is one that stops being read — which returns the original silence by a different route. The
// rule is about the TRANSITION, mirroring the UI Fallback Pause.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveAlert } = require('../trading/agent/killswitch');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('★★ STOPPING IS LOUD: off -> soft and off -> hard both alert on an omitted flag', () => {
  assert.equal(resolveAlert('soft', 'off', null), true);
  assert.equal(resolveAlert('hard', 'off', null), true);
});

test('★ soft -> hard alerts, because the book is now being closed', () => {
  assert.equal(resolveAlert('hard', 'soft', null), true);
});

test('★ RESUMING IS QUIET: a human just did it', () => {
  assert.equal(resolveAlert('off', 'soft', null), false);
  assert.equal(resolveAlert('off', 'hard', null), false);
  assert.equal(resolveAlert('soft', 'hard', null), false, 'relaxing to a less restrictive tier is not a stop');
});

test('★ an explicit boolean still wins — the opt-out exists, it is just no longer the DEFAULT', () => {
  // ⚠ `false` must silence a genuine stop (the smoke test depends on it) and `true` must alert on a resume.
  assert.equal(resolveAlert('hard', 'off', false), false, 'explicit false still silences');
  assert.equal(resolveAlert('off', 'hard', true), true, 'explicit true still alerts');
});

test('★★ the default is null, NOT false — omission and opt-out must stay distinguishable', () => {
  const src = code('trading/agent/killswitch.js');
  // ⚠ THE WHOLE FIX RESTS ON THIS. If the default were `false`, the omitted flag and the explicit opt-out would
  // be the same value and no rule could tell them apart — which is exactly how the silence arose.
  assert.match(src, /alert = null/, 'setTier must default the alert flag to null');
  assert.ok(!/alert = false/.test(src), 'and must NOT keep the old default');
});

test('★ the rule follows the precedent already in the same file, rather than inventing one', () => {
  const src = code('trading/agent/killswitch.js');
  // `resolveAutoClose` is the established shape: explicit opt-out, never an omission. Keeping the two side by side
  // means the next option added here has an obvious template to follow.
  assert.match(src, /function resolveAlert\(tier, currentTier, alert\)/);
  assert.match(src, /function resolveAutoClose\(tier, autoClose\)/);
  assert.match(src, /if \(typeof alert === 'boolean'\) return alert;/, 'explicit boolean wins');
});

test('the alert flag is actually USED, not merely computed', () => {
  const src = code('trading/agent/killswitch.js');
  const call = src.indexOf('resolveAlert(');
  const use = src.indexOf('if (shouldAlert)');
  assert.ok(call > -1 && use > call, 'the computed verdict must be what gates the alert');
  assert.ok(!/if \(alert\) \{/.test(src), 'the raw flag must no longer gate it directly');
});
