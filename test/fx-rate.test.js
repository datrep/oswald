// test/fx-rate.test.js — TRD-PNL-7 / P1a: the USD->SGD rate is DERIVED, never assumed.
//
// WHAT IS PINNED, AND WHY EACH ONE IS HERE.
//
// 1. THE ARITHMETIC, AGAINST REAL MEASURED ROWS. The five vectors below are actual `position_pnl` first/last
//    pairs from the recorded history, with the rates they produced during the 2026-10-01 derivation test. They
//    are the difference between "this code runs" and "this code reproduces the number the venue printed".
// 2. THE REFUSALS, because a rate that silently becomes a plausible number is exactly the defect this module
//    exists to remove. Every refusal path has a test: a missing field, a flat price, the `Number(null) === 0`
//    trap, an implausible value, and too little signal.
// 3. NO HARDCODED RATE IN ARITHMETIC. Asserted against the COMMENT-STRIPPED source, so the prose explaining why
//    the rate is not hardcoded cannot make the assertion pass on documentation.
// 4. THE WIRING. The rate must reach the object `risk.js` already reads, or it is a module nobody calls.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { code } = require('./_source');
const fx = require('../trading/agent/fxRate');

const POLLER = 'trading/agent/accountPoller.js';
const MODULE = 'trading/agent/fxRate.js';

// Measured vectors: {size, direction, dPnl, dRate} -> the rate observed on 2026-10-01.
// ⚠ These are the numbers the derived estimator produced, so a change to the estimator that alters them will
// fail here loudly rather than quietly re-scaling every ticket.
// `clears` records whether the pair's move in VALUE terms reaches the weak gate. ⚠ THE FIRST DRAFT OF THIS TEST
// ASSUMED FOUR OF FIVE CLEARED IT AND TWO DID NOT — the module refused, correctly, and the TEST was wrong. The
// colonn is kept explicit so that cannot happen again silently.
const VECTORS = [
  // name      size   dir     dPnl     dRate    usdMove   expect   clears $3
  { name: 'Silver238', size: 22.5,  dir: 'sell', dPnl: -11.59, dRate: 0.393,  expect: 1.3107, clears: true },
  { name: 'Oil200',    size: 15,    dir: 'buy',  dPnl: 18.84,  dRate: 0.99,   expect: 1.2687, clears: true },
  { name: 'Silver485', size: 7.5,   dir: 'sell', dPnl: 8.66,   dRate: -0.909, expect: 1.2703, clears: true },
  { name: 'Silver682', size: 5,     dir: 'sell', dPnl: 5.33,   dRate: -0.846, expect: 1.2600, clears: true },
  { name: 'Silver134', size: 22.5,  dir: 'sell', dPnl: 16.21,  dRate: -0.567, expect: 1.2706, clears: true },
  { name: 'Gold224',   size: 0.225, dir: 'sell', dPnl: 9.84,   dRate: -34.46, expect: 1.2691, clears: true },
  // Below the gate: correct to DERIVE, but not to trust. Kept so their exclusion is asserted rather than assumed.
  { name: 'Gold381',   size: 0.225, dir: 'sell', dPnl: -3.55,  dRate: 12.24,  expect: 1.2890, clears: false },
  { name: 'Arabica360', size: 5,    dir: 'sell', dPnl: -0.32,  dRate: 0.05,   expect: 1.2800, clears: false },
];

const CLEARING = VECTORS.filter((v) => v.clears);
const BLOCKED = VECTORS.filter((v) => !v.clears);

// Build the a/b pair the poller would have accumulated for one position.
const pair = (v) => ({
  a: { symbol: v.name, size: v.size, direction: v.dir, pnl: 100, rate: 1000 },
  b: { symbol: v.name, size: v.size, direction: v.dir, pnl: 100 + v.dPnl, rate: 1000 + v.dRate },
});

test('the derivation reproduces the measured rate for every recorded vector', () => {
  for (const v of VECTORS) {
    const r = fx.pairRate(pair(v).a, pair(v).b);
    assert.ok(r, `${v.name}: pair must be usable`);
    assert.equal(+r.rate.toFixed(4), v.expect, `${v.name}: derived rate`);
  }
});

test('★ a BUY and a SELL both resolve — the sign cancels, so direction cannot flip the rate', () => {
  const sell = fx.pairRate(pair(VECTORS[0]).a, pair(VECTORS[0]).b);
  const buy = fx.pairRate(pair(VECTORS[1]).a, pair(VECTORS[1]).b);
  assert.equal(+sell.rate.toFixed(4), 1.3107);
  assert.equal(+buy.rate.toFixed(4), 1.2687);
  // and reversing the sample order must give the SAME rate, not its reciprocal
  const reversed = fx.pairRate(pair(VECTORS[1]).b, pair(VECTORS[1]).a);
  assert.equal(+reversed.rate.toFixed(4), 1.2687);
});

test('★ the gate is what makes it converge: a sub-gate move is EXCLUDED rather than averaged in', () => {
  const r = fx.deriveRate(VECTORS.map(pair));
  assert.equal(r.ok, true, `expected a rate, got ${r.reason}`);
  // Two vectors clear the STRONG gate ($10) - below MIN_SAMPLES - so the module must step down to the weak one.
  assert.equal(r.gate, 'weak', 'strong gate had 2 of 3 required samples, so weak was used');
  assert.equal(r.n, CLEARING.length, `exactly the ${CLEARING.length} clearing vectors contribute`);
  assert.equal(r.candidates, VECTORS.length, 'every pair was evaluated as a candidate');
  assert.ok(r.usdMoveMin >= fx.GATE_WEAK, 'every contributing pair must clear the gate it was admitted under');
  // The two blocked vectors are genuinely below the gate, which is WHY they are excluded - assert the fact
  for (const v of BLOCKED) {
    const p = fx.pairRate(pair(v).a, pair(v).b);
    assert.ok(p, `${v.name} is still DERIVABLE - exclusion is a gate decision, not a parse failure`);
    assert.ok(Math.abs(p.usdMove) < fx.GATE_WEAK, `${v.name} must be below the weak gate`);
  }
});

test('★★ the estimator is a MEDIAN, so the one high reading cannot drag it', () => {
  const base = fx.deriveRate(CLEARING.map(pair));
  assert.equal(base.ok, true, `expected a rate, got ${base.reason}`);
  // ⚠ THE EXPECTATION IS COMPUTED FROM THE VECTORS, NOT TYPED IN. The first two drafts of this test hardcoded a
  // value produced by my own hand arithmetic, and both were wrong — the same class of error this whole review
  // keeps finding. The property is what matters: the estimator is the MEDIAN of the admitted readings.
  const rates = CLEARING.map((v) => fx.pairRate(pair(v).a, pair(v).b).rate).sort((x, y) => x - y);
  const expectedMedian = (rates[2] + rates[3]) / 2;
  assert.equal(base.rate, expectedMedian, 'the median is the mean of the two middle readings');
  // Six real vectors: five sit in 1.260-1.271 and one reads 1.3107. A MEAN would land at ~1.275 and be dragged
  // by the outlier; the median must sit with the majority.
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  assert.ok(base.rate > 1.26 && base.rate < 1.28, `median sits with the majority, got ${base.rate}`);
  assert.ok(mean > base.rate, `and the MEAN is demonstrably the higher, dragged one: mean ${mean} > median ${base.rate}`);
  // The disagreement must stay VISIBLE rather than be smoothed away by the choice of estimator.
  assert.ok(base.spreadPct > 3, `the 1.3107 outlier must show up in the spread, got ${base.spreadPct}%`);
  // Adding a wildly wrong pair that still clears the gate must barely move it.
  const outlier = { a: { symbol: 'X', size: 10, direction: 'buy', pnl: 0, rate: 500 },
    b: { symbol: 'X', size: 10, direction: 'buy', pnl: 200, rate: 505 } }; // implied 4.0
  const withOutlier = fx.deriveRate([...CLEARING.map(pair), outlier]);
  assert.equal(withOutlier.ok, true);
  assert.ok(Math.abs(withOutlier.rate - base.rate) < 0.01,
    `median must barely move: ${base.rate} -> ${withOutlier.rate}`);
});

test('★★ the REFUSALS — a rate must never become a plausible number by accident', () => {
  const good = pair(VECTORS[0]);
  // an unread field is null, never zero
  assert.equal(fx.pairRate(null, good.b), null);
  assert.equal(fx.pairRate({ ...good.a, size: null }, good.b), null, 'unread size');
  assert.equal(fx.pairRate({ ...good.a, size: '' }, good.b), null, 'blank size');
  assert.equal(fx.pairRate({ ...good.a, direction: null }, good.b), null, 'unread direction is not a guess');
  assert.equal(fx.pairRate({ ...good.a, direction: 'sideways' }, good.b), null, 'an unknown direction is not a guess');
  assert.equal(fx.pairRate({ ...good.a, pnl: null }, good.b), null);
  assert.equal(fx.pairRate(good.a, { ...good.b, rate: null }), null);
  // a flat price implies nothing and must not divide
  assert.equal(fx.pairRate(good.a, { ...good.b, rate: good.a.rate }), null, 'no move -> no rate');
  // ⚠ THE TRAP THIS SUITE EXISTS FOR: Number(null) === 0, so a `!= null` check that forgets to reject '' would
  // produce rate = 0 / 0 and a finite-looking answer.
  assert.equal(fx.pairRate({ ...good.a, size: null, pnl: null }, good.b), null, 'two nulls must not become 0/0');

  // too little signal -> refuse, do NOT fall back to an ungated (biased) average
  const tiny = { a: { symbol: 'T', size: 1, direction: 'buy', pnl: 0, rate: 100 },
    b: { symbol: 'T', size: 1, direction: 'buy', pnl: 0.01, rate: 100.001 } }; // move 0.001
  const r = fx.deriveRate([tiny, tiny, tiny]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_signal');
  assert.equal(r.n, 0, 'nothing cleared even the weak gate');

  // implausible value -> REPORTED, not clipped. The observed number must travel with the refusal.
  const bad = { a: { symbol: 'B', size: 1, direction: 'buy', pnl: 0, rate: 100 },
    b: { symbol: 'B', size: 1, direction: 'buy', pnl: 500, rate: 105 } }; // implied 100
  const out = fx.deriveRate([bad, bad, bad]);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'outside_plausible_band');
  assert.equal(out.rate, 100, 'the observed value is carried so an operator can see it');
  assert.deepEqual(out.band, [fx.PLAUSIBLE_MIN, fx.PLAUSIBLE_MAX]);

  assert.equal(fx.deriveRate([]).reason, 'no_usable_pairs');
  assert.equal(fx.deriveRate(null).reason, 'no_usable_pairs');
});

test('★★ no hardcoded rate in ARITHMETIC — asserted against comment-stripped source', () => {
  const src = code(MODULE);
  // The band bounds are literals on purpose (they are a sanity range, not a conversion); anything that looks
  // like a conversion factor is not.
  assert.doesNotMatch(src, /\*\s*1\.2[0-9]/, 'no `* 1.28...` style conversion');
  assert.doesNotMatch(src, /\/\s*1\.2[0-9]/, 'and no division by a hardcoded rate');
  assert.doesNotMatch(src, /1\.2812/, 'the old prose figure must not have become code');
  assert.doesNotMatch(src, /12774|12757/, 'nor a literal of the measured value');
  // The rate must come from the data, and the data must come from a difference of two samples.
  assert.match(src, /\(pnlB - pnlA\) \/ usdMove/, 'the rate is computed from the observed delta');
});

test('★ the wiring: the derived rate reaches the object risk.js already reads', () => {
  const src = code(POLLER);
  assert.match(src, /require\('\.\/fxRate'\)/, 'the poller imports the derivation');
  assert.match(src, /fxPairObserve\(fxPairs/, 'and feeds it from the read it was already doing');
  assert.match(src, /fxSgd: fx && fx\.ok \? fx\.rate : null/, 'getLive() carries the rate');
  assert.match(src, /fxBasis: fx/, 'and the basis, so a refusal is visible rather than absent');
  assert.match(src, /fxPairs\.delete\(k\)/, 'stale pairs are pruned - the rate is dynamic');
  // risk.js reads getLive() already; assert that, so the integration claim is checkable
  const risk = code('trading/agent/risk.js');
  assert.match(risk, /require\('\.\/accountPoller'\)\.getLive\(\)/,
    'risk.js is the consumer and already reads getLive(), which is why this needed no plumbing');
});

test('★★ P1b: the RATE TIME SERIES — every account sample carries the rate, or a NAMED refusal', () => {
  // Why this matters: a CLOSE needs the rate at the moment of the close, and a close cannot derive it — by the
  // time `pnl_range` is written the position is gone and its pair with it. Stamping the rate on the account
  // sample is what turns "the rate at the close" into a lookup instead of an inference.
  const src = code(POLLER);
  assert.match(src, /const fx = getFxRate\(\);\s*\n\s*await store\.logEvent\(userId, 'account'/,
    'the account write derives the rate it stamps');
  assert.match(src, /fxSgd: fx\.rate, fxN: fx\.n, fxGate: fx\.gate, fxSpreadPct: fx\.spreadPct/,
    'a successful derivation carries the value AND its evidence');
  assert.match(src, /fxSgd: null, fxWhy: \(fx && fx\.reason\) \|\| 'not_derived'/,
    'and a refusal is RECORDED as one - an absent key and a failed derivation must not look the same');
  // the currency declaration must survive alongside it, or the series loses the unit it is denominated in
  assert.match(src, /\.\.\.\(accountCurrency \? \{ currency: accountCurrency \} : \{\}\)/, 'the unit still travels');
});
