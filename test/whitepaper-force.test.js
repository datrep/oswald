// TRD-WP-1 (#1502, 2026-10-02): the FORCE path — Generate now / black swan must be able to REWRITE a
// current-period tier, while the auto (wake) path stays period-throttled so nothing rewrites silently.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { periodGate } = require('../trading/agent/whitepaper');

const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'whitepaper.js'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '..', 'trading', 'routes.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'trading', 'public', 'js', 'app.js'), 'utf8');
const wake = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'wakePipeline.js'), 'utf8');

test('the gate throttles WITHOUT force, and the SAME inputs pass WITH force', () => {
  const existing = { payload: { period: 'W40' } };
  assert.equal(periodGate(existing, 'W40', false), true, 'same period, no force → throttled (unchanged behaviour)');
  assert.equal(periodGate(existing, 'W40', true), false, 'same period, force → REWRITES (the fix)');
  assert.equal(periodGate(existing, 'W41', false), false, 'a new period always writes');
  assert.equal(periodGate(null, 'W40', false), false, 'nothing written yet');
});

test('★ wiring: force flows through BOTH manual paths, and the AUTO path stays throttled', () => {
  assert.match(src, /async function generate\(userId, settings, tier, \{ force = false \} = \{\}\)/);
  assert.match(src, /if \(periodGate\(existing, period, force\)\) return existing;/);
  assert.match(src, /async function ensureCurrent\(userId, settings, \{ force = false \} = \{\}\)/);
  assert.match(src, /generate\(userId, settings, tier, \{ force \}\)/);
  // the black-swan comment claimed "force" for months while the call was throttled — it must FORCE now
  assert.match(src, /await ensureCurrent\(userId, settings, \{ force: true \}\);/);
  // the route accepts the flag; the dashboard button SENDS it (manual key = explicit human action)
  assert.match(routes, /const force = \(req\.body \|\| \{\}\)\.force === true;/);
  assert.match(app, /apiPost\('\/api\/trading\/whitepaper\/generate', \{ force: true \}\)/);
  // the wake cadence must NEVER force — an auto rewrite would move study inputs silently
  assert.match(wake, /ensureCurrent\(userId, settings\)/, 'the auto path stays throttled');
});
