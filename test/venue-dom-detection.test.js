// test/venue-dom-detection.test.js — 2026-10-05 (#1511): the venue UI moved to ICON nav buttons and a
// collapsed account menu. These pins keep the desk's detection aligned with the LIVE DOM and keep the
// navigation-burst regression (demoPage goto-per-call) from returning.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('demoPage READS the current page first; the trade navigation is only a fallback', () => {
  const src = read('trading', 'connector', 'browser.js');
  const fnAt = src.indexOf('async function demoPage(settings) {');
  assert.ok(fnAt > -1, 'demoPage exists');
  const body = src.slice(Math.max(0, fnAt - 900), fnAt + 1400);
  const firstCheck = body.indexOf('assertDemo(page, settings)');
  const firstGoto = body.indexOf("webtrader.gotoPage(page, 'trade', settings)");
  assert.ok(firstCheck > -1, 'assertDemo is called');
  assert.ok(firstGoto > -1, 'the fallback navigation exists');
  assert.ok(firstCheck < firstGoto, 'the READ happens BEFORE the navigation (no goto-per-call)');
  assert.match(body, /READ THE CURRENT PAGE FIRST/, 'the 2026-10-05 rule is stated');
});

test('healthCheck detects the nav via NavigationBar testids, not only the old label text', () => {
  const src = read('trading', 'plus500', 'webtrader.js');
  assert.match(src, /data-testid\^="NavigationBar"/, 'the NavigationBar testid probe exists');
  const probeAt = src.indexOf("navTrade: (await pageText(page)).includes('Open Positions')");
  assert.ok(probeAt > -1, 'the text fallback stays');
  const near = src.slice(probeAt, probeAt + 500);
  assert.match(near, /data-testid\^="NavigationBar"/, 'the testid check sits WITH the navTrade probe');
});

test('softParkOpenPositions exists, is exported, and the mirror prefers it with a hard fallback', () => {
  const wt = read('trading', 'plus500', 'webtrader.js');
  assert.match(wt, /async function softParkOpenPositions\(page/, 'the soft park helper exists');
  assert.match(wt, /softParkOpenPositions,\r?\n/, 'it is exported');
  assert.match(wt, /data-testid="NavigationBar.Button.openPositionsNav/,
    'it uses the app’s own nav button (proved a client-side route change 2026-10-05)');
  const mirror = read('trading', 'agent', 'mirrorPoller.js');
  assert.match(mirror, /softParkOpenPositions\(page\)/, 'the mirror tries soft first');
  assert.match(mirror, /page\.goto\('https:\/\/app\.plus500\.com\/open-positions'/, 'the hard goto fallback stays');
  assert.match(mirror, /via: soft\.ok \? soft\.via : 'goto'/, 'the telemetry records which path was used');
});
