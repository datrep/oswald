'use strict';
// measurement.test.js — the two failure classes that produced every wrong number in this repo's recent history,
// written as tests so they fail here instead of in a report to the owner.
//
// ⚠ THESE ARE REGRESSIONS, NOT ILLUSTRATIONS. Each `it(...)` below is a real number that was published and then
// retracted. If one of them ever starts passing for the wrong reason, the guard has stopped guarding.
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../trading/agent/measurement');

const gold = (o = {}) => ({
  quantity: 'gold_half_spread',
  unit: 'half_spread_pct',
  population: 'curated_table',
  value: 0.0097,
  window: 'static',
  ...o,
});

test('claim: rejects an unknown unit, because a comparison against it would be a guess', () => {
  assert.throws(() => m.claim(gold({ unit: 'percent_ish' })), /unknown unit/);
});

test('claim: rejects an unknown population, because two rows sets are not interchangeable', () => {
  assert.throws(() => m.claim(gold({ population: 'some_rows' })), /unknown population/);
});

test('claim: a value from zero samples is not a measurement', () => {
  // spreadDerivation guard 1: p75 over a single-sided feed is 0.00 -> every venue admitted on a cost of ZERO.
  assert.throws(() => m.claim(gold({ n: 0 })), /no samples/);
});

test('claim: an ABSENCE is representable, and is not zero', () => {
  const c = m.claim(gold({ value: null, window: null }));
  assert.strictEqual(c.value, null);
  assert.notStrictEqual(c.value, 0);
});

// ── FAILURE CLASS 1: UNIT ────────────────────────────────────────────────────────────────────────────────────
test('compare: REFUSES a round-trip total against a spread-only figure — the 2026-10-27 retraction', () => {
  // Published and then withdrawn: "Gold's static basis is 11.94 bps against a live 1.77 bps, so the spread is
  // 6.76x too high". 11.94 is `2 x (spread + slip) x 100`, i.e. it contains a 10 bps flat slippage term; 1.77 is
  // spread only. The ratio was the slippage placeholder, not a spread error.
  const staticBasis = m.claim({
    quantity: 'gold_round_trip_cost', unit: 'round_trip_cost_bps',
    population: 'curated_table', value: 11.94, window: 'static',
  });
  const liveSpread = m.claim({
    quantity: 'gold_round_trip_spread', unit: 'round_trip_spread_bps',
    population: 'tick_quote_source', value: 1.77, n: 2180, window: '14d',
  });
  assert.throws(() => m.compare(staticBasis, liveSpread, { label: 'gold' }), /different quantities/);
});

test('compare: still refuses when the units differ only by the half/round-trip divisor', () => {
  const half = m.claim(gold());
  const roundTrip = m.claim(gold({ unit: 'round_trip_spread_pct', value: 0.0194 }));
  assert.throws(() => m.compare(half, roundTrip), /different quantities/);
});

test('convert: percent -> bps multiplies by 100, and marks the claim as derived', () => {
  // The first implementation had this inverted and turned 12.5 bps into 0.00125.
  const c = m.claim({ quantity: 'eth_half', unit: 'half_spread_pct', population: 'curated_table', value: 0.1251, window: 'static' });
  const bps = m.asBps(c);
  assert.strictEqual(bps.unit, 'half_spread_bps');
  assert.ok(Math.abs(bps.value - 12.51) < 1e-9, `expected 12.51 bps, got ${bps.value}`);
  assert.deepStrictEqual(bps.derivedFrom, { unit: 'half_spread_pct', value: 0.1251 });
  assert.strictEqual(bps.population, 'curated_table', 'provenance must survive a conversion');
});

test('convert: round trip -> half divides by two, and the round trip of a half is exactly twice it', () => {
  const rt = m.claim({ quantity: 'oil_rt', unit: 'round_trip_spread_pct', population: 'venue_ticket_at_submit', value: 0.080, n: 22, window: '14d' });
  const half = m.asHalf(rt);
  assert.strictEqual(half.unit, 'half_spread_pct');
  assert.ok(Math.abs(half.value - 0.040) < 1e-12, `expected 0.040, got ${half.value}`);
  assert.ok(Math.abs(m.asRoundTrip(half).value - 0.080) < 1e-12);
});

test('convert: refuses to cross families, and refuses to convert an absence', () => {
  const slip = m.claim({ quantity: 'oil_slip', unit: 'slippage_pct', population: 'fill_realised', value: 0.01, n: 22, window: '14d' });
  assert.throws(() => m.asHalf(slip), /not a spread/);
  assert.throws(() => m.convert(slip, 'half_spread_pct'), /not a unit conversion/);
  const absent = m.claim(gold({ value: null }));
  assert.throws(() => m.asBps(absent), /ABSENCE/);
});

// ── FAILURE CLASS 2: POPULATION ─────────────────────────────────────────────────────────────────────────────
test('compare: REFUSES the same unit over different populations — the 5.72x Gold discrepancy', () => {
  // Both `half_spread_pct`, both arithmetically correct, 5.72x apart, because a 14-day p75 includes overnight
  // widening and a ticket label is read when the desk trades. No units guard can catch this one.
  const ticks = m.claim({
    quantity: 'gold_half_spread', unit: 'half_spread_pct',
    population: 'tick_quote_source', value: 0.0563, n: 2180, window: '14d',
  });
  const ticket = m.claim({
    quantity: 'gold_half_spread', unit: 'half_spread_pct',
    population: 'venue_ticket_at_submit', value: 0.0098, n: 14, window: '14d',
  });
  assert.throws(() => m.compare(ticks, ticket, { label: 'gold' }), /different POPULATION/);
});

test('compare: agrees when unit AND population match, and bands the ratio', () => {
  const a = m.claim(gold({ population: 'venue_ticket_at_submit', value: 0.0097, n: 14, window: '14d' }));
  const b = m.claim(gold({ population: 'venue_ticket_at_submit', value: 0.0098, n: 14, window: '14d' }));
  const r = m.compare(a, b, { label: 'gold' });
  assert.strictEqual(r.verdict, 'reproduces');
  assert.ok(Math.abs(r.ratio - 0.9897) < 0.001, `ratio ${r.ratio}`);
});

// ── THE CROSS-POPULATION CHECK, WHICH NEEDS ITS OWN NAME ───────────────────────────────────────────────────
test('agreesWith: tests a curated constant against a measurement and RECORDS both populations', () => {
  // "Does the constant track the venue?" is a legitimate question whose two sides are always from different
  // populations. It must be a tolerance test, not a like-for-like ratio — and the result says which it was.
  const goldCurated = m.claim(gold());                                                               // 0.0097
  const goldTicket = m.claim(gold({ population: 'venue_ticket_at_submit', value: 0.0098, n: 14, window: '14d' }));
  const g = m.agreesWith(goldCurated, goldTicket, { label: 'gold' });
  assert.strictEqual(g.verdict, 'agrees');
  assert.strictEqual(g.crossPopulation, true);
  assert.strictEqual(g.baselinePopulation, 'curated_table');
  assert.strictEqual(g.measuredPopulation, 'venue_ticket_at_submit');

  // Silver 0.0468 against the venue's ticket 0.0634 = 0.738, inside the band. This is the measurement that
  // WITHDREW the "Silver is 35% too cheap" recommendation that an unfiltered tick median had produced.
  const silverCurated = m.claim(gold({ quantity: 'silver_half', value: 0.0468 }));
  const silverTicket = m.claim(gold({ quantity: 'silver_half', population: 'venue_ticket_at_submit', value: 0.0634, n: 27, window: '14d' }));
  assert.strictEqual(m.agreesWith(silverCurated, silverTicket).verdict, 'agrees');

  // And the tick p75 DOES fail it — 0.0468 / 0.1614 = 0.29 — which is why the tick population cannot be used to
  // price a gate even though it is the larger sample.
  const silverTicks = m.claim(gold({ quantity: 'silver_half', population: 'tick_quote_source', value: 0.1614, n: 2180, window: '14d' }));
  const s = m.agreesWith(silverCurated, silverTicks);
  assert.strictEqual(s.verdict, 'differs');
  assert.strictEqual(s.measuredN, 2180, 'a bigger sample does not make a wrong population right');
});

test('agreesWith: refuses a cross-unit test, because agreement is only meaningful in one unit', () => {
  const half = m.claim(gold());
  const rtBps = m.claim(gold({ unit: 'round_trip_spread_bps', value: 1.94, population: 'venue_ticket_at_submit' }));
  assert.throws(() => m.agreesWith(half, rtBps), /Agreement is only meaningful in ONE unit/);
});

test('compare: refuses an absence on either side rather than dividing it as zero', () => {
  const present = m.claim(gold());
  const absent = m.claim(gold({ value: null }));
  assert.throws(() => m.compare(absent, present), /ABSENCE/);
  assert.throws(() => m.compare(present, absent), /ABSENCE/);
  assert.throws(() => m.compare(present, m.claim(gold({ value: 0 }))), /unbounded/);
});

test('render: prints the unit, the population, n, the window and the derivation', () => {
  const c = m.asBps(m.claim(gold({ n: 2180, window: '14d' })));
  const line = m.render(c);
  assert.match(line, /half_spread_bps/);
  assert.match(line, /population curated_table/);
  assert.match(line, /n=2180/);
  assert.match(line, /window 14d/);
  assert.match(line, /derived from 0\.0097 half_spread_pct/);
});
