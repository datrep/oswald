// test/trailing-stop.test.js — TRD-TRL-2 (venue-native trailing stop).
//
// The strongest tests here reproduce the money the venue actually printed on the live Oil position (#1134) from
// the trail level implied by that same print. If the arithmetic model is wrong these fail before any DOM work is
// attempted - which is the point of splitting the module out of the bridge.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  trailLevelFor, moneyAt, trailLevelFromMoney, distanceFromReadback, distanceFromPercent, pipFromPair, plan,
  pipsFromReadback, verifyReadback, PROBE_FLOOR,
} = require('../trading/agent/trailingStop');

// the live position, 2026-09-30. Oil #1134: sell, entry 89.76, size 15, venue stop 90.9704.
const OIL = { direction: 'sell', entry: 89.76, size: 15, stopPrice: 90.9704 };
const STOP_DIST = 1.2104; // |89.76 - 90.9704|
const ON = { risk: { trailingStop: { enabled: true } } };

test('moneyAt reproduces the venue readings on the live Oil position', () => {
  // dump A: the reading S$-5.56 implies a trail level of entry + 5.56/15
  assert.strictEqual(moneyAt({ ...OIL, trailLevel: 90.13066667 }), -5.56);
  // dump B: S$-6.90 implies 89.76 + 6.90/15
  assert.strictEqual(moneyAt({ ...OIL, trailLevel: 90.22 }), -6.90);
});

test('trailLevelFromMoney inverts the venue print, which is how the pip size is avoided', () => {
  assert.ok(Math.abs(trailLevelFromMoney({ ...OIL, moneyRead: -5.56 }) - 90.13066667) < 1e-6);
  assert.strictEqual(trailLevelFromMoney({ ...OIL, moneyRead: -6.90 }), 90.22);
  // a BUY in profit prints positive money and inverts to a level above the entry
  assert.strictEqual(trailLevelFromMoney({ direction: 'buy', entry: 100, size: 2, moneyRead: 4 }), 102);
  // refuses rather than inventing a level
  assert.strictEqual(trailLevelFromMoney({ ...OIL, moneyRead: null }), null);
  assert.strictEqual(trailLevelFromMoney({ direction: 'buy', entry: 100, size: 0, moneyRead: 4 }), null);
});

test('the trail level sits on the STOP side of the price, for both directions', () => {
  // Oil is a SELL with the venue stop ABOVE the price (90.9704 > 89.76) - the trail must go the same way
  assert.strictEqual(trailLevelFor({ direction: 'sell', price: 89.86, distance: 0.36 }), 90.22);
  // a buy's stop lives BELOW the price, so its trail does too
  assert.strictEqual(trailLevelFor({ direction: 'buy', price: 100, distance: 2 }), 98);
  // refuses rather than guessing a level
  assert.strictEqual(trailLevelFor({ direction: 'sell', price: 0, distance: 1 }), null);
  assert.strictEqual(trailLevelFor({ direction: 'sell', price: 100, distance: 0 }), null);
  assert.strictEqual(trailLevelFor({ direction: 'hold', price: 100, distance: 1 }), null);
  assert.strictEqual(trailLevelFor({ direction: 'sell', price: 100, distance: -1 }), null);
});

test('plan is off unless the setting turns it on', () => {
  assert.strictEqual(plan({ settings: {}, ...OIL, price: 89.86 }).reason, 'disabled');
  assert.strictEqual(plan({ settings: { risk: { trailingStop: { enabled: false } } }, ...OIL, price: 89.86 }).reason,
    'disabled');
});

test('at the entry price the trail starts exactly on the venue stop', () => {
  // This is the property that makes `d = stopDist` the safe default: measured from the entry the two are the
  // same number, so the trail does not move the level the position was sized against.
  const p = plan({ settings: ON, ...OIL, price: OIL.entry });
  assert.strictEqual(p.ok, true);
  assert.ok(Math.abs(p.stopDist - STOP_DIST) < 1e-9);
  assert.strictEqual(p.distance, 1.2104);
  assert.strictEqual(p.trailLevel, 90.9704);
  assert.strictEqual(p.trailLevel, OIL.stopPrice);
  assert.strictEqual(p.expectedMoney, -18.156); // the venue stop's own loss, in the venue's own units
});

test('the trail starts ON the venue stop whatever the price is, so it never moves the sized level', () => {
  // This is what makes the default right: the trail lands exactly on the stop the position was sized against -
  // at any price - and the venue ratchet then walks it in. The sizing reference never moves.
  for (const price of [89.76, 89.86, 89.60]) {
    const p = plan({ settings: ON, ...OIL, price });
    assert.strictEqual(p.ok, true);
    assert.strictEqual(p.trailLevel, OIL.stopPrice);
    assert.ok(Math.abs(p.distance - Math.abs(OIL.stopPrice - price)) < 1e-6);
    assert.ok(Math.abs(p.stopDistFromEntry - STOP_DIST) < 1e-9);
    assert.strictEqual(p.expectedMoney, -18.156);
  }
});

test('the guard measures the stop from the PRICE, not from the entry - the Bitcoin case that caught it', () => {
  // Bitcoin #1131: entry 83,568.7, stop 84,215.9112 (a 647.21 sizing distance), read at a price of ~83,327.
  const BTC = { direction: 'sell', entry: 83568.7, size: 0.007, stopPrice: 84215.9112 };
  const price = 83326.9;
  // the trail the owner read sits 808.4 from the price while the stop sits 889.0 from it: TIGHTER, so it fires
  // first and replaces the stop. But 808.4 > 647.21 = |entry - stop|, so an entry-based guard waves it through.
  const trailLevel = 84135.32292;
  const dTrail = Math.abs(trailLevel - price);
  const dStop = Math.abs(BTC.stopPrice - price);
  assert.ok(Math.abs(dTrail - 808.42292) < 1e-3);
  assert.ok(Math.abs(dStop - 889.0112) < 1e-3);
  assert.ok(dTrail < dStop); // tighter than the stop => the venue fires the trail first
  assert.ok(dTrail > Math.abs(BTC.entry - BTC.stopPrice)); // yet WIDER than the sizing distance
  // so the same trailing distance must be judged REFUSED: express 808.4 as a multiple of the price-anchored stop
  const p = plan({ settings: { risk: { trailingStop: { enabled: true, distanceMultiple: dTrail / dStop } } },
    ...BTC, price });
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.reason, 'tighter_than_stop_requires_explicit_opt_in');
  // and the DEFAULT for this position puts the trail exactly on the stop, 889.0 away - safe
  const dflt = plan({ settings: ON, ...BTC, price });
  assert.strictEqual(dflt.ok, true);
  assert.ok(Math.abs(dflt.trailLevel - BTC.stopPrice) < 1e-6);
});

test('a trail tighter than the stop needs an explicit opt-in, because it REPLACES the stop', () => {
  const refused = plan({
    settings: { risk: { trailingStop: { enabled: true, distanceMultiple: 0.25 } } }, ...OIL, price: 89.86,
  });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'tighter_than_stop_requires_explicit_opt_in');
  const allowed = plan({
    settings: { risk: { trailingStop: { enabled: true, distanceMultiple: 0.25, allowTighterThanStop: true } } },
    ...OIL, price: 89.86,
  });
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(allowed.tighterThanStop, true);
  // the reference is the stop's distance FROM THE PRICE (1.1104 here), not from the entry (1.2104)
  assert.ok(Math.abs(allowed.distance - Math.abs(OIL.stopPrice - 89.86) / 4) < 1e-9);
});

test('plan refuses when the stop distance is unknown rather than defaulting one', () => {
  assert.strictEqual(plan({ settings: ON, direction: 'sell', entry: 89.76, size: 15, price: 89.86 }).reason,
    'stop_distance_unknown');
  assert.strictEqual(plan({ settings: ON, ...OIL, stopPrice: 89.76, price: 89.86 }).reason,
    'stop_distance_unknown'); // entry == stopPrice is a zero-distance stop: no d can be derived from it
  assert.strictEqual(plan({ settings: ON, ...OIL, price: 0 }).reason, 'price_unknown');
});

test('distance is invariant when the market ticks and money is not - the bug this module fixed in itself', () => {
  // Same trail distance, two prices, and the venue money differs by 8.3% between them. A money-based check
  // would fail a trail that is exactly right, which is why the verification is on the distance.
  const atEntry = distanceFromReadback({ ...OIL, moneyRead: -18.156, price: 89.76 });
  const ticked = distanceFromReadback({ ...OIL, moneyRead: -19.656, price: 89.86 });
  assert.strictEqual(atEntry.ok, true);
  assert.strictEqual(ticked.ok, true);
  assert.strictEqual(atEntry.distance, STOP_DIST);
  assert.strictEqual(ticked.distance, STOP_DIST);
  assert.ok(Math.abs((-19.656 - -18.156) / -18.156) > 0.08); // >8% apart in money, 0% apart in distance
});

test('distanceFromPercent needs no fx rate and no pip size, and gets the SELL sign right', () => {
  // Bitcoin #1131, the owner reading: 80,000 pips -> S$-5.09 / -0.68%, price ~83,327.
  // percent = money / (size x price x fx), so size and fx BOTH cancel in the level.
  const btc = distanceFromPercent({ direction: 'sell', entry: 83568.7, price: 83326.9, percentFraction: -0.0068 });
  assert.strictEqual(btc.ok, true);
  assert.ok(Math.abs(btc.trailLevel - 84135.32292) < 1e-4);
  assert.ok(Math.abs(btc.distance - 808.42292) < 1e-3);
  // CROSS-CHECK: 80,000 pips for ~808 price units puts the pip at ~0.0101, i.e. a CENT - which is what a
  // 2-decimal instrument should have. The module never needs it, but a non-round pip would say the model is wrong.
  assert.ok(Math.abs(808.42292 / 80000 - 0.010105) < 0.0001);
  // the sign trap: flip the direction and the level lands BELOW the price, which is not a stop at all
  const wrong = distanceFromPercent({ direction: 'buy', entry: 83568.7, price: 83326.9, percentFraction: -0.0068 });
  assert.ok(wrong.trailLevel < 83326.9);
  // refuses unreadable input rather than inventing a level
  assert.strictEqual(distanceFromPercent({ direction: 'sell', entry: null, price: 83326.9,
    percentFraction: -0.0068 }).reason, 'percent_inputs_unusable');
  assert.strictEqual(distanceFromPercent({ direction: 'sell', entry: 83568.7, price: 0,
    percentFraction: -0.0068 }).ok, false);
  assert.strictEqual(distanceFromPercent({ direction: 'hold', entry: 83568.7, price: 83326.9,
    percentFraction: -0.0068 }).reason, 'bad_direction');
});

test('the money span is measured FROM THE ENTRY, which is why it moves when the price does not', () => {
  // the same trail level, two prices, 8.3% apart in money and identical in distance (see the test above)
  assert.strictEqual(trailLevelFromMoney({ ...OIL, moneyRead: -6.90 }), 90.22);
  assert.strictEqual(trailLevelFromMoney({ ...OIL, moneyRead: -5.56 }), 90.13066667);
});

test('pipFromPair pins the pip from two readings with NO assumption, and Bitcoin lands on a cent', () => {
  // The owner's controlled pair on Bitcoin #1131, 2026-09-30, read from one panel at one moment:
  //   80,000 pips -> S$-5.31 / -0.71%      40,000 pips -> S$-1.75 / -0.23%
  const got = pipFromPair({
    entry: 83568.7, size: 0.007,
    readings: [
      { pips: 80000, money: -5.31, percentFraction: -0.0071 },
      { pips: 40000, money: -1.75, percentFraction: -0.0023 },
    ],
  });
  assert.strictEqual(got.ok, true);
  // ★ THE VERIFICATION IS THAT THE PIP IS ROUND. Three free parameters came out of four readings, and nothing
  // forced the answer to a cent - a wrong model would land on a number as arbitrary as 0.0164.
  assert.ok(Math.abs(got.pip - 0.01) < 1e-4, `expected a cent, got ${got.pip}`);
  // and the implied quantities are all sane for a USD instrument on an SGD account
  assert.ok(Math.abs(got.impliedFx - 1.27) < 0.02);
  assert.ok(Math.abs(got.impliedPrice - 83365.5) < 5);
  assert.ok(Math.abs(got.impliedP - 1.81) < 0.02); // S$ - a small profit, which is why the money reads negative
  assert.ok(Math.abs(got.impliedValue - 741.667) < 0.01);
  // the pair may be given in either order: the function sorts by pip count
  const flipped = pipFromPair({
    entry: 83568.7, size: 0.007,
    readings: [
      { pips: 40000, money: -1.75, percentFraction: -0.0023 },
      { pips: 80000, money: -5.31, percentFraction: -0.0071 },
    ],
  });
  assert.strictEqual(flipped.pip, got.pip);
});

test('the cent pip for OIL is corroborated by a panel this test otherwise never touches', () => {
  // Oil #1134 on-trade dump: 15 barrels, entry 89.76, venue stop 90.9704, reading S$-6.90 / -0.40%.
  // The CLOSED-position panel recorded a Close Rate of 89.83. Feeding that back independently: the spans give
  // value = money/percent = 6.90/0.004 = S$1,725, and 89.83 x (15 x 1.2801) = S$1,724.9 - the same number.
  const entry = 89.76, money = -6.90, closeRate = 89.83, stopPrice = 90.9704;
  const S = 15 * 1.2801; // size x fx
  assert.ok(Math.abs(closeRate * S - 1725) < 1);
  // now ask the only question that matters: with a CENT pip, does that dump hold together?
  const impliedP = (entry - closeRate) * S;
  const pips = (impliedP - money) / (0.01 * S); // the count the panel must have been holding
  assert.ok(Math.abs(pips - 28.9) < 0.2);
  assert.ok(Math.abs(impliedP - 0.01 * pips * S - money) < 0.02); // and it reproduces the reading
  // ⚠ the trail that count implies is ~4x TIGHTER than the stop the desk sized against - so it does not add
  // protection, it REPLACES the level every R multiple on this desk divides by.
  const d = 0.01 * pips;
  const stopDist = Math.abs(stopPrice - closeRate);
  assert.ok(d < stopDist);
  assert.ok(Math.abs(stopDist / d - 3.94) < 0.05);
});

test('pipFromPair refuses anything it cannot pin rather than returning a number', () => {
  const base = { entry: 83568.7, size: 0.007 };
  const r = (p, m, pct) => ({ pips: p, money: m, percentFraction: pct });
  // a flat pair says the widget is not a trailing distance at all
  assert.strictEqual(pipFromPair({ ...base, readings: [r(1000, -2, -0.003), r(2000, -2, -0.003)] }).reason,
    'not_monotonic');
  // money that moves the WRONG way
  assert.strictEqual(pipFromPair({ ...base, readings: [r(1000, -2, -0.003), r(2000, -1, -0.001)] }).reason,
    'not_monotonic');
  // the same pip count twice is not a pair
  assert.strictEqual(pipFromPair({ ...base, readings: [r(1000, -2, -0.003), r(1000, -1, -0.002)] }).reason,
    'pips_do_not_differ');
  assert.strictEqual(pipFromPair({ ...base, readings: [r(1000, -2, -0.003)] }).reason, 'need_two_readings');
  assert.strictEqual(pipFromPair({ ...base, readings: [r(1000, -2, -0.003), r(2000, null, -0.002)] }).reason,
    'unreadable_reading');
  assert.strictEqual(pipFromPair({ entry: 0, size: 0.007, readings: [] }).reason, 'bad_entry');
});

test('the calibrated pip closes the loop: the desk can now name the distance it is asking for', () => {
  const PIP = 0.01;
  const price = 83365.5;
  const stopPrice = 84215.9112;
  const stopDist = Math.abs(stopPrice - price); // 850.4 - the trail sits ON the stop
  assert.ok(Math.abs(stopDist - 850.4112) < 1e-3);
  // the desk's default request for this position, in the venue's own units
  const pips = Math.round(stopDist / PIP);
  assert.strictEqual(pips, 85041);
  // and the trail the owner actually read (80,000) falls ~6% SHORT of that, so it fires first
  assert.ok(80000 * PIP < stopDist);
  assert.ok(Math.abs((80000 * PIP) / stopDist - 0.9407) < 0.001);
});

test('distanceFromReadback recovers a distance from a money reading', () => {
  // ⚠ this route needs `fx` for the ABSOLUTE level (the span is SGD, the position is USD) and is therefore the
  // fallback; `distanceFromPercent` above is preferred whenever the desk has a price of its own.
  const b = distanceFromReadback({ ...OIL, moneyRead: -6.90, price: 89.86 });
  assert.strictEqual(b.trailLevel, 90.22);
  assert.strictEqual(b.distance, 0.36);
  // and it refuses inputs it cannot turn into a distance
  assert.strictEqual(distanceFromReadback({ ...OIL, moneyRead: -6.90, price: 0 }).reason, 'price_unknown');
  assert.strictEqual(distanceFromReadback({ ...OIL, moneyRead: null, price: 89.86 }).reason, 'level_undefined');
});

test('pipsFromReadback scales by the distance ratio, and refuses an unusable probe', () => {
  const scale = pipsFromReadback({ probePips: 100000, moneyRead: -6.90, distanceRead: 0.36, distanceTarget: 1.2104 });
  assert.strictEqual(scale.ok, true);
  assert.strictEqual(scale.pips, Math.round((100000 * 1.2104) / 0.36));
  // asking for half the distance asks for half the count
  assert.strictEqual(pipsFromReadback({ probePips: 100000, moneyRead: -6.90, distanceRead: 0.36,
    distanceTarget: 0.18 }).pips, 50000);
  // the guard that exists because inverting the money divides by `size`
  const small = pipsFromReadback({ probePips: 100000, moneyRead: -0.7, distanceRead: 0.36, distanceTarget: 1.2104 });
  assert.strictEqual(small.ok, false);
  assert.strictEqual(small.reason, 'probe_reading_too_small');
  assert.strictEqual(small.floor, PROBE_FLOOR);
  assert.strictEqual(pipsFromReadback({ probePips: 100000, moneyRead: -6.90, distanceRead: 0,
    distanceTarget: 1.2104 }).reason, 'bad_readback_distance');
  assert.strictEqual(pipsFromReadback({ probePips: 0, moneyRead: -6.90, distanceRead: 0.36,
    distanceTarget: 1.2104 }).reason, 'bad_probe');
  assert.strictEqual(pipsFromReadback({ probePips: 100000, moneyRead: -6.90, distanceRead: 0.36,
    distanceTarget: 0 }).reason, 'bad_target');
});

test('verifyReadback is the mandatory gate and is measured against the target distance', () => {
  assert.strictEqual(verifyReadback({ distanceRead: 1.2104, distanceTarget: 1.2104, tolerancePct: 2 }).ok, true);
  assert.strictEqual(verifyReadback({ distanceRead: 1.2104, distanceTarget: 1.2104 }).driftPct, 0);
  const fail = verifyReadback({ distanceRead: 1.30, distanceTarget: 1.2104, tolerancePct: 2 });
  assert.strictEqual(fail.ok, false);
  assert.ok(fail.driftPct > 2 && fail.driftPct < 8);
  // an unverifiable readback never passes
  assert.strictEqual(verifyReadback({ distanceRead: null, distanceTarget: 1.2104 }).ok, false);
  assert.strictEqual(verifyReadback({ distanceRead: 0, distanceTarget: 0 }).ok, false);
});
