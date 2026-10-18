// test/exe1-order-book-probe.test.js — TRD-EXE-1 (#1454): the order book MEASUREMENT.
//
// ★ WHAT THIS PINS, AND WHY IT NEEDS PINS AT ALL. The measurement exists so that item 4's classifier and
// item 2's cancel/adopt can be written against a real `data-testid` instead of a guess. Two things could go
// wrong silently, and both are pinned here:
//
//   1. THE PROBE COULD STOP BEING READ-ONLY. It navigates the venue's SHARED tab. A single click added later
//      would turn a measurement into something that can cancel a live order — with no test failing, because a
//      click is not a syntax error. So the ABSENCE of a click is asserted, not assumed.
//   2. THE PROBE COULD START ASSERTING A PREFIX. Nothing in this repo has ever SEEN the order row's testid, so
//      any literal `OrderRow.` in this path would be a guess wearing a selector's clothes. The reader must stay
//      testid-agnostic; when the real prefix is observed, changing that is a deliberate edit that breaks this.
//
// Structural, because requiring `webtrader` attaches to the desk's LIVE Chrome on :9224.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const wt = nl(code('trading/plus500/webtrader.js'));
const routes = nl(code('trading/routes.js'));

// The measurement lives between positionsEval and readPositions.
const from = wt.indexOf('function orderBookEval()');
const to = wt.indexOf('async function readPositions(page, _settings)');
const meas = from >= 0 && to > from ? wt.slice(from, to) : '';

const rFrom = routes.indexOf("router.post('/orders/book-probe'");
// ⚠ THE END MARKER MUST BE CODE, NOT A COMMENT. `_source.code()` STRIPS COMMENTS, so an end marker written as
// a comment resolves to -1 and the slice silently comes back EMPTY — which reported three failures here that
// were the test's fault, not the code's. Same family as every prose-vs-field defect in this register.
const rTo = routes.indexOf("router.get('/instruments'", rFrom);
const route = rFrom >= 0 && rTo > rFrom ? routes.slice(rFrom, rTo) : '';

test('the measurement block exists and is wired up', () => {
  assert.ok(meas, 'orderBookEval .. readOrderBookShape must exist between positionsEval and readPositions');
  assert.match(meas, /async function readOrderBookShape\(page\)/);
  assert.ok(route, "the /orders/book-probe route must exist");
});

test('THE PROBE IS READ-ONLY — it contains no click, so it cannot cancel or modify an order', () => {
  // A click is the only thing in this path that could touch a live order.
  assert.doesNotMatch(meas, /\.click\(/, 'the measurement must not click the venue');
  assert.doesNotMatch(meas, /page\.click\(/, 'the measurement must not click the venue');
  assert.doesNotMatch(route, /\.click\(/, 'the route must not click the venue');
});

test('THE READER STAYS TESTID-AGNOSTIC — no guessed order-row prefix anywhere in this path', () => {
  // Anything that ASSERTS a prefix would be a guess. The names that are checked for are exactly the guesses
  // that were rejected: the venue's real prefix is still unobserved.
  for (const guess of ['OrderRow.', 'OrdersRow.', 'PendingOrderRow.']) {
    assert.ok(!meas.includes(guess), `${guess} must not appear — it is a guess, not an observation`);
  }
  // `rowLike` and `orderish` are REPORTED, never used as selectors.
  assert.match(meas, /const rowLike = \[\.\.\.new Set\(all\.filter/);
  assert.match(meas, /const orderish = \[\.\.\.new Set\(all\.filter/);
});

test('THE MOUNT CHECK REQUIRES CONTENT, NOT CHROME — this is the defect the first run produced', () => {
  // MEDIATION: the first version waited on `querySelectorAll('[data-testid]').length > 0` and returned
  // mounted:true on a page whose only testids were InactivityTimer/WalkThrough/Dialog with an EMPTY body,
  // which reads as "the venue has no orders". If the weak condition comes back, this fails.
  assert.doesNotMatch(meas,
    /querySelectorAll\('\[data-testid\]'\)\.length > 0\)/,
    'the weak "any testid exists" mount check must not return');
  assert.match(meas, /bodyLen > 300 \|\| rows > 8/, 'mount must mean rendered content');
  assert.match(meas, /const bodyLen = document\.body \? document\.body\.innerText\.trim\(\)\.length : 0;/);
});

test('the three render states are distinguished, so "no orders" can never be inferred from an overlay', () => {
  assert.match(meas, /contentState: rowLike\.length > 0 \? 'content'/);
  assert.match(meas, /'overlay_or_shell_only'/);
  assert.match(meas, /'shell_only' : 'nothing_rendered'/);
  // Overlay chrome is named rather than being counted as content.
  assert.match(meas, /overlayTestids/);
  assert.match(meas, /shadowLen/, 'text rendered inside a shadow root must be counted, or a working page reads as blank');
});

test('the route runs IN-PROCESS and always parks the tab back on /open-positions', () => {
  // pageLock is IN-PROCESS mutual exclusion, so a standalone script could not coordinate with a ticket and
  // would race the shared tab — the fault that killed order 6289. The route must therefore use the lock.
  assert.match(route, /pageLock\.acquire\('ticket'/, 'the probe must take the shared-tab lock');
  assert.match(route, /pageLock\.release\('ticket'\)/, 'and must release it');
  // Parking MUST be in a finally: a probe that throws and leaves the tab on /open-orders silently disables
  // the positions mirror for every other flow.
  assert.match(route, /\} finally \{/, 'the park must survive a throw');
  assert.match(route, /goto\('https:\/\/app\.plus500\.com\/open-positions'/);
  // The shared-tab rule ("never close it and never disconnect()") is stated in a COMMENT, and `code()` strips
  // comments — so it is asserted against the RAW file, not the stripped one. Asserting it on `route` would have
  // been a test that can never pass.
  const rawRoutes = nl(require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'trading', 'routes.js'), 'utf8'));
  assert.match(rawRoutes, /never close it and never disconnect\(\)/, 'the shared-tab rule must stay stated');
});

test('the lock wait is explicit, because a degraded mirror can hold the bridge past a minute', () => {
  // Measured 2026-09-29: the first attempt got `bridge busy (mirror) — lock wait exceeded for ticket` at 60s
  // while `account_poll_stats workMsMax` read 20393. A magic constant here reads as "the bridge is broken".
  assert.match(route, /const waitMs = Math\.max\(10000, Math\.min\(300000,/);
  assert.match(route, /pageLock\.acquire\('ticket', \{ waitMs \}\)/);
});
