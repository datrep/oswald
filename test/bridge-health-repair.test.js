// test/bridge-health-repair.test.js — the A1 selector-health check's REPAIR CHAIN.
//
// WHY THIS EXISTS (measured live 2026-10-02): the desk took TWO entry lockouts in one day because the
// check's single repair — `gotoPage(page,'trade')` → `https://app.plus500.com/trade` — is REDIRECTED
// BY THE SPA back to the remembered trade route. The mirror parks the shared tab on `/open-positions`
// (routes.js parks there by design), which carries no instrument table, so from there the repair
// bounced straight back; three consecutive wake captures failed (`navTrade:false,
// instrumentTable:false`) and the UI Fallback Pause latched. The fallback under test navigates
// DIRECTLY to a category URL — a concrete route the SPA cannot bounce.
//
// MUTATION-CHECKED: deleting the `stillMissing` fallback block in webtrader.healthCheck makes test 1
// fail (`ok` stays false and only one goto is recorded) and test 3's `repairFallback` assertion fail.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const webtrader = require('../trading/plus500/webtrader');

const TRADE_URL = 'https://app.plus500.com/trade';
const CATEGORY_URL = 'https://app.plus500.com/trade/cryptocurrencies';

// A tab parked off the trade route: logged in, account strip present, NO 'Open Positions' text and
// NO table (the measured wedge state).
function parked(url = 'https://app.plus500.com/open-positions') {
  return {
    url,
    text: ('DEMO ACCOUNT. Available S$ 1,234.56 Equity S$ 1,234.56. ' +
      'positions list, filters, totals — no instrument table on this route. '.repeat(3)),
    tables: [],
  };
}

// A healthy category page: nav text and a 'Type / Instrument' table.
function healthy(url = CATEGORY_URL) {
  const headRow = { querySelectorAll: () => [{ textContent: 'Type / Instrument' }, { textContent: 'Current Rate' }] };
  const row = { querySelectorAll: () => [{ textContent: 'Bitcoin' }, { textContent: '78,000' }] };
  return {
    url,
    text: ('Open Positions Orders Trade. Available S$ 1,234.56 Equity S$ 1,234.56. ' +
      'instrument list rendered with rows. '.repeat(6)),
    tables: [{
      querySelector: (sel) => (String(sel).includes('tr') ? headRow : null),
      querySelectorAll: () => [headRow, row],
    }],
  };
}

// The SPA redirect: /trade bounces back to the remembered route (world unchanged). A category URL is
// a concrete route and lands wherever `afterCategory` says.
function makePage(state) {
  const gotos = [];
  return {
    gotos,
    page: {
      url: () => state.current.url,
      goto: async (u) => {
        gotos.push(u);
        if (u === CATEGORY_URL) state.current = state.afterCategory;
        // the TRADE_URL bounce leaves the world (and the remembered route) untouched
      },
      evaluate: (fn, arg) => Promise.resolve(fn(arg)),
    },
  };
}

function installDocument(state) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    get() {
      const w = state.current;
      return {
        body: { innerText: w.text },
        // The login probe (2026-10-03) asks the DOM for the account-strip cells first; these fixtures
        // carry the account words in innerText instead, which exercises the rendered-text fallback.
        // Without this method the probe would throw and every state would read as signed out.
        querySelector: () => null,
        querySelectorAll: (sel) => {
          if (sel === 'strong') {
            return [{ textContent: 'Available', parentElement: { textContent: 'Available S$ 1,234.56', parentElement: null } }];
          }
          if (sel === 'table') return w.tables;
          return [];
        },
      };
    },
  });
}

test('parked off-route: the /trade repair bounces, and the category fallback recovers', async () => {
  const state = { current: parked(), afterCategory: healthy() };
  installDocument(state);
  try {
    const { page, gotos } = makePage(state);
    const out = await webtrader.healthCheck(page, {});
    assert.equal(out.checks.loggedIn, true);
    assert.equal(out.checks.repairAttempted, true);
    assert.equal(out.checks.repairFallback, true);
    assert.equal(out.checks.instrumentTable, true);
    assert.equal(out.ok, true, 'the fallback must bring the trade DOM back');
    assert.deepEqual(gotos, [TRADE_URL, CATEGORY_URL], 'repair order: /trade first, category fallback second');
  } finally {
    delete globalThis.document;
  }
});

test('a healthy page needs no repair and performs no navigation (control, non-vacuity)', async () => {
  const state = { current: healthy() };
  installDocument(state);
  try {
    const { page, gotos } = makePage(state);
    const out = await webtrader.healthCheck(page, {});
    assert.equal(out.ok, true);
    assert.equal(out.checks.repairAttempted, undefined);
    assert.deepEqual(gotos, []);
  } finally {
    delete globalThis.document;
  }
});

test('genuinely broken everywhere: still fails after the fallback (the check is not relaxed)', async () => {
  const state = { current: parked(), afterCategory: parked(CATEGORY_URL) };
  installDocument(state);
  try {
    const { page } = makePage(state);
    const out = await webtrader.healthCheck(page, {});
    assert.equal(out.ok, false);
    assert.match(String(out.reason), /critical DOM missing/);
    assert.equal(out.checks.repairFallback, true, 'the fallback must have been attempted');
    assert.equal(out.checks.instrumentTable, false);
  } finally {
    delete globalThis.document;
  }
});
