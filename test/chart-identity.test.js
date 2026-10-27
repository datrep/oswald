'use strict';
// test/chart-identity.test.js — 2026-10-27. The venue's instrument id, parsed from `engine.chart.symbol`.
//
// ⚠ WHY THIS FILE EXISTS SEPARATELY FROM THE GUARD IT CAME FROM. The rule was written inside `plus500/capture.js`,
// which cannot be loaded by a test (it requires `webtrader`, which requires the browser). It moved to
// `plus500/chartIdentity.js` when `webtrader.placeOrder` became its second consumer — `Trades.venueInstrumentId`,
// migration 055 — so both sides now share one implementation and this test can reach it.
//
// ⚠ AND THE VALUE IS NOT A NAME. Gold's chart symbol is `11_Sell`, not `Gold`. The first identity guard compared the
// two directly and reported `of:12, match:0, mismatch:12` on a capture that was working perfectly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { chartInstrumentId, chartIdentityVerdict } = require('../trading/plus500/chartIdentity');

test('the id is the numeric prefix, with the side suffix ignored', () => {
  assert.equal(chartInstrumentId('11_Sell'), '11');       // Gold
  assert.equal(chartInstrumentId('10_Sell'), '10');       // Oil
  assert.equal(chartInstrumentId('3406_Sell'), '3406');   // Bitcoin
  assert.equal(chartInstrumentId('  3989_Buy '), '3989'); // Sands China, with the other side
});

test('★ a desk symbol is NOT an id — this is the confusion that made the guard report 12 mismatches', () => {
  assert.equal(chartInstrumentId('Gold'), null);
  assert.equal(chartInstrumentId('Oil | Call 94 | Sep W2'), null);
});

test('an absent chart symbol is NULL, and null is never treated as a pass', () => {
  for (const v of [null, undefined, '', '   ', '_Sell']) assert.equal(chartInstrumentId(v), null, `for ${JSON.stringify(v)}`);
});

test('chartIdentityVerdict: absence is never `match`', () => {
  assert.equal(chartIdentityVerdict(null, 'Gold', 'Gold'), 'unrecorded');
  assert.equal(chartIdentityVerdict('11_Sell', 'Gold', null), 'unregistered');
  assert.equal(chartIdentityVerdict('11_Sell', 'Gold', 'Gold'), 'match');
  assert.equal(chartIdentityVerdict('11_Sell', 'Silver', 'Gold'), 'mismatch');
  // Name comparison is normalised, so punctuation and case are not identity.
  assert.equal(chartIdentityVerdict('11_Sell', 'sands china', 'Sands China'), 'match');
});

test('capture.js still re-exports both — two scripts call `capture.chartInstrumentId`', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'capture.js'), 'utf8');
  assert.match(src, /const \{ chartInstrumentId, chartIdentityVerdict \} = require\('\.\/chartIdentity'\)/,
    'capture.js must delegate, not re-implement — two producers of one rule is the defect this repo keeps finding');
  assert.match(src, /module\.exports = \{[^}]*chartInstrumentId[^}]*\}/s,
    'the existing callers (scripts/repro/chart-identity-check.js, scripts/backfill-chart-identity-registry.js) read it '
    + 'off capture, so the re-export is part of the contract');
});
