// test/tp-offset.test.js — 2026-09-25: the take-profit offset, calibrated against the LIVE chart.
//
// ★ THE FIXTURE IS THE OWNER'S OWN EVIDENCE, NOT A MADE-UP CASE. A live Gold short on Plus500 (15m) came within a
// hair of `close at profit` TWICE on 9/24 and reversed both times. The two bars:
//
//     9/24 18:30   open 4,246.21  close 4,258.81  high 4,262.98   LOW 4,245.11
//     9/24 23:00   open 4,253.43  close 4,247.15  high 4,254.44   LOW 4,245.36
//     the venue levels: target 4,244.24   stop 4,285.10   opening rate 4,271.56
//
// ★ AND THE MODEL REPRODUCES THOSE LEVELS EXACTLY, which is what makes this a measurement rather than an
// illustration: with `price 4,272.29`, `declared 18.7` (2xATR with ATR 9.35) and the live 0.30% adverse cap, it
// returns target **4,244.24** and stop **4,285.11** — the two lines drawn on the chart.
//
// ★★ SO THE NUMBER THE OWNER ASKED ABOUT CAN BE CHECKED RATHER THAN GUESSED. The misses were 0.87 and 1.12
// points short of a 28.05-point target — 3.1% and 4.0% of the target's own distance. A 5% offset gives the target
// **4,245.64**, which BOTH lows reach. The suggested `0.0020` gives 4,244.30, which NEITHER reaches.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { entryLevels, LEVEL_RR } = require('../trading/agent/exitLevels');

// The live trade, reconstructed from the chart.
const TRADE = {
  direction: 'sell', price: 4272.29, atr14: 9.35, stopDistance: 18.7, maxAdversePct: 0.30,
};
const TARGET_ON_CHART = 4244.24;
const STOP_ON_CHART = 4285.10;
// The two lows that nearly filled it.
const MISSES = [4245.11, 4245.36];
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

test('the calibration: the model reproduces the levels DRAWN ON THE CHART', () => {
  assert.equal(LEVEL_RR, 1.5, 'the target is LEVEL_RR x DECLARED; if this moves, the fixture below is invalid');
  const lv = entryLevels(TRADE);
  assert.ok(lv.ok, `entryLevels refused: ${lv.reason}`);
  assert.ok(near(lv.takeProfitPrice, TARGET_ON_CHART), `target ${lv.takeProfitPrice} must be the chart's ${TARGET_ON_CHART}`);
  assert.ok(near(lv.stopPrice, STOP_ON_CHART), `stop ${lv.stopPrice} must be the chart's ${STOP_ON_CHART}`);
  assert.equal(lv.cappedBy, 'max_adverse_pct', 'the cap must actually bind, or this trade is not the one observed');
  // And the asymmetry that CAUSED the near-misses: the cap moved the target from 1.5R to ~2.2R.
  assert.ok(lv.effectiveRR > 2.0, `effective R:R must be ~2.2 on this trade (got ${lv.effectiveRR})`);
  assert.equal(lv.takeProfitOffsetPct, 0, 'no offset unless asked for');
  assert.equal(lv.effectiveRR, +(1.5 * lv.declaredStopDist / lv.stopDist).toFixed(3),
    'with no offset, effectiveRR is LEVEL_RR x declared / stopDist — the formula it always was');
});

test('★ with NO offset, neither measured low reaches the target — the misses were real', () => {
  const tp = entryLevels(TRADE).takeProfitPrice;
  for (const low of MISSES) {
    assert.ok(low > tp, `low ${low} must sit ABOVE the target ${tp}, i.e. it did not fill`);
  }
});

test('★★ a 5% offset catches BOTH misses — this is the number, and it is NOT 0.0020', () => {
  const lv = entryLevels({ ...TRADE, takeProfitOffsetPct: 5 });
  assert.equal(lv.takeProfitOffsetPct, 5);
  assert.ok(lv.takeProfitDist < lv.declaredTakeProfitDist, 'the target distance must shrink');
  // The offset is a share of the TARGET'S OWN DISTANCE — so 5% = 1.40 points here.
  assert.ok(near(lv.takeProfitDist, lv.declaredTakeProfitDist * 0.95, 0.01));
  for (const low of MISSES) {
    assert.ok(low <= lv.takeProfitPrice,
      `low ${low} must now REACH the target ${lv.takeProfitPrice} (missed by ${(low - (lv.takeProfitPrice + 0)).toFixed(2)})`);
  }
  // The price of the guarantee: the R:R falls from ~2.19 to ~2.08, i.e. ~5% of the reward.
  assert.ok(lv.effectiveRR < 2.19 && lv.effectiveRR > 2.0, `effectiveRR should fall to ~2.08 (got ${lv.effectiveRR})`);
});

test('★★ NON-VACUITY: 0.0020 as a share of the target distance catches NEITHER miss', () => {
  // The owner's suggested threshold, tested rather than accepted. As a fraction of the target distance it moves
  // the target by 0.0020 x 28.05 = 0.056 points — against misses of 0.87 and 1.12. Roughly 20x too small.
  const lv = entryLevels({ ...TRADE, takeProfitOffsetPct: 0.2 });
  assert.equal(lv.takeProfitOffsetPct, 0.2);
  for (const low of MISSES) {
    assert.ok(low > lv.takeProfitPrice,
      `a 0.2% offset must NOT reach ${low} — if it did, the 5% figure would be unjustified`);
  }
  // Quantified: how far short each threshold leaves the deepest miss.
  const shortfall = (pct) => MISSES[1] - entryLevels({ ...TRADE, takeProfitOffsetPct: pct }).takeProfitPrice;
  assert.ok(near(shortfall(0), 1.12, 0.05), 'with no offset the deepest miss is 1.12 points short');
  assert.ok(near(shortfall(0.2), 1.06, 0.05), '0.2% recovers only 0.06 of that 1.12');
  assert.ok(shortfall(5) <= 0, '5% clears it');
});

test('the offset is CLAMPED and cannot invert the trade', () => {
  // A nonsensical setting must not place the target on the wrong side of the entry.
  const extreme = entryLevels({ ...TRADE, takeProfitOffsetPct: 500 });
  assert.equal(extreme.takeProfitOffsetPct, 90, 'clamped at 90%');
  assert.ok(extreme.takeProfitPrice < TRADE.price, 'even clamped, the target stays below the entry on a sell');
  // Zero and negatives are OFF, and must not be mistaken for a small offset.
  for (const off of [0, -5, null, undefined, NaN, 'abc']) {
    const lv = entryLevels({ ...TRADE, takeProfitOffsetPct: off });
    assert.equal(lv.takeProfitOffsetPct, 0, `offset ${JSON.stringify(off)} must be OFF`);
    assert.ok(near(lv.takeProfitPrice, TARGET_ON_CHART), 'and must leave the geometry untouched');
  }
});
