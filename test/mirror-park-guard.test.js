// test/mirror-park-guard.test.js — 2026-10-05 (#1511 / soft-nav): the mirror's park-back must NEVER
// reload the page while it is already parked. It used to `page.goto('/open-positions')` every 60 s
// cycle (~1,400 hard app-boots/day) — the desk's largest source of hard-navigation traffic on Plus500
// and the standing risk to the venue session (see trading/docs/incident-2026-10-05-chrome-exit-loop.md).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the mirror parks ONLY when off-park, and logs the rare real navigation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'mirrorPoller.js'), 'utf8');
  assert.match(src, /if \(!\/\\\/open-positions\/\.test\(here\)\) \{/, 'the off-park guard exists');
  assert.match(src, /source: 'mirror_park_nav'/, 'real park navigations are logged (countable)');
  // The goto must live INSIDE the guard: the guard line must appear before the goto.
  const guardAt = src.indexOf('if (!/\\/open-positions/.test(here)) {');
  const gotoAt = src.indexOf("page.goto('https://app.plus500.com/open-positions'");
  assert.ok(guardAt > -1 && gotoAt > -1, 'guard and goto both present');
  assert.ok(guardAt < gotoAt, 'the goto sits after (inside) the guard');
});

test('the venue-alerts mirror is cadence-throttled (1-in-5 cycles), not every cycle', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'mirrorPoller.js'), 'utf8');
  assert.match(src, /const ALERTS_READ_EVERY_CYCLES = 5;/, 'the cadence constant exists');
  assert.match(src, /if \(cyclesSinceAlertsRead >= ALERTS_READ_EVERY_CYCLES\) \{/, 'the alerts read sits behind the cadence gate');
  const gateAt = src.indexOf('if (cyclesSinceAlertsRead >= ALERTS_READ_EVERY_CYCLES) {');
  // 2026-10-18: the read now races its own deadline (withDeadline), so the call is no longer prefixed by a
  // bare `await ` — the invariant is that the read lives INSIDE the cadence gate, which is what the pin checks.
  const readAt = src.indexOf('webtrader.readPlus500Alerts(page)');
  assert.ok(gateAt > -1 && readAt > -1 && gateAt < readAt, 'the read is inside the gate');
});
