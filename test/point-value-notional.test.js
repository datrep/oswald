// ★★ The `pointValue` sweep (2026-10-01) — the worked first case of `recurring-defect-class-2026-10-01.md`.
//
// WHAT WAS WRONG. `notional = size x price x pointValue x fx`, and every site computed only `size x price x fx`.
// `pointValue` converts a RAW QUOTE into instrument currency per unit; it is `1.000000` on Gold, Oil, Silver and
// Sugar, so the missing factor was INVISIBLE on every instrument the desk had ever sized. Soybeans quotes in
// CENTS (`pointValue 0.01`, unit `Bushels`), so its notional came out 100x too large: the 35% per-position cap
// bound at 0.69 instead of ~69, that fell under the venue's 15-bushel minimum, and the desk refused a trade it
// could afford — reporting the arithmetic error as a venue fact ("the venue's minimum is ~487% of equity").
//
// ⚠ THE IDENTITY IS THE POINT. `pointValue = 1` must leave the arithmetic BYTE-IDENTICAL, because every existing
// instrument, every recorded decision and every other test means that case. A scaling fix that is only tested on
// the scaled instrument cannot show it left the unscaled one alone.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const risk = require('../trading/agent/risk');
const { fitExposureBudget, fitMarginBudget } = risk;

const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('★★ IDENTITY: pointValue absent and pointValue 1 are byte-identical', () => {
  // ⚠ This is the regression pin for every instrument the desk has ever traded. If this ever fails, the fix has
  // changed what an UNSCALED instrument sizes to — which is every instrument except the new ones.
  const base = { size: 1000, price: 100, exposurePct: 0, exposureCapPct: 10, equity: 100000 };
  assert.deepStrictEqual(
    fitExposureBudget({ ...base }),
    fitExposureBudget({ ...base, pointValue: 1 }),
    'an absent pointValue must behave exactly as 1, not as "no cap" and not as a default',
  );
  const mb = { size: 100000, price: 100, marginRatePct: 20, usedMargin: 0, capPct: 50, equity: 100000 };
  assert.deepStrictEqual(
    fitMarginBudget({ ...mb }),
    fitMarginBudget({ ...mb, pointValue: 1 }),
  );
});

test('★★ A CENTS-QUOTED INSTRUMENT gets ~100x the size under the same cap', () => {
  // The Soybeans case, in arithmetic. With pv=1 the 10% cap admits floor(10000/100) = 100 units; with pv=0.01 the
  // same cap admits 10000/(100*0.01) = 10000, because 100 units at a cents quote is $1 of notional, not $10,000.
  const base = { size: 1e9, price: 100, exposurePct: 0, exposureCapPct: 10, equity: 100000 };
  const unit = fitExposureBudget({ ...base, pointValue: 1 });
  const cents = fitExposureBudget({ ...base, pointValue: 0.01 });
  assert.ok(unit.size > 0 && cents.size > 0, 'both must size at all');
  assert.ok(Math.abs((cents.size / unit.size) - 100) < 1, `expected ~100x, got ${cents.size / unit.size}`);
});

test('★★ the same holds for the MARGIN cap — the guard is not allowed to disagree with the budget', () => {
  const mb = { size: 1e9, price: 100, marginRatePct: 20, usedMargin: 0, capPct: 50, equity: 100000 };
  const unit = fitMarginBudget({ ...mb, pointValue: 1 });
  const cents = fitMarginBudget({ ...mb, pointValue: 0.01 });
  assert.ok(Math.abs((cents.size / unit.size) - 100) < 1, `expected ~100x, got ${cents.size / unit.size}`);
});

test('★ FAIL-SAFE: a non-positive or unreadable factor is the IDENTITY, never zero', () => {
  // ⚠ A `pointValue` of 0 would zero every notional and read as "this instrument consumes no capital" — the same
  // permissive reading of a bad input that `marginRatePct` returns `null` to avoid. Identity is the safe direction.
  const base = { size: 1000, price: 100, exposurePct: 0, exposureCapPct: 10, equity: 100000 };
  for (const bad of [0, -1, null, undefined, NaN, 'abc', '']) {
    assert.deepStrictEqual(fitExposureBudget({ ...base, pointValue: bad }), fitExposureBudget({ ...base }),
      `pointValue=${JSON.stringify(bad)} must degrade to the identity`);
  }
});

test('★★ SOURCE PIN: the product is derived in ONE place, and the old defect form is gone', () => {
  const src = readSrc('trading/agent/risk.js');
  // The one multiplier.
  assert.match(src, /function notionalFactor\(pointValue, fx\)/, 'the single derivation must exist');
  // The defect THIS fix replaces: comparing an instrument-currency notional against an account-currency ceiling.
  assert.ok(!/size \* price > maxValue/.test(src), 'the currency-blind comparison must be gone');
  // Every site the sweep was supposed to reach must route through a factor.
  assert.match(src, /const notionalK = notionalFactor\(pointValue, fx\)/, 'evaluate must resolve it ONCE');
  assert.match(src, /if \(size \* price \* notionalK > maxValue\)/, 'the per-position cap must use it');
  assert.match(src, /const n = \(Number\(t\.size\) \|\| 0\) \* \(Number\(t\.openPrice\) \|\| 0\) \* notionalFactor\(/,
    'the open-book MARGIN sum must use the per-symbol factor');
  assert.match(src, /notionalFactor\(pointValueForSymbol\(t\.symbol\), fx\)/,
    'the open-book EXPOSURE sum must use the per-symbol factor');
});

test('★★ SOURCE PIN: the caller supplies the OPEN BOOK\'s scales, not just the proposal\'s', () => {
  // ⚠ The proposal's factor and the book's are different facts — the book can mix a USD-quoted contract with a
  // cents-quoted one. Threading only the proposal's would size the NEW ticket correctly while every OPEN
  // cents-quoted position kept a 100x-overstated contribution to the caps deciding whether it fits.
  const agg = readSrc('trading/agent/aggregator.js');
  assert.match(agg, /pointValueBySymbol/, 'the per-symbol map must be supplied');
  assert.match(agg, /pointValue, pointValueBySymbol \}/, 'and passed to evaluate alongside the proposal factor');
  assert.match(agg, /for \(const t of \(openTrades \|\| \[\]\)\)/, 'resolved per OPEN position, not once');
});

test('★ SOURCE PIN: the rate accessor carries the scale, so no caller re-derives it', () => {
  const inst = readSrc('trading/agent/instruments.js');
  assert.match(inst, /out\[s\] = \{ \.\.\.marginRatePct\(lev\), pointValue:/,
    'marginRatesFor must return the contract scale beside the rate — the rows are already read');
});
