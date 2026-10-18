// Pins for TRD-36 class-aware matching (2026-09-11): the venue search surfaces
// OPTION instruments for plain spot queries ("Oil" -> "Oil | Call 101 | Sep W2");
// a spot-intent resolve path must never silently select one (it would bank
// option premiums into the spot symbol's tick stream).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cleanName, isOptionName, pickIndex, pickRow } = require('../trading/plus500/matching');

test('option labels are detected by the structured Call/Put naming', () => {
  assert.equal(isOptionName('Oil | Call 101 | Sep W2'), true);
  assert.equal(isOptionName('Gold | Call 4350 | Oct'), true);
  assert.equal(isOptionName('S&P 500 | Put 7600 | Sep W2'), true);
  assert.equal(isOptionName('Oil'), false);
  assert.equal(isOptionName('S&P 500'), false);
  // The search row's own format uses a pipe too ("D05.SGX | DBS Group") —
  // it must NOT be classified as an option.
  assert.equal(isOptionName('D05.SGX | DBS Group'), false);
});

test('bidi/space junk is cleaned before classification', () => {
  assert.equal(cleanName('\u200eOil | Call  101 | Sep W2\u200f'), 'Oil | Call 101 | Sep W2');
  assert.equal(isOptionName('\u200bOil | put 101 | Sep W2'), true);
});

test('spot query skips the option row and picks the spot row later in the list', () => {
  const items = ['Oil | Call 101 | Sep W2', 'Oil', 'Oil ETF'];
  assert.equal(pickIndex(items, 'Oil'), 1);
});

test('spot query with ONLY an option match is refused (no silent class switch)', () => {
  const items = ['Oil | Call 101 | Sep W2'];
  assert.equal(pickIndex(items, 'Oil'), -1);
});

test('exact match still wins within the allowed class', () => {
  const items = ['Oil Weekly', 'Oil'];
  assert.equal(pickIndex(items, 'Oil'), 1);
});

test('allowOptions: true opts in to option rows', () => {
  const items = ['Oil | Call 101 | Sep W2'];
  assert.equal(pickIndex(items, 'Oil', { allowOptions: true }), 0);
});

test('an option-shaped query implies option intent', () => {
  const items = ['Oil | Call 101 | Sep W2'];
  assert.equal(pickIndex(items, 'Oil | Call 101 | Sep W2'), 0);
});

test('pickRow mirrors pickIndex for table rows (search fallback / discoverer)', () => {
  const rows = [{ name: 'Oil | Call 101 | Sep W2' }, { name: 'Oil' }];
  assert.equal(pickRow(rows, 'Oil').name, 'Oil');
  assert.equal(pickRow([{ name: 'Oil | Call 101 | Sep W2' }], 'Oil'), null);
  assert.equal(pickRow([{ name: 'Oil | Call 101 | Sep W2' }], 'Oil', { allowOptions: true }).name, 'Oil | Call 101 | Sep W2');
});
