// test/shadow-score.test.js — TRD-SHW-2 (2026-09-14). The forward scorer.
//
// The pin that matters most is the last one: benchmarkLongR must NOT mirror the
// call's direction. A benchmark that mirrors the treatment measures the treatment.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const s = require('../trading/agent/shadowScore');
const { code } = require('./_source');

// ★ THE FIXTURE USES THE PRODUCER'S FIELD NAMES (TRD-SHW-4, 2026-09-23). `PriceBars`
// stores the opening price as `openPrice`, and `store.listBars` runs `SELECT *`, so a
// store row carries that name verbatim. This helper used to build `open` — the same
// wrong name the implementation read — so all 13 tests passed while `excursionOf`
// returned null on EVERY real bar for seven days. A fixture built from the code's belief
// instead of the producer's contract cannot fail; this is the line that now prevents it.
const bar = (iso, open, high, low, close) => ({ barStart: iso, openPrice: open, high, low, closePrice: close });
const T0 = '2026-09-14T00:00:00.000Z';
const at = (h) => new Date(new Date(T0).getTime() + h * 3600 * 1000).toISOString();

// --- risk unit ------------------------------------------------------------

test('the risk unit is the desk convention: 2 x ATR14 as a percentage of price', () => {
  // ATR 1 on a price of 100 -> a 2% stop.
  assert.strictEqual(s.riskPctOf(1, 100), 2);
  assert.strictEqual(s.rOf(2, 2), 1);      // +2% against a 2% risk = +1R
  assert.strictEqual(s.rOf(-2, 2), -1);    // a stop-out is -1R
});

test('a missing or nonsensical risk unit yields null, not a fabricated R', () => {
  for (const [a, p] of [[null, 100], [1, null], [0, 100], [1, 0], [1, -5], ['x', 100]]) {
    assert.strictEqual(s.riskPctOf(a, p), null, `${a}/${p}`);
  }
  assert.strictEqual(s.rOf(1, null), null);
  assert.strictEqual(s.rOf(1, 0), null);
});

// --- forward-only ---------------------------------------------------------

test('★ the horizon slice is strictly FORWARD: no bar at or before the call', () => {
  const bars = [bar(T0, 100, 100, 100, 100), bar(at(1), 101, 101, 101, 101)];
  const rows = s.sliceHorizon(bars, T0, 1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].openPrice, 101, 'the call-time bar must not be used');
  assert.ok(!rows.some((b) => new Date(b.barStart).getTime() <= new Date(T0).getTime()));
});

test('not enough bars yet means NOT READY, never a partial score', () => {
  const bars = [bar(at(1), 100, 101, 99, 100), bar(at(2), 100, 101, 99, 100)];
  assert.deepStrictEqual(s.sliceHorizon(bars, T0, 24), []);
  assert.deepStrictEqual(s.scoreRow({ createdAt: T0, direction: 'buy', atr14: 1, priceAtCall: 100 }, bars, []), { ready: false });
});

test('the slice stops at the horizon even when many more bars exist', () => {
  const bars = [];
  for (let h = 1; h <= 60; h++) bars.push(bar(at(h), 100, 100, 100, 100));
  assert.strictEqual(s.sliceHorizon(bars, T0, 24).length, 24);
});

// --- excursions -----------------------------------------------------------

test('excursions are signed the desk way: MFE positive, MAE negative, MAE <= MFE', () => {
  const rows = [bar(at(1), 100, 104, 97, 103)];
  const buy = s.excursionOf(rows, 'buy');
  assert.strictEqual(buy.mfePct, 4);        // peak 104 vs open 100
  assert.strictEqual(buy.maePct, -3);       // trough 97 vs open 100
  assert.ok(buy.maePct <= buy.mfePct);
  assert.strictEqual(buy.closePct, 3);

  const sell = s.excursionOf(rows, 'sell');
  assert.strictEqual(sell.mfePct, 3);       // a short's favourable extreme is the LOW
  assert.strictEqual(sell.maePct, -4);
  assert.strictEqual(sell.closePct, -3);
  assert.ok(sell.maePct <= sell.mfePct);
});

test('a direction that is not buy or sell has no excursion at all', () => {
  assert.strictEqual(s.excursionOf([bar(at(1), 100, 104, 97, 103)], null), null);
  assert.strictEqual(s.excursionOf([bar(at(1), 100, 104, 97, 103)], 'none'), null);
});

// --- baseline B -----------------------------------------------------------

test('benchmarkLongPct is the UNMIRRORED long return of the window', () => {
  assert.strictEqual(s.benchmarkLongPct([bar(at(1), 100, 101, 99, 100), bar(at(2), 100, 112, 100, 110)]), 10);
  assert.strictEqual(s.benchmarkLongPct([bar(at(1), 100, 101, 99, 100), bar(at(2), 100, 100, 88, 90)]), -10);
});

test('★ B does NOT mirror the call: a short into a rising window is B-positive and T-negative', () => {
  // 24 bars (the horizon) drifting UP by 1 per hour.
  const bars = [bar(T0, 100, 100, 100, 100)];
  for (let h = 1; h <= 24; h++) bars.push(bar(at(h), 100, 100 + h, 100 - h / 2, 100 + h));
  const short = s.scoreRow(
    { createdAt: T0, direction: 'sell', atr14: 1, priceAtCall: 100, symbol: 'Gold' }, bars, [],
  );
  assert.strictEqual(short.ready, true);
  assert.strictEqual(short.realisedR, -12, 'a short into a +24% window loses 12R on a 2% unit');
  assert.strictEqual(short.benchmarkLongR, 12, 'the benchmark is LONG, so it gains — that is the point');
  assert.notStrictEqual(short.realisedR, short.benchmarkLongR);
});

// --- the field boundary (TRD-SHW-4) ---------------------------------------

test('★ absence is not zero: rOf must not fabricate a 0R out of a missing percentage', () => {
  // `Number(null) === 0`, so a guard placed AFTER coercion cannot tell "not measured"
  // from "measured zero". That is how benchmarkLongR came to be stored as 0.000000 on
  // 45 rows while realisedR was NULL — a value the gate's own isNum() accepts as real.
  assert.strictEqual(s.rOf(null, 2), null);
  assert.strictEqual(s.rOf('', 2), null);
  assert.strictEqual(s.rOf(undefined, 2), null);
  assert.strictEqual(s.rOf(0, 2), 0, 'a genuine zero is still a measurement');
});

test('★ the scorer reads the store\'s own field name, and still tolerates the short one', () => {
  const storeRow = { barStart: at(1), openPrice: 100, high: 104, low: 97, closePrice: 103 };
  const ex = s.excursionOf([storeRow], 'buy');
  assert.ok(ex, 'a store-shaped row must produce an excursion — this returned null for 7 days');
  assert.strictEqual(ex.open, 100);
  assert.strictEqual(ex.closePct, 3);
  assert.strictEqual(s.benchmarkLongPct([storeRow]), 3);
  // The short name must keep working: two repro scripts inject `open` deliberately.
  const injected = { barStart: at(1), open: 100, high: 104, low: 97, closePrice: 103 };
  assert.deepStrictEqual(s.excursionOf([injected], 'buy'), ex);
  assert.strictEqual(s.benchmarkLongPct([injected]), 3);
});

test('★ scoreRow on STORE-SHAPED bars fills BOTH R values, and B is not a fabricated zero', () => {
  // The exact shape the live scorer has never once handled: `openPrice`, not `open`.
  const bars = [{ barStart: T0, openPrice: 100, high: 100, low: 100, closePrice: 100 }];
  for (let h = 1; h <= 24; h++) {
    bars.push({ barStart: at(h), openPrice: 100, high: 100 + h, low: 100 - h, closePrice: 100 + h });
  }
  const out = s.scoreRow({ createdAt: T0, direction: 'buy', atr14: 1, priceAtCall: 100, symbol: 'Gold' }, bars, []);
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.realisedR, 12);
  assert.strictEqual(out.benchmarkLongR, 12);
  assert.notStrictEqual(out.benchmarkLongR, 0, 'a rising window\'s benchmark must not read as an exact zero');
  assert.ok(out.mfePct != null && out.maePct != null, 'excursions must be WRITTEN, not left NULL');
});

// --- baseline A -----------------------------------------------------------

test('baseline A matches symbol AND direction AND window', () => {
  const decisions = [
    { symbol: 'Gold', direction: 'sell', createdAt: at(2) },
    { symbol: 'Gold', direction: 'buy', createdAt: at(2) },
    { symbol: 'Oil', direction: 'sell', createdAt: at(2) },
    { symbol: 'Gold', direction: 'sell', createdAt: at(99) }, // beyond the horizon
  ];
  assert.strictEqual(s.confirmedIn(decisions, 'Gold', 'sell', T0, at(24)), true);
  assert.strictEqual(s.confirmedIn(decisions, 'Gold', 'buy', T0, at(24)), true);
  assert.strictEqual(s.confirmedIn(decisions, 'Silver', 'sell', T0, at(24)), false);
  assert.strictEqual(s.confirmedIn(decisions, 'Silver', 'buy', T0, at(24)), false);
  // The same direction on a DIFFERENT symbol must not count as confirmation.
  assert.strictEqual(s.confirmedIn([{ symbol: 'Oil', direction: 'sell', createdAt: at(2) }], 'Gold', 'sell', T0, at(24)), false);
});

// --- the assembled row ----------------------------------------------------

test('scoreRow fills every outcome field, and takes R from the ROW not later bars', () => {
  const bars = [bar(T0, 100, 100, 100, 100)];
  for (let h = 1; h <= 24; h++) bars.push(bar(at(h), 100, 100 + h, 100 - h, 100 + h));
  const out = s.scoreRow({ createdAt: T0, direction: 'buy', atr14: 1, priceAtCall: 100, symbol: 'Gold' }, bars, []);
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.barsToHorizon, 24);
  assert.strictEqual(out.riskPct, 2, 'the denominator comes from the row');
  assert.strictEqual(out.confirmedByStrategy, false);
  assert.ok(out.realisedR != null);
  // The horizon is 24 one-hour bars from midnight, so it ENDS on the 15th. Asserting
  // the value rather than a prefix — the first version of this line asserted
  // startsWith('2026-09-14') and failed on correct code.
  assert.strictEqual(out.horizonAt, at(24));
  assert.strictEqual(out.realisedR, 12); // +24% against a 2% risk unit
});

test('a row with no direction is not a claim and is left unscored', async () => {
  // Exercised through the pure path: no direction -> no excursion, no R.
  const rows = [bar(at(1), 100, 104, 97, 103)];
  assert.strictEqual(s.excursionOf(rows, null), null);
  const src = code('trading/agent/shadowScore.js');
  assert.ok(src.includes("row.direction !== 'buy' && row.direction !== 'sell'"), 'the job must skip non-claims');
});

// ------------------------------------------------------------ structure

test('STRUCTURE: the scorer writes only through store.scoreShadowSignal', () => {
  const src = code('trading/agent/shadowScore.js');
  assert.ok(src.includes('store.scoreShadowSignal('), 'the outcome write must be the dedicated accessor');
  assert.ok(!src.includes('UPDATE ShadowSignals'), 'the scorer must not hand-roll SQL');
  for (const forbidden of ['openTrade', 'closeTrade', 'executor', 'connector']) {
    assert.ok(!src.includes(forbidden), `the scorer must not reference ${forbidden}`);
  }
});
