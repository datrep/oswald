// test/trail-engage-verify.test.js — 2026-10-18 (feature `trail-engage-entry-anchored-verify`, TRD-TRL-12b).
//
// THE DEFECT THIS PINS: the Edit-card percent is anchored to the ENTRY price (measured live in five readings on
// 2026-10-08: readDistance = |entry - (price + D_venue)|, i.e. trail distance PLUS the current excursion). The
// engage verification passed the CURRENT price as `entry`, so it read `D + excursion` and compared it against
// `D` — refusing every engage more than a rounding band from break-even, which is why promotion was held.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { distanceFromPercent } = require('../trading/agent/trailingStop');
const { code } = require('./_source');

// A sell: entry 100, price fell to 90 (in profit), venue trail distance D = 2 -> venue's level = 92.
// The card shows percent = (level - entry) x profitSign / price = (92 - 100) x -1 / 90 = +8.888...%
const SELL = { direction: 'sell', entry: 100, price: 90, percentFraction: 8.888888888888888 / 100 };

test('★ with the TRUE entry the card resolves the venue level, and the distance is D', () => {
  const r = distanceFromPercent(SELL);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.trailLevel - 92) < 1e-6, `level ${r.trailLevel} should be the venue's 92`);
  assert.ok(Math.abs(r.distance - 2) < 1e-6, `distance ${r.distance} should be D = 2`);
});

test('★ the OLD call (entry = current price) reproduces the measured defect: |entry − venue level|', () => {
  const bug = distanceFromPercent({ ...SELL, entry: SELL.price });
  // level' = price + q*price*sign = 90 + 0.0888..*90*(-1) = 82; distance = |82 - 90| = 8.
  // The measured law was readDistance = |entry - (price + D)| = |100 - 92| = 8: the card reads the distance
  // from the ENTRY to the venue's level. On a FAVOURABLE position that is |D - excursion| and on an ADVERSE one
  // it is D + excursion — either way it is NOT D, which is what the verification compared it against.
  assert.ok(Math.abs(bug.distance - 8) < 1e-6, `the defect reads ${bug.distance}`);
  assert.ok(Math.abs(bug.distance - Math.abs(SELL.entry - 92)) < 1e-6, 'exactly |entry - venue level|');
  const adverse = distanceFromPercent({ direction: 'sell', entry: 102, price: 102, percentFraction: -0.0392156862745098 });
  // adverse: with entry = price = 102 and the venue level at 104 the defect reads |102 - 104| = 2 ... plus nothing,
  // because entry = price erases the excursion. The point of the pin: the old call cannot see the entry at all.
  assert.ok(Math.abs(adverse.distance - 4) < 1e-6, 'a losing ticket with entry = price reads only the distance, never the excursion');
});

test('the buy side is symmetric: the same absolute-distance error appears', () => {
  // buy entry 100, price rose to 110, D = 2 -> level = 108; percent = (108-100)/110 = +7.2727%
  const buy = { direction: 'buy', entry: 100, price: 110, percentFraction: 7.272727272727273 / 100 };
  const trueEntry = distanceFromPercent(buy);
  assert.ok(Math.abs(trueEntry.distance - 2) < 1e-6, `distance ${trueEntry.distance} should be D = 2`);
  const bug = distanceFromPercent({ ...buy, entry: buy.price });
  assert.ok(Math.abs(bug.distance - 8) < 1e-6, `the defect reads ${bug.distance} = |entry - venue level| on the buy side too`);
});

test('★ the engage path uses the TRADE entry and refuses without one — never guesses an anchor', () => {
  // Raw source (not code()): the comment that marks the end of the function is stripped by code(), and the
  // TICKET-time paths legitimately still pass price-as-entry — the slice must end before them.
  const fs = require('node:fs');
  const path = require('node:path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'webtrader.js'), 'utf8');
  const start = raw.indexOf('async function setPositionTrail');
  assert.ok(start > -1, 'setPositionTrail exists');
  const nextFn = raw.indexOf('\nasync function ', start + 10);
  const body = raw.slice(start, nextFn > -1 ? nextFn : raw.length);
  assert.match(body, /const entryRate = trade && trade\.openPrice != null \? Number\(trade\.openPrice\) : null;/,
    'the entry rate must come from the trade row');
  assert.match(body, /if \(!\(entryRate > 0\)\) \{ out\.reason = 'entry_rate_unknown'; return out; \}/,
    'an unknown entry must REFUSE — a guessed anchor makes the verification meaningless');
  assert.match(body, /distanceFromPercent\(\{ direction, entry: entryRate, price: post\.price,/,
    'the distance must be computed with the TRUE entry, not with the current price (the old call)');
  assert.doesNotMatch(body, /distanceFromPercent\(\{ direction, entry: post\.price, price: post\.price,/,
    'the old price-as-entry call must be GONE from the engage path');
  assert.match(body, /entryUsed: entryRate/, 'the reading must record which entry it was computed against');
});

test('the engage path is still INERT: the decider is flag-gated and the flag defaults false', () => {
  const engage = code('trading/agent/trailEngage.js');
  assert.match(engage, /engageOnTouch/, 'the decider reads the engage flag');
  const store = code('trading/store.js');
  assert.match(store, /engageOnTouch: \{ enabled: false, lockR: 0\.75, trailR: 0\.15 \}/,
    'the shipped default must remain disabled (build-only rollout until the watched engage)');
});
