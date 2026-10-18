// test/autopsy-metrics.test.js — 2026-09-12: the capture metric must be trustworthy.
//
// Two defects found by reconciling day one (2026-09-11, +24.86 across 7 closes):
//
//  1. DIRECTION. MFE (favourable excursion) and MAE (adverse excursion) were
//     computed as (max(open, mid) * dir) and (min * dir). For a SELL the best
//     price seen is the LOW, so the two were swapped: a short's "MFE" reported
//     its worst adverse excursion and vice versa. Half the book is shorts.
//
//  2. WINDOW. store.ticksSince had no upper bound, so a closed trade's
//     "maximum favourable excursion" included every tick from the open until
//     the backfill ran — price action after the position was already out. That
//     is the malicious case: a trade that never went our way still looks like it
//     "had 0.46% available", and the learning loop concludes we exited too early.
//
// Both would corrupt exactly the question analytics asks: did the exit capture
// the move that was available while we were actually in the trade?
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const store = require('../trading/store');
const autopsy = require('../trading/agent/autopsy');

// autopsy resolves ticks THROUGH the store aggregate (`store.ticksSince`), so
// patching store/ticks.js directly has no effect — and a silent fallthrough
// queries the LIVE database with the fixture timestamps. The stub therefore
// records its calls and the tests assert on that, so a broken stub fails loudly
// instead of quietly grading real market data.
let calls = [];
const mockTicks = (rows) => {
  const orig = store.ticksSince;
  store.ticksSince = async (userId, symbol, venue, since, until) => {
    calls.push({ symbol, venue, since, until });
    return rows;
  };
  return () => { store.ticksSince = orig; };
};

const OPEN = '2026-09-11T10:00:00.000Z';
const CLOSE = '2026-09-11T11:00:00.000Z';
const tick = (at, mid) => ({ bid: mid - 0.01, ask: mid + 0.01, capturedAt: at });

// Entry 100. Path: dips to 99.0 (-1.0%), peaks at 101.5 (+1.5%), closes 100.5.
const PATH = [
  tick('2026-09-11T10:05:00.000Z', 99.5),
  tick('2026-09-11T10:20:00.000Z', 99.0),
  tick('2026-09-11T10:45:00.000Z', 101.5),
  tick('2026-09-11T10:55:00.000Z', 100.5),
];

test('buy: MFE is the favourable extreme, MAE the adverse one', async () => {
  calls = [];
  const restore = mockTicks(PATH);
  try {
    const m = await autopsy.computeMetrics(1, {
      symbol: 'Oil', venue: 'plus500', direction: 'buy',
      openPrice: 100, closePrice: 100.5, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(calls.length, 1, 'stub must be used, not the live tick table');
    assert.strictEqual(m.holdingMinutes, 60);
    assert.ok(m.mfePct > 0 && m.maePct < 0, 'MFE positive, MAE negative');
    assert.strictEqual(m.mfePct, 1.5);
    assert.strictEqual(m.maePct, -1);
  } finally { restore(); }
});

test('sell swaps which extreme is favourable, and keeps MFE > 0 > MAE', async () => {
  // Same price path. For a BUY the favourable extreme is the HIGH (101.5 = +1.5%)
  // and the adverse one the LOW (99.0 = -1.0%). For a SELL those roles are
  // mirrored: +1.0% favourable, -1.5% adverse. The pre-fix code signed the raw
  // max/min pair by direction, so a sell reported mfePct -1.5 / maePct +1.0 —
  // MFE negative, i.e. "the best it ever got was 1.5% against us". The invariant
  // is the swap, not equality.
  const restore = mockTicks(PATH);
  try {
    const buy = await autopsy.computeMetrics(1, {
      symbol: 'Oil', venue: 'plus500', direction: 'buy',
      openPrice: 100, closePrice: 100.5, openAt: OPEN, closeAt: CLOSE,
    });
    const sell = await autopsy.computeMetrics(1, {
      symbol: 'Oil', venue: 'plus500', direction: 'sell',
      openPrice: 100, closePrice: 99.5, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(buy.mfePct, 1.5);
    assert.strictEqual(buy.maePct, -1);
    assert.strictEqual(sell.mfePct, 1, 'best price for a short is the LOW');
    assert.strictEqual(sell.maePct, -1.5, 'worst price for a short is the HIGH');
    // The swap property: each direction's MFE is the other's |MAE|.
    assert.strictEqual(sell.mfePct, Math.abs(buy.maePct));
    assert.strictEqual(buy.mfePct, Math.abs(sell.maePct));
    assert.ok(sell.mfePct > 0 && sell.maePct < 0, 'a short can have positive MFE');
  } finally { restore(); }
});

test('ticks after the close are excluded from MFE/MAE and slippage', async () => {
  // A +9% rally one minute AFTER we are out must not appear as available move.
  const rows = [...PATH, tick('2026-09-11T11:01:00.000Z', 109.0)];
  calls = [];
  const restore = mockTicks(rows);
  try {
    const m = await autopsy.computeMetrics(1, {
      symbol: 'Oil', venue: 'plus500', direction: 'buy',
      openPrice: 100, closePrice: 100.5, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(calls.length, 1, 'stub must be used');
    // The window is bounded at the close at the SOURCE, not only by filtering.
    assert.strictEqual(new Date(calls[0].until).toISOString(), CLOSE, 'closeAt passed as the upper bound');
    assert.strictEqual(m.mfePct, 1.5, 'post-close tick ignored');
    assert.strictEqual(m.maePct, -1);
    // Slippage is the close fill vs the last mid BEFORE the close (100.5), not 109.
    assert.strictEqual(m.slippagePct, 0);
  } finally { restore(); }
});

test('fewer than 3 ticks in the window leaves metrics null rather than guessing', async () => {
  const restore = mockTicks(PATH.slice(0, 2));
  try {
    const m = await autopsy.computeMetrics(1, {
      symbol: 'Oil', venue: 'plus500', direction: 'buy',
      openPrice: 100, closePrice: 100.5, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(m.mfePct, null);
    assert.strictEqual(m.maePct, null);
    assert.strictEqual(m.holdingMinutes, 60, 'holding time needs no ticks');
  } finally { restore(); }
});

test('MFE can never read lower than the move the trade actually achieved', async () => {
  // Real case, trade 29 (Oil buy, 2026-09-11): the 5-min ticks topped out at
  // 1.866% but the exit fill was 2.145% away from the entry — the true peak fell
  // between two samples. Reading that literally gives capture efficiency of 115%
  // and makes "did the TP leave money on the table?" unanswerable.
  const rows = [
    tick('2026-09-11T10:10:00.000Z', 100.3),
    tick('2026-09-11T10:30:00.000Z', 101.2),
    tick('2026-09-11T10:50:00.000Z', 100.9),
  ];
  const restore = mockTicks(rows);
  try {
    const m = await autopsy.computeMetrics(1, {
      symbol: 'Oil', venue: 'plus500', direction: 'buy',
      openPrice: 100, closePrice: 102.0, openAt: OPEN, closeAt: CLOSE,
    });
    const achieved = ((102 - 100) / 100) * 100;
    assert.ok(m.mfePct >= achieved, `MFE ${m.mfePct} must be >= achieved ${achieved}`);
    assert.strictEqual(m.mfePct, 2);
    // The same guard applies to a short: the exit fill is the low, so the
    // favourable extreme must be at least as good as the close.
    const s = await autopsy.computeMetrics(1, {
      symbol: 'Oil', venue: 'plus500', direction: 'sell',
      openPrice: 100, closePrice: 98.0, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(s.mfePct, 2);
    assert.ok(s.mfePct >= 2);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// TRD-117 (2026-09-22): the excursion's PROVENANCE.
//
// The close is appended to the path on purpose (the test above needs it), but that makes
// MAE degenerate on a row that exits at its worst point — which is what a stop-out IS. The
// metric then restates the close instead of measuring an excursion. Measured on the live
// book: 23 of 39 rows carrying maePct had it EXACTLY equal to the close excursion to 4dp,
// and that set was every row whose close was adverse.
//
// The fix records WHICH observation produced each extreme. No number moves, so the tests
// below are about the LABEL and about the tautology it makes visible — not about new maths.
// ---------------------------------------------------------------------------

test('TRD-117: a stop-out row labels its MAE as coming FROM THE CLOSE — the tautology, named', async () => {
  // A short that gets stopped out: price runs up and the venue closes it at the high.
  // Path never goes our way at all, so the adverse extreme IS the close.
  const rows = [
    tick('2026-09-11T10:10:00.000Z', 99.0),
    tick('2026-09-11T10:30:00.000Z', 100.0),
    tick('2026-09-11T10:50:00.000Z', 101.0),
  ];
  const restore = mockTicks(rows);
  try {
    const m = await autopsy.computeMetrics(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'sell',
      openPrice: 100, closePrice: 103, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(m.maeSource, 'close', 'the adverse extreme is the close');
    assert.strictEqual(m.mfeSource, 'mid', 'the favourable extreme came from a real tick');
    // THE POINT OF THE LABEL: when it says close, the metric IS the close excursion, so it
    // cannot be read as "how far price ran against us". This is what 23 live rows looked like
    // while every reader treated the number as an excursion.
    const closeExcursion = +((((103 - 100) * -1) / 100) * 100).toFixed(4);
    assert.strictEqual(m.maePct, closeExcursion, 'an anchored MAE equals the close excursion exactly');
  } finally { restore(); }
});

test('TRD-117: an adverse extreme that came from a MID is labelled mid, and is a real excursion', async () => {
  // A short whose worst moment was a tick ABOVE the eventual close. Here the MAE is a
  // genuine excursion and must NOT be confusable with the close.
  const rows = [
    tick('2026-09-11T10:10:00.000Z', 104.0),
    tick('2026-09-11T10:30:00.000Z', 99.0),
    tick('2026-09-11T10:50:00.000Z', 100.0),
  ];
  const restore = mockTicks(rows);
  try {
    const m = await autopsy.computeMetrics(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'sell',
      openPrice: 100, closePrice: 101, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(m.maeSource, 'mid');
    assert.strictEqual(m.mfeSource, 'mid');
    assert.strictEqual(m.maePct, -4, 'the tick at 104 is the adverse extreme');
    // And it is NOT the close: the close only moved 1% against us.
    const closeExcursion = +((((101 - 100) * -1) / 100) * 100).toFixed(4);
    assert.notStrictEqual(m.maePct, closeExcursion, 'a mid-sourced MAE is a different number from the close');
  } finally { restore(); }
});

test('TRD-117: the label follows DIRECTION, like the extremes themselves', async () => {
  // Same path, same close. For a BUY the close is the FAVOURABLE extreme, so it is MFE
  // that is anchored; for a SELL it is MAE. A label that did not swap with direction
  // would be wrong on one half of the book — the same class of bug as the 2026-09-12
  // favourable/adverse swap this file already guards.
  const rows = [
    tick('2026-09-11T10:10:00.000Z', 99.5),
    tick('2026-09-11T10:30:00.000Z', 100.5),
    tick('2026-09-11T10:50:00.000Z', 101.0),
  ];
  const restore = mockTicks(rows);
  try {
    const buy = await autopsy.computeMetrics(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'buy',
      openPrice: 100, closePrice: 102, openAt: OPEN, closeAt: CLOSE,
    });
    const sell = await autopsy.computeMetrics(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'sell',
      openPrice: 100, closePrice: 98, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(buy.mfeSource, 'close', 'a buy closing at its high anchors MFE');
    assert.strictEqual(buy.maeSource, 'mid');
    assert.strictEqual(sell.mfeSource, 'close', 'a sell closing at its low anchors MFE too');
    assert.strictEqual(sell.maeSource, 'mid');
  } finally { restore(); }
});

test('TRD-117: no excursion means no provenance — a stale source must never survive', async () => {
  // A forced recompute that can no longer compute the path must CLEAR the provenance with the
  // number, or a reader sees a source pointing at a value that is gone.
  const restore = mockTicks(PATH.slice(0, 2));
  try {
    const m = await autopsy.computeMetrics(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'buy',
      openPrice: 100, closePrice: 100.5, openAt: OPEN, closeAt: CLOSE,
    });
    assert.strictEqual(m.mfePct, null);
    assert.strictEqual(m.maePct, null);
    assert.strictEqual(m.mfeSource, null);
    assert.strictEqual(m.maeSource, null);
  } finally { restore(); }
});
