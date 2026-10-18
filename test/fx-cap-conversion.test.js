// test/fx-cap-conversion.test.js — P2 (2026-10-01): no control compares two currencies any more.
//
// THE TWO-POINT TABLE, PINNED AS BEHAVIOUR RATHER THAN PROSE. The defect had a signature: a cap of `P%` bound
// at `P% x fx`. Both points are reproduced below from the SAME arithmetic the code uses, so the claim is a test
// and not a paragraph:
//     cap 40% -> old ceiling 51.25% (fills measured at 50.0-50.9%)
//     cap 35% -> old ceiling 44.84% (fills measured at 44.0-44.3%)
// The old ceiling is asserted by computing it the OLD way in the test itself; the new one is asserted by calling
// the function. If someone reinstates the currency-blind comparison, the old-way computation stops matching the
// function and this fails.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { code } = require('./_source');
const { fitExposureBudget, fitMarginBudget } = require('../trading/agent/risk');
const ac = require('../trading/agent/accountCurrency');

const RISK = 'trading/agent/risk.js';
const FX = 1.2812; // the measured rate; the real one is dynamic and derived (agent/fxRate.js)

// notional% in the ACCOUNT's currency — the only unit the caps are denominated in.
const acctPct = (size, price, fx, equity) => (size * price * fx) / equity * 100;

test('★★ the two-point table: with fx=1 the caps bind at the WRONG place, and that is reproducible', () => {
  const equity = 4000, price = 100, big = 100; // a 250%-of-equity proposal, so the cap must act
  for (const cap of [40, 35]) {
    // What the OLD (currency-blind) form produced: it clamped size so that `size * price == equity * cap%`, and
    // the resulting real notional% was `cap * fx`. This is the measurement, computed not quoted.
    const oldSize = (equity * (cap / 100)) / price;
    assert.equal(+acctPct(oldSize, price, FX, equity).toFixed(2), +(cap * FX).toFixed(2));
    assert.equal(+acctPct(oldSize, price, FX, equity).toFixed(2), cap === 40 ? 51.25 : 44.84,
      `cap ${cap}% must reproduce the measured ceiling`);

    // What the NEW form produces: the ceiling is the cap itself, in account currency.
    const fit = fitExposureBudget({ size: big, price, exposurePct: 0, exposureCapPct: cap, equity, fx: FX });
    assert.equal(fit.fitted, true, `cap ${cap}% must clamp a 250% proposal`);
    // ⚠ This assertion is what forced `Math.round` -> `Math.floor` in `fitExposureBudget`. With round, the fitted
    // size landed 2.5e-7 of equity ABOVE its own ceiling (40.0000249% for a 40% cap) — immaterial while the
    // budget was self-imposed, not immaterial once P2 made the cap a real converted limit. A guard that can
    // exceed its own ceiling cannot carry an invariant, which is the argument `fitMarginBudget` already makes.
    const newPct = acctPct(fit.size, price, FX, equity);
    assert.ok(newPct <= cap, `cap ${cap}%: real notional ${newPct}% must not exceed the cap (fail closed)`);
    assert.ok(Math.abs(newPct - cap) < 0.01, `and must use the room: ${newPct}% vs ${cap}%`);
  }
});

test('★ the same ticket is judged differently once the factor is applied — which is the whole fix', () => {
  const equity = 4000, price = 100, size = 12; // notional 1200 = 30% of equity in USD terms
  // 30% of equity in USD terms is 38.4% in SGD terms at this rate, so a 35% cap must now bind where it did not.
  const naive = fitExposureBudget({ size, price, exposurePct: 0, exposureCapPct: 35, equity });
  assert.equal(naive.fitted, false, 'without the factor the ticket looks like it fits');
  const real = fitExposureBudget({ size, price, exposurePct: 0, exposureCapPct: 35, equity, fx: FX });
  assert.equal(real.fitted, true, 'with it, the ticket is over budget');
  assert.ok(real.size < size, 'and is resized down');
  // the inverse conversion must be right too: the fitted size, converted, must equal the room
  assert.ok(Math.abs(acctPct(real.size, price, FX, equity) - 35) < 0.01,
    'the fitted size must convert back to exactly the remaining room');
});

test('★ fx=1 is the same-currency case, so an SGD-quoted instrument is untouched', () => {
  const equity = 4000, price = 22.695, size = 60;
  const withDefault = fitExposureBudget({ size, price, exposurePct: 0, exposureCapPct: 35, equity });
  const withOne = fitExposureBudget({ size, price, exposurePct: 0, exposureCapPct: 35, equity, fx: 1 });
  assert.deepEqual(withDefault, withOne, 'the default IS the same-currency case, not a special path');
  // 60 x 22.695 = 1361.7 = 34.04% -> fits under 35
  assert.equal(withOne.fitted, false);
});

test('★ the MARGIN guard converts on both sides', () => {
  const equity = 4000, price = 100, capPct = 20, marginRatePct = 20, usedMargin = 0;
  // 20% cap on 4000 = 800 of margin; at a 20% rate that is 4000 of notional; in USD terms at fx that is
  // 4000/fx of notional, i.e. a size of 4000/fx/100.
  const fit = fitMarginBudget({ size: 100, price, marginRatePct, usedMargin, capPct, equity, fx: FX });
  assert.equal(fit.fitted, true);
  const expectedSize = Math.floor(((4000 * 0.20) / (marginRatePct / 100) / (price * FX)) * 10000) / 10000;
  assert.equal(fit.size, expectedSize, 'the fitted size must be the room converted BACK into instrument units');
  assert.ok(fit.finalMargin <= fit.capMargin + 1e-6, 'and the invariant must still hold in account currency');
  assert.ok(Math.abs(fit.finalPct - capPct) < 1e-3, `final margin must sit on the ceiling, got ${fit.finalPct}%`);
});

test('★★ convertToAccount REFUSES rather than defaulting', () => {
  assert.equal(ac.convertToAccount({ amount: 100, from: 'USD', to: 'SGD', rate: 1.28 }).amount, 128);
  assert.equal(ac.convertToAccount({ amount: 100, from: 'USD', to: 'SGD', rate: 1.28 }).basis, 'converted');
  // same currency is a FIRST-CLASS answer, not a default
  const same = ac.convertToAccount({ amount: 100, from: 'SGD', to: 'SGD' });
  assert.deepEqual(same, { ok: true, amount: 100, rate: 1, basis: 'same_currency' });
  // ⚠ an unrecorded instrument is not USD, and a missing rate is not 1 — both must refuse with a NAME
  assert.equal(ac.convertToAccount({ amount: 100, from: null, to: 'SGD', rate: 1.28 }).reason, 'currency_unrecorded');
  assert.equal(ac.convertToAccount({ amount: 100, from: 'USD', to: null, rate: 1.28 }).reason, 'currency_unrecorded');
  assert.equal(ac.convertToAccount({ amount: 100, from: 'USD', to: 'SGD' }).reason, 'rate_unavailable');
  assert.equal(ac.convertToAccount({ amount: 100, from: 'USD', to: 'SGD', rate: 0 }).reason, 'rate_not_usable');
  assert.equal(ac.convertToAccount({ amount: 100, from: 'USD', to: 'SGD', rate: 'x' }).reason, 'rate_not_usable');
  assert.equal(ac.convertToAccount({ amount: null, from: 'USD', to: 'SGD', rate: 1.28 }).reason, 'amount_unrecorded');
  // ⚠ the Number(null) === 0 trap: an absent amount must not become a convertible zero
  assert.equal(ac.convertToAccount({ from: 'USD', to: 'SGD', rate: 1.28 }).reason, 'amount_unrecorded');
});

test('★★ STRUCTURE: the currency-blind comparisons are gone and cannot come back silently', () => {
  const src = code(RISK);
  // ⚠⚠ UPDATED 2026-10-01 (the `pointValue` sweep). The call sites no longer SPELL `fx` inline — both scales are
  // applied by ONE helper, which is what makes the next missing factor a one-line change instead of a hunt.
  // ⚠ THE INTENT OF THIS TEST IS UNCHANGED: `fx` must still be applied. So the assertion is not relaxed — it is
  // MOVED onto the helper's own body, which is the thing that would have to change to break it.
  assert.match(src, /function notionalFactor\(pointValue, fx\)/, 'one derivation of the quote -> account multiplier');
  assert.match(src,
    /return \(Number\.isFinite\(pv\) && pv > 0 \? pv : 1\) \* \(Number\.isFinite\(f\) && f > 0 \? f : 1\)/,
    '★ and it MUST still apply `fx` — this line is what stops this update from weakening the test');
  assert.match(src, /size \* price \* notionalK > maxValue/, 'the per-position cap converts');
  assert.doesNotMatch(src, /if \(size \* price > maxValue\)/, 'the blind form is absent');
  assert.doesNotMatch(src, /size = maxValue \/ price;/, 'including its resize');
  assert.match(src, /\(size \* price \* k\) \/ equity \* 100/, 'the exposure budget converts');
  assert.match(src, /const wanted = size \* price \* k \* \(rate \/ 100\)/, 'the margin guard converts its notional');
  assert.match(src, /notionalFactor\(pointValueForSymbol\(t\.symbol\), fx\)/, 'the reported exposure converts');
  assert.match(src, /notionalPct:[\s\S]{0,200}v\.size \* price \* notionalK \/ equity/,
    'and so does the number the wake commits');
  // the factor is resolved ONCE and named on the decision, with a conservative fallback rather than a veto
  assert.match(src, /const fxF = fxFactorFor\(\{ settings, symbol: proposal && proposal\.symbol, live: accLive \}\)/);
  assert.match(src, /v\.fxRate = fx;/, 'the factor travels with the decision');
  assert.match(src, /v\.fxBasis = fxF\.basis;/, 'and so does its BASIS, so a conservative fallback is visible');
  assert.match(src, /FX_RATE_PLAUSIBLE_MAX/, 'the fallback bound is IMPORTED, not restated');
  assert.match(src, /basis: 'conservative_no_rate'/, 'and a missing rate is a NAMED state');
});

test('★★ P2c: the OPEN BOOK\'s margin converts, and PER SYMBOL rather than once', () => {
  const src = code(RISK);
  // ⚠ The accumulation must convert the notional. Without `* fxForSymbol(...)` the guard sums USD margin
  // against an SGD ceiling — the same defect as `v.exposurePct`, in the control that is the desk's brake.
  // ⚠ UPDATED 2026-10-01: the accumulation now applies BOTH scales through the one helper — `fx` for the currency
  // and `pointValue` for the contract. The per-symbol requirement is unchanged and still pinned below.
  assert.match(src, /const n = \(Number\(t\.size\) \|\| 0\) \* \(Number\(t\.openPrice\) \|\| 0\) \* notionalFactor\(pv, fxForSymbol\(t\.symbol\)\)/,
    'the open book margin must be converted before it is summed');
  assert.doesNotMatch(src, /const n = \(Number\(t\.size\) \|\| 0\) \* \(Number\(t\.openPrice\) \|\| 0\);/,
    'and the blind form must be gone');
  // ⚠ PER SYMBOL, not the proposal's factor: the book can mix a USD-quoted instrument with SGX, and one factor
  // applied to both would be a new error introduced by the fix.
  assert.match(src, /const fxBySymbol = new Map\(\);/, 'the per-symbol factors are memoised');
  assert.match(src, /fxFactorFor\(\{ settings, symbol: sym, live: accLive \}\)\.fx/,
    'and resolved for the POSITION\'s symbol, not the proposal\'s');
  // The margin guard must still receive the proposal's factor for the ticket it is sizing — the two are
  // different questions and both are asked in the same block.
  assert.match(src, /capPct: marginCapPctRaw, equity, fx,/, 'the ticket still uses the proposal factor');
});
