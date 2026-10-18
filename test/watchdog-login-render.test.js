// test/watchdog-login-render.test.js — 2026-10-03: the false "plus500 signed out" pages.
//
// WHAT WENT WRONG. The shared bridge tab is navigated several times a minute (mirror cycle), and each
// navigation rebuilds the SPA shell: for ~2-3 s `document.body.innerText` is 0-1 chars and the
// account strip is absent. `isLoggedIn` read only rendered innerText, so a check landing in that
// window read "signed out"; the watchdog then navigated to verify — opening a FRESH shell window —
// and a second negative inside it reached `reactToLogin` as a death. Measured 2026-10-03: the account
// strip was being read with live values 56 s inside a declared death window, and a full desktop
// render showed the banner for the same tab. See docs/incident-2026-10-03-false-login-death.md.
//
// THE PINS BELOW: (1) isLoggedIn must trust the render-independent account evidence, (2) it must
// still fail closed on a foreign URL and keep the rendered-text fallback, and (3) waitForLogin must
// resolve the three outcomes the watchdog relies on — alive / settled-dead / never-settled-skip.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const WEBTRADER = 'trading/plus500/webtrader.js';
const WATCHDOG = 'trading/agent/watchdog.js';
const webtrader = require('../trading/plus500/webtrader');

// A fake Playwright page for the pure-read helpers. It answers the two evaluates the helpers make:
//   - the DOM probe (detected by its 'available-balance' selector) -> next value of `domSeq`
//   - the rendered-text read (detected by 'innerText')            -> 'x' * next value of `textSeq`
// Sequences are consumed per call and hold their last value.
function fakePage({ url = 'https://app.plus500.com/trade', domSeq = [false], textSeq = [0] } = {}) {
  let d = 0;
  let t = 0;
  return {
    url: () => url,
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('available-balance')) return domSeq[Math.min(d++, domSeq.length - 1)];
      if (src.includes('innerText')) return 'x'.repeat(textSeq[Math.min(t++, textSeq.length - 1)]);
      return null;
    },
  };
}

test('isLoggedIn trusts the account cells even while innerText is empty (mid-navigation shell)', async () => {
  const page = fakePage({ domSeq: [true], textSeq: [1] });
  assert.strictEqual(await webtrader.isLoggedIn(page), true);
});

test('isLoggedIn falls back to rendered text when the structural markers are absent', async () => {
  const page = fakePage({ domSeq: [false], textSeq: [5000] });
  // The fake's text is 'xxxx...' — no words — so this pins the fallback CALL PATH, not a login.
  assert.strictEqual(await webtrader.isLoggedIn(page), false);
});

test('isLoggedIn still fails closed on a foreign URL', async () => {
  const page = fakePage({ url: 'https://example.com/trade', domSeq: [true], textSeq: [5000] });
  assert.strictEqual(await webtrader.isLoggedIn(page), false);
});

test('waitForLogin resolves to alive as soon as account evidence appears', async () => {
  const page = fakePage({ domSeq: [false, false, true], textSeq: [1, 1, 400] });
  const r = await webtrader.waitForLogin(page, { timeoutMs: 400, pollMs: 20 });
  assert.strictEqual(r.loggedIn, true);
  assert.ok(r.waitedMs >= 0);
});

test('waitForLogin returns a settled-dead verdict when the page renders without account evidence', async () => {
  const page = fakePage({ domSeq: [false], textSeq: [500, 500, 500] });
  const r = await webtrader.waitForLogin(page, { timeoutMs: 2000, pollMs: 20 });
  assert.strictEqual(r.loggedIn, false);
  assert.strictEqual(r.settled, true, 'two consecutive rendered samples without account evidence is the logout shape');
});

test('waitForLogin reports never-settled (no verdict) when the page stays in its boot shell', async () => {
  const page = fakePage({ domSeq: [false], textSeq: [1] });
  const r = await webtrader.waitForLogin(page, { timeoutMs: 150, pollMs: 20 });
  assert.strictEqual(r.loggedIn, false);
  assert.strictEqual(r.settled, false, 'a page that never renders is a render problem, not a signed-out session');
  assert.strictEqual(r.bodyLen, 1);
});

test('the watchdog never records a death from an unsettled page (blank_render skip comes first)', () => {
  const wd = code(WATCHDOG);
  const idxBlank = wd.indexOf("skipped: 'blank_render'");
  const idxDeath = wd.indexOf("return { loggedIn: false, mode: 'navigated_settled'");
  assert.ok(idxBlank > 0, 'the blank_render skip must exist');
  assert.ok(idxDeath > 0, 'the settled-death verdict must exist');
  assert.ok(idxBlank < idxDeath, 'the unsettled case must return BEFORE the death verdict can be reached');
  assert.match(wd, /waitForLogin\(page, \{ timeoutMs: WATCHDOG_SETTLE_WAIT_MS \}\)/, 'the verify path must wait for settle');
});

test('isLoggedIn reads the exact elements readAccountStatus parses (one source of truth)', () => {
  const web = code(WEBTRADER);
  assert.match(web, /li\[automation="available-balance"\]/, 'the account cell is the render-independent evidence');
  assert.match(web, /li\[automation="equity"\]/, 'both cells must be present for a positive');
  assert.match(web, /s\.textContent \|\| ''\)\.trim\(\)\.replace\(\/\\\.\$\/, ''\)/, 'the strong-label fallback reads exact labels');
  assert.match(web, /text\.includes\('Available'\) && text\.includes\('Equity'\)/, 'the rendered-text fallback must remain');
  assert.match(web, /app\\\.plus500\\\.com/, 'the URL guard must remain fail-closed');
});
