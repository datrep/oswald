// test/venue-cost-basis.test.js — TRD-45 Phase 2: the venue's own costs reach the model AND the chair.
//
// THE TWO DEFECTS THIS PINS.
//
// 1. The cost model charged `cfdSwapDailyPct: 0.02` — ONE number, both sides, every instrument. The
//    venue does not work that way: Gold spot is **-0.0319%/night on the buy side and -0.0120% on the
//    sell side** (a 2.7x difference for holding the same instrument), and the options on the same
//    underlier charge **0.0000% both sides**. A flat dial overcharges options outright and misprices
//    which side of a spot CFD is expensive.
//
// 2. The chair voted on "is this trade worth taking" with nothing in the bundle about carry. The
//    bundle had the market snapshot, indicators, positions and the pulse — and not the overnight
//    funding, the funding time, the minimum trade size or the spread. `carryPctFor`/`costFactLines`
//    are that missing section.
//
// THE SIGN IS NOT A GUESS. Eleven venue-closed trades carry both netPnl and funding: every one that
// opened and closed inside a single UTC day has funding EXACTLY 0; the one trade crossing a UTC
// midnight is the one with non-zero funding (-0.12 on 802.6 notional = -0.01495%/night against the
// venue's stated -0.0120% sell rate); and all eleven are <= 0. So a negative display means the desk
// PAYS, and `carryPctFor` negates once, in one place, instead of leaving every consumer to get it
// right. The rule "a missing rate is NOT a zero rate" is the other half.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const bt = require('../trading/agent/backtest');
const ins = require('../trading/agent/instruments');

// Module-level basis, so every test starts from a known state — a leaked basis would make the
// fallback assertions pass for the wrong reason.
function seed(map) { bt.setVenueCostBasis(map); }

// The real Phase 0 capture for Gold spot, verbatim: the numbers the venue displayed.
const GOLD_FACTS = {
  Gold: {
    symbol: 'Gold', venueInstrumentId: '11', instrumentClass: 'spot',
    minimumUnits: 0.025, unitKind: 'Troy Ounces',
    fundingBuyPct: -0.0319, fundingSellPct: -0.012, fundingTime: '5:00 AM',
    leverageRaw: '1:5', initialMarginPct: 20,
    spreadValue: null, spreadHalfPct: null, spreadCapturedAt: null,
    spreadBasis: 'no_open_market_capture',
    capturedAt: '2026-09-13T18:44:50.290Z', marketStateAtCapture: 'closed',
  },
};

// --- the sign -------------------------------------------------------------------
test('carryPctFor negates the venue sign ONCE, per side', () => {
  // The venue displays -0.0319% for the buy side. That is what the desk PAYS, so the cost is +0.0319.
  assert.equal(ins.carryPctFor(GOLD_FACTS.Gold, 'buy'), 0.0319);
  assert.equal(ins.carryPctFor(GOLD_FACTS.Gold, 'sell'), 0.012);
  // A POSITIVE venue rate is a credit, so the cost is negative — the model must be able to return a
  // credit rather than clamping at zero, or a carry-positive instrument becomes free.
  assert.equal(ins.carryPctFor({ fundingBuyPct: 0.02, fundingSellPct: 0 }, 'buy'), -0.02);
  assert.equal(ins.carryPctFor({ fundingBuyPct: 0, fundingSellPct: 0 }, 'buy'), 0, 'a zero rate is a real zero');
  // Absent is NOT zero: `Number(null) === 0` would report a free night for an uncaptured instrument.
  assert.equal(ins.carryPctFor({ fundingBuyPct: null, fundingSellPct: null }, 'buy'), null);
  assert.equal(ins.carryPctFor({}, 'buy'), null);
  assert.equal(ins.carryPctFor(null, 'buy'), null);
});

test('the two sides of one instrument cost different amounts', () => {
  const buy = ins.carryPctFor(GOLD_FACTS.Gold, 'buy');
  const sell = ins.carryPctFor(GOLD_FACTS.Gold, 'sell');
  assert.notEqual(buy, sell);
  assert.ok(Math.abs(buy / sell - 2.6583) < 0.001, 'buy is ~2.66x the sell side — a flat dial cannot express this');
});

// --- the cost model -------------------------------------------------------------
test('a seeded basis switches the model to per-side venue funding, and SAYS SO', () => {
  seed(GOLD_FACTS);
  const cfg = bt.costCfgFor('Gold');
  assert.equal(cfg.costModelVersion, 'v3-venue');
  assert.equal(cfg.cfdSwapBuyPct, 0.0319, 'the cost, not the venue display');
  assert.equal(cfg.cfdSwapSellPct, 0.012);
  assert.equal(cfg.costModelBasis.funding, 'venue_per_side');
  // The spread half is unchanged: no open-market capture exists, so it keeps the tick-history basis
  // and says so. One half being venue-derived must not make the other half LOOK venue-derived.
  assert.equal(cfg.costModelBasis.spread, 'tick_history_p75');
  seed({});
});

test('THE CLOSED-MARKET GUARD: a placeholder spread can never become a cost', () => {
  // Phase 0 measured Gold spot's spread as 2.89 while the venue was rendering "Market is closed". The
  // registry stores that quote with marketState='closed' and produces spreadHalfPct = null, so a
  // basis built from it has nothing to offer — and the model must fall through rather than adopt the
  // placeholder. This is the single most expensive way to misread the Phase 0 capture.
  seed({ Gold: { ...GOLD_FACTS.Gold, spreadValue: 2.89, spreadHalfPct: null, spreadBasis: 'no_open_market_capture' } });
  const cfg = bt.costCfgFor('Gold');
  assert.equal(cfg.cfdSpreadPct, 0.0097, 'keeps the tick-history P75, NOT 2.89 and not a % of it');
  assert.equal(cfg.costModelBasis.spread, 'tick_history_p75');
  // And a degenerate/zero spread is refused for the same reason.
  seed({ Gold: { ...GOLD_FACTS.Gold, spreadHalfPct: 0 } });
  assert.equal(bt.costCfgFor('Gold').costModelBasis.spread, 'tick_history_p75');
  seed({});
});

test('an OPEN-market spread replaces the tick-history basis and is labelled as such', () => {
  seed({ Gold: { ...GOLD_FACTS.Gold, spreadValue: 0.44, spreadHalfPct: 0.0051, spreadMid: 4350, spreadBasis: 'open_market_capture' } });
  const cfg = bt.costCfgFor('Gold');
  assert.equal(cfg.cfdSpreadPct, 0.0051);
  assert.equal(cfg.costModelBasis.spread, 'venue_open_market');
  seed({});
});

test('the fallbacks are unchanged, so an unseeded symbol behaves exactly as before', () => {
  seed({});
  // A symbol with a tick-history calibration stays on v2 with a flat funding placeholder.
  const oil = bt.costCfgFor('Oil');
  assert.equal(oil.costModelVersion, 'v2');
  assert.equal(oil.costModelBasis.spread, 'tick_history_p75');
  assert.equal(oil.costModelBasis.funding, 'flat_placeholder');
  assert.equal(oil.cfdSwapBuyPct, undefined, 'no per-side rate when the venue said nothing');
  // A symbol with neither stays on the flat v1 basis.
  assert.equal(bt.costCfgFor('ZZZ-NOT-AN-INSTRUMENT').costModelVersion, 'v1-flat');
});

test('swapPctFor is per-side and falls back to the flat dial', () => {
  seed(GOLD_FACTS);
  const cfg = bt.costCfgFor('Gold');
  assert.equal(bt.swapPctFor(cfg, 'buy'), 0.0319);
  assert.equal(bt.swapPctFor(cfg, 'sell'), 0.012);
  seed({});
  // Unseeded: the flat v2 dial, for BOTH sides — the behaviour being replaced, preserved as the
  // documented fallback.
  const flat = { ...bt.DEFAULTS, ...bt.costCfgFor('Oil') };
  assert.equal(bt.swapPctFor(flat, 'buy'), bt.DEFAULTS.cfdSwapDailyPct);
  assert.equal(bt.swapPctFor(flat, 'sell'), bt.swapPctFor(flat, 'buy'));
  // A direction the model does not know is treated as the buy side rather than as free.
  assert.equal(bt.swapPctFor(flat, undefined), bt.swapPctFor(flat, 'buy'));
  // THE FREE-NIGHT GUARD: a cfg with NO dial at all still charges the placeholder. `Number(undefined)
  // || 0` would have charged nothing, which is the absent-means-zero trap wearing a cost model.
  assert.equal(bt.swapPctFor({}, 'buy'), bt.DEFAULTS.cfdSwapDailyPct);
  // But an EXPLICIT zero is honoured — "this instrument carries no funding" is a real instruction,
  // and `||` would have overwritten it with the placeholder.
  assert.equal(bt.swapPctFor({ cfdSwapBuyPct: 0 }, 'buy'), 0);
  assert.equal(bt.swapPctFor({ cfdSwapDailyPct: 0 }, 'buy'), 0);
});

test('the swap is charged PER DIRECTION through the worksheet', () => {
  seed(GOLD_FACTS);
  const cfg = { ...bt.DEFAULTS, ...bt.costCfgFor('Gold'), cfdSpreadPct: 0, cfdSlippagePct: 0 };
  const mk = (direction) => ({ direction, size: 1, entryPrice: 4000, exitPrice: 4000, entryTime: 0, exitTime: 1, nights: 1, reason: 'test' });
  const buy = bt.worksheet([mk('buy')], cfg, 'cfd').rows[0];
  const sell = bt.worksheet([mk('sell')], cfg, 'cfd').rows[0];
  // notional 4000 x 1 night: buy costs 4000 x 0.0319% = 1.276, sell 4000 x 0.012% = 0.48.
  assert.ok(Math.abs(buy.costs - 1.276) < 0.001, `buy costs ${buy.costs}`);
  assert.ok(Math.abs(sell.costs - 0.48) < 0.001, `sell costs ${sell.costs}`);
  assert.ok(buy.costs > sell.costs, 'holding the buy side of Gold spot costs more than the sell side');
  seed({});
});

// --- the chair's section ---------------------------------------------------------
test('the chair is told what the venue charges, per side, with the legend that makes it usable', () => {
  const lines = ins.costFactLines(GOLD_FACTS);
  const text = lines.join('\n');
  // The legend is not decoration: without it "-0.0319%" reads as a credit to a reader who assumes
  // positive numbers are charges (which is how the desk's own flat dial treated it).
  assert.match(text, /CALENDAR NIGHT/);
  assert.match(text, /NEGATIVE rate means the desk PAYS/);
  assert.match(text, /DIFFERENT rate per side/);
  assert.match(text, /Gold: min size 0\.025 Troy Ounces/);
  assert.match(text, /overnight funding buy -0\.0319% \/ sell -0\.012% @ 5:00 AM/);
  assert.match(text, /leverage 1:5 \(initial margin 20%\)/);
  // ⚠ THIS ASSERTED `no open-market capture — NOT usable as a cost` UNTIL 2026-10-27, AND THAT SENTENCE BECAME
  // FALSE: the desk has a cost basis for every watchlist symbol (a curated constant), so "no live capture" is not
  // "no cost". The property worth keeping is that an ABSENT basis NAMES ITSELF rather than rendering as blank.
  assert.match(text, /cost spread UNKNOWN - no cost basis resolved/);
});

test('★ with a cost model, the line quotes the number the RISK GATE uses and labels its population', () => {
  const lines = ins.costFactLines({
    Gold: { ...GOLD_FACTS.Gold, costModel: { spreadHalfPct: 0.0097, slippagePct: 0.05, spreadBasis: 'tick_history_p75', version: 'v3-venue' } },
    'Natural Gas': { ...GOLD_FACTS.Gold, symbol: 'Natural Gas', costModel: { spreadHalfPct: 0.1, slippagePct: 0.05, spreadBasis: 'flat_default', version: 'v3-venue' } },
  });
  const text = lines.join('\n');
  assert.match(text, /cost spread 0\.0097% per side \+ 0\.05% slippage \(p75 of the desk's own two-sided ticks\)/);
  // A placeholder must not be able to pass for a measurement.
  assert.match(text, /0\.1% per side \+ 0\.05% slippage \(PLACEHOLDER, not a measurement\)/);
  assert.doesNotMatch(text, /NOT usable as a cost/);
});

test('a live capture is CORROBORATION when both exist — never the answer', () => {
  const lines = ins.costFactLines({
    Gold: {
      ...GOLD_FACTS.Gold, spreadValue: 2.89, spreadHalfPct: 0.0332, spreadMid: 4347.63, spreadBasis: 'open_market_capture',
      costModel: { spreadHalfPct: 0.0097, slippagePct: 0.05, spreadBasis: 'tick_history_p75', version: 'v3-venue' },
    },
  });
  const text = lines.join('\n');
  assert.match(text, /cost spread 0\.0097% per side/);
  assert.match(text, /venue capture 0\.0332% half-spread of 4347\.63 \(corroboration\)/);
});

test('no facts says UNKNOWN, not zero', () => {
  const lines = ins.costFactLines({});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /UNKNOWN, not zero/);
  assert.equal(ins.costFactLines(null).length, 1);
  assert.equal(ins.costFactLines(undefined).length, 1);
});

test('a live spread is rendered as a half-spread percentage, the unit the model already uses', () => {
  const lines = ins.costFactLines({
    Gold: { ...GOLD_FACTS.Gold, spreadValue: 2.89, spreadHalfPct: 0.0332, spreadMid: 4347.63, spreadBasis: 'open_market_capture' },
  });
  const text = lines.join('\n');
  assert.match(text, /spread 2\.89 \(half-spread 0\.0332% of 4347\.63\)/);
  assert.equal(/no open-market capture/.test(text), false);
});

// ⚠ THE SPEC HAD NO AGE GATE WHILE THE QUOTE HAD A 72h ONE. A quote older than `maxQuoteAgeHours` is refused and the
// prompt says "NOT usable as a cost"; the instrument SPEC — min size, funding per side, leverage — had no equivalent
// and no wording at all. Measured 2026-10-28: the registry's newest row was 2026-10-01, so every one of these numbers
// was 27 days old and every one of them read as live.
test('★ a stale spec is DISCLOSED on the line the numbers appear on', () => {
  const lines = ins.costFactLines({ Gold: { ...GOLD_FACTS.Gold, specAgeHours: 27 * 24 } });
  const text = lines.join('\n');
  assert.match(text, /SPECS 648h OLD/);
  assert.match(text, /UNVERIFIED/);
  // The numbers stay. Hiding them would leave the chairs with nothing where they had something — a different and
  // worse silence than the one this is fixing.
  assert.match(text, /min size 0\.025 Troy Ounces/);
});

test('a fresh, unknown or exactly-at-threshold spec says nothing extra — the warning must not cry wolf', () => {
  const line = (h) => ins.costFactLines({ Gold: { ...GOLD_FACTS.Gold, specAgeHours: h } }).join('\n');
  assert.doesNotMatch(line(5), /SPECS/);
  assert.doesNotMatch(line(null), /SPECS/);
  // Exactly 168h is NOT stale: the rule is "older than a week", and an off-by-one here would flag a refresh that ran
  // exactly on schedule and teach the reader to ignore the marker.
  assert.doesNotMatch(line(ins.MAX_SPEC_AGE_HOURS), /SPECS/);
  assert.match(line(ins.MAX_SPEC_AGE_HOURS + 1), /SPECS/);
});

// --- structural ------------------------------------------------------------------
test('venueCostFacts owns no SQL, and seeding is one call', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../trading/agent/instruments'), 'utf8');
  // The whole point of the store layer: a second place that queries the registry is a second place
  // that can forget the open-market filter.
  assert.equal(/getPool|query\(/.test(src), false, 'no ad-hoc SQL in agent/instruments');
  assert.match(src, /seedBacktestCostBasis/, 'the seeder must exist');
  assert.equal(typeof ins.seedBacktestCostBasis, 'function');
});
