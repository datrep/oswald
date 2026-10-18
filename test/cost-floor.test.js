// test/cost-floor.test.js — the stop-cap slider's safety arithmetic.
//
// WHY THIS FILE EXISTS. The owner asked for a slider to move the stop cap up and down for all positions.
// A slider is safe only if it cannot be moved to a value that SILENTLY excludes an instrument, and that is
// not a matter of taste: `costShare = roundTrip% / cap%`, so a TIGHTER cap raises the cost share, and past
// the ceiling the risk gate refuses the entry with no feedback to the model or the chair.
//
// The trap this file is written against: it is tempting to derive a floor from ONE rule. There are TWO, in
// two different modules, and they bind at different settings:
//   (a) trading/agent/stopPolicy.js `adverseStopCap`   — refuses the CAP when `cap < costPct x maxAdverseCostMultiple`
//   (b) trading/agent/stopPolicy.js `costShareCheck`   — refuses the TRADE when `costPct / cap > maxCostShareOfR`
// Live: ceiling 0.65 (=> x1/0.65 = x1.5385) and mult 1.5, so (b) binds and (a) sits just underneath. Loosen the
// ceiling past 0.667 and (a) becomes the binding rule — a floor that only knew (b) would then under-report and
// bless a cap the code refuses. So the floor is `max(costPct/ceiling, costPct*mult)` and BOTH rules are
// asserted against it below, at the boundary, in both directions.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const stopPolicy = require('../trading/agent/stopPolicy');
const backtest = require('../trading/agent/backtest');
const venueComparability = require('../trading/agent/venueComparability');

const SETTINGS = { risk: { maxCostShareOfR: 0.65, maxAdverseCostMultiple: 1.5 } };
// The seven instruments the desk holds strategies for, plus one that has never had a cost basis.
const SYMBOLS = ['Gold', 'Oil', 'Silver', 'Sugar', 'Bitcoin', 'SGX', 'Arabica Coffee'];

// The floor, as the endpoint computes it — restated here rather than imported so the test pins the RULE and
// not the implementation's current spelling of it.
function floorFor(costPct, settings) {
  const ceiling = stopPolicy.costCeiling(settings);
  const mult = Number((settings.risk || {}).maxAdverseCostMultiple) || 1.5;
  return Math.max(costPct / ceiling.share, costPct * mult);
}
function costPctFor(symbol) {
  const bps = venueComparability.roundTripBpsFromCfg(backtest.costCfgFor(symbol));
  return Number.isFinite(bps) ? bps / 100 : null;
}

test('the ceiling resolves from the dial that supplied it, and says which one', () => {
  assert.deepStrictEqual(stopPolicy.costCeiling(SETTINGS), { share: 0.65, from: 'maxCostShareOfR' });
  // Legacy fallback must still work, because old settings blobs carry the multiple and not the share.
  assert.strictEqual(stopPolicy.costCeiling({ risk: { maxAdverseCostMultiple: 1.5 } }).share, 1 / 1.5);
  assert.strictEqual(stopPolicy.costCeiling({ risk: {} }).share, 1 / 1.5);
});

test('no cost basis is a STATE, not a zero — it must never resolve to a permissive floor', () => {
  assert.strictEqual(stopPolicy.costShareOf({ costPct: null, stopPct: 0.3 }), null);
  assert.strictEqual(stopPolicy.costShareOf({ costPct: '', stopPct: 0.3 }), null);
  assert.strictEqual(stopPolicy.costShareOf({ costPct: 0.25, stopPct: null }), null);
  assert.strictEqual(stopPolicy.costShareCheck({ costPct: null, stopPct: 0.3, settings: SETTINGS }), null);
  // A zero stop distance has no cost share either (and must not read as "0% of R").
  assert.strictEqual(stopPolicy.costShareOf({ costPct: 0.25, stopPct: 0 }), null);
});

test('the boundary: a cap AT the floor clears the ceiling, a hair below does not', () => {
  const costPct = 0.25; // Bitcoin's measured round trip, 2026-09-25
  const exactly = costPct / 0.65;
  const at = stopPolicy.costShareCheck({ costPct, stopPct: exactly, settings: SETTINGS });
  assert.strictEqual(at.over, false, 'the floor must be ACCEPTED — `over` uses a +1e-9 tolerance for exactly this');
  assert.strictEqual(at.share, 0.65);

  const under = stopPolicy.costShareCheck({ costPct, stopPct: exactly - 0.0001, settings: SETTINGS });
  assert.strictEqual(under.over, true, 'a cap below the floor is what silently excludes an instrument');
  assert.ok(under.share > 0.65);
});

// ★ THE TEST THAT MATTERS. Every instrument that has a cost basis must be genuinely admitted at its floor by
// BOTH rules, and refused by at least one of them immediately below it. Without the second half the first is
// vacuous — a floor of 99% would pass it.
test('the floor is admitted by BOTH cap rules, and one below it is refused by at least one', () => {
  let checked = 0;
  let looseCeilingChecked = 0;
  for (const symbol of SYMBOLS) {
    const costPct = costPctFor(symbol);
    if (costPct == null) continue; // a symbol with no basis cannot have a floor — covered by its own test
    checked++;

    for (const settings of [SETTINGS, { risk: { maxCostShareOfR: 2.0, maxAdverseCostMultiple: 1.5 } }]) {
      if (settings !== SETTINGS) looseCeilingChecked++;
      const floor = floorFor(costPct, settings);
      const capSettings = { risk: { ...settings.risk, maxAdversePct: floor } };

      // (a) the cap itself is not refused
      const cap = stopPolicy.adverseStopCap(capSettings, symbol);
      assert.strictEqual(cap.pct, floor, `${symbol}: adverseStopCap refused its own floor (${floor}%)`);
      assert.strictEqual(cap.note === null, false, `${symbol}: an accepted cap must still explain itself`);

      // (b) the resulting trade is not refused by the cost-share ceiling
      const share = stopPolicy.costShareCheck({ costPct, stopPct: floor, settings });
      assert.strictEqual(share.over, false, `${symbol}: floor ${floor}% still breaches the ceiling (share ${share.share})`);

      // …and the floor is TIGHT: a hair under it must be refused by (a), (b), or both.
      const below = floor - 1e-4;
      const refusedCap = stopPolicy.adverseStopCap({ risk: { ...settings.risk, maxAdversePct: below } }, symbol).pct == null;
      const refusedShare = stopPolicy.costShareCheck({ costPct, stopPct: below, settings }).over;
      assert.ok(refusedCap || refusedShare,
        `${symbol}: ${below}% is below the floor but neither rule refuses it — the floor is not tight,`
        + ' so the slider could exclude this instrument silently');
    }
  }
  assert.ok(checked >= 5, `expected the desk's instruments to have a cost basis, checked only ${checked}`);
  assert.ok(looseCeilingChecked > 0, 'the loose-ceiling pass must actually run — that is where rule (a) binds');
});

// The rule that makes the loose-ceiling case real: past 1/1.5 = 0.6667 the SHARE rule stops binding and the
// MULTIPLE rule takes over. If this ever stops being true the `max(...)` in the floor is dead weight.
test('a loosened ceiling hands the binding constraint from the share rule to the multiple rule', () => {
  const costPct = 0.25;
  const settings = (maxCostShareOfR) => ({ risk: { maxCostShareOfR, maxAdverseCostMultiple: 1.5 } });
  const tight = floorFor(costPct, settings(0.65));
  // Compare with a tolerance: `0.25/0.65` is 0.3846153846153846, and rounding either side of the comparison
  // is how this assertion failed on its first run — the code was right, the test's exactness was not.
  assert.ok(Math.abs(tight - costPct / 0.65) < 1e-12, `at ceiling 0.65 the share rule binds (got ${tight})`);
  const loose = floorFor(costPct, settings(2.0));
  assert.ok(Math.abs(loose - costPct * 1.5) < 1e-12, `at ceiling 2.0 the multiple rule binds (got ${loose})`);
  assert.ok(loose < tight, 'loosening the ceiling can only lower the floor');
});

test('a cap of 0 or less means NO CAP, so the slider\'s off position cannot be read as a tight one', () => {
  for (const v of [0, -1, null, undefined, '']) {
    const r = stopPolicy.adverseStopCap({ risk: { maxAdversePct: v } }, 'Gold');
    assert.strictEqual(r.pct, null, `maxAdversePct ${JSON.stringify(v)} must mean "no cap"`);
  }
  assert.notStrictEqual(stopPolicy.adverseStopCap({ risk: { maxAdversePct: 1.0 } }, 'Gold').pct, null);
});
