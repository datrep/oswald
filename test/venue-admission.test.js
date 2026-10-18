'use strict';
// C3 / B4 — the substitute-venue admission resolver: may another venue's tick stand in for the venue of
// record, and on what arithmetic?
//
// TWO TESTS HERE CARRY THE DESIGN:
//
// 1. THE PAIR THAT SHARES ONE MEASUREMENT AND DISAGREES. A +20 bps relationship is REFUSED for Gold and
//    ADMITTED for Bitcoin, because Gold's round trip is 11.94 bps and Bitcoin's is 25.00. If that pair
//    ever returns the same verdict, the threshold has stopped being derived from the cost model and has
//    become a tolerance someone chose.
//
// 2. THE OFF TEST. `enabled: false` must return BEFORE it touches the store, and the fake store here
//    THROWS if read. A regression that "only reads a little" therefore fails loudly, instead of
//    quietly putting a second venue's price on the price path.
const test = require('node:test');
const assert = require('node:assert');
const va = require('../trading/agent/venueAdmission');
const vc = require('../trading/agent/venueComparability');
const quant = require('../trading/agent/quant');
const backtest = require('../trading/agent/backtest');

const HOUR = 3600000;
const t0 = Date.parse('2026-09-01T00:00:00Z');
const N = 120; // > minPoints (50)
const series = (fn, n = N) => Array.from({ length: n }, (_, i) => ({ barStart: new Date(t0 + i * HOUR), closePrice: fn(i) }));
const flat = (price) => series(() => price);
// A perfectly stable offset in bps — the shape a "different instrument that tracks well" would have.
// `bps(a,b)` is `(a-b)/b`, i.e. measured AGAINST the candidate, so a candidate placed BELOW the
// reference by bps/(1+bps/1e4) reports exactly +bps. Getting this sign backwards is how the doc's
// Gold/yahoo row reads -116.84 rather than +116.84, so the fixtures are built to be sign-exact.
const offset = (price, bps) => series(() => price / (1 + bps / 10000));
// ...and this is scatter: a level that matches but a relationship that does not hold still.
const jitter = (price, bps) => series((i) => price * (1 + (i % 2 ? bps : -bps) / 10000));

const costOf = (symbol) => vc.roundTripBpsFromCfg(backtest.costCfgFor(symbol));
const decide = (symbol, bps) => va.admissionFor({
  symbol, reference: 'plus500',
  seriesByVenue: { plus500: flat(100), yahoo: offset(100, bps) },
  roundTripBps: costOf(symbol),
});

// The store is a fake, and every call is counted. `fail` makes a read throw on demand.
function fakeStore({ coverage = [], bars = {}, fail = null } = {}) {
  const calls = { barsCoverage: 0, listBars: 0 };
  return {
    calls,
    async barsCoverage() { calls.barsCoverage++; if (fail === 'coverage') throw new Error('coverage unavailable'); return coverage; },
    async listBars(userId, { symbol, venue }) { calls.listBars++; if (fail === 'bars') throw new Error('bars unavailable'); return bars[`${symbol}|${venue}`] || []; },
  };
}

const tick = (venue, mid) => ({ venue, mid, capturedAt: new Date().toISOString(), ageMs: 1000 });

// ── 1. OFF means OFF ─────────────────────────────────────────────────────────

test('C3: the gate is off by default and returns before it touches the store', async () => {
  va.clearCache();
  const store = fakeStore({ fail: 'coverage' });
  // These throw if read, so a "reads a little even when off" regression cannot pass quietly.
  assert.equal(await va.resolve(1, 'Gold', {}, { store }), null, 'no settings at all -> not gated');
  assert.equal(await va.resolve(1, 'Gold', undefined, { store }), null);
  assert.equal(await va.resolve(1, 'Gold', { venueComparability: {} }, { store }), null);
  assert.equal(store.calls.barsCoverage + store.calls.listBars, 0, 'the price path must not be touched with the gate off');
});

test('C3: only a literal `true` enables it — a truthy string or number must not', async () => {
  va.clearCache();
  const store = fakeStore();
  for (const v of ['true', 'yes', 1, {}, []]) {
    assert.equal(await va.resolve(1, 'Gold', { venueComparability: { enabled: v } }, { store }), null, `enabled: ${JSON.stringify(v)} must not enable a price path`);
  }
  assert.equal(store.calls.barsCoverage, 0);
  assert.deepEqual(va.configFrom({ venueComparability: { enabled: true } }), { enabled: true, ttlHours: 6 });
  assert.equal(va.configFrom({ venueComparability: { enabled: true, ttlHours: 2 } }).ttlHours, 2);
  assert.equal(va.configFrom({ venueComparability: { enabled: true, ttlHours: -1 } }).ttlHours, 6, 'a negative TTL is a typo, not a policy');
});

// ── 2. the threshold is DERIVED from the cost model ───────────────────────────

test('B4: the budget is each symbol\'s own round-trip cost, from the cost model', () => {
  assert.equal(costOf('Gold'), 11.94, '2 x (0.0097 + 0.05) x 100');
  assert.equal(costOf('Oil'), 17.28);
  assert.equal(costOf('Bitcoin'), 25);
  assert.equal(costOf('Nonexistent'), null, 'no spread and no funding -> no cost basis, not a zero cost');
  assert.equal(vc.roundTripBpsFromCfg(null), null);
  assert.equal(vc.roundTripBpsFromCfg({ cfdSpreadPct: null, cfdSlippagePct: 0.05 }), null, 'a null spread must not coerce to 0');
});

test('B4: the SAME measured gap is refused for Gold and admitted for Bitcoin', () => {
  const gold = decide('Gold', 20);
  const btc = decide('Bitcoin', 20);
  assert.equal(gold.allowed.length, 0, '20 bps is above Gold\'s 11.94 bps round trip');
  assert.deepEqual(btc.allowed, ['yahoo'], '20 bps is below Bitcoin\'s 25.00 bps round trip');
  // The charge is the same measurement in both cases; only the budget differs. That IS the derivation.
  assert.equal(gold.evidence[0].chargedBps, 20);
  assert.equal(btc.evidence[0].chargedBps, 20);
  assert.equal(gold.evidence[0].budgetBps, 11.94);
  assert.equal(btc.evidence[0].budgetBps, 25);
  assert.match(btc.evidence[0].code, /^admitted$/);
  assert.match(btc.table.rows[0].reason, /headroom/);
  assert.equal(btc.table.rows[0].headroomBps, 5);
});

test('B4: an offset-conditional pass is NOT an admission (pickTick applies no offset)', () => {
  // Gold, a perfectly stable +20 bps: the residual is zero, so an offset-corrected caller would be
  // safe — but pickTick does not correct offsets, so this must stay OFF the allowlist.
  const gold = decide('Gold', 20);
  const row = gold.table.rows[0];
  assert.equal(row.code, 'admissible_with_offset');
  assert.equal(row.admissibleWithOffset, true);
  assert.equal(row.needsOffset, true);
  assert.equal(row.offsetBps, 20);
  assert.equal(row.residualP90Bps, 0);
  assert.equal(gold.allowed.length, 0, 'conditional must never be consumable as unconditional');
  assert.match(gold.line, /NOBODY/);
  assert.match(row.reason, /pickTick does not/);
});

test('B4: a tight venue IS admitted for Gold — the rule is a budget, not a veto', () => {
  const gold = decide('Gold', 3);
  assert.deepEqual(gold.allowed, ['yahoo'], '3 bps sits under Gold\'s 11.94 bps round trip');
  assert.equal(gold.table.rows[0].headroomBps, 8.94);
});

test('B4: Gold measured with scatter refuses, and says which quantity refused it', () => {
  // level gap ~0 (fine) but +-20 bps of scatter: |diff| p90 = 20 against an 11.94 bps budget.
  const noisy = series((i) => 100 + (i % 2 ? 0.2 : -0.2));
  const r = va.admissionFor({ symbol: 'Gold', reference: 'plus500', seriesByVenue: { plus500: flat(100), yahoo: noisy }, roundTripBps: costOf('Gold') });
  const row = r.table.rows[0];
  assert.equal(r.allowed.length, 0);
  assert.equal(row.code, 'residual_exceeds_budget');
  assert.equal(row.assessment.levelOk, true, 'the level is fine — this is not a level-gap refusal');
  assert.ok(row.chargedBps > row.budgetBps, `charged ${row.chargedBps} must exceed the ${row.budgetBps} bps round trip`);
  assert.match(row.reason, /costs more than it saves/);
});

test('B4: no cost basis and no comparable history both FAIL CLOSED, with distinct codes', () => {
  const unknown = decide('Nonexistent', 1);
  assert.equal(unknown.roundTripBps, null);
  assert.equal(unknown.allowed.length, 0);
  assert.equal(unknown.evidence[0].budgetBps, null);
  assert.equal(unknown.evidence[0].code, 'no_cost_basis');

  // The silent-empty trap: no pairs is NOT "no difference".
  const empty = va.admissionFor({ symbol: 'Gold', reference: 'plus500', seriesByVenue: { plus500: [], yahoo: [] }, roundTripBps: 11.94 });
  assert.equal(empty.allowed.length, 0);
  assert.equal(empty.evidence[0].code, 'insufficient_data');
  assert.equal(empty.evidence[0].chargedBps, null);
});

test('B4: the venue of record is never a substitute for itself — including its other feeds', () => {
  const r = va.admissionFor({ symbol: 'Gold', reference: 'plus500', seriesByVenue: { plus500: flat(100), yahoo: flat(100) }, roundTripBps: 11.94 });
  assert.equal(r.evidence.length, 1);
  assert.equal(r.evidence[0].venue, 'yahoo');
  assert.deepEqual(r.allowed, ['yahoo'], 'a venue agreeing with itself would read as a pass in every report');

  // The live coverage carries BOTH for Gold. `plus500_chart` is the same broker's chart capture, so a
  // plus500 bar "replacing" a plus500 tick is the one comparison that can never be evidence.
  assert.equal(va.sameVenue('plus500_chart', 'plus500'), true);
  assert.equal(va.sameVenue('plus500', 'plus500'), true);
  assert.equal(va.sameVenue('yahoo', 'plus500'), false);
  const withChart = va.admissionFor({
    symbol: 'Gold', reference: 'plus500',
    seriesByVenue: { plus500: flat(100), plus500_chart: flat(100), yahoo: flat(100) },
    roundTripBps: 11.94,
  });
  assert.deepEqual(withChart.evidence.map((e) => e.venue), ['yahoo']);
});

// ── 3. the measurement, gated and cached ─────────────────────────────────────

const BTC = [
  { symbol: 'Bitcoin', venue: 'plus500', timeframe: '1h', bars: N },
  { symbol: 'Bitcoin', venue: 'binance', timeframe: '1h', bars: N },
  { symbol: 'Bitcoin', venue: 'yahoo', timeframe: '1h', bars: N },
  { symbol: 'Bitcoin', venue: 'okx', timeframe: '1d', bars: N },   // wrong timeframe -> not a candidate
  { symbol: 'Gold', venue: 'binance', timeframe: '1h', bars: N },  // another symbol
];
const BTC_BARS = {
  'Bitcoin|plus500': flat(60000),
  'Bitcoin|binance': offset(60000, 3),    // 3 bps, under the 25 bps budget -> admitted
  // A stable 200 bps gap is `admissible_with_offset` (fixable), NOT a scatter refusal - so the
  // genuinely unusable candidate here has to be scatter: a matching level that will not hold still.
  'Bitcoin|yahoo': jitter(60000, 40),     // +-40 bps of |diff| against a 25 bps budget
};

test('C3: resolve() measures per candidate venue and reports the evidence', async () => {
  va.clearCache();
  const store = fakeStore({ coverage: BTC, bars: BTC_BARS });
  const r = await va.resolve(11, 'Bitcoin', { venueComparability: { enabled: true } }, { store });
  assert.equal(r.enabled, true);
  assert.equal(r.unavailable, false);
  assert.equal(r.reference, 'plus500');
  assert.deepEqual(r.allowed, ['binance']);
  assert.deepEqual(r.candidates, ['binance', 'yahoo'], 'okx is 1d, Gold is another symbol, plus500 is the reference');
  assert.equal(r.roundTripBps, 25);
  assert.equal(r.referenceBars, N);
  assert.equal(r.cached, false);
  assert.equal(r.evidence.length, 2);
  assert.equal(r.evidence[0].code, 'admitted');
  assert.equal(r.evidence[0].chargedBps, 3);
  assert.equal(r.evidence[1].code, 'residual_exceeds_budget');
  assert.ok(r.evidence[1].chargedBps > r.evidence[1].budgetBps);
  assert.ok(!r.evidence.some((e) => e.venue === 'plus500'));
  assert.equal(store.calls.listBars, 3, 'one read for the reference plus one per candidate');
});

test('C3: the TTL caches the verdict, and ttlHours 0 means measure every time', async () => {
  va.clearCache();
  const store = fakeStore({ coverage: BTC, bars: BTC_BARS });
  const on = { venueComparability: { enabled: true, ttlHours: 6 } };
  const a1 = await va.resolve(12, 'Bitcoin', on, { store });
  const a2 = await va.resolve(12, 'Bitcoin', on, { store });
  assert.equal(a1.cached, false);
  assert.equal(a2.cached, true);
  assert.deepEqual(a2.allowed, a1.allowed, 'a cached verdict must be the same verdict');
  assert.equal(store.calls.barsCoverage, 1, 'the second call must not re-measure');
  assert.equal(store.calls.listBars, 3);

  va.clearCache();
  const store0 = fakeStore({ coverage: BTC, bars: BTC_BARS });
  const zero = { venueComparability: { enabled: true, ttlHours: 0 } };
  assert.equal((await va.resolve(13, 'Bitcoin', zero, { store: store0 })).cached, false);
  assert.equal((await va.resolve(13, 'Bitcoin', zero, { store: store0 })).cached, false);
  assert.equal(store0.calls.barsCoverage, 2);

  va.clearCache();
  const store3 = fakeStore({ coverage: BTC, bars: BTC_BARS });
  await va.resolve(14, 'Bitcoin', on, { store: store3 });
  va.clearCache();
  assert.equal((await va.resolve(14, 'Bitcoin', on, { store: store3 })).cached, false, 'clearCache() forces a re-measure');
});

test('C3: a failed measurement fails CLOSED and is not cached', async () => {
  va.clearCache();
  const store = fakeStore({ fail: 'coverage' });
  const on = { venueComparability: { enabled: true, ttlHours: 6 } };
  const r = await va.resolve(15, 'Gold', on, { store });
  assert.equal(r.enabled, true, 'the gate is on — it just has no answer');
  assert.equal(r.unavailable, true);
  assert.deepEqual(r.allowed, [], 'unmeasurable is not safe: refuse the substitute');
  assert.match(r.reason, /unavailable/);
  const again = await va.resolve(15, 'Gold', on, { store });
  assert.equal(again.unavailable, true);
  assert.equal(store.calls.barsCoverage, 2, 'a transient failure must not blind the gate for the whole TTL');
});

test('C3: a reference with no stored bars admits nobody (the silent-empty trap)', async () => {
  va.clearCache();
  const store = fakeStore({
    coverage: [{ symbol: 'Gold', venue: 'yahoo', timeframe: '1h', bars: N }],
    bars: { 'Gold|yahoo': flat(100) }, // no 'Gold|plus500' at all
  });
  const r = await va.resolve(16, 'Gold', { venueComparability: { enabled: true } }, { store });
  assert.equal(r.referenceBars, 0);
  assert.deepEqual(r.allowed, [], '[] and not null: the gate is on and shut');
  assert.equal(r.evidence[0].code, 'insufficient_data');
  assert.equal(r.roundTripBps, 11.94, 'the budget is still reported — the refusal is about evidence, not cost');
});

test('C3: no candidate venues at all is an empty allowlist, not an error', async () => {
  va.clearCache();
  const store = fakeStore({ coverage: [{ symbol: 'Gold', venue: 'plus500', timeframe: '1h', bars: N }], bars: { 'Gold|plus500': flat(100) } });
  const r = await va.resolve(17, 'Gold', { venueComparability: { enabled: true } }, { store });
  assert.equal(r.unavailable, false);
  assert.deepEqual(r.allowed, []);
  assert.deepEqual(r.evidence, []);
  assert.equal(store.calls.listBars, 1, 'only the reference had to be read');
});

// ── 4. the verdict is what actually gates the price path ─────────────────────

test('C3: pickTick honours the three states — null substitutes, [] refuses', () => {
  const fresh = [tick('yahoo', 4312.9)];
  const open = quant.pickTick(fresh, { primary: 'plus500', allowedVenues: null });
  assert.equal(open.mid, 4312.9);
  assert.equal(open.substituted, true, 'off = the pre-existing behaviour, unchanged');
  assert.equal(open.comparability.gated, false);

  const shut = quant.pickTick(fresh, { primary: 'plus500', allowedVenues: [] });
  assert.equal(shut.mid, null, 'a fresh usable substitute the gate refuses must NOT be used');
  assert.match(shut.reason, /admits no substitute/);
  assert.equal(shut.comparability.refusedUsable, 1);

  const allowed = quant.pickTick(fresh, { primary: 'plus500', allowedVenues: ['yahoo'] });
  assert.equal(allowed.mid, 4312.9);
  assert.equal(allowed.substituted, true);
});

test('C3: end to end — Gold\'s measured verdict refuses the substitute the old rule would have used', async () => {
  va.clearCache();
  const noisyYahoo = series((i) => 100 + (i % 2 ? 0.2 : -0.2));
  const store = fakeStore({
    coverage: [{ symbol: 'Gold', venue: 'yahoo', timeframe: '1h', bars: N }],
    bars: { 'Gold|plus500': flat(100), 'Gold|yahoo': noisyYahoo },
  });
  const r = await va.resolve(18, 'Gold', { venueComparability: { enabled: true } }, { store });
  assert.equal(r.roundTripBps, 11.94);
  assert.deepEqual(r.allowed, []);
  const picked = quant.pickTick([tick('yahoo', noisyYahoo[0].closePrice)], { primary: 'plus500', allowedVenues: r.allowed });
  assert.equal(picked.mid, null, 'yahoo is a different instrument for Gold — the desk must not trade its price');
  assert.equal(picked.comparability.gated, true);
});
