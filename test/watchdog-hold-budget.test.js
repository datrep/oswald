// test/watchdog-hold-budget.test.js — the invariant behind the 2026-09-16/17 tick outage.
//
// WHAT WENT WRONG. `plus500/pageLock` is real mutual exclusion over the ONE shared Plus500 tab.
// `watchdog.checkLogin` used `tryAcquire`, so it never QUEUED behind anyone — the header's stated
// policy ("watchdog (login ping) — SKIPS if held"). What it did not bound was its own HOLD.
// `webtrader.gotoPage`'s worst case was `timeout*2 + content*2` = 45s + 15s + 45s + 15s = 120s, and
// `capture` acquires with `waitMs: 120000`. The two numbers were EQUAL, so whenever the page rendered
// slowly the watchdog held the tab for the capture's entire patience and the feed lost every cycle:
//
//   telemetry { source: 'plus500_frontend', captured: 0,
//               reason: 'bridge busy (watchdog) - lock wait exceeded for capture' }
//
// Observed for ~16 hours, while the desk kept trading on the frozen data. The fix gives `gotoPage` a
// navigation budget and has the watchdog pass a small one. THIS TEST READS BOTH FILES, because the
// defect was a relationship between two numbers in two files, and restating either constant locally
// would let them drift apart again exactly as they did before.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const WATCHDOG = 'trading/agent/watchdog.js';
const WEBTRADER = 'trading/plus500/webtrader.js';
const CAPTURE = 'trading/plus500/capture.js';

const constMs = (src, name) => {
  const m = src.match(new RegExp(`\\b${name}\\b\\s*=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
};

test('the watchdog hold can never reach the capture wait budget', () => {
  const wd = code(WATCHDOG);
  const cap = code(CAPTURE);

  const navMs = constMs(wd, 'WATCHDOG_NAV_TIMEOUT_MS');
  const contentMs = constMs(wd, 'WATCHDOG_CONTENT_WAIT_MS');
  const settleMs = constMs(wd, 'WATCHDOG_SETTLE_WAIT_MS');
  assert.ok(navMs > 0, 'the watchdog navigation timeout must be a named constant');
  assert.ok(contentMs >= 0, 'the watchdog content wait must be a named constant');
  assert.ok(settleMs > 0, 'the settle wait must be a named constant (added 2026-10-03)');

  // Read the capture's budget out of the capture itself, so the comparison cannot drift.
  const capWait = Number((cap.match(/acquire\('capture',\s*\{\s*waitMs:\s*(\d+)/) || [])[1]);
  assert.ok(capWait > 0, 'the capture lock budget must be readable from capture.js');

  // gotoPage can burn its timeout twice (goto + reload) and its content wait twice, and the verify
  // path may then poll the settle window once (2026-10-03 fix). All three terms must stay summed here.
  const worstHoldMs = navMs * 2 + contentMs * 2 + settleMs;
  assert.ok(
    worstHoldMs < capWait,
    `worst-case watchdog hold ${worstHoldMs}ms must stay strictly under the capture budget ${capWait}ms`,
  );
});

test('gotoPage accepts a caller-supplied navigation budget, defaulting to the old behaviour', () => {
  const web = code(WEBTRADER);
  assert.match(
    web,
    /async function gotoPage\(page, route, _settings, \{ timeoutMs = 45000, contentWaitMs = 15000 \} = \{\}\)/,
    'the budget must be an optional 4th argument so every existing caller is unchanged',
  );
  assert.match(web, /page\.goto\(url, \{ timeout: timeoutMs,/, 'goto must use the budget');
  assert.match(web, /page\.reload\(\{ timeout: timeoutMs,/, 'the reload retry must use the same budget');
  assert.match(web, /const contentIters = Math\.max\(0, Math\.ceil\(contentWaitMs \/ 500\)\)/, 'the content poll must be derived from the budget');
});

test('the watchdog passes its bound, and reports how long it held', () => {
  const wd = code(WATCHDOG);
  assert.match(wd, /gotoPage\(page, 'trade', settings, \{\s*timeoutMs: WATCHDOG_NAV_TIMEOUT_MS,/, 'the watchdog must pass its budget');
  assert.match(wd, /contentWaitMs: WATCHDOG_CONTENT_WAIT_MS/, 'including the content wait');
  assert.match(wd, /heldMs: Date\.now\(\) - navStartedAt/, 'the hold must be observable, not inferred');
  // The settle wait must be the BUDGETED one — a bare literal here would let the worst-case hold
  // drift away from the arithmetic pinned above.
  assert.match(wd, /waitForLogin\(page, \{ timeoutMs: WATCHDOG_SETTLE_WAIT_MS \}\)/, 'the settle wait must pass the named budget');
  // The skipping half was already correct and must stay that way: a login ping never queues.
  assert.match(wd, /if \(!pageLock\.tryAcquire\('watchdog'\)\)/, 'the watchdog must still SKIP rather than wait');
  assert.match(wd, /finally\s*\{[\s\S]*pageLock\.release\('watchdog'\)/, 'release must be in a finally block');
});
