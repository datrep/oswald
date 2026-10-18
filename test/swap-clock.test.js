// test/swap-clock.test.js — TRD-49 pins:
//   "Swap nights are counted at UTC midnight, but the venue bills at its own funding clock time
//    (05:00) — every swap charge is wrong for holds that straddle one and not the other."
//
// The bug had FOUR homes (the seven strategy backtesters, paper.js, and the two writers of the stored
// `swapNights` column) and one place that already knew better (the funding validator). These tests pin
// the primitive, the cost-model wiring, and — structurally — that no home was left behind, because
// "we fixed it in six of seven places" is indistinguishable from "we fixed it" by reading the diff.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const bt = require('../trading/agent/backtest');
const paper = require('../trading/agent/paper');
const turtle = require('../trading/agent/strategies/turtleUltimate');
const { nightsBetween, nightsFor, fundingMinuteFromText, fundingMinuteUtc, DEFAULT_FUNDING_MINUTE_UTC } = require('../trading/agent/time');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------------------------
// The clock itself
// ---------------------------------------------------------------------------------------------

test('the venue default clock is 05:00 Singapore = 21:00 UTC', () => {
  assert.equal(DEFAULT_FUNDING_MINUTE_UTC, 1260);
  assert.equal(fundingMinuteUtc({ hourLocal: 5, utcOffsetMinutes: 480 }), 1260);
  assert.equal(1260 / 60, 21, '21:00 UTC');
});

test('fundingMinuteFromText reads the venue display text, and refuses the placeholder', () => {
  assert.equal(fundingMinuteFromText('5:00 AM'), 1260);
  assert.equal(fundingMinuteFromText(' 5:00 am '), 1260, 'case/space tolerant');
  assert.equal(fundingMinuteFromText('12:00 AM'), 960, 'midnight SGT = 16:00 UTC the day before');
  assert.equal(fundingMinuteFromText('7:15 PM'), 675, '19:15 SGT = 11:15 UTC');
  // '--' means the instrument carries NO funding time. That is UNKNOWN, and it must not arrive as
  // minute 0, which would silently mean "bills at UTC midnight" — the exact claim being retired.
  assert.equal(fundingMinuteFromText('--'), null);
  assert.equal(fundingMinuteFromText(null), null);
  assert.equal(fundingMinuteFromText(''), null);
  assert.notEqual(fundingMinuteFromText('--'), 0);
});

// ---------------------------------------------------------------------------------------------
// The count — the case that started this (the venue's own Oil trade #29)
// ---------------------------------------------------------------------------------------------

// Trades #29: Oil, buy, opened 2026-09-10 18:02 UTC, closed 22:00 UTC, venue charged 0.31. The
// midnight model says this hold crosses NOTHING and therefore costs NOTHING — which is how a correct
// venue charge came to be reported as a defect.
const OIL29 = { openAt: new Date('2026-09-10T18:02:00Z'), closeAt: new Date('2026-09-10T22:00:00Z') };

test('nightsFor counts the venue clock, and agrees with the venue on the trade that exposed this', () => {
  assert.equal(nightsBetween(OIL29.openAt, OIL29.closeAt), 0, 'UTC midnight: a free hold');
  assert.equal(nightsFor(OIL29.openAt, OIL29.closeAt, DEFAULT_FUNDING_MINUTE_UTC), 1, 'venue clock: one night, which is what was charged');
});

test('nightsFor keeps the midnight count only when the caller says it has no clock', () => {
  const e = new Date('2026-09-10T18:02:00Z');
  const x = new Date('2026-09-11T22:00:00Z');
  // Both null and undefined mean "no clock known" — one idea, deliberately not two.
  assert.equal(nightsFor(e, x, null), nightsBetween(e, x));
  assert.equal(nightsFor(e, x, undefined), nightsBetween(e, x));
  assert.equal(nightsFor(e, x, NaN), nightsBetween(e, x));
  // With a clock it is the clock count, and it differs from midnight: this hold crosses ONE UTC
  // midnight (09-10 -> 09-11) but TWO funding instants, because 05:00 SGT on 09-11 is 21:00Z on
  // 09-10 — under three hours after an entry the midnight model bills nothing for at that boundary.
  assert.equal(nightsBetween(e, x), 1);
  assert.equal(nightsFor(e, x, 1260), 2);
  assert.notEqual(nightsFor(e, x, 1260), nightsBetween(e, x));
});

test('nightsFor is still zero for a hold that crosses nothing, on either clock', () => {
  const e = new Date('2026-09-10T22:30:00Z');
  const x = new Date('2026-09-11T06:00:00Z');
  // 22:30 -> 06:00 crosses UTC midnight but NOT 21:00 UTC. The exact inverse of #29, and the reason
  // the fix cannot be "use the clock" as a synonym for "count more".
  assert.equal(nightsBetween(e, x), 1);
  assert.equal(nightsFor(e, x, 1260), 0);
});

// ---------------------------------------------------------------------------------------------
// The cost model — the clock must arrive from the registry, and the basis must say which one ran
// ---------------------------------------------------------------------------------------------

const GOLD_FACTS = {
  Gold: {
    symbol: 'Gold', instrumentClass: 'spot', fundingBuyPct: -0.0319, fundingSellPct: -0.012,
    fundingTime: '5:00 AM', spreadValue: null, spreadHalfPct: null,
  },
};

test('a venue-basis symbol gets the venue clock AND a label saying so', () => {
  bt.setVenueCostBasis(GOLD_FACTS);
  try {
    const c = bt.costCfgFor('Gold');
    assert.equal(c.costModelVersion, 'v3-venue');
    assert.equal(c.cfdSwapClockMinuteUtc, 1260, 'the instrument\'s own published funding time');
    assert.equal(c.costModelBasis.swapClock, 'venue_funding_time');
    // The clock must never be left unset on a venue basis: "we know the venue's rate but not its
    // clock" would restore the midnight count underneath a v3-venue label.
    assert.notEqual(c.cfdSwapClockMinuteUtc, null);
    // And the identity the bug was made of: v3-venue is NOT self-describing without this field.
    assert.ok('swapClock' in c.costModelBasis);
  } finally {
    bt.setVenueCostBasis({});
  }
});

test('a venue-basis symbol whose registry row has no funding time gets the VENUE default, not midnight', () => {
  bt.setVenueCostBasis({
    Oil: { symbol: 'Oil', fundingBuyPct: -0.0319, fundingSellPct: -0.012, fundingTime: '--', spreadHalfPct: null },
  });
  try {
    const c = bt.costCfgFor('Oil');
    assert.equal(c.cfdSwapClockMinuteUtc, DEFAULT_FUNDING_MINUTE_UTC);
    assert.notEqual(c.cfdSwapClockMinuteUtc, 0, 'midnight is never the venue\'s rule');
    assert.equal(c.costModelBasis.swapClock, 'venue_time_default');
    assert.equal(c.costModelVersion, 'v3-venue');
  } finally {
    bt.setVenueCostBasis({});
  }
});

test('a symbol with no venue basis keeps the legacy midnight count, and says that too', () => {
  bt.setVenueCostBasis({});
  const c = bt.costCfgFor('Gold');
  // Gold is in the tick-history calibration, so it is v2 — an unseeded run must be numerically
  // identical to the run that produced any stored v2 number, which is why this branch exists at all.
  assert.equal(c.costModelVersion, 'v2');
  assert.equal(c.cfdSwapClockMinuteUtc, null);
  assert.equal(c.costModelBasis.swapClock, 'utc_midnight');
});

test('DEFAULTS declares the clock, so absent reads as a decision rather than an omission', () => {
  assert.ok('cfdSwapClockMinuteUtc' in bt.DEFAULTS);
  assert.equal(bt.DEFAULTS.cfdSwapClockMinuteUtc, null);
});

test('the label describes the clock that ACTUALLY ran, not the one the registry proposed', () => {
  // Found by the live A/B, not by reasoning: forcing `cfdSwapClockMinuteUtc: null` on a venue-basis
  // symbol moved the rows onto midnight while the stored provenance still read `venue_funding_time`,
  // because the label was computed before the caller's override was applied. A stored run whose
  // meaning changed without its label changing is the TRD-25 erratum again.
  assert.equal(bt.swapClockBasisOf({ cfdSwapClockMinuteUtc: 1260, costModelBasis: { swapClock: 'venue_funding_time' } }), 'venue_funding_time');
  assert.equal(bt.swapClockBasisOf({ cfdSwapClockMinuteUtc: null, costModelBasis: { swapClock: 'venue_funding_time' } }), 'utc_midnight', 'the override wins the label');
  assert.equal(bt.swapClockBasisOf({ cfdSwapClockMinuteUtc: 1260, costModelBasis: { swapClock: 'utc_midnight' } }), 'venue_funding_time', 'a forced clock is labelled as one');
  assert.equal(bt.swapClockBasisOf({ cfdSwapClockMinuteUtc: 1260, costModelBasis: { swapClock: 'venue_time_default' } }), 'venue_time_default');
  assert.equal(bt.swapClockBasisOf({}), 'utc_midnight');
  assert.equal(bt.swapClockBasisOf(null), 'utc_midnight');
});

// ---------------------------------------------------------------------------------------------
// The strategies — wiring, proven by behaviour and then by structure
// ---------------------------------------------------------------------------------------------

function rampBars() {
  const bars = [];
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  for (let i = 0; i < 260; i++) {
    const close = i < 200 ? 100 + i : 100 + 199 - (i - 199) * 4;
    bars.push({ open: close, high: close + 0.5, low: close - 0.5, close, time: new Date(t0 + i * 3600000) });
  }
  return bars;
}

test('a clock in cfg reaches the strategy, and no clock means the legacy midnight count', () => {
  const bars = rampBars();
  const legacy = turtle.backtest(bars, { capital: 10000 });
  const clocked = turtle.backtest(bars, { capital: 10000, cfdSwapClockMinuteUtc: 1260 });
  assert.ok(legacy.trades.length >= 1, 'the fixture must produce a trade');
  assert.equal(legacy.trades.length, clocked.trades.length, 'the clock changes cost, never the signal stream');
  for (let i = 0; i < legacy.trades.length; i++) {
    const l = legacy.trades[i];
    const k = clocked.trades[i];
    assert.strictEqual(l.entryTime, k.entryTime, 'same entries');
    assert.strictEqual(l.nights, nightsBetween(l.entryTime, l.exitTime), 'no clock -> midnight');
    assert.strictEqual(k.nights, nightsFor(k.entryTime, k.exitTime, 1260), 'clock -> the venue count');
  }
});

test('every strategy backtester reads the clock out of cfg (all seven, not six)', () => {
  const dir = path.join(ROOT, 'trading', 'agent', 'strategies');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'index.js');
  const withBacktest = files.filter((f) => /function backtest/.test(read(`trading/agent/strategies/${f}`)));
  assert.ok(withBacktest.length >= 7, `expected the seven strategy backtesters, found ${withBacktest.length}`);
  for (const f of withBacktest) {
    const src = read(`trading/agent/strategies/${f}`);
    assert.match(src, /c\.cfdSwapClockMinuteUtc/, `${f} must pass the venue clock`);
    assert.doesNotMatch(src, /\bnightsBetween\s*\(/, `${f} must not count UTC midnights`);
    assert.doesNotMatch(src, /barsHeld\s*\/\s*24/, `${f} must not use the pre-TRD-25 bars/24 form`);
  }
});

test('the two writers of the stored swapNights column count on the venue clock', () => {
  const venueClose = read('trading/agent/venueClose.js');
  assert.match(venueClose, /nightsFor\(/, 'venueClose must count nights on a clock');
  assert.doesNotMatch(venueClose, /nightsBetween\(/, 'venueClose must not write the midnight count');
  assert.match(venueClose, /resolveSwapClocks/, 'the clock must come from the registry, per symbol');
  assert.match(venueClose, /DEFAULT_FUNDING_MINUTE_UTC/, 'an unknown clock falls back to the venue default');

  const executor = read('trading/agent/executor.js');
  assert.match(executor, /fundingMinuteUtc:\s*clockMinute/, 'the close estimate must be told the clock');
  assert.doesNotMatch(executor, /swapNights:\s*require\('\.\/time'\)\.nightsBetween/, 'no midnight count on close');
});

// ---------------------------------------------------------------------------------------------
// Paper trading
// ---------------------------------------------------------------------------------------------

test('paper states the venue funding clock and defaults to 05:00', () => {
  assert.equal(paper.cfg({ paper: {} }).swapClockMinuteUtc, DEFAULT_FUNDING_MINUTE_UTC);
  // The knob is the venue's own display text, so changing it means copying a fact off the venue
  // rather than doing timezone arithmetic.
  assert.equal(paper.cfg({ paper: { fundingTime: '7:15 PM' } }).swapClockMinuteUtc, 675);
  assert.equal(paper.cfg({ paper: { fundingTime: '--' } }).swapClockMinuteUtc, DEFAULT_FUNDING_MINUTE_UTC);
  const src = read('trading/agent/paper.js');
  assert.doesNotMatch(src, /Date\.UTC\(end\.getUTCFullYear/, 'the UTC-day-difference body must be gone');
});

test('the funding validator still prefers the caller\'s clock over the stored count', () => {
  const f = require('../trading/agent/funding');
  const row = { openAt: OIL29.openAt, closeAt: OIL29.closeAt, swapNights: 0 };
  // The stored count says 0 (it was written under the old convention). The clock says 1, and the clock
  // is the venue's rule — a historical record is not a better answer than the rule that produced it.
  assert.equal(f.nightsOf(row), 0, 'no clock supplied -> the stored record');
  assert.equal(f.nightsOf(row, { fundingMinuteUtc: 1260 }), 1, 'clock supplied -> the clock wins');
});
