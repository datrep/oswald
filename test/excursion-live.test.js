// test/excursion-live.test.js — P4 (2026-10-01): the in-flight excursion, recorded and never acted on.
//
// WHY THIS WENT IN THE WAKE PIPELINE AND NOT THE POLLER. The plan assumed `accountPoller` could feed the trigger.
// It cannot: the poller knows the venue's rows but NOT the trade's stop distance, and `pnl_range` is written when
// the position DISAPPEARS, so it is a post-close record. The two inputs only meet in the wake's position review,
// which holds `openTrades` (with the stop) and `quantResult` (with the live price) at the same moment.
//
// WHAT IS PINNED HERE.
// 1. THE ARITHMETIC, including the direction of the adverse move for both a buy and a sell.
// 2. ⚠ THE CLAMP THAT WAS A REAL BUG IN THE FIRST DRAFT. `excursionFraction` derives its answer from
//    `Math.abs(maePct)` because `maePct` is a magnitude by definition. Handing it a SIGNED move made a position
//    in PROFIT report an excursion of 1.0 and `wouldCut: true`. The test below fails if that clamp is removed.
// 3. THE COVERAGE, because an open trade the scan cannot evaluate must be COUNTED — a thin scan that reports no
//    gaps is indistinguishable from a clean one.
// 4. THE OBSERVE-ONLY PROPERTY, asserted structurally so a later change cannot quietly make it act.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { code } = require('./_source');
const { liveExcursionScan } = require('../trading/agent/wakePipeline');
const { EXCURSION_THRESHOLD } = require('../trading/agent/autopsy');

const WAKE = 'trading/agent/wakePipeline.js';

// entry 100, stop 98 -> a 2.00% stop distance, so the fraction is (adverse% / 2).
const buy = (over = {}) => ({ id: 1, symbol: 'Gold', direction: 'buy', status: 'open', openPrice: 100, stopPrice: 98, ...over });
const px = (p) => ({ symbols: [{ symbol: 'Gold', price: p }] });

test('★ the fraction is the adverse move over the stop distance, for a BUY', () => {
  // 1.00 of adverse move against a 2.00 stop = 0.50, below the 0.6 threshold
  let s = liveExcursionScan({ quantResult: px(99), openTrades: [buy()] });
  assert.equal(s.n, 1);
  assert.equal(s.rows[0].excursionFraction, 0.5);
  assert.equal(s.rows[0].excursionStopDistPct, 2);
  assert.equal(s.rows[0].wouldCut, false);
  assert.equal(s.threshold, EXCURSION_THRESHOLD);
  // 1.40 of adverse move = 0.70, over the threshold
  s = liveExcursionScan({ quantResult: px(98.6), openTrades: [buy()] });
  assert.equal(s.rows[0].excursionFraction, 0.7);
  assert.equal(s.rows[0].wouldCut, true);
  assert.equal(s.nWouldCut, 1);
  // AT the stop is 1.0, past it is > 1
  s = liveExcursionScan({ quantResult: px(98), openTrades: [buy()] });
  assert.equal(s.rows[0].excursionFraction, 1);
  s = liveExcursionScan({ quantResult: px(96), openTrades: [buy()] });
  assert.equal(s.rows[0].excursionFraction, 2);
});

test('★★ A POSITION IN PROFIT IS NOT AN EXCURSION — the clamp that was missing in the first draft', () => {
  // The buy is 2% ABOVE its entry. `excursionFraction` uses Math.abs, so a signed move would read as 1.0 and
  // `wouldCut: true`: a false alert on every winner, which is the one thing this measure must never do.
  const s = liveExcursionScan({ quantResult: px(102), openTrades: [buy()] });
  assert.equal(s.rows[0].excursionFraction, 0, 'a favourable move is ZERO adverse excursion');
  assert.equal(s.rows[0].wouldCut, false, 'and must never alert');
  assert.equal(s.nWouldCut, 0);
});

test('★ direction is respected — a SELL is hurt by a HIGHER price, not a lower one', () => {
  const sell = { id: 2, symbol: 'Gold', direction: 'sell', status: 'open', openPrice: 100, stopPrice: 102 };
  // price up 1.00 -> adverse for the sell -> 0.5 of the 2.00 stop
  let s = liveExcursionScan({ quantResult: px(101), openTrades: [sell] });
  assert.equal(s.rows[0].excursionFraction, 0.5);
  // price down 1.00 -> FAVOURABLE for the sell -> zero
  s = liveExcursionScan({ quantResult: px(99), openTrades: [sell] });
  assert.equal(s.rows[0].excursionFraction, 0);
  assert.equal(s.rows[0].wouldCut, false);
});

test('★★ COVERAGE: an unevaluable position is NAMED, never silently skipped', () => {
  const cases = [
    { t: buy({ openPrice: null }), why: 'levels_unrecorded' },
    { t: buy({ stopPrice: null }), why: 'levels_unrecorded' },
    { t: buy({ direction: null }), why: 'levels_unrecorded' },
  ];
  for (const c of cases) {
    const s = liveExcursionScan({ quantResult: px(99), openTrades: [c.t] });
    assert.equal(s.n, 0);
    assert.equal(s.nUnmeasurable, 1, 'the gap must be counted');
    assert.equal(s.unmeasurable[0].why, c.why);
  }
  // no live price for the symbol
  let s = liveExcursionScan({ quantResult: { symbols: [] }, openTrades: [buy()] });
  assert.equal(s.unmeasurable[0].why, 'no_live_price');
  // a closed trade is not part of the review at all
  s = liveExcursionScan({ quantResult: px(99), openTrades: [buy({ status: 'closed' })] });
  assert.equal(s.n, 0);
  assert.equal(s.nUnmeasurable, 0, 'a closed trade is neither measured nor a gap');
  // and the empty book is a clean zero, not an error
  s = liveExcursionScan({ quantResult: px(99), openTrades: [] });
  assert.deepEqual({ n: s.n, nUnmeasurable: s.nUnmeasurable, nWouldCut: s.nWouldCut }, { n: 0, nUnmeasurable: 0, nWouldCut: 0 });
  assert.equal(liveExcursionScan({}).n, 0, 'a missing argument is an empty scan, not a throw');
  assert.equal(liveExcursionScan().n, 0);
});

test('★ a mixed book reports each position independently', () => {
  const gold = buy({ id: 1 });
  const oil = { id: 2, symbol: 'Oil', direction: 'sell', status: 'open', openPrice: 90, stopPrice: 92 };
  const q = { symbols: [{ symbol: 'Gold', price: 98.6 }, { symbol: 'Oil', price: 90.4 }] };
  const s = liveExcursionScan({ quantResult: q, openTrades: [gold, oil] });
  assert.equal(s.n, 2);
  assert.equal(s.nWouldCut, 1, 'Gold is at 0.70; Oil at 0.20 is not');
  assert.deepEqual(s.rows.map((r) => r.symbol), ['Gold', 'Oil']);
});

test('★★ STRUCTURE: it is record-only, fail-open, and cannot cost a wake', () => {
  const src = code(WAKE);
  assert.match(src, /store\.logEvent\(userId, 'excursion_live'/, 'the scan is recorded as its own event kind');
  assert.match(src, /observeOnly: true/, 'and says so ON THE EVENT, not only in the code');
  assert.match(src, /source: 'wake_position_review'/, 'named to the point in the wake that produced it');
  // ⚠ the fail-open wrapper, matching the cost gate above it: instrumentation that can cost a wake is worse
  // than none. Both the log AND the scan are inside the try.
  assert.match(src, /catch \(e\) \{\s*\n\s*await store\.logEvent\(userId, 'telemetry', \{ source: 'excursion_live_error'/,
    'a throw must be swallowed and named, never propagated');
  // ⚠ AND NOTHING READS IT. If a later change makes this act, the pre-registration in
  // pre-registration-2026-10-01.md must report first - the 0.6 threshold is a pooled in-sample maximum.
  assert.doesNotMatch(src, /scan\.rows[^\n]*wouldCut[^\n]*continue/, 'no early exit keyed on the scan');
  assert.doesNotMatch(src, /liveExcursionScan\([^)]*\)[\s\S]{0,200}veto\(/, 'and it must not veto anything');
});
