// 2026-10-18: the watchlist-table QUOTE FAST PATH (ADR-1) — pure pins.
// The dynamic capture stopped searching per instrument for quotes (7-15 s each, >90 s per sweep, named
// capture_timeout on nearly every wake). Quotes now come from one read of the venue's own watchlist table;
// a renamed or absent name must FALL THROUGH to the search fallback rather than be guessed.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mapTableRowsToTicks, WATCHLIST_PATH_RE } = require('../trading/plus500/capture');

test('mapTableRowsToTicks: exact-name match; bid=sell ask=buy; venue defaults plus500', () => {
  const rows = [
    { name: 'Gold', sell: 100.5, buy: 100.9, change: '1%' },
    { name: 'Silver', sell: 50.1, buy: 50.2 },
  ];
  const out = mapTableRowsToTicks(rows, [{ symbol: 'Gold' }, { symbol: 'Silver', venue: 'plus500' }]);
  assert.equal(out.ticks.length, 2);
  assert.deepStrictEqual(out.ticks[0], { venue: 'plus500', symbol: 'Gold', bid: 100.5, ask: 100.9, source: 'plus500_frontend' });
  assert.deepStrictEqual(out.missing, []);
});

test('mapTableRowsToTicks: an absent name is MISSING, never guessed', () => {
  const out = mapTableRowsToTicks([{ name: 'Gold', sell: 1, buy: 2 }], [{ symbol: 'Gold' }, { symbol: 'Arabica Coffee' }]);
  assert.deepStrictEqual(out.missing, ['Arabica Coffee']);
  assert.equal(out.ticks.length, 1);
});

test('mapTableRowsToTicks: a row with no prices counts as missing', () => {
  const out = mapTableRowsToTicks([{ name: 'Gold', sell: null, buy: null }], [{ symbol: 'Gold' }]);
  assert.deepStrictEqual(out.ticks, []);
  assert.deepStrictEqual(out.missing, ['Gold']);
});

test('WATCHLIST_PATH_RE: the account watchlist route only', () => {
  assert.equal(WATCHLIST_PATH_RE.test('/trade/watchlists--86806649'), true);
  assert.equal(WATCHLIST_PATH_RE.test('https://app.plus500.com/trade/watchlists--86806649'), true);
  assert.equal(WATCHLIST_PATH_RE.test('/trade/gold'), false);
  assert.equal(WATCHLIST_PATH_RE.test('/open-positions'), false);
  assert.equal(WATCHLIST_PATH_RE.test('/trade/watchlists'), false);
});
