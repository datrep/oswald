// test/strategy-param-resolution.test.js — TRD-TUN-2 (#1393), fixed 2026-09-28.
//
// THE DEFECT. `strategies.list()` resolved params INLINE — `overrides[s.id][p.key] ?? p.def` over
// `settings.strategies.params` — while the trading path resolved DEFAULTS -> params[id] -> symbolParams via
// `paramsFor`. TWO implementations of one documented order, and the tuner and the Strategy tab read the one
// that cannot see the per-symbol layer. Measured live before the fix: `Gold.turtle.adxGate` displayed as 20
// while `paramsFor` returned 0, and `Oil.turtle.donchianPeriod` as 20 while `paramsFor` returned 5.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const strategies = require('../trading/agent/strategies');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// A settings shape that reproduces the live divergence exactly (both cases were measured on userId 1).
const S = {
  strategies: {
    enabled: ['turtle'],
    params: { turtle: { donchianPeriod: 20, adxGate: 20 } },
    symbolParams: {
      Gold: { turtle: { adxGate: 0 } },
      Oil: { turtle: { donchianPeriod: 5 } },
    },
  },
};
const valueOf = (listOut, id, key) => {
  const s = listOut.find((x) => x.id === id);
  assert.ok(s, `strategy ${id} must be listed`);
  const p = s.params.find((x) => x.key === key);
  assert.ok(p, `param ${id}.${key} must be listed`);
  return p;
};

test('★ the two resolvers AGREE — this is the invariant the row asks for', () => {
  // For every strategy, every param, and every symbol the desk can name, `list()` must report the SAME value
  // `paramsFor()` gives the trading path. Before the fix this failed in 2 places.
  const symbols = [null, 'Gold', 'Oil', 'Bitcoin', 'Sugar', 'Arabica Coffee'];
  let checked = 0;
  for (const s of Object.values(strategies.REGISTRY)) {
    for (const sym of symbols) {
      const eff = strategies.paramsFor(S, s.id, sym);
      const out = strategies.list(S, sym);
      for (const p of s.params) {
        const want = eff[p.key] != null ? eff[p.key] : p.def;
        const got = valueOf(out, s.id, p.key).value;
        assert.equal(got, want,
          `${s.id}.${p.key} on ${sym === null ? '(no symbol)' : sym}: list() says ${JSON.stringify(got)}, paramsFor() says ${JSON.stringify(want)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0, 'the registry must expose at least one parameter to check');
});

test('reproduces the two divergences measured live, and now resolves BOTH ways', () => {
  // Gold: the symbol layer turns the ADX gate OFF against a global 20.
  assert.equal(valueOf(strategies.list(S), 'turtle', 'adxGate').value, 20, 'no symbol -> the global layer');
  assert.equal(valueOf(strategies.list(S), 'turtle', 'adxGate').source, 'params');
  assert.equal(valueOf(strategies.list(S, 'Gold'), 'turtle', 'adxGate').value, 0, 'Gold -> the symbol layer');
  assert.equal(valueOf(strategies.list(S, 'Gold'), 'turtle', 'adxGate').source, 'symbolParams');
  // Oil: the symbol layer changes the breakout window from 20 to 5.
  assert.equal(valueOf(strategies.list(S), 'turtle', 'donchianPeriod').value, 20);
  assert.equal(valueOf(strategies.list(S, 'Oil'), 'turtle', 'donchianPeriod').value, 5);
  assert.equal(valueOf(strategies.list(S, 'Oil'), 'turtle', 'donchianPeriod').source, 'symbolParams');
});

test('★ a per-symbol value of 0 or false is a VALUE, not an absence', () => {
  // `adxGate: 0` is the entire point of the Gold override, and `if (!v)` would walk straight past it to the
  // global 20 — reintroducing the defect in the opposite direction. The resolver must test `!= null`.
  assert.equal(strategies.paramSource(S, 'turtle', 'adxGate', 'Gold'), 'symbolParams');
  assert.equal(valueOf(strategies.list(S, 'Gold'), 'turtle', 'adxGate').value, 0);
  const F = { strategies: { params: { turtle: { adxGate: 20 } }, symbolParams: { Gold: { turtle: { adxGate: false } } } } };
  assert.equal(strategies.paramSource(F, 'turtle', 'adxGate', 'Gold'), 'symbolParams');
  assert.equal(valueOf(strategies.list(F, 'Gold'), 'turtle', 'adxGate').value, false);
});

test('the layer that supplied a value is named, in strict order', () => {
  assert.equal(strategies.paramSource(S, 'turtle', 'adxGate', 'Gold'), 'symbolParams', 'symbol beats global');
  assert.equal(strategies.paramSource(S, 'turtle', 'adxGate', null), 'params', 'global beats DEFAULTS');
  assert.equal(strategies.paramSource(S, 'turtle', 'adxGate', 'Sugar'), 'params', 'a symbol with no entry falls to global');
  // a key present in NO settings layer falls through to the module
  const src = strategies.paramSource(S, 'turtle', 'aKeyNothingSets', 'Gold');
  assert.ok(['DEFAULTS', 'module-default'].includes(src), `unexpected source ${src}`);
  // and an unknown strategy is not a crash
  assert.equal(strategies.paramSource(S, 'nope', 'k', 'Gold'), 'module-default');
});

test('list() without a symbol is UNCHANGED — existing callers must not shift under them', () => {
  // `symbol` defaults to null, and null must reproduce the previous global-layer behaviour exactly.
  const noSym = strategies.list(S);
  const explicitNull = strategies.list(S, null);
  assert.deepEqual(noSym.map((s) => [s.id, s.enabled]), explicitNull.map((s) => [s.id, s.enabled]));
  assert.equal(strategies.list(S).length, Object.keys(strategies.REGISTRY).length);
  assert.equal(strategies.list(undefined).length, Object.keys(strategies.REGISTRY).length, 'undefined settings must not throw');
});

test('★ the inline resolver is GONE — one implementation, not two', () => {
  const src = code('trading/agent/strategies/index.js');
  assert.doesNotMatch(src, /overrides\[s\.id\]/, 'the inline `overrides[s.id]` resolution must not come back');
  assert.match(src, /function list\(settings, symbol = null\)/, 'list must accept the symbol');
  // The delegation lives in a helper rather than inline in the map, so that the map stays a readable object
  // literal — the claim that matters is that the helper calls the ONE resolver, not where it sits.
  assert.match(src, /value: resolveParam\(settings, s\.id, p\.key, symbol, p\.def\)/, 'list must delegate');
  assert.match(src, /function resolveParam\([\s\S]{0,160}const eff = paramsFor\(settings, id, symbol\)/,
    'resolveParam must call paramsFor — the single resolver');
  assert.match(src, /source: paramSource\(settings, s\.id, p\.key, symbol\)/, 'provenance must be reported');
  // the provenance helper must be exported, or a UI reader cannot ask which layer won
  assert.match(src, /REGISTRY, get, list, paramsFor, paramSource,/, 'paramSource must be exported');
});

test('paramsFor itself is unchanged — the fix moved the READER, not the trading path', () => {
  // `turtle` carries module DEFAULTS, so the resolved object has MORE keys than the settings layers name.
  // Assert the keys this test is about rather than the whole object — 
  assert.equal(strategies.paramsFor(S, 'turtle', 'Gold').adxGate, 0, 'Gold: symbol layer wins');
  assert.equal(strategies.paramsFor(S, 'turtle', 'Gold').donchianPeriod, 20, 'Gold: unset key falls to global');
  assert.equal(strategies.paramsFor(S, 'turtle', 'Oil').donchianPeriod, 5, 'Oil: symbol layer wins');
  assert.equal(strategies.paramsFor(S, 'turtle', 'Oil').adxGate, 20, 'Oil: unset key falls to global');
  assert.equal(strategies.paramsFor(S, 'turtle', null).adxGate, 20, 'no symbol: global layer');
  assert.deepEqual(strategies.paramsFor(S, 'nope', 'Gold'), {}, 'an unknown strategy resolves to nothing, not to a throw');
  // and the precedence order is DEFAULTS < global < symbolParams
  const dflt = strategies.paramsFor(S, 'turtle', 'NowhereAtAll');
  assert.equal(dflt.donchianPeriod, 20, 'a symbol with no entry falls back to global');
});
