// test/bar-scale-review.test.js — TRD-GRD-1 acceptance, plus the failure mode it must NOT be trusted past.
//
// `barViolation` is ROW-INTERNAL. The China Telecom bar that welded Oil onto a 4.43 instrument passed it
// cleanly, because it contradicts the SERIES, not itself. These tests pin both halves: the new predicate
// catches that row, AND it is shown misfiring when the series' majority is itself corrupt — the caveat in
// the source comment, made executable rather than promised.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  barViolation, barScaleReview, trailingReference, BAR_SCALE_MAX_RATIO,
} = require('../trading/store/bars');

// The exact row the 2026-09-22 capture banked under China Telecom: two instruments welded into one bar.
const WELDED = {
  venue: 'plus500', symbol: 'China Telecom', timeframe: '1d',
  barStart: new Date('2026-09-22T00:00:00Z'),
  openPrice: 4.40, high: 93.29, low: 4.40, closePrice: 89.61,
};
// China Telecom's real level at the time, from the venue's own quote.
const CLEAN_REFERENCE = { median: 4.43, samples: 300 };

test('TRD-GRD-1: ★ the welded row PASSES barViolation — which is the whole reason this exists', () => {
  assert.strictEqual(barViolation(WELDED), null,
    'the row is internally consistent (low 4.40 <= open 4.40 <= high 93.29, close inside), so the '
    + 'row-internal predicate cannot see it — this test documents the GAP, it does not assert a defect '
    + 'in barViolation');
});

test('TRD-GRD-1: the same row is SUSPECT against the series it claims to belong to', () => {
  const v = barScaleReview(WELDED, CLEAN_REFERENCE);
  assert.strictEqual(v.verdict, 'suspect');
  assert.strictEqual(v.reason, 'scale_out_of_range');
  assert.ok(v.ratio > 20, `close 89.61 vs reference 4.43 is a ~20x instrument swap (got ${v.ratio})`);
  // The list must be actionable: which field, what value, against what reference.
  assert.ok(['openPrice', 'high', 'low', 'closePrice'].includes(v.field));
  assert.strictEqual(v.reference, 4.43);
  assert.strictEqual(v.value, 93.29, 'the worst deviation is the high, not the close');
});

test('TRD-GRD-1: ★ a legitimate price is NOT flagged — 3.60 on a 4.43 instrument', () => {
  const v = barScaleReview(
    { openPrice: 4.40, high: 4.45, low: 3.58, closePrice: 3.60 }, CLEAN_REFERENCE);
  assert.strictEqual(v.verdict, 'ok');
  assert.ok(v.ratio > 0.8 && v.ratio < 0.9, `3.60/4.43 = ${v.ratio}, an ordinary move`);
});

test('TRD-GRD-1: the boundary behaves — ratio exactly at the cap passes, past it does not', () => {
  const ref = { median: 2, samples: 100 };
  const at = barScaleReview({ openPrice: 2, high: 6, low: 2, closePrice: 2 }, ref);
  assert.strictEqual(at.verdict, 'ok', `${BAR_SCALE_MAX_RATIO}x exactly is inside the cap`);
  const past = barScaleReview({ openPrice: 2, high: 6.01, low: 2, closePrice: 2 }, ref);
  assert.strictEqual(past.verdict, 'suspect');
  // And downward, symmetrically: 1/3 of the reference is the same distance as 3x.
  const down = barScaleReview({ openPrice: 2, high: 2, low: 0.66, closePrice: 2 }, ref);
  assert.strictEqual(down.verdict, 'suspect');
});

test('TRD-GRD-1: ★ no history is UNGUARDED, never `ok` — the TRD-111 lesson', () => {
  const fresh = { openPrice: 4.4, high: 4.5, low: 4.3, closePrice: 4.43 };
  assert.deepStrictEqual(barScaleReview(fresh, null).verdict, 'unguarded');
  assert.strictEqual(barScaleReview(fresh, null).reason, 'no_history');
  assert.strictEqual(barScaleReview(fresh, { median: 4.4, samples: 2 }).verdict, 'unguarded',
    'two samples is not a level — reporting `ok` there would vouch for something unmeasured');
  assert.strictEqual(barScaleReview(fresh, { median: 4.4, samples: 0 }).reason, 'no_history');
});

test('TRD-GRD-1: a price barViolation already owns stays with barViolation', () => {
  const v = barScaleReview({ openPrice: 0, high: 4.5, low: 4.3, closePrice: 4.43 }, CLEAN_REFERENCE);
  assert.strictEqual(v.verdict, 'unguarded');
  assert.strictEqual(v.reason, 'no_usable_price',
    'one defect, one owner — this predicate must not mint a second verdict for it');
});

test('TRD-GRD-1: trailingReference reports "not enough" as a count, not as a silent null', () => {
  assert.deepStrictEqual(trailingReference([]), { median: null, samples: 0 });
  assert.deepStrictEqual(trailingReference([4.4, 4.42]), { median: null, samples: 2 });
  assert.deepStrictEqual(trailingReference([4.4, 4.42, 4.41, 4.43, 4.44]), { median: 4.42, samples: 5 });
  // Median, not mean: a minority of corrupt rows must not move the level.
  assert.strictEqual(trailingReference([4.4, 4.42, 4.41, 4.43, 89.61]).median, 4.42);
  // Non-positive and non-finite values are not prices and must not become the level.
  assert.deepStrictEqual(trailingReference([4.4, 4.42, 4.41, 4.43, 4.44, 0, null, NaN, -1, '']),
    { median: 4.42, samples: 5 });
});

test('TRD-GRD-1: ★★ THE CAVEAT IS REAL — a majority-corrupt series turns the detector against the repair', () => {
  // This test asserts the detector MISFIRES. It exists so the risk is executable, not just documented:
  // the reference is a median of stored bars, so if a symbol's history is majority-corrupt the median IS
  // the corruption and a CLEAN row is flagged. That is why the output is a list and not a rule.
  const corruptHistory = [89.6, 90.1, 91.2, 90.4, 89.9, 4.43];   // five bad, one good
  const ref = trailingReference(corruptHistory);
  const cleanRow = { openPrice: 4.42, high: 4.47, low: 4.38, closePrice: 4.43 };
  assert.strictEqual(cleanRow.closePrice, 4.43);
  assert.ok(ref.median > 80, 'the median of a majority-corrupt window IS the corruption');
  const v = barScaleReview(cleanRow, ref);
  assert.strictEqual(v.verdict, 'suspect',
    'the CLEAN repair row is flagged and the corruption is defended — this is the documented failure mode, '
    + 'and the reason the reference window must exclude the rows under review');
  assert.ok(v.ratio < 0.06, `a clean 4.43 reads as ${v.ratio}x against a 90-level "reference"`);
});
