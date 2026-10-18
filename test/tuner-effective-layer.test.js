// test/tuner-effective-layer.test.js — TRD-TUN-2, second half:
//   "a caller that WRITES the global layer must not write where the per-symbol layer shadows it."
//
// The first half made the resolution single. This is the half that stops the WRITE being meaningless: the
// tuner writes `strategies.params.<id>`, and when a strategy runs on symbols carrying a `symbolParams` entry
// the per-symbol layer wins — so the change would be recorded, displayed and ignored.
//
// The helpers are pure and take the symbol universe as an ARGUMENT (requiring scopeResolution from
// strategies/index.js would be a cycle, since it lazily requires strategies).
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strategies = require('../trading/agent/strategies');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ---------------------------------------------------------------------------------------------
// scopedSymbols — TRD-91's replacement rule
// ---------------------------------------------------------------------------------------------

test('an explicit symbolScope entry REPLACES the global enabled list for that symbol', () => {
  const settings = { strategies: { enabled: ['turtle'], symbolScope: { Gold: ['rsi2'] } } };
  const got = strategies.scopedSymbols(settings, 'turtle', ['Gold', 'Oil']);
  // Gold names rsi2 explicitly, so turtle is NOT reachable there even though `enabled` lists it.
  assert.deepEqual(got, ['Oil'], 'Gold must be excluded: its own entry replaces the global list');
  assert.deepEqual(strategies.scopedSymbols(settings, 'rsi2', ['Gold', 'Oil']), ['Gold']);
});

test('a symbol with NO entry falls back to the global enabled list', () => {
  const settings = { strategies: { enabled: ['turtle'], symbolScope: {} } };
  assert.deepEqual(strategies.scopedSymbols(settings, 'turtle', ['Gold', 'Oil']), ['Gold', 'Oil']);
  // an EMPTY entry is still an explicit entry — it names nothing, so it reaches nothing
  const empty = { strategies: { enabled: ['turtle'], symbolScope: { Oil: [] } } };
  assert.deepEqual(strategies.scopedSymbols(empty, 'turtle', ['Gold', 'Oil']), ['Gold']);
});

test('scopedSymbols is defensive about missing settings and an absent universe', () => {
  assert.deepEqual(strategies.scopedSymbols(null, 'turtle', ['Gold']), []);
  assert.deepEqual(strategies.scopedSymbols({}, 'turtle', []), []);
  assert.deepEqual(strategies.scopedSymbols({ strategies: {} }, 'turtle', null), []);
});

// ---------------------------------------------------------------------------------------------
// paramDivergence — the question the tuner must ask
// ---------------------------------------------------------------------------------------------

test('one symbol cannot diverge from itself, so fewer than two symbols is always []', () => {
  const settings = { strategies: { params: {}, symbolParams: { Gold: { turtle: { adxGate: 0 } } } } };
  assert.deepEqual(strategies.paramDivergence(settings, 'turtle', ['Gold']), []);
  assert.deepEqual(strategies.paramDivergence(settings, 'turtle', []), []);
  assert.deepEqual(strategies.paramDivergence(settings, 'turtle'), []);
});

test('★ a per-symbol override makes the strategy DIVERGENT across the symbols it runs on', () => {
  // The live shape this exists for: Gold carries a `symbolParams` entry, so the global layer cannot express
  // the strategy's configuration and a global write is shadowed on Gold.
  const settings = {
    strategies: { params: {}, symbolParams: { Gold: { turtle: { adxGate: 0 } } } },
  };
  const div = strategies.paramDivergence(settings, 'turtle', ['Gold', 'Oil']);
  assert.ok(div.length >= 1, 'the override must register as a divergence');
  const gate = div.find((d) => d.key === 'adxGate');
  assert.ok(gate, 'adxGate must be the divergent key');
  const bySym = Object.fromEntries(gate.values.map((v) => [v.symbol, v.value]));
  assert.equal(bySym.Gold, 0, 'Gold resolves the override');
  assert.ok(bySym.Oil !== 0, 'Oil resolves something else');
});

test('★★ 0 and false are VALUES, so an override to 0 must not read as absent', () => {
  // `adxGate: 0` IS the whole point of the Gold override — the ADX filter turned OFF. A resolver that tested
  // truthiness would walk past it to the default and report NO divergence, which is the coercion bug class
  // this desk keeps re-finding.
  const settings = { strategies: { symbolParams: { Gold: { turtle: { adxGate: 0 } } } } };
  const div = strategies.paramDivergence(settings, 'turtle', ['Gold', 'Oil']);
  assert.ok(div.some((d) => d.key === 'adxGate'), 'an override to 0 must still be a divergence');
});

test('identical resolution across symbols is NOT a divergence (no false alarm)', () => {
  const settings = { strategies: { params: {}, symbolParams: { Gold: { turtle: { adxGate: 0 } }, Oil: { turtle: { adxGate: 0 } } } } };
  assert.deepEqual(strategies.paramDivergence(settings, 'turtle', ['Gold', 'Oil']), [],
    'both symbols resolve the same value, so a global write is NOT shadowed');
});

test('a FROZEN strategy cannot diverge — it exposes no params to tune', () => {
  // survgold spreads its own DEFAULTS inside liveSignal, so overrides are a no-op by design (rule-L). The
  // tuner therefore must not exclude it on these grounds; it has nothing to propose against.
  const settings = { strategies: { symbolParams: { Gold: { survgold: { adxGate: 0 } } } } };
  assert.deepEqual(strategies.paramDivergence(settings, 'survgold', ['Gold', 'Oil']), []);
});

test('an unknown strategy id yields no divergence rather than throwing', () => {
  assert.deepEqual(strategies.paramDivergence({}, 'no-such-strategy', ['Gold', 'Oil']), []);
});

// ---------------------------------------------------------------------------------------------
// The tuner wiring — structural
// ---------------------------------------------------------------------------------------------

test('the tuner EXCLUDES shadowed strategies instead of warning about them', () => {
  const src = code('trading/agent/tuner.js');
  assert.match(src, /strategies\.scopedSymbols\(settings, s\.id, watchlist\)/, 'it must ask which symbols the strategy runs on');
  assert.match(src, /strategies\.paramDivergence\(settings, s\.id, symbols\)/, 'and whether they diverge');
  // Escalate from warning to exclusion: a warning beside a written value is not enough — binding.js already
  // warns for the inert case and the row records that the state remained creatable.
  assert.match(src, /const registry = registryAll\.filter\(/, 'the registry must be FILTERED, not annotated');
  assert.match(src, /shadowedStrategies\.push\(/, 'the exclusion must be collected for the record');
});

test('the exclusion is RECORDED, so it is not silently absent from the prompt', () => {
  const src = code('trading/agent/tuner.js');
  const n = (src.match(/shadowedStrategies: shadowedStrategies\.length/g) || []).length;
  assert.ok(n >= 2, `the exclusion must travel on every tune payload (found ${n} of 2)`);
});

test('the helpers are pure — they take the symbol universe rather than requiring scopeResolution', () => {
  const src = code('trading/agent/strategies/index.js');
  const start = src.indexOf('function scopedSymbols');
  const end = src.indexOf('module.exports');
  assert.ok(start > -1 && end > start);
  const slice = src.slice(start, end);
  // A require of scopeResolution here would be a CYCLE: it lazily requires this module.
  assert.doesNotMatch(slice, /require\(/, 'the helpers must require nothing');
  assert.match(src, /scopedSymbols, paramDivergence,/, 'both must be exported');
});
