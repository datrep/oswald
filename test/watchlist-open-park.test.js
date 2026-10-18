// test/watchlist-open-park.test.js — 4.12 (2026-10-03): park the shared tab after /watchlist/open.
//
// THE DEFECT: the route navigates the SHARED bridge tab to the requested instrument and returned
// with the tab left ON that instrument — every other shared-tab consumer assumes it rests on
// /open-positions (mirror + account pollers read positions/account strip there; the watchdog's
// in-place login fast path assumes a parked page). Same class as the pinned book-probe rule:
// "Parking MUST be in a finally: a probe that throws and leaves the tab on /open-orders silently
// disables the positions mirror for every other flow" (test/exe1-order-book-probe.test.js).
//
// THE PINS: the park lives in the route's finally (survives a throw), the race warning + response
// shape stay, and the never-disconnect rule stays stated (raw-file check — comments are stripped).
//
// Run with: npm run test:unit  (or: node --test test/watchlist-open-park.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const routes = nl(code('trading/routes.js'));

const rFrom = routes.indexOf("router.post('/watchlist/open'");
const rTo = routes.indexOf("router.post('/watchlist/toggle'", rFrom);
const route = rFrom >= 0 && rTo > rFrom ? routes.slice(rFrom, rTo) : '';

test('the /watchlist/open route exists and always parks the tab back on /open-positions', () => {
  assert.ok(route, 'the /watchlist/open route must exist');
  assert.match(route, /\} finally \{/, 'the park must survive a throw');
  const fin = route.indexOf('} finally {');
  const goto = route.search(/goto\('https:\/\/app\.plus500\.com\/open-positions'/);
  assert.ok(fin >= 0 && goto > fin, 'the park goto must live INSIDE the finally block');
  assert.match(route, /\.catch\(\(\) => \{\}\)/, 'the park must be failure-swallowing');
});

test('the route contract survives: race warning + chart title in the response', () => {
  assert.match(route, /WATCHLIST_OPEN_RACE_WARNING/);
  assert.match(route, /chartTitle: r\.chartTitle/);
});

test('the never-disconnect rule stays stated (checked on the raw file — comments are stripped)', () => {
  const raw = nl(fs.readFileSync(path.join(__dirname, '..', 'trading', 'routes.js'), 'utf8'));
  assert.match(raw, /no bridgeBrowser\.disconnect\(\)/);
});
