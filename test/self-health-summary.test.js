// test/self-health-summary.test.js — the freshness line, in the shape the incident had (F16/F22, 2026-09-18).
//
// WHAT WENT WRONG. The health banner said `Tick freshness (12 symbols)` and then named FIVE — the first five
// in WATCHLIST ORDER, not the stalest. During the 16-hour outage that meant it named whichever symbols
// happened to be listed first, while the database held stale venue ticks for ≥17 symbols at ages 964m →
// 8182m. And after recovery the ages were a stairCASE (11 symbols at ~10m, 6 at 1041m, one at 8259m) because
// the watchlist sweep is interrupted part-way — a shape a single number cannot express.
//
// The audit's §8 also records that nothing under `test/` names `selfHealth`, the board that surfaces
// everything else. This file is a start: the summary is pure, so the interesting half is pinned without a
// database, and the two structural pins hold the parts that need one.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const { tickAgeSummary, TICK_SLA_MIN } = require('../trading/agent/selfHealth');

test('the worst symbols are named BY AGE, not by watchlist order', () => {
  // The stalest symbol is LAST in the list — exactly the case `slice(0, 5)` got wrong.
  const rows = [
    { symbol: 'Bitcoin', mins: 2 },
    { symbol: 'Gold', mins: 10 },
    { symbol: 'Silver', mins: 12 },
    { symbol: 'Sugar', mins: 964 },
    { symbol: 'Xiaomi', mins: 8182 },
  ];
  const s = tickAgeSummary(rows);
  assert.strictEqual(s.stale, 2, 'two are past the SLA');
  assert.deepStrictEqual(s.worst, ['Xiaomi 8182m', 'Sugar 964m'], 'worst-first, and the count matches the label');
});

test('the summary reports the DISTRIBUTION, not just a count', () => {
  // The recovery staircase from the audit: 11 fresh, 6 an hour+ stale, one a day+.
  const rows = [
    ...Array.from({ length: 11 }, (_, i) => ({ symbol: `s${i}`, mins: 10 })),
    ...Array.from({ length: 6 }, (_, i) => ({ symbol: `b${i}`, mins: 1041 })),
    { symbol: 'Xiaomi', mins: 8259 },
  ];
  const s = tickAgeSummary(rows);
  assert.strictEqual(s.checked, 18);
  assert.strictEqual(s.stale, 7);
  assert.match(s.shape, /^11 ≤15m · 6 ≤1d · 1 >1d$/, 'buckets run fresh → worse, and account for every symbol');
  const counts = [...s.shape.matchAll(/(\d+) /g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0);
  assert.strictEqual(counts, rows.length, 'the shape must add up to what was checked — a lost symbol is a lost fact');
});

test('a symbol that has NEVER been captured is not "0 minutes old"', () => {
  // `no ticks yet` is its own fact. Averaging it into an age would make the most broken state look the
  // freshest, which is the failure mode this whole line exists to avoid.
  const s = tickAgeSummary([{ symbol: 'Gold', mins: 3 }, { symbol: 'New', mins: null }, { symbol: 'Oil', mins: null }]);
  assert.strictEqual(s.missing, 2);
  assert.strictEqual(s.stale, 0, 'missing is not stale, and not fresh either');
  assert.strictEqual(s.shape, '1 ≤15m', 'only the measurable symbol is bucketed');
});

test('the SLA is one number, imported rather than restated at the call site', () => {
  const src = code('trading/agent/selfHealth.js');
  assert.match(src, /const TICK_SLA_MIN = 15;/, 'the SLA lives in one place');
  assert.match(src, /tickAgeSummary\(rows\)/, 'and the check uses the summary');
  assert.doesNotMatch(src, /stale\.slice\(0, 5\)/, 'the watchlist-order slice is gone');
});

test('F17: a blocked entry is not drift, and the tick line cannot silently drop a symbol', () => {
  const src = code('trading/agent/selfHealth.js');
  assert.match(src, /!e\.blocked/, 'a policy refusal must not read as a decision that never filled');
  assert.match(src, /const tickSum = tickAgeSummary\(rows\)/, 'and every watchlist symbol is pushed into `rows`');
  assert.ok(TICK_SLA_MIN > 0);
});
