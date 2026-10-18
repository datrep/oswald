// test/bridge-park.test.js — the operator PARK control (2026-10-03, owner-authorized build).
//
// One switch stops every browser-facing loop; UNPARKED BEHAVIOUR IS UNCHANGED — every gate is an
// early return behind `settings.bridge.parked`. These are SOURCE PINS in the house style: each
// component's gate must exist, and the capture gate must sit BEFORE the cold-start, because capture
// is the only path that launches Chrome by design (`browser.newPage()` → `connectOrLaunch`).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'trading', p), 'utf8');

test('capture refuses while parked, and the gate sits BEFORE the newPage() cold-start', () => {
  const src = read('plus500/capture.js');
  const gate = src.indexOf("reason: 'parked'");
  const launch = src.indexOf('await browser.newPage()');
  assert.ok(gate > -1, 'captureOnce has a parked gate');
  assert.ok(launch > -1, 'the cold-start call still exists');
  assert.ok(gate < launch, 'the parked gate precedes the newPage() launch');
});

test('mirror cycle stands down while parked (standing down = no reads, no navigation)', () => {
  const src = read('agent/mirrorPoller.js');
  assert.match(src, /settings\.bridge\?\.parked/, 'cycle checks the park flag');
  assert.match(src, /reason: 'parked'/, 'the stand-down is logged once per transition');
});

test('account poller returns parked before touching chromeAlive/newPage', () => {
  const src = read('agent/accountPoller.js');
  const fn = src.indexOf('async function pollOnce');
  assert.ok(fn > -1, 'pollOnce exists');
  const gate = src.indexOf("skipped: 'parked'", fn);
  const alive = src.indexOf('chromeAlive()', fn);
  assert.ok(gate > -1 && alive > -1 && gate < alive, 'parked check precedes chromeAlive/newPage');
  assert.match(src, /parked = !!\(settings && settings\.bridge && settings\.bridge\.parked\)/, 'loop caches the flag from its one settings read');
});

test('sessionFeed never LAUNCHES chrome: the silence watch checks parked and first chromeAlive', () => {
  const src = read('plus500/sessionFeed.js');
  const watch = src.slice(src.indexOf('startSilenceWatch'));
  assert.match(watch, /bridge\.parked/, 'watch honors the park');
  assert.match(watch, /chromeAlive\(\)/, 'watch checks chromeAlive before re-attaching');
  const parkChk = watch.indexOf('bridge.parked');
  const aliveChk = watch.indexOf('chromeAlive()');
  const attachCall = watch.indexOf("attach('silence')");
  assert.ok(parkChk > -1 && aliveChk > -1 && attachCall > -1, 'all three exist in the watch');
  assert.ok(parkChk < attachCall && aliveChk < attachCall, 'both checks precede the re-attach');
  assert.match(src, /attach, detach \}/, 'detach is exported for the park route');
});

test('waker: parked stops the loop, and no wake can bypass the runWake guard', () => {
  const src = read('agent/waker.js');
  assert.match(src, /settings\.bridge\?\.parked/, 'scheduleNext/start treat park as a stop');
  assert.match(src, /s\.bridge\?\.parked/, 'the tick treats park as a stop');
  const rw = src.slice(src.indexOf('async function runWake'), src.indexOf('async function runWake') + 900);
  assert.match(rw, /parked/, 'runWake refuses while parked (covers scheduled, alert and manual)');
});

test('routes expose the park control and the status field', () => {
  const src = read('routes.js');
  assert.match(src, /router\.post\('\/bridge\/park'/, 'the park route exists');
  assert.match(src, /kind: on \? 'bridge_park' : 'bridge_unpark'/, 'engage/clear is logged');
  assert.match(src, /parked: !!\(settings\.bridge \|\| \{\}\)\.parked/, 'GET /bridge publishes the flag');
});
