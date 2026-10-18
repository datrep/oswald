// test/news-digest.test.js — 2026-10-03: S2 digest pins (open-work 4.19 / TRD-NEW-1).
//
// The digest is DETERMINISTIC and that is its entire contract: same rows in, same panel out, no
// model, no invented scalar. These pins freeze the ordering rule (dated newest-first, then undated
// by score, then id — never random), the per-symbol cap, alphabetical symbol order, and the
// content-free toast line. If any of these change, the panel order changes between refreshes and
// the owner reads a reshuffling list as if it meant something.
//
// Run with: npm run test:unit  (or: node --test test/news-digest.test.js)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildDigest, toastLine, orderItems } = require('../trading/agent/newsDigest');

function row(over = {}) {
  return { id: 1, symbol: 'Gold', title: 't', url: 'https://e.example/1', source: 'e.example', engine: 'x', publishedAt: null, score: null, ...over };
}

test('ordering — dated items newest-first, then undated by score, then id', () => {
  const items = [
    row({ id: 1, publishedAt: null, score: 0.5 }),
    row({ id: 2, publishedAt: '2026-10-03T00:00:00Z' }),
    row({ id: 3, publishedAt: null, score: 2.0 }),
    row({ id: 4, publishedAt: '2026-10-03T06:00:00Z' }),
    row({ id: 5, publishedAt: null, score: null }),
  ];
  const ordered = orderItems(items).map((r) => r.id);
  assert.deepStrictEqual(ordered, [4, 2, 3, 1, 5]);
});

test('buildDigest — per-symbol cap, alphabetical symbols, totals, and honest ages', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => row({ id: 10 + i, symbol: 'Silver', publishedAt: `2026-10-0${(i % 3) + 1}T0${i}:00:00Z` })),
    row({ id: 30, symbol: 'Gold', publishedAt: '2026-10-03T00:00:00Z' }),
    row({ id: 31, symbol: 'Gold', publishedAt: null, score: 9 }),
    row({ id: 32, symbol: 'Bitcoin', publishedAt: null, score: 1 }),
  ];
  const d = buildDigest(rows, { perSymbol: 3, now: new Date('2026-10-03T12:00:00Z') });
  assert.deepStrictEqual(d.symbols.map((s) => s.symbol), ['Bitcoin', 'Gold', 'Silver']);
  const gold = d.symbols.find((s) => s.symbol === 'Gold');
  assert.strictEqual(gold.items.length, 2);
  assert.strictEqual(gold.items[0].id, 30);
  assert.strictEqual(gold.items[0].ageMin, 720, 'age computed at read time');
  assert.strictEqual(gold.items[1].ageMin, null, 'undated item: null age, never fabricated');
  const silver = d.symbols.find((s) => s.symbol === 'Silver');
  assert.strictEqual(silver.items.length, 3, 'cap holds');
  assert.strictEqual(silver.total, 5, 'total counts all, cap only shapes the view');
  assert.strictEqual(d.totals.items, 8);
  assert.strictEqual(d.totals.symbols, 3);
  assert.strictEqual(d.totals.shown, 6); // gold 2 + bitcoin 1 + silver 3
});

test('buildDigest — empty input is an empty digest, not an error', () => {
  const d = buildDigest([], { now: new Date('2026-10-03T12:00:00Z') });
  assert.strictEqual(d.symbols.length, 0);
  assert.strictEqual(d.totals.items, 0);
  assert.strictEqual(d.asOf, '2026-10-03T12:00:00.000Z');
});

test('toastLine — content-free, pluralised, and total when fields are missing', () => {
  assert.strictEqual(toastLine({ inserted: 12, symbols: 6 }), 'news updated · 12 new items · 6 symbols');
  assert.strictEqual(toastLine({ inserted: 1, symbols: 1 }), 'news updated · 1 new item · 1 symbol');
  assert.strictEqual(toastLine({}), 'news updated · 0 new items · 0 symbols');
  assert.ok(!/gold|bitcoin|%|bull|bear/i.test(toastLine({ inserted: 3, symbols: 2 })), 'no headline/verdict words can ride the line');
});
