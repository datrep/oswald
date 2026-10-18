// test/news-keywords.test.js — 2026-10-03: S1 of the news aggregator (open-work 4.19 / TRD-NEW-1).
//
// THE PINS BELOW freeze the query composer's contract before any fetch loop consumes it, because
// the query IS the product: a wrong query produces plausible-looking items for the wrong subject,
// which is the silent-wrong-answer class this desk keeps paying for. Specific traps pinned:
//   (1) ambiguous single-word displays (Gold/Silver/Oil/Sugar) must carry their category on the
//       right of the AND — never go out alone;
//   (2) Gold must NOT inherit the crypto classification its binance proxy key triggers in
//       pulse.categorize() (measured: categorize('Gold') === 'crypto'); no PAXG token in queries;
//   (3) crypto gets its universally resolvable token on the left of the OR (BTC), futures proxies
//       (=F) get no token at all;
//   (4) multi-word displays are quoted phrases.
//
// Run with: npm run test:unit  (or: node --test test/news-keywords.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { keywordFor, keywordsFor, newsTickerFor, queryCategoryFor } = require('../trading/agent/newsKeywords');
const { SYMBOL_MAP } = require('../trading/agent/providers');

test('ambiguous displays carry their category — never sent alone', () => {
  for (const s of ['Gold', 'Silver', 'Oil', 'Sugar', 'Natural Gas']) {
    const k = keywordFor(s);
    assert.ok(k.query.includes('AND'), `${s} query must contain an AND anchor`);
  }
  assert.strictEqual(keywordFor('Gold').query, '(Gold AND commodity)');
  assert.strictEqual(keywordFor('Silver').query, '(Silver AND commodity)');
  assert.strictEqual(keywordFor('Oil').query, '(Oil AND commodity)');
});

test('Gold — the binance proxy key must not leak PAXG/crypto into queries', () => {
  const k = keywordFor('Gold');
  assert.strictEqual(k.category, 'commodities', 'query category corrects the categorize() proxy quirk');
  assert.strictEqual(k.ticker, null, 'GC=F is a futures proxy - no searchable token');
  assert.ok(!/PAXG/i.test(k.query), 'no PAXG token in the query');
  assert.ok(!/crypto/i.test(k.query), 'no crypto term in the query');
});

test('crypto gets its resolvable token; futures proxies get none', () => {
  assert.strictEqual(keywordFor('Bitcoin').query, 'BTC OR (Bitcoin AND crypto)');
  assert.strictEqual(keywordFor('Ethereum').query, 'ETH OR (Ethereum AND crypto)');
  assert.strictEqual(keywordFor('Soybeans').ticker, null);
  // Every futures-proxy symbol in the registry must yield a null ticker.
  for (const [name, entry] of Object.entries(SYMBOL_MAP)) {
    if (String(entry.yahoo || '').endsWith('=F')) {
      assert.strictEqual(newsTickerFor(name, entry, queryCategoryFor(name, entry)), null, `${name} must have no token`);
    }
  }
});

test('multi-word displays become quoted phrases', () => {
  assert.strictEqual(keywordFor('Arabica Coffee').query, '("Arabica Coffee" AND commodity)');
});

test('empty input is null; keywordsFor de-duplicates', () => {
  assert.strictEqual(keywordFor(''), null);
  assert.strictEqual(keywordFor('   '), null);
  const list = keywordsFor(['Gold', 'Gold', 'Bitcoin']);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list.map((k) => k.symbol), ['Gold', 'Bitcoin']);
});

test('unmapped symbols fall back to the equity term, still anchored', () => {
  const k = keywordFor('Some New Symbol');
  assert.strictEqual(k.category, 'equities');
  assert.strictEqual(k.query, '("Some New Symbol" AND stock)');
});
