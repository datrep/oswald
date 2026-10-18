// Pins for the strategy-scope resolution (2026-09-11 scope-leak fix):
// the Sany-Heavy-Equipment/survoil incident — a symbol with NO scope entry
// inherited the global enabled list, so the frozen Oil survivor evaluated an
// equity. Fix = DEFAULT key ('others'/'*') + track-bound strategies.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scopedStrategyIds, symbolEligible } = require('../trading/agent/quant');

// fake registry: survGold/survoil are track-bound; turtle is not.
const reg = new Map([
  ['survgold', { liveSignal: () => {}, symbols: ['Gold'] }],
  ['survoil', { liveSignal: () => {}, symbols: ['Oil'] }],
  ['turtle', { liveSignal: () => {} }],
]);
const GLOBAL = ['survgold', 'survoil'];

test('explicit scope entry wins over the global list', () => {
  assert.deepEqual(scopedStrategyIds(GLOBAL, { Oil: ['survoil'] }, 'Oil', reg), ['survoil']);
});

test('legacy config with no default: track-bound filter still protects other symbols', () => {
  const scope = { Gold: ['survgold'] };
  assert.deepEqual(scopedStrategyIds(GLOBAL, scope, 'Sany Heavy Equipment', reg), []);
  assert.deepEqual(scopedStrategyIds(['turtle'], scope, 'Sany Heavy Equipment', reg), ['turtle']);
});

test("default key 'others' applies to unlisted symbols", () => {
  const scope = { Gold: ['survgold'], Oil: ['survoil'], others: [] };
  assert.deepEqual(scopedStrategyIds(GLOBAL, scope, 'Sany Heavy Equipment', reg), []);
  assert.deepEqual(scopedStrategyIds(GLOBAL, scope, 'Gold', reg), ['survgold']);
});

test("'*' works as a default key too", () => {
  assert.deepEqual(scopedStrategyIds(GLOBAL, { '*': ['turtle'] }, 'Sany Heavy Equipment', reg), ['turtle']);
});

test('an explicit empty entry means no strategies', () => {
  assert.deepEqual(scopedStrategyIds(GLOBAL, { Silver: [], others: ['turtle'] }, 'Silver', reg), []);
});

test('track-bound strategies never run outside their instrument', () => {
  assert.equal(symbolEligible('survoil', 'Sany Heavy Equipment', reg), false);
  assert.equal(symbolEligible('survoil', 'Oil', reg), true);
  assert.equal(symbolEligible('survgold', 'Oil', reg), false);
});

test('unknown / non-live strategies are dropped', () => {
  const r = new Map([['ghost', {}]]);
  assert.deepEqual(scopedStrategyIds(['ghost', 'turtle'], { others: [] }, 'Oil', r), []);
});

test('the REAL registry marks survgold/survoil as track-bound', () => {
  const strategies = require('../trading/agent/strategies');
  assert.deepEqual(strategies.get('survgold').symbols, ['Gold']);
  assert.deepEqual(strategies.get('survoil').symbols, ['Oil']);
});
