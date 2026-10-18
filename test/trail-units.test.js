// test/trail-units.test.js — TRD-TRL-3 (#1492). What a pip count buys, measured per instrument.
//
// THE DEFECT THIS PINS. Eight approved entries were refused because a trailing-stop distance "did not hold the
// requested value", and the read never depended on the request: three Sugar attempts asking for 0.115 / 0.095 /
// 0.125 all read 31.55. The cause was measured on 2026-09-30 by reading the control's own consequence at a sweep
// of counts on a ticket that was never submitted - and it is that the control CLAMPS. Every one of those reads was
// the SYMBOL'S OWN MAXIMUM:
//
//     Oil            wanted 0.8832 / 0.8916   read 150.62 / 150.70   measured ceiling 150.50
//     Sugar          wanted 0.125 / 0.095 / 0.115   read 31.575 / 31.535 / 31.554   measured ceiling 31.53
//     Arabica Coffee wanted 1.6572 / 1.4072   read 267.00 / 266.93   measured ceiling 266.70
//
// So these tests do two jobs: they pin the affine model against the MEASURED CURVES (the numbers below are read
// off `temp/trail-curve-*.json`, not invented), and they pin the REFUSALS, because a count the desk cannot
// justify is the defect the whole row exists to remove.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { PIP_UNITS, pipUnitsFor, pipsForTarget } = require('../trading/agent/trailingStop');

// The measured curves, straight from `temp/trail-curve-*.json`: [count, distance].
const MEASURED = {
  Oil: [[100, 1.07350], [1000, 10.06632], [5000, 50.07002]],
  Sugar: [[100, 1.03015], [1000, 10.02992]],
  'Arabica Coffee': [[5000, 50.23100], [25000, 250.23141]],
  Bitcoin: [[5000, 175.62592], [25000, 376.34080], [100000, 1129.57834]],
  Gold: [[1000, 10.89111], [5000, 50.68702], [25000, 250.91391], [100000, 1000.66371]],
  // Silver: RE-MEASURED 2026-10-08 (TRD-TRL-8, sell-side sweep); the 09-30 points that went with the old
  // offset live in temp/trail-curve-Silver-2026-09-30.json, and the offset drift 0.052 -> 0.078 is exactly
  // why the model is compared against a CURRENT curve rather than a historical one.
  Silver: [[1000, 1.08362], [5000, 5.08223], [25000, 25.08326]],
};

const predict = (symbol, count) => {
  const u = PIP_UNITS[String(symbol).toLowerCase()];
  return u.pip * count + u.offset;
};

test('the unit is a MEASURED pip and offset per instrument - and it is NOT one cent everywhere', () => {
  for (const [key, row] of Object.entries(PIP_UNITS)) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.measuredAt), `${key}: the row carries where it came from`);
    assert.ok(row.pip > 0, `${key}: a pip that is not positive is not a pip`);
  }
  // ⚠ THE DATE IS PER ROW, NOT ONE DATE FOR THE TABLE. Silver's offset drifted 0.052 -> 0.078 between 09-30
  // and 10-08 and was re-measured after the T2.5 read-back abort - a row that silently kept its old date
  // would be a measurement pretending to be current, which is the class this table exists to end.
  assert.strictEqual(PIP_UNITS.silver.measuredAt, '2026-10-08', 'Silver carries its re-measurement date');
  // ⚠⚠ THIS ASSERTION USED TO READ `pip === 0.01` FOR EVERY ROW, AND SILVER FALSIFIED IT. Four instruments had
  // all been a cent, and "the control counts cents" was becoming a generalisation the desk would have written
  // down. Silver measures 0.001 - a tenth of that - so any default, or any inference from another row, is wrong.
  assert.strictEqual(PIP_UNITS.silver.pip, 0.001, 'Silver is NOT a cent; measuring it is the only way to know');
  assert.strictEqual(PIP_UNITS.gold.pip, 0.01, 'Gold is');
  // the offsets are measured, not derived, and they differ by more than an order of magnitude
  assert.ok(PIP_UNITS.bitcoin.offset > 100, 'Bitcoin carries a material offset (0.15% of its price)');
  assert.ok(PIP_UNITS.oil.offset < 0.1 && PIP_UNITS.sugar.offset < 0.1);
});

test('the model reproduces the measured curves', () => {
  for (const [symbol, points] of Object.entries(MEASURED)) {
    for (const [count, measured] of points) {
      const predicted = predict(symbol, count);
      const errPct = Math.abs((predicted - measured) / measured) * 100;
      // Bitcoin is the loosest: its four-digit price makes the 2-decimal money span coarse.
      assert.ok(errPct < 1.2, `${symbol} at ${count}: predicted ${predicted.toFixed(4)} vs measured ${measured.toFixed(4)} (${errPct.toFixed(2)}%)`);
    }
  }
});

test('an instrument that has NOT been measured is refused, never defaulted', () => {
  // ⚠ Soybean Oil is the example BECAUSE 'oil' IS a key: the lookup is an exact key match, so a symbol that
  // merely CONTAINS a measured one must still refuse. Defaulting it to the nearest measured row would size a
  // Soybean Oil trail off a number nobody took, which is the defect class this whole table exists to end.
  const u = pipUnitsFor('Soybean Oil');
  assert.strictEqual(u.ok, false);
  assert.strictEqual(u.reason, 'instrument_not_measured');
  const p = pipsForTarget({ symbol: 'Soybean Oil', distanceTarget: 1.5 });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'instrument_not_measured');
  // the trap this guards: a defaulted cent would size the trail off a number nobody measured
  assert.notStrictEqual(p.pips, 150);
  // and it is REPORTED as unmeasured rather than as a bad target
  assert.strictEqual(p.detail, undefined);
});

test('the two instruments measured LAST - the ones the desk actually trades most - behave as their curves read', () => {
  // Gold is 47 of ~150 trades and had NO row until 2026-09-30, so the fix would have refused every one of them.
  // Its floor is a DISTANCE, not a count: counts 1..100 all read 2.5134.
  const low = pipsForTarget({ symbol: 'Gold', distanceTarget: 1.0 });
  assert.strictEqual(low.ok, false);
  assert.strictEqual(low.reason, 'below_venue_minimum_count');
  assert.ok(Math.abs(low.wouldBeDistance - 2.5134) < 0.02, 'the floor is the distance the control kept returning');
  // above the floor it is expressible, and the count is the model's arithmetic
  const ok = pipsForTarget({ symbol: 'Gold', distanceTarget: 5 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.pips, 421); // (5 - 0.79) / 0.01
  // Silver DID clamp, and the venue said so by rewriting the field to its own maximum: 37,850.
  const high = pipsForTarget({ symbol: 'Silver', distanceTarget: 1000 });
  assert.strictEqual(high.ok, false);
  assert.strictEqual(high.reason, 'above_venue_maximum_count');
  assert.strictEqual(high.maxCount, 37850);
  assert.ok(Math.abs(high.wouldBeDistance - 37.93) < 0.01, 'the ceiling it clamps to is the one it printed');
  // and Silver's much finer pip is used, not Gold's - the two differ by 10x on the same venue, same card
  // (offset re-measured 2026-10-08, TRD-TRL-8: 0.052 -> 0.078; pip unchanged at 0.001)
  assert.strictEqual(pipsForTarget({ symbol: 'Silver', distanceTarget: 5 }).pips, 4922); // (5 - 0.078) / 0.001
});

test('the count is COMPUTED from the model - and the probe it replaces was far enough off to refuse', () => {
  // Oil #139066's target. The old path scaled from a 100,000-pip probe that had CLAMPED, so it derived a
  // pip-per-count of 0.0015 instead of 0.01, asked for 62 pips, and read the ceiling back.
  const p = pipsForTarget({ symbol: 'Oil', distanceTarget: 0.8916 });
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.pips, 82); // (0.8916 - 0.07) / 0.01
  assert.ok(Math.abs(p.expectedDistance - 0.89) < 0.02);
  // what the old scaling would have asked for, and why it could never verify
  const oldPips = Math.round(0.8916 / 0.00150571);
  assert.strictEqual(oldPips, 592);
  const arrival = PIP_UNITS.oil.pip * 592 + PIP_UNITS.oil.offset; // 6.0, against a 0.89 target
  assert.ok(Math.abs(arrival - 0.8916) / 0.8916 > 1, 'the old count was more than 100% off the target');
});

test('a count outside the range the venue accepts is REFUSED, with what it would have become', () => {
  // below the floor: Oil clamps any count under 7 up to 7 (measured: 1, 2 and 5 all read 7)
  const low = pipsForTarget({ symbol: 'Oil', distanceTarget: 0.1 });
  assert.strictEqual(low.ok, false);
  assert.strictEqual(low.reason, 'below_venue_minimum_count');
  assert.strictEqual(low.wouldBeDistance, 0.14);
  // ⚠ THE OFFSET IS CHECKED FIRST, and that ordering is the correct one: a target at or below the offset cannot be
  // expressed by ANY count, so it must not be reported as merely "a small count"
  assert.strictEqual(pipsForTarget({ symbol: 'Oil', distanceTarget: 0.07 }).reason, 'at_or_below_control_offset');
  assert.strictEqual(pipsForTarget({ symbol: 'Oil', distanceTarget: 0.04 }).reason, 'at_or_below_control_offset');
  // above the ceiling: both 25,000 and 100,000 measured the SAME reading, 150.50
  const high = pipsForTarget({ symbol: 'Oil', distanceTarget: 200 });
  assert.strictEqual(high.ok, false);
  assert.strictEqual(high.reason, 'above_venue_maximum_count');
  assert.strictEqual(high.wouldBeDistance, 150.57);
  const absurd = pipsForTarget({ symbol: 'Oil', distanceTarget: 1000 });
  assert.strictEqual(absurd.reason, 'above_venue_maximum_count');
  assert.strictEqual(absurd.wouldBeDistance, high.wouldBeDistance, 'both land on the same ceiling, as measured');
});

test('a target inside the control OFFSET is refused rather than rounded to nothing', () => {
  // Bitcoin's offset is 126.6 (0.15% of its price) - a 100-unit trail cannot be expressed at all
  const b = pipsForTarget({ symbol: 'Bitcoin', distanceTarget: 100 });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.reason, 'at_or_below_control_offset');
  assert.strictEqual(b.offset, 126.6);
  // and just above it, the count is right
  const ok = pipsForTarget({ symbol: 'Bitcoin', distanceTarget: 500 });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.pips, 37340); // (500 - 126.6) / 0.01
});

test('every unstatable input refuses, and the reasons are distinguishable', () => {
  for (const [args, reason] of [
    [{ symbol: 'Oil', distanceTarget: null }, 'bad_target'],
    [{ symbol: 'Oil', distanceTarget: 0 }, 'bad_target'],
    [{ symbol: 'Oil', distanceTarget: -5 }, 'bad_target'],
    [{ symbol: '', distanceTarget: 1 }, 'instrument_not_measured'],
    [{ symbol: null, distanceTarget: 1 }, 'instrument_not_measured'],
  ]) {
    const r = pipsForTarget(args);
    assert.strictEqual(r.ok, false, JSON.stringify(args));
    assert.strictEqual(r.reason, reason, JSON.stringify(args));
  }
});

test('the symbol lookup tolerates the casing the desk actually records', () => {
  for (const s of ['Oil', 'oil', ' OIL ', 'Arabica Coffee', 'arabica coffee']) {
    assert.strictEqual(pipUnitsFor(s).ok, true, `"${s}" must resolve`);
  }
  assert.strictEqual(pipsForTarget({ symbol: 'Arabica Coffee', distanceTarget: 1.4072 }).ok, true);
});
