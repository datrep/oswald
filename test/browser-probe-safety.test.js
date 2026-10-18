// test/browser-probe-safety.test.js — a health probe must not be able to kill the desk bridge (2026-09-15).
//
// THE DEFECT. `trading/scripts/browser-probe.js` is the Phase-0 browser spike behind `GET /api/trading/ping`
// (and the dashboard's browser badge). It uses the SAME debug port (9224) and the SAME Chrome profile
// (`.chrome-profile`) as the live desk bridge — so whenever the desk is running, which is the normal case:
//
//   1. the probe's own `spawn()` cannot take 9224 (Chrome is single-instance per profile),
//   2. `tcpUp(9224)` therefore succeeds AGAINST THE DESK'S CHROME,
//   3. `connectOverCDP` attaches to the desk's browser, and
//   4. cleanup then killed it — `killPortHolder(PORT)` taskkills whatever holds 9224, and `Browser.close`
//      shuts down the browser it just attached to.
//
// `routes.js` records the consequence ("cost the bridge its life once"), and the desk then has to relaunch
// and re-attach: mirror cycles fail with `Target page, context or browser has been closed`, `sessionFeed`
// records another attach, and any in-flight account read hangs until its deadline.
//
// The rule these pins defend: a browser that was ALREADY LISTENING before the probe started is READ, never
// killed and never closed. Only what the probe itself created is the probe's to destroy.
//
// NOTE ON PROVENANCE: the probe was DORMANT when this was found (`temp/browser-probe.json` last written
// 2026-09-12), so it is a latent landmine rather than the cause of any observed 2026-09-15 error. That was
// checked BEFORE the fix, because a suspect is not a cause until the failure's timeline is inside the
// suspect's. It is still fixed: the same cleanup already cost the bridge its life once.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { code } = require('./_source');

const SRC = code('trading/scripts/browser-probe.js');

test('PROBE SAFETY: the pre-existing-port check happens BEFORE anything is spawned', () => {
  const check = SRC.indexOf('const preexisting = await tcpUp(PORT)');
  const firstSpawn = SRC.indexOf('await tryLibreWolf()');
  assert.ok(check > -1, 'the probe must ask who holds the port first');
  assert.ok(firstSpawn > -1, 'the LibreWolf probe must still run');
  assert.ok(check < firstSpawn, 'the question has to be asked before anything is launched or killed');
});

test('PROBE SAFETY: the port holder is only cleared when the probe found the port FREE', () => {
  assert.match(SRC, /if \(!preexisting\) await killPortHolder\(PORT\)/);
  // The bug was an UNGUARDED kill. Assert the bare statement is gone, line-anchored so the guarded form
  // (which is preceded by `if (...) `) cannot satisfy it.
  assert.ok(
    !/^\s*await killPortHolder\(PORT\);/m.test(SRC),
    'killPortHolder must never run unguarded — it kills whatever holds the port, which is the desk bridge',
  );
});

test('PROBE SAFETY: Browser.close is skipped when the browser was not ours', () => {
  assert.match(
    SRC,
    /if \(!preexisting\) \{[\s\S]{0,240}?await cdp\.send\('Browser\.close'\)/,
    'closing a browser the probe did not launch is how it killed the desk',
  );
  assert.match(SRC, /await tryChromium\(preexisting\)/, 'the flag must reach the function that closes it');
  assert.match(SRC, /reused: preexisting/, 'and the result must say whether the browser was pre-existing');
});

test('PROBE SAFETY: the strikes are counted against code, not comments', () => {
  // `code()` strips comments, so the assertions above cannot be satisfied by the prose explaining them —
  // and this file must not silently stop stripping (the CRLF trap that once no-oped every structural test).
  assert.ok(!SRC.includes('a health check must not'), 'comments must be stripped before asserting');
  assert.ok(SRC.includes('killPortHolder'), 'but the code itself must survive the strip');
});
