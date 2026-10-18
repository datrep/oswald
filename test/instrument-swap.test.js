// test/instrument-swap.test.js — TRD-GRD-3 (2026-09-24).
//
// Pins the detector for the defect that put 151 rows of the wrong instrument in front of quant across
// seven watchlist symbols. Two things make it safe enough to act, and both are pinned here:
//   1. the match is an EXACT identity, so a flat bar is the only shape two unrelated instruments could
//      legitimately share — and `isSwapCandidate` refuses it;
//   2. the VICTIM is chosen by the symbol's own ticks, not by its bar history, so there is no median to be
//      corrupted by the very defect being detected.
//
// ★ THE NUMBERS IN THE GOLD/SINOPEC CASE ARE MEASURED, NOT INVENTED. They are row 1720610's neighbours and
// the PriceTicks summary for 2026-09-23 08:00 read out of DB_Oswald on 2026-09-24 (Gold 222 ticks, mid
// 4316.86-4322.51; Sinopec 15 ticks, mid 4.44-4.44). This repo has twice shipped a defect past a green
// suite because the FIXTURE was built from the code's belief instead of from the producer; a fixture that
// cannot disagree with the code is not a test.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bars = require('../trading/store/bars');
const { code } = require('./_source');

// The real swapped pair, 2026-09-23 08:00. Gold's row is the source; Sinopec's is the copy.
const GOLD_BAR = { symbol: 'Gold', venue: 'plus500_chart', timeframe: '1h', barStart: '2026-09-23T08:00:00Z', openPrice: 4319.24, high: 4322.40, low: 4315.26, closePrice: 4317.91 };
const SINOPEC_BAR = { ...GOLD_BAR, symbol: 'Sinopec' };
const GOLD_TICKS = [4316.86, 4319.42, 4322.51];   // 222 ticks, min/avg/max
const SINOPEC_TICKS = [4.44, 4.44, 4.44];         // 15 ticks, all at 4.44

test('isSwapCandidate: the real Gold/Sinopec pair is a candidate', () => {
  assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, SINOPEC_BAR), true);
});

test('isSwapCandidate refuses every near miss — the same bar is not enough', () => {
  const same = { ...SINOPEC_BAR, symbol: 'Gold' };
  assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, same), false, 'the SAME symbol is not a swap');

  assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, { ...SINOPEC_BAR, venue: 'yahoo' }), false);
  assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, { ...SINOPEC_BAR, timeframe: '1d' }), false);
  assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, { ...SINOPEC_BAR, barStart: '2026-09-23T09:00:00Z' }), false);

  // One digit different is not a copy. A detector that allowed drift here would flag genuine near-misses.
  assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, { ...SINOPEC_BAR, closePrice: 4317.92 }), false);
  assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, { ...SINOPEC_BAR, low: 4315.27 }), false);
});

test('★ isSwapCandidate refuses a FLAT bar — the one shape two instruments could legitimately share', () => {
  // Two illiquid instruments can both sit unmoved at the same price for an hour, giving identical OHLC on
  // both. That is a coincidence, not a swap, and it is the ONLY false-positive mechanism this predicate
  // has. `high > low` excludes it.
  const flatA = { symbol: 'A', venue: 'plus500_chart', timeframe: '1h', barStart: '2026-09-23T08:00:00Z', openPrice: 0.5, high: 0.5, low: 0.5, closePrice: 0.5 };
  const flatB = { ...flatA, symbol: 'B' };
  assert.strictEqual(bars.isSwapCandidate(flatA, flatB), false, 'a flat bar must never be called a swap');

  // ...and one that moved is still caught, so the guard is not a blanket exclusion.
  const moved = { ...flatA, high: 0.51 };
  assert.strictEqual(bars.isSwapCandidate(moved, { ...moved, symbol: 'B' }), true);
});

test('isSwapCandidate fails closed on missing or unusable data', () => {
  for (const bad of [null, undefined, {}, { ...SINOPEC_BAR, high: null }, { ...SINOPEC_BAR, low: 'x' }]) {
    assert.strictEqual(bars.isSwapCandidate(GOLD_BAR, bad), false);
    assert.strictEqual(bars.isSwapCandidate(bad, GOLD_BAR), false);
  }
});

test('tickAgreesWithBar uses INTERVAL INTERSECTION, so it is scale-free', () => {
  assert.strictEqual(bars.tickAgreesWithBar(GOLD_BAR, GOLD_TICKS), 'agrees');
  // The source's bar agrees even though its own low (4315.26) sits BELOW the retained tick minimum
  // (4316.86) — tick pruning and the partial re-aggregation both move a bar's extremes. An equality test
  // would call the LEGITIMATE row a mismatch here, which is why this is a range overlap.
  assert.ok(GOLD_BAR.low < Math.min(...GOLD_TICKS), 'the fixture must actually exercise that gap');
});

test('★ tickAgreesWithBar convicts the copy from its OWN ticks', () => {
  // Sinopec's bar claims 4315.26-4322.40 while Sinopec's own ticks say 4.44. Nothing about Gold is needed
  // to reach that verdict — which is what makes this non-circular.
  assert.strictEqual(bars.tickAgreesWithBar(SINOPEC_BAR, SINOPEC_TICKS), 'disagrees');
  assert.strictEqual(bars.tickAgreesWithBar({ ...SINOPEC_BAR, low: 4.42, high: 4.45 }, SINOPEC_TICKS), 'agrees');
});

test('tickAgreesWithBar returns UNGUARDED, not a pass, when it cannot know', () => {
  assert.strictEqual(bars.tickAgreesWithBar(SINOPEC_BAR, []), 'unguarded');
  assert.strictEqual(bars.tickAgreesWithBar(SINOPEC_BAR, null), 'unguarded');
  assert.strictEqual(bars.tickAgreesWithBar(SINOPEC_BAR, [null, NaN, 0, -1]), 'unguarded');
  assert.strictEqual(bars.tickAgreesWithBar({ ...SINOPEC_BAR, low: 0 }, SINOPEC_TICKS), 'unguarded');
});

test('★ swapVerdict names the VICTIM from the ticks alone — the real case', () => {
  const v = bars.swapVerdict(GOLD_BAR, GOLD_TICKS, SINOPEC_BAR, SINOPEC_TICKS);
  assert.strictEqual(v.verdict, 'victim');
  assert.strictEqual(v.victim, 'Sinopec', 'the side that contradicts its own ticks is the copied one');
  assert.strictEqual(v.source, 'Gold');
});

test('★ swapVerdict separates a pair no LEVEL test could — CK Hutchison vs Silver, ~1.1x apart', () => {
  // The tightest real pair: the copy holds 69.18 while Silver's own ticks say 63.x. A 3x ratio test sees
  // nothing here; the two symbols' own ticks do. This is the case that justifies the tick comparison.
  const copy = { symbol: 'Silver', venue: 'plus500_chart', timeframe: '1h', barStart: '2026-09-09T08:00:00Z', openPrice: 69.18, high: 69.30, low: 69.05, closePrice: 69.18 };
  const src = { ...copy, symbol: 'CK Hutchison' };
  const v = bars.swapVerdict(src, [69.10, 69.18, 69.31], copy, [63.40, 63.55, 63.72]);
  assert.strictEqual(v.verdict, 'victim');
  assert.strictEqual(v.victim, 'Silver');
  assert.ok(Math.abs(69.18 / 63.55) < 1.15, 'the levels are within ~15% — no ratio test could act on this');
});

test('swapVerdict acts on NOTHING when it is not sure', () => {
  // Missing ticks on either side.
  assert.strictEqual(bars.swapVerdict(GOLD_BAR, [], SINOPEC_BAR, SINOPEC_TICKS).verdict, 'unguarded');
  assert.strictEqual(bars.swapVerdict(GOLD_BAR, GOLD_TICKS, SINOPEC_BAR, []).verdict, 'unguarded');
  // Both sides consistent with their own ticks: identical OHLC but NOT a swap — stand down.
  const b2 = { ...SINOPEC_BAR, low: 4.42, high: 4.45 };
  const both = bars.swapVerdict({ ...GOLD_BAR }, GOLD_TICKS, b2, SINOPEC_TICKS);
  assert.strictEqual(both.verdict, 'ambiguous');
  assert.strictEqual(both.reason, 'both_agree');
  // Both contradicting their own ticks is a DIFFERENT defect; this predicate must not claim it.
  // NOTE: the two sides must be DISTINCT symbols and the tick sets must disagree with their OWN side — a
  // first version of this case reused one symbol for both bars and passed Gold's ticks against a Gold-scale
  // bar, which made `va` agree and returned a legitimate `victim` verdict. The test was wrong, not the code.
  const bad = bars.swapVerdict(GOLD_BAR, [1.0], SINOPEC_BAR, [2.0]);
  assert.strictEqual(bad.verdict, 'ambiguous');
  assert.strictEqual(bad.reason, 'both_disagree');
});

test('STRUCTURE: the bar build pass actually RUNS the check — as TEXT and as a LIVE SYMBOL', () => {
  // Without a call site this is a library nobody calls — which is exactly the state `barScaleReview` has
  // been in since GRD-1. Assert the call, not the intent.
  const src = code('trading/agent/bars.js');
  assert.ok(src.includes('flagSwappedBars('), 'buildAll must invoke flagSwappedBars, or nothing is blocked');
  assert.ok(src.includes('swaps'), 'the result must travel on the bars_built event, not be discarded');

  // ★ THE TEXT ASSERTION ABOVE IS NOT ENOUGH, AND THIS WAS A REAL FAILURE RATHER THAN A HYPOTHETICAL.
  // `agent/bars.js` reaches the store through the INDEX in `trading/store.js`. On the first attempt
  // `flagSwappedBars` was exported from `store/bars.js` but NOT re-exported by the index, so
  // `store.flagSwappedBars` was `undefined` and `buildAll` would have thrown a TypeError on EVERY wake —
  // while the text assertion above passed untouched, because the call site LOOKED correct. A call site is
  // only real if the symbol resolves, so assert the resolution too. Text pins cannot see this; only
  // requiring the module can.
  const store = require('../trading/store');
  assert.strictEqual(typeof store.flagSwappedBars, 'function', 'the store index must re-export flagSwappedBars or buildAll throws every wake');
  assert.strictEqual(typeof store.isSwapCandidate, 'function');
  assert.strictEqual(typeof store.tickAgreesWithBar, 'function');
  assert.strictEqual(typeof store.swapVerdict, 'function');
});
