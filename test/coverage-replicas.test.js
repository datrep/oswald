// test/coverage-replicas.test.js — 2026-09-25: the two PROVEN survivor sets reproduced per instrument.
//
// ⚠ 2026-09-30: the instrument list grew from five to eight (Ethereum, Soybeans, Natural Gas). The pins below
// were UPGRADED rather than restored, because they pin the CONSEQUENCE of `survReplicas.INSTRUMENTS` — and the
// work of adding an instrument is meant to be exactly that one line, so a test that could pass while the
// declaration moved would be pinning nothing.
//
// WHY THIS EXISTS AND WHY IT REPLACED AN EARLIER FILE. The first version of this work picked one cell per
// symbol out of a 4-cell grid (dc{5,20} x gate{0,20}) measured on a 1-year window of current bars. The owner
// ruled that basis out — the measurements predate the current policy set — and the only two strategies with a
// live record are `survgold` and `survoil`. So the replicas do not DERIVE anything: they REPRODUCE those two.
//
// ★ THE PIN THAT MATTERS IS IDENTITY, NOT SHAPE. A replica that restated its survivor's numbers as literals
// would become a DIFFERENT strategy the moment the survivor was re-frozen, and nothing would notice — the
// replica would keep running "survivor A's set" while no longer being survivor A's set. So `survReplicas.js`
// imports the survivors' `DEFAULTS` by reference and this file asserts the result is equal by VALUE and
// distinct by OBJECT (a copy, so a replica can never re-tune the survivor it copies).
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const replicas = require('../trading/agent/strategies/survReplicas');
const strategies = require('../trading/agent/strategies');
const scopeResolution = require('../trading/scopeResolution');
const survGold = require('../trading/agent/strategies/survGold');
const survOil = require('../trading/agent/strategies/survOil');

const EXPECTED = [
  'survasilver', 'survasugar', 'survabitcoin', 'survasgx', 'survaarabicacoffee',
  'survcsilver', 'survcsugar', 'survcbitcoin', 'survcsgx', 'survcarabicacoffee',
  // 2026-09-30: the three instruments added to the watchlist that morning. UPGRADED, not restored — the list is
  // the declaration's consequence, so it moves when the declaration does.
  'survaethereum', 'survcethereum', 'survasoybeans', 'survcsoybeans',
  'survanaturalgas', 'survcnaturalgas',
];
const SOURCE_OF = { survgold: survGold, survoil: survOil };

test('★ every replica carries its survivor\'s frozen set exactly — by value, not by reference', () => {
  for (const m of replicas.MODULES) {
    const src = SOURCE_OF[m.replicates];
    assert.ok(src, `${m.id} names an unknown source strategy: ${m.replicates}`);
    assert.deepEqual(m.DEFAULTS, src.DEFAULTS,
      `${m.id} must carry ${m.replicates}'s frozen set EXACTLY — a replica that drifts is a different strategy`);
    // A spread copy, so the replica can never mutate the survivor it copies. If these were the same object, a
    // future `Object.assign` on a replica would silently re-tune a live survivor.
    assert.notEqual(m.DEFAULTS, src.DEFAULTS, `${m.id} must own a COPY of the set`);
  }
});

test('★★ NON-VACUITY: the two proven sets actually DIFFER, so "replicates X" is a discriminating claim', () => {
  // Without this, both letters could be carrying the same set and every assertion above would still pass.
  assert.notDeepEqual(survGold.DEFAULTS, survOil.DEFAULTS, 'the two survivors must have different frozen sets');
  assert.equal(survGold.DEFAULTS.donchianPeriod, 20, 'survivor A is the dc20 window');
  assert.equal(survGold.DEFAULTS.adxGate, 0, 'survivor A has the ADX gate OFF');
  assert.equal(survOil.DEFAULTS.donchianPeriod, 5, 'survivor C is the dc5 window');
  assert.equal(survOil.DEFAULTS.adxGate, 20, 'survivor C has the gate ON');
  // And the axis each replica claims to follow is the one that differs.
  for (const m of replicas.MODULES) {
    const src = SOURCE_OF[m.replicates];
    assert.equal(m.DEFAULTS.donchianPeriod, src.DEFAULTS.donchianPeriod, `${m.id} window`);
    assert.equal(m.DEFAULTS.adxGate, src.DEFAULTS.adxGate, `${m.id} gate`);
  }
});

test('there are exactly sixteen — two sets across eight instruments — and the superseded family is GONE', () => {
  assert.deepEqual(replicas.MODULES.map((m) => m.id).sort(), EXPECTED.slice().sort());
  assert.equal(replicas.MODULES.length, 16);
  assert.deepEqual(replicas.SCOPE.map((s) => s.symbol).sort(),
    ['Arabica Coffee', 'Bitcoin', 'Ethereum', 'Natural Gas', 'SGX', 'Silver', 'Soybeans', 'Sugar']);
  for (const s of replicas.SCOPE) assert.equal(s.ids.length, 2, `${s.symbol} must carry BOTH survivor sets`);
  // ★ The replaced ids must not linger. A scope entry naming a removed strategy resolves to nothing, so the
  // symbol would look configured while being unable to enter — the exact invisible-guard shape this desk keeps
  // finding. Asserted through the registry, which is what the resolver consults.
  for (const dead of ['survsilver', 'survsugar', 'survbitcoin', 'survsgx']) {
    assert.equal(strategies.get(dead), null, `${dead} must be REMOVED — the replicas replaced it`);
  }
});

test('every replica is TRACK-BOUND, proven through the real resolver', () => {
  for (const m of replicas.MODULES) {
    const symbol = m.symbols[0];
    assert.deepEqual(m.symbols, [symbol], `${m.id} must be bound to exactly one instrument`);
    assert.equal(scopeResolution.applicableOn(m.id, symbol), true, `${m.id} must be applicable on its own symbol`);
    // The property under test is that a replica cannot leak onto another instrument — otherwise all ten
    // would be applicable everywhere and Gold's window would be applied to Sugar by a scope typo.
    for (const other of replicas.INSTRUMENTS.filter((s) => s !== symbol)) {
      assert.equal(scopeResolution.applicableOn(m.id, other), false, `${m.id} must NOT be applicable on ${other}`);
    }
  }
});

test('the replicas are frozen and carry the survivors\' interface', () => {
  for (const m of replicas.MODULES) {
    assert.deepEqual(m.params, [], `${m.id} must expose NO editable parameters (frozen by design)`);
    assert.equal(typeof m.liveSignal, 'function', `${m.id} needs liveSignal or it can never signal`);
    assert.equal(typeof m.backtest, 'function', `${m.id} needs backtest`);
    assert.ok(m.description.includes(m.replicates === 'survgold' ? 'survivor A' : 'survivor C'),
      `${m.id}'s description — the field list() renders — must name the survivor it reproduces`);
  }
});

test('the survivors themselves are untouched: still one instrument each, still the sets being copied', () => {
  for (const [id, symbol] of [['survgold', 'Gold'], ['survoil', 'Oil']]) {
    const m = strategies.get(id);
    assert.deepEqual(m.symbols, [symbol], `${id} must still be bound to ${symbol}`);
    assert.deepEqual(m.params, [], `${id} must still be frozen — the replicas copy it, they do not retune it`);
    // The forward track that made these the survivors depends on the set not moving.
    assert.deepEqual(m.DEFAULTS, SOURCE_OF[id].DEFAULTS, `${id}'s frozen set must not have moved`);
  }
});
