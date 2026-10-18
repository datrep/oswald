// test/account-currency.test.js — TRD-PNL-4 (#1484): the unit the desk's money is in, recorded once.
//
// THE GAP. TradingSettings held no currency key and the `account` event payload carried only
// {available, equity, margin, pnl, at}, so every report quoted a bare number and a declared external cost could
// not be reconciled against equity without a human supplying the rate. It was not only a reporting gap: nothing
// recording that the venue pays P&L in the ACCOUNT's currency while prices and sizes are the INSTRUMENT's is
// what let `closeFill.js` divide one by the other and inflate 60 venue closes by USD/SGD (TRD-PNL-5 / #1496).
//
// WHAT IS PINNED. One source (a settings declaration read through one helper, never a literal at a call site),
// the unit travelling with the number on BOTH account write paths, and the REFUSAL that must survive: an
// unrecorded instrument is not USD by default, and even a recorded mismatch cannot be converted without an fx
// rate the desk does not store.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { code, read } = require('./_source');
const ac = require('../trading/agent/accountCurrency');
const { impliedFillPrice } = require('../trading/agent/closeFill');

const POLLER = 'trading/agent/accountPoller.js';
const VENUE_CLOSE = 'trading/agent/venueClose.js';
const PROMPT = 'trading/agent/promptBuilder.js';
const STORE = 'trading/store.js';

test('the declared account currency is read from settings, and a missing declaration is NULL not a default', () => {
  assert.equal(ac.currencyOf({ account: { currency: 'SGD' } }), 'SGD');
  assert.equal(ac.currencyOf({ account: { currency: ' sgd ' } }), 'SGD', 'trimmed and normalised');
  // ⚠ null is a REAL ANSWER - "nobody has said" - and must be distinguishable from a wrong unit
  assert.equal(ac.currencyOf({}), null);
  assert.equal(ac.currencyOf({ account: {} }), null);
  assert.equal(ac.currencyOf({ account: { currency: '' } }), null);
  assert.equal(ac.currencyOf({ account: { currency: 123 } }), null, 'a number is not a currency');
  assert.equal(ac.currencyOf(null), null);
  assert.equal(ac.currencyOf(undefined), null);
});

test('★★ an unrecorded INSTRUMENT is not USD by default — the assumption that caused the defect', () => {
  const s = { account: { currency: 'SGD', instrumentCurrency: { SGX: 'SGD' } } };
  assert.equal(ac.instrumentCurrencyOf(s, 'SGX'), 'SGD');
  assert.equal(ac.instrumentCurrencyOf(s, 'Gold'), null, 'Gold is simply unrecorded, not USD');
  assert.equal(ac.instrumentCurrencyOf(s, 'gold'), null, 'the lookup is exact — no case folding into a match');
  assert.equal(ac.instrumentCurrencyOf({ account: {} }, 'Gold'), null, 'and an absent map records nothing');
  assert.equal(ac.instrumentCurrencyOf({ account: { currency: 'SGD', instrumentCurrency: { Gold: 1 } } }, 'Gold'), null);
  // the derived question the fill path asks
  assert.equal(ac.convertible(s, 'SGX'), true, 'same currency -> convertible');
  assert.equal(ac.convertible(s, 'Gold'), false, 'unrecorded -> NOT convertible, which is why it refuses');
  assert.equal(ac.convertible({ account: { currency: 'SGD', instrumentCurrency: { Gold: 'USD' } } }, 'Gold'), false,
    'and a recorded MISMATCH is also not convertible without a rate');
  assert.equal(ac.sameCurrency('usd', 'USD'), true);
  assert.equal(ac.sameCurrency('', ''), false, 'two blanks are not a match');
});

test('the unit travels WITH the number on both account write paths', () => {
  const src = code(POLLER);
  // both writers spread the strip; both must stamp the unit, or a reader learns to distrust the field
  const stamps = src.match(/\.\.\.\(accountCurrency \? \{ currency: accountCurrency \} : \{\}\)/g) || [];
  assert.equal(stamps.length, 2, `both account writers must stamp the currency (found ${stamps.length})`);
  // and the cache is filled from the settings read the loop ALREADY performs, not a second query
  assert.match(src, /accountCurrency = currencyOf\(settings\);/, 'filled from the shared cached settings read');
  assert.ok(!/currency:\s*'[A-Z]{3}'/.test(src), 'the poller must not write a currency literal');
  assert.match(src, /const \{ currencyOf \} = require\('\.\/accountCurrency'\);/);
});

test('★★ the declaration exists in exactly one written place', () => {
  // the store default IS the declaration; a literal anywhere else is a second home
  assert.match(read(STORE), /account: \{ enabled: true, pollSeconds: 1, currency: 'SGD' \}/,
    'settings.account.currency is where the unit is declared');
  for (const f of [VENUE_CLOSE, POLLER, PROMPT]) {
    assert.ok(!/'SGD'/.test(code(f)), `${f} must not restate the account currency`);
  }
  // the bundle a chair reads carries the unit beside the equity
  assert.match(code(PROMPT), /currency: currencyOf\(settings\)/, 'the account block names its unit');
});

test('recording the currencies does NOT quietly re-enable the fill derivation', () => {
  // ⚠ THE TRAP THIS CLOSES: someone records instrumentCurrency.Gold = 'USD', sees the argument now resolve,
  // and assumes the derived fill is fixed. It is not — USD vs SGD needs the fx rate AT THE CLOSE, which the
  // desk does not store, so the refusal must survive a recorded mismatch.
  const withBoth = { account: { currency: 'SGD', instrumentCurrency: { Gold: 'USD' } } };
  assert.equal(ac.convertible(withBoth, 'Gold'), false);
  assert.equal(impliedFillPrice({
    openPrice: 4400, direction: 'buy', grossPnl: -10, size: 1,
    pnlCurrency: ac.currencyOf(withBoth), quoteCurrency: ac.instrumentCurrencyOf(withBoth, 'Gold'),
  }), null, 'a recorded mismatch still derives nothing');
  // and an SGD-quoted instrument on an SGD account IS derivable — the one case that was always safe
  const sgd = { account: { currency: 'SGD', instrumentCurrency: { SGX: 'SGD' } } };
  assert.equal(ac.convertible(sgd, 'SGX'), true);
  assert.strictEqual(impliedFillPrice({
    openPrice: 25, direction: 'buy', grossPnl: -2, size: 1,
    pnlCurrency: ac.currencyOf(sgd), quoteCurrency: ac.instrumentCurrencyOf(sgd, 'SGX'),
  }), 23);
});

test('the stopgap literal is gone from the module that used to carry it', () => {
  const src = code(VENUE_CLOSE);
  assert.ok(!/ACCOUNT_CURRENCY/.test(src), 'the constant the stopgap added must be removed, not left to drift');
  assert.match(src, /const \{ currencyOf, instrumentCurrencyOf \} = require\('\.\/accountCurrency'\);/,
    'this module reads the currencies from the one source');
});
