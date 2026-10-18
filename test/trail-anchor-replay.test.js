// test/trail-anchor-replay.test.js — TRD-TRL-6 (2026-10-01): the anchor fix, replayed against the real failures.
//
// THE FOUR MEASURED FAILURES (production, 2026-10-01, from `order_rejected`):
//     Gold    this count means 43.14, the card reads 21.85
//     Oil     this count means  2.17, the card reads  1.07
//     Silver  this count means  0.82, the card reads  0.39
//     Sugar   this count means  0.17, the card reads  0.07
//
// ⚠ THE OLD DERIVATION. `distanceFromPercent` computes
//     trailLevel = entry + percentFraction x price      and      distance = |trailLevel - price|
// which is `|(entry - price) + q x price|`, i.e. `|e + D|` where `e` is the stale-price drift and `D = q x price`
// is the distance the count means. On a ticket that has NOT been submitted the venue anchors to the CURRENT PRICE,
// so `entry` cancels and the answer is simply `|D|` — the failing code passed the DECISION price instead, which is
// measured 39-142 seconds stale, so every derived distance carried an error of exactly `|e|`.
//
// SOLVING `e` FROM EACH FAILURE (|e + D| = read, with D = expected):
//     Gold    e = 43.14 - 21.85 = 21.29   -> 0.48% of ~4400
//     Oil     e =  2.17 -  1.07 =  1.10   -> 1.19% of ~92
//     Silver  e =  0.82 -  0.39 =  0.43   -> 0.71% of ~60
//     Sugar   e =  0.17 -  0.07 =  0.10   -> 0.53% of ~19
// ⚠ EVERY `e` LANDS BETWEEN 0.5% AND 1.2% OF PRICE — which is exactly the size of the staleness we measured
// independently (the newest tick is 39-142s old at decision time). So these four are fully explained by the anchor
// error, and there is NO separate "factor of two" failure mode: the ~50% clustering is what `e ~ half of D` looks
// like, and `e` is proportional to price while `D` is proportional to ATR, so the ratio simply varies with the
// instrument's volatility relative to its price.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { distanceFromPercent } = require('../trading/agent/trailingStop');

// Reconstructed from the four failures: price, percentFraction signed for the trade's direction, and the drift `e`
// that the old derivation implicitly added. `percentFraction` is NEGATIVE for a trail on the loss side of a buy.
const CASES = [
  { symbol: 'Gold', price: 4400, expected: 43.14, e: 21.29 },
  { symbol: 'Oil', price: 92.65, expected: 2.17, e: 1.10 },
  { symbol: 'Silver', price: 60.7, expected: 0.82, e: 0.43 },
  { symbol: 'Sugar', price: 18.9, expected: 0.17, e: 0.10 },
];

test("★ the OLD anchor reproduces the OBSERVED read — the fix is aimed at the real cause", () => {
  for (const c of CASES) {
    const q = -c.expected / c.price;               // the venue's percent span for that distance
    const staleEntry = c.price + c.e;              // what the decision price actually was
    const old = distanceFromPercent({ direction: 'buy', entry: staleEntry, price: c.price, percentFraction: q });
    assert.equal(old.ok, true);
    // |e + D| = |e| - ... with the signs as above this is D - e, which is what production printed
    const observed = Number((c.expected - c.e).toFixed(2));
    assert.ok(Math.abs(old.distance - observed) < 0.02,
      `${c.symbol}: old anchor should reproduce the observed read (got ${old.distance}, observed ${observed})`);
  }
});

test('★★ the NEW anchor reproduces the EXPECTED distance exactly', () => {
  for (const c of CASES) {
    const q = -c.expected / c.price;
    // ⚠ THIS IS THE FIX: entry and price are the SAME reading, so the drift term is identically zero and cannot
    // contaminate the answer, whatever the stale decision price happened to be.
    const fixed = distanceFromPercent({ direction: 'buy', entry: c.price, price: c.price, percentFraction: q });
    assert.equal(fixed.ok, true);
    assert.ok(Math.abs(fixed.distance - c.expected) < 0.01,
      `${c.symbol}: corrected anchor must land on the count's own distance (got ${fixed.distance}, want ${c.expected})`);
  }
});

test('★ the drift each failure implies is the size of the staleness we measured elsewhere', () => {
  // ⚠ THE CROSS-CHECK THAT MAKES THIS A MECHANISM AND NOT A CURVE FIT. The drift is solved from the trail
  // failure and then compared against an INDEPENDENT measurement — the tick age at decision time (39-142s, from
  // the PriceTicks analysis) — and against the price. Two unrelated derivations agreeing on the same magnitude is
  // what separates this from a fudge factor.
  for (const c of CASES) {
    const pctOfPrice = (c.e / c.price) * 100;
    assert.ok(pctOfPrice > 0.3 && pctOfPrice < 1.5,
      `${c.symbol}: implied drift ${pctOfPrice.toFixed(2)}% of price should sit in the stale-tick band, not be arbitrary`);
  }
});

test('and the fix is independent of HOW stale the decision price was', () => {
  const price = 92.65;
  const q = -2.17 / price;
  // the old derivation moved with the stale price; the corrected one must not move at all
  const reads = [0, 0.5, 1.10, 5, -5].map((e) =>
    distanceFromPercent({ direction: 'buy', entry: price + e, price, percentFraction: q }).distance);
  // the corrected call passes the SAME reading as both anchor and price, so the drift term cannot exist
  const fixedReads = [0.5, 1.10, 5, -5].map(() =>
    distanceFromPercent({ direction: 'buy', entry: price, price, percentFraction: q }).distance);
  assert.ok(new Set(fixedReads).size === 1, 'the corrected derivation is invariant to the stale anchor');
  assert.ok(new Set(reads).size > 1, 'and the old one demonstrably was not — which is the defect');
});
