'use strict';
// TRD-75 — the instrument <-> (strategy, params) binding, per instrument.
//
// The registry is INJECTED rather than required, because trading/agent/strategies/index.js ->
// congress.js -> store.js opens a DB pool at require time. That injection is also what lets these
// tests use the two frozen survivors' real param sets as fixtures, since those are the whole argument
// for the per-symbol axis existing.
const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const binding = require('../trading/agent/binding');

// The real shapes: turtle is tunable, the survivors are FROZEN (params: []) and track-bound.
const registry = {
  get(id) {
    const r = {
      turtle: {
        id: 'turtle', name: 'Turtle Ultimate', liveSignal() {},
        DEFAULTS: { donchianPeriod: 20, adxGate: 20 },
        params: [
          { key: 'donchianPeriod', def: 20, min: 5, max: 100 },
          { key: 'adxGate', def: 20, min: 0, max: 60 },
        ],
      },
      survgold: {
        id: 'survgold', name: 'Turtle - Gold survivor (frozen)', liveSignal() {}, symbols: ['Gold'],
        DEFAULTS: { donchianPeriod: 20, adxGate: 0 }, params: [],
      },
      survoil: {
        id: 'survoil', name: 'Turtle - Oil survivor C (frozen)', liveSignal() {}, symbols: ['Oil'],
        DEFAULTS: { donchianPeriod: 5, adxGate: 20 }, params: [],
      },
    };
    return r[id] || null;
  },
};

const SYMBOLS = ['Gold', 'Oil', 'Silver'];
const settings = (o = {}) => ({ strategies: { enabled: ['survgold', 'survoil', 'turtle'], symbolScope: { Gold: ['survgold', 'turtle'], Oil: ['survoil', 'turtle'] }, ...o } });

// --- resolution order -------------------------------------------------------

test('TRD-75: a per-symbol override beats the global one, and says so', () => {
  const s = settings({ params: { turtle: { donchianPeriod: 40 } }, symbolParams: { Gold: { turtle: { donchianPeriod: 60 } } } });
  const b = binding.resolveBinding(s, 'Gold', 'turtle', registry);
  assert.equal(b.params.donchianPeriod.value, 60);
  assert.equal(b.params.donchianPeriod.source, 'symbol');
  assert.equal(b.params.adxGate.value, 20);
  assert.equal(b.params.adxGate.source, 'default');
  assert.equal(b.overriddenHere, true);
});

test('TRD-75: the global override beats the default', () => {
  const s = settings({ params: { turtle: { adxGate: 30 } } });
  const b = binding.resolveBinding(s, 'Gold', 'turtle', registry);
  assert.equal(b.params.adxGate.value, 30);
  assert.equal(b.params.adxGate.source, 'global');
  assert.equal(b.overriddenHere, false);
});

test('TRD-75: with no overrides everything resolves to the module defaults', () => {
  const b = binding.resolveBinding(settings(), 'Gold', 'turtle', registry);
  assert.equal(b.params.donchianPeriod.value, 20);
  assert.equal(b.params.donchianPeriod.source, 'default');
});

test('TRD-75: THE POINT - one strategy, two instruments, two param sets', () => {
  // This is the config the survivors' own parameters describe, and which was INEXPRESSIBLE before:
  // params resolved by strategy id only, so `turtle` on Gold and Oil forced ONE set on both.
  const s = settings({ symbolParams: {
    Gold: { turtle: { donchianPeriod: 20, adxGate: 0 } },
    Oil: { turtle: { donchianPeriod: 5, adxGate: 20 } },
  } });
  const gold = binding.resolveBinding(s, 'Gold', 'turtle', registry);
  const oil = binding.resolveBinding(s, 'Oil', 'turtle', registry);
  assert.deepEqual(gold.tuned, { donchianPeriod: 20, adxGate: 0 });
  assert.deepEqual(oil.tuned, { donchianPeriod: 5, adxGate: 20 });
  assert.notDeepEqual(gold.tuned, oil.tuned, 'the binding must be able to differ per instrument');
  assert.equal(gold.params.adxGate.source, 'symbol');
  assert.equal(oil.params.adxGate.source, 'symbol');
});

test('TRD-75: an inherited global is still visible as inherited, per symbol', () => {
  const s = settings({ params: { turtle: { adxGate: 25 } }, symbolParams: { Gold: { turtle: { donchianPeriod: 30 } } } });
  const g = binding.resolveBinding(s, 'Gold', 'turtle', registry);
  const o = binding.resolveBinding(s, 'Oil', 'turtle', registry);
  assert.equal(g.params.adxGate.source, 'global', 'not overridden here, but still inherited');
  assert.equal(o.params.adxGate.source, 'global');
  assert.equal(o.params.donchianPeriod.source, 'default');
});

// --- scope provenance -------------------------------------------------------

test('TRD-75: scope source distinguishes explicit, default-key and global-list', () => {
  const s = settings({
    enabled: ['survgold', 'survoil', 'turtle'],
    symbolScope: { Gold: ['survgold', 'turtle'], others: ['turtle'] },
  });
  assert.equal(binding.inScopeIds(s, 'Gold', registry).source, 'explicit');
  assert.equal(binding.inScopeIds(s, 'Silver', registry).source, 'default_key');
  assert.deepEqual(binding.inScopeIds(s, 'Silver', registry).ids, ['turtle']);
  const noDefault = settings({ symbolScope: {} });
  assert.equal(binding.inScopeIds(noDefault, 'Silver', registry).source, 'global_list');
});

test('TRD-75: track-bound survivors are filtered out of the wrong symbol', () => {
  const s = settings({ symbolScope: { Gold: ['survgold', 'survoil'] } });
  assert.deepEqual(binding.inScopeIds(s, 'Gold', registry).ids, ['survgold'], 'survoil is bound to Oil');
  assert.deepEqual(binding.inScopeIds(s, 'Gold', registry).raw, ['survgold', 'survoil'], 'the configured list is still reported');
});

// --- validate: the silent no-ops -------------------------------------------

test('TRD-75: a per-symbol override aimed at a FROZEN strategy is an ERROR, not a shrug', () => {
  // rule-L: retuning a survivor voids the candidate, so liveSignal spreads its own DEFAULTS and the
  // override does nothing. A tuning UI that accepted it would be lying to its operator.
  const s = settings({ symbolParams: { Gold: { survgold: { donchianPeriod: 5 } } } });
  const problems = binding.validate(s, { symbols: SYMBOLS, registry });
  const hit = problems.find((p) => p.strategy === 'survgold' && /FROZEN/.test(p.reason));
  assert.ok(hit, `expected a FROZEN error, got ${JSON.stringify(problems)}`);
  assert.equal(hit.level, 'error');
});

test('TRD-75: a strategy outside `enabled` warns ONLY when no symbol scope names it', () => {
  // ★ CORRECTED 2026-09-15. This warning used to fire whenever the strategy was not in
  // `strategies.enabled`, and it called the values "inert". That is wrong for a symbol whose own
  // symbolScope names the strategy: an explicit scope entry REPLACES the global enabled list for that
  // symbol (inScopeIds, mirrored by quant.scopedStrategyIds), so the override is LIVE. The old test only
  // passed because it never asked whether the pairing was reachable.
  //
  // It matters beyond tidiness: the binding reviewer reads these warnings and reasons about them, and the
  // live Gold proposal of 2026-09-15 quoted this exact sentence. A warning about a configuration that is
  // running is worse than no warning, because it argues against the correct action.

  // (a) REACHABLE - Gold's own scope lists turtle, so the override applies and there is nothing inert.
  const reachable = settings({ enabled: ['survgold', 'survoil'], symbolParams: { Gold: { turtle: { adxGate: 0 } } } });
  assert.equal(
    binding.validate(reachable, { symbols: SYMBOLS, registry }).some((p) => p.strategy === 'turtle'),
    false,
    'a scope entry replaces `enabled` for that symbol, so this pairing runs',
  );

  // (b) GENUINELY INERT - Silver has no scope entry here, so it inherits the global list, which does not
  // name turtle.
  const inert = settings({ symbolScope: { Gold: ['survgold'] }, enabled: ['survgold', 'survoil'], symbolParams: { Silver: { turtle: { adxGate: 0 } } } });
  const problems = binding.validate(inert, { symbols: SYMBOLS, registry });
  const hit = problems.find((p) => p.strategy === 'turtle' && /neither in strategies.enabled/.test(p.reason));
  assert.ok(hit, `expected the inert warning, got ${JSON.stringify(problems)}`);
  assert.equal(hit.level, 'warn');
});

test('TRD-75: a binding on a track-bound strategy for the wrong symbol is an ERROR', () => {
  const s = settings({ symbolParams: { Gold: { survoil: { adxGate: 20 } } } });
  const hit = binding.validate(s, { symbols: SYMBOLS, registry }).find((p) => /track-bound/.test(p.reason));
  assert.ok(hit, `expected a track-bound error, got ${JSON.stringify(binding.validate(s, { symbols: SYMBOLS, registry }))}`);
});

test('TRD-75: unknown parameter keys, non-numeric values and out-of-range values are all caught', () => {
  const s = settings({ symbolParams: { Gold: { turtle: { nonsense: 1, adxGate: 'abc' } }, Oil: { turtle: { donchianPeriod: 1, adxGate: 99 } } } });
  const problems = binding.validate(s, { symbols: SYMBOLS, registry });
  assert.ok(problems.some((p) => /unknown parameter "nonsense"/.test(p.reason)));
  assert.ok(problems.some((p) => /is not a number/.test(p.reason)));
  assert.ok(problems.some((p) => /below min 5/.test(p.reason)));
  assert.ok(problems.some((p) => /above max 60/.test(p.reason)));
});

test('TRD-75: unknown strategies and off-watchlist symbols are reported', () => {
  const s = settings({ symbolParams: { Platinum: { turtle: { adxGate: 0 } }, Gold: { wat: { x: 1 } } }, symbolScope: { Nope: ['turtle'] } });
  const problems = binding.validate(s, { symbols: SYMBOLS, registry });
  assert.ok(problems.some((p) => /not on the watchlist/.test(p.reason) && p.symbol === 'Platinum'));
  assert.ok(problems.some((p) => /unknown strategy "wat"/.test(p.reason)));
  assert.ok(problems.some((p) => p.symbol === 'Nope'));
});

test('TRD-75: a clean config validates clean, and the table describes it', () => {
  const s = settings({ symbolParams: {
    Gold: { turtle: { donchianPeriod: 20, adxGate: 0 } },
    Oil: { turtle: { donchianPeriod: 5, adxGate: 20 } },
  } });
  assert.deepEqual(binding.validate(s, { symbols: SYMBOLS, registry }), []);
  const t = binding.bindingTable(s, { symbols: SYMBOLS, registry });
  assert.deepEqual(t.perSymbolParamsPresent, ['Gold', 'Oil']);
  const gold = t.symbols.find((x) => x.symbol === 'Gold');
  assert.deepEqual(gold.strategies.map((x) => x.strategy), ['survgold', 'turtle']);
  assert.equal(gold.strategies.find((x) => x.strategy === 'survgold').tunable, false, 'the frozen survivor is not tunable');
  assert.equal(gold.strategies.find((x) => x.strategy === 'turtle').tunable, true);
  const silver = t.symbols.find((x) => x.symbol === 'Silver');
  assert.equal(silver.scopeSource, 'global_list', 'no explicit entry and no default key -> the global list applies');
  assert.deepEqual(silver.strategies.map((x) => x.strategy), ['turtle'], 'and so Silver inherits it');

  // The LIVE config carries `others: []`, which is the Sany/survoil scope-leak fix: an unlisted symbol
  // must get NOTHING rather than silently inheriting the global list (which held the survivors).
  const withDefault = binding.bindingTable(
    settings({ symbolScope: { Gold: ['survgold', 'turtle'], Oil: ['survoil', 'turtle'], others: [] } }),
    { symbols: SYMBOLS, registry },
  );
  const silver2 = withDefault.symbols.find((x) => x.symbol === 'Silver');
  assert.equal(silver2.scopeSource, 'default_key');
  assert.deepEqual(silver2.strategies, [], 'with others: [] an unlisted symbol binds nothing at all');
});

test('TRD-75: validate does not mutate the settings it inspects', () => {
  const s = settings({ symbolParams: { Gold: { turtle: { adxGate: 0 } } } });
  const before = JSON.stringify(s);
  binding.validate(s, { symbols: SYMBOLS, registry });
  binding.bindingTable(s, { symbols: SYMBOLS, registry });
  assert.equal(JSON.stringify(s), before);
});

// --- the wiring, which is what makes the axis real --------------------------

test('TRD-75: quant resolves params WITH the symbol (without this the new axis is inert)', () => {
  const src = code('trading/agent/quant.js');
  assert.match(src, /paramsFor\(settings,\s*id,\s*symbol\)/,
    'quant must pass the symbol, or symbolParams is dead config that looks applied');
});

test('TRD-75: paramsFor layers symbolParams LAST (so the symbol wins)', () => {
  const src = code('trading/agent/strategies/index.js');
  const a = src.indexOf('function paramsFor');
  assert.ok(a > -1, 'paramsFor must exist');
  const slice = src.slice(a, src.indexOf('module.exports', a));
  assert.ok(slice.length > 80, 'slice guard');
  assert.match(slice, /\{\s*\.\.\.\(s\.DEFAULTS \|\| \{\}\),\s*\.\.\.global,\s*\.\.\.perSymbol\s*\}/,
    'the spread order is the resolution order - symbolParams must come last');
  assert.match(slice, /symbolParams/, 'the per-symbol layer must be read');
});
