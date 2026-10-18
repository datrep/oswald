// test/trailing-anchor.test.js — 2026-09-12: the trailing stop must be anchored
// to the position's OWN path, never to prices from before it existed.
//
// quant.js used to do `const src = since.length >= 5 ? since : bars` when
// building the peak/trough context for a trailing stop. For any position
// younger than 5 bars of the 1h signal series — i.e. younger than ~5 hours,
// which is most positions — it discarded the since-open filter entirely and took
// the peak over the WHOLE lookback window, including pre-entry prices. For a long
// entered below the recent high, the trail then sat above the market and the exit
// rule fired immediately, on a stop the price had never reached.
//
// It is not a cosmetic bug. On 2026-09-11 three of seven closes came from it:
//   - trade 1032 (Oil buy, 25 min) exited quoting "trailing stop 102.9064" while
//     the position's own best price was 100.145 — an implied peak of ~104.2,
//     which was Oil's PRE-ENTRY high. It capped a winner at 65% of the move.
//   - trades 1031 (45 min, -1.23) and 1028 (60 min, -0.81) left the same way.
// The backtester seeds peak=trough=entryPrice and only updates forward, so this
// also restores live<->backtest parity — every backtest's expectancy had been
// measured against an exit rule the live desk was not actually running.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openPositionContext } = require('../trading/agent/quant');

const bar = (iso, close) => ({ barStart: iso, closePrice: close });
const OPEN_AT = '2026-09-11T16:35:00.000Z';
const pos = { symbol: 'Oil', venue: 'plus500', direction: 'buy', openPrice: 99.9, openAt: OPEN_AT };

// Oil's pre-entry history — a high of 104.33 that the position never saw, then
// the entry region and the position's own (small) move.
const BARS = [
  bar('2026-09-11T08:00:00.000Z', 103.10),
  bar('2026-09-11T09:00:00.000Z', 104.33), // pre-entry high -> must be IGNORED
  bar('2026-09-11T10:00:00.000Z', 102.40),
  bar('2026-09-11T16:00:00.000Z', 99.85),  // bar containing the entry (starts before it)
  bar('2026-09-11T16:35:00.000Z', 100.10),
  bar('2026-09-11T17:00:00.000Z', 100.145),
];

test('peak/trough come from the position path only — pre-entry bars never contribute', () => {
  const ctx = openPositionContext(BARS, pos);
  assert.strictEqual(ctx.direction, 'buy');
  assert.strictEqual(ctx.peak, 100.145, 'peak is the best price SINCE entry');
  assert.strictEqual(ctx.trough, 99.9, 'trough is floored at the entry price, not a pre-entry low');
  // The day-one failure in one line: the old fallback produced peak ~104.33.
  assert.ok(ctx.peak < 102, `peak ${ctx.peak} must not be the pre-entry high 104.33`);
});

test('a brand-new position (no bars since entry) anchors at the entry price', () => {
  // Hold time < one bar: `since` is empty, which is exactly what used to trigger
  // the fallback to the full history.
  const bars = [bar('2026-09-11T08:00:00.000Z', 104.33), bar('2026-09-11T09:00:00.000Z', 103.10)];
  const ctx = openPositionContext(bars, pos);
  assert.strictEqual(ctx.peak, 99.9, 'equals openPrice -> trail starts at openPrice - k*ATR');
  assert.strictEqual(ctx.trough, 99.9);
});

test('the trail for a fresh long sits BELOW the market, so it cannot fire instantly', () => {
  // The reproduction of trade 1032: 2xATR on Oil ~= 1.42. Old behaviour put the
  // trail at 104.33 - 1.42 = 102.91 against a price of 100.145 (already breached).
  const ctx = openPositionContext(BARS, pos);
  const atr = 0.7105;
  const trail = ctx.peak - 2 * atr;
  assert.ok(trail < 100.145, `trail ${trail.toFixed(4)} must be below the current price`);
  assert.strictEqual(+trail.toFixed(4), 98.724, 'trail = peak - 2xATR from the position path');
});

test('a sell mirrors: pre-entry lows are ignored and the entry price is the floor', () => {
  const s = { ...pos, direction: 'sell', openPrice: 104.28, openAt: '2026-09-10T18:03:00.000Z' };
  const bars = [
    bar('2026-09-10T08:00:00.000Z', 100.53), // pre-entry low -> must be IGNORED
    bar('2026-09-10T18:03:00.000Z', 104.20),
    bar('2026-09-10T19:00:00.000Z', 103.60),
    bar('2026-09-10T22:00:00.000Z', 104.28),
  ];
  const ctx = openPositionContext(bars, s);
  assert.strictEqual(ctx.direction, 'sell');
  assert.strictEqual(ctx.trough, 103.60, 'best price for a short is the LOW since entry');
  assert.strictEqual(ctx.peak, 104.28, 'peak floored at the entry price');
  assert.ok(ctx.trough > 100.53, 'the pre-entry low must not become the anchor');
});

test('pre-entry bars are never consulted — by any threshold (refactor-proof)', () => {
  // The original defect was `since.length >= 5 ? since : bars`: a THRESHOLD that
  // silently fell back to pre-entry bars for young positions. Asserting the
  // consequence ("the trail sits below the market") would still pass under a
  // future variant of the same bug with a different threshold. This asserts the
  // CAUSE instead: mutate every pre-entry bar into an absurd value and require
  // the resulting context to be byte-identical.
  const baseline = openPositionContext(BARS, pos);
  const openMs = new Date(OPEN_AT).getTime();
  const poison = (v) => BARS.map((b) => (new Date(b.barStart).getTime() < openMs ? { ...b, closePrice: v } : b));

  assert.deepStrictEqual(openPositionContext(poison(99999), pos), baseline, 'a huge pre-entry high must not move the peak');
  assert.deepStrictEqual(openPositionContext(poison(-99999), pos), baseline, 'a huge pre-entry low must not move the trough');

  // And in the exact shape that triggered the fallback hardest: a young position
  // with only ONE post-entry bar, where `since.length < 5` used to be true.
  assert.deepStrictEqual(
    openPositionContext(poison(99999).slice(0, 5), pos),
    openPositionContext(BARS.slice(0, 5), pos),
    'with a single post-entry bar the result must depend only on that bar',
  );
});

test('bars with no entry timestamp or price yield no context (no guessing)', () => {
  assert.strictEqual(openPositionContext(BARS, null), null);
  assert.strictEqual(openPositionContext(BARS, { symbol: 'Oil', openPrice: null, openAt: OPEN_AT }), null);
  assert.strictEqual(openPositionContext(BARS, { symbol: 'Oil', openPrice: 99.9, openAt: null }), null);
  assert.strictEqual(openPositionContext(BARS, { symbol: 'Oil', openPrice: 'abc', openAt: OPEN_AT }), null);
});
