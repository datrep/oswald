'use strict';
// TRD-116 (2026-09-25) — the scope rule lives in ONE place, and this file is what makes that true rather
// than aspirational.
//
// THE DEFECT THIS PINS. "Which strategies may run on this symbol" is one sentence — explicit symbolScope
// entry > default key ('others'/'*') > strategies.enabled, then the applicability filter — and before this
// module it was implemented four times. Two of the copies (`selfHealth.scopeEnabledVerdict` and
// `analytics.strategyLiveness.reachableAnywhere`) disagreed with the resolver the desk trades on, in the
// same direction, and the check built on one of them reported working configurations as dead.
//
// So the central test here is not "does resolveEntry do what the comment says" — it is "does the shared
// resolver give the SAME ANSWER as `quant.scopedStrategyIds`, on every configuration in a grid". A future
// edit that changes one and not the other fails here instead of on the desk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scopeResolution = require('../trading/scopeResolution');
const { scopedStrategyIds, symbolEligible } = require('../trading/agent/quant');

// A registry that covers the shapes the real one has: a plain strategy, a TRACK-BOUND one (`symbols`), and
// one with no liveSignal at all. The track-bound case is the reason the applicability filter exists — the
// live registry's `survoil` is exactly this shape, and a two-list reading of the settings calls it reachable
// on symbols it cannot trade.
const REG = {
  get(id) {
    return {
      alpha: { id: 'alpha', liveSignal: () => 1 },
      beta: { id: 'beta', liveSignal: () => 1 },
      goldonly: { id: 'goldonly', liveSignal: () => 1, symbols: ['Gold'] },
      silent: { id: 'silent' }, // registered but cannot signal -> never eligible
    }[id] || null;
  },
};

const SCOPES = [
  {},
  { others: [] },
  { others: ['alpha'] },
  { others: null },
  { '*': ['beta'] },
  { Gold: [] },
  { Gold: ['beta'] },
  { Gold: ['goldonly'] },
  { Gold: null },
  { Gold: ['silent'] },
  { Gold: 'alpha' },
  { Gold: ['alpha'], others: ['beta'] },
  { Gold: ['alpha'], other: [] },
  { Gold: ['silent'], others: ['goldonly'] },
];
const ENABLEDS = [[], ['alpha'], ['alpha', 'beta'], ['goldonly'], ['silent'], ['alpha', 'silent']];
const SYMBOLS = ['Gold', 'Oil', 'Silver'];

test('the shared resolver and quant.scopedStrategyIds agree on every configuration', () => {
  // ★ THE CENTRAL PIN. Not a restatement of the rule — a comparison against the resolver the desk runs on.
  let compared = 0;
  for (const scope of SCOPES) {
    for (const enabled of ENABLEDS) {
      for (const sym of SYMBOLS) {
        assert.deepEqual(
          scopeResolution.scopeIdsFor(enabled, scope, sym, REG),
          scopedStrategyIds(enabled, scope, sym, REG),
          `divergence on enabled=${JSON.stringify(enabled)} scope=${JSON.stringify(scope)} symbol=${sym}`,
        );
        compared++;
      }
    }
  }
  assert.ok(compared >= 200, `the grid must actually be swept (compared ${compared})`);
});

test('...and the OLD two-list rule does NOT agree, so the pin above is not vacuous', () => {
  // ★ NON-VACUITY. If the previous rule also passed the sweep, the sweep would prove nothing about the fix.
  // This is `analytics.strategyLiveness.reachableAnywhere` as it stood before 2026-09-25: "named by a scope
  // entry or by the default key", with no third branch (the global list an ABSENT key falls back to) and no
  // applicability filter.
  const oldReachableAnywhere = (enabled, scope, id) => {
    const has = (k) => Object.prototype.hasOwnProperty.call(scope, k);
    const othersDefault = has('others') ? scope.others : (has('*') ? scope['*'] : null);
    const named = Object.entries(scope).some(([, ids]) => Array.isArray(ids) && ids.includes(id));
    return named || (Array.isArray(othersDefault) && othersDefault.includes(id));
  };
  const resolvable = (enabled, scope, id, symbols) => symbols
    .some((s) => scopeResolution.scopeIdsFor(enabled, scope, s, REG).includes(id));

  const disagreements = [];
  for (const scope of SCOPES) {
    for (const enabled of ENABLEDS) {
      for (const id of ['alpha', 'beta', 'goldonly']) {
        const old = oldReachableAnywhere(enabled, scope, id);
        const now = resolvable(enabled, scope, id, SYMBOLS);
        if (old !== now) disagreements.push({ enabled, scope, id, old, now });
      }
    }
  }
  assert.ok(disagreements.length >= 20,
    `the old rule must disagree on many configurations, not a corner case (found ${disagreements.length})`);
  // and the disagreement that matters most: an ABSENT key falls back to `enabled`, which the old rule read
  // as unable to run anywhere.
  assert.ok(disagreements.some((d) => d.id === 'alpha' && d.old === false && d.now === true),
    'the "absent key" case — enabled, undeclared symbol — must be one of them');
});

test('resolveEntry reports WHICH branch resolved, because the three are different facts', () => {
  assert.deepEqual(scopeResolution.resolveEntry(['alpha'], { Gold: ['beta'] }, 'Gold'),
    { raw: ['beta'], source: 'explicit', defaultKey: null });
  assert.deepEqual(scopeResolution.resolveEntry(['alpha'], { others: ['beta'] }, 'Gold'),
    { raw: ['beta'], source: 'default_key', defaultKey: 'others' });
  assert.deepEqual(scopeResolution.resolveEntry(['alpha'], { '*': ['beta'] }, 'Gold'),
    { raw: ['beta'], source: 'default_key', defaultKey: '*' });
  // 'others' wins over '*' when both are present — the order is stated, not incidental
  assert.equal(scopeResolution.resolveEntry([], { others: ['a'], '*': ['b'] }, 'Gold').raw[0], 'a');
  // no key at all -> the global list
  assert.deepEqual(scopeResolution.resolveEntry(['alpha'], { Silver: [] }, 'Gold'),
    { raw: ['alpha'], source: 'global_list', defaultKey: null });

  // ★ AN EXPLICIT `null` FALLS THROUGH TO THE GLOBAL LIST, and that is deliberate rather than an oversight:
  // it is what the resolver has always done. The SOURCE is still 'explicit', because the settings DID carry
  // a key for this symbol — a reader tracing why a strategy ran needs the branch that decided the LIST, and
  // a reader asking "was this symbol declared at all" needs the source.
  assert.deepEqual(scopeResolution.resolveEntry(['alpha'], { Gold: null }, 'Gold').raw, ['alpha']);
  assert.equal(scopeResolution.resolveEntry(['alpha'], { Gold: null }, 'Gold').source, 'explicit');

  // a non-array entry names nothing (it does not fall back)
  assert.deepEqual(scopeResolution.resolveEntry(['alpha'], { Gold: 'alpha' }, 'Gold').raw, []);
  // an absent enabled list is not a crash
  assert.deepEqual(scopeResolution.resolveEntry(undefined, {}, 'Gold').raw, []);
});

test('applicableOn is the track-bound filter — and quant.symbolEligible agrees', () => {
  assert.equal(scopeResolution.applicableOn('alpha', 'Gold', REG), true);
  assert.equal(scopeResolution.applicableOn('goldonly', 'Gold', REG), true);
  assert.equal(scopeResolution.applicableOn('goldonly', 'Oil', REG), false, '`symbols: [\'Gold\']` binds it');
  assert.equal(scopeResolution.applicableOn('silent', 'Gold', REG), false, 'no liveSignal means it cannot run');
  assert.equal(scopeResolution.applicableOn('ghost', 'Gold', REG), false, 'unregistered is not eligible');
  for (const id of ['alpha', 'beta', 'goldonly', 'silent', 'ghost']) {
    for (const sym of SYMBOLS) {
      assert.equal(scopeResolution.applicableOn(id, sym, REG), symbolEligible(id, sym, REG),
        `divergence on ${id}/${sym}`);
    }
  }
});

test('unreachableEnabled reports ONLY the direction that is a defect', () => {
  const WL = ['Gold', 'Oil'];

  // The true positive: an explicit empty entry on every symbol.
  const dead = scopeResolution.unreachableEnabled(['alpha'], { Gold: [], Oil: [] }, WL, REG);
  assert.deepEqual(dead.map((p) => p.id), ['alpha']);
  assert.match(dead[0].why, /no symbol in the universe resolves/);

  // ★ The track-bound cause is named SEPARATELY, because "the settings never name it" and "the registry
  // binds it away" are different things to go and fix.
  const bound = scopeResolution.unreachableEnabled(['goldonly'], {}, ['Oil'], REG);
  assert.deepEqual(bound.map((p) => p.id), ['goldonly']);
  assert.match(bound[0].why, /track-bound/);
  assert.deepEqual(bound[0].namedFor, ['Oil'], 'it IS named for Oil — it just cannot run there');

  // ★ The scope-only direction is NOT a defect and must not be reported: an explicit entry REPLACES the
  // global list, so the assignment is live (TRD-91).
  assert.deepEqual(scopeResolution.unreachableEnabled(['alpha'], { Gold: ['beta'] }, WL, REG), [],
    'beta is not in `enabled`, and that is the DELIBERATE override, not a dead setting');

  // a strategy reachable on exactly one symbol of many is reachable
  assert.deepEqual(scopeResolution.unreachableEnabled(['goldonly'], { Oil: ['alpha'] }, WL, REG), []);
});

test('newlyDeadIds reports the WRITE that orphans a setting, and only that write', () => {
  // TRD-116 option (b): "keep both but VALIDATE them". `saveSettings` is the one chokepoint every writer
  // shares — including the automated ones — so the guard has to say WHICH write created the dead setting,
  // and then be quiet. A state-based warning would re-fire on every settings write forever.
  const WL = ['Gold', 'Oil'];
  const before = { strategies: { enabled: ['alpha'], symbolScope: {} } };

  // The write that empties Gold's entry is the one reported...
  const introduced = scopeResolution.newlyDeadIds(before,
    { strategies: { enabled: ['alpha'], symbolScope: { Gold: [], Oil: [] } } }, WL, REG);
  assert.deepEqual(introduced, ['alpha']);

  // ...and a LATER write that changes something unrelated reports nothing, because the id was already dead.
  assert.deepEqual(scopeResolution.newlyDeadIds(
    { strategies: { enabled: ['alpha'], symbolScope: { Gold: [], Oil: [] } } },
    { strategies: { enabled: ['alpha'], symbolScope: { Gold: [], Oil: [] } }, risk: { maxPositions: 2 } }, WL, REG), [],
  'a signal, not a stream — the second save must be silent');

  // a write that REPAIRS the setting reports nothing
  assert.deepEqual(scopeResolution.newlyDeadIds(
    { strategies: { enabled: ['alpha'], symbolScope: { Gold: [], Oil: [] } } },
    { strategies: { enabled: ['alpha'], symbolScope: { Gold: ['alpha'], Oil: [] } } }, WL, REG), []);

  // ★ NO UNIVERSE MEANS UNMEASURED, so nothing is reported. It fails QUIET rather than naming every strategy
  // as newly dead — an unmeasured absence is not a finding, and this guard must not invent one.
  assert.deepEqual(scopeResolution.newlyDeadIds(before,
    { strategies: { enabled: ['alpha'], symbolScope: { Gold: [], Oil: [] } } }, [], REG), []);
  assert.deepEqual(scopeResolution.newlyDeadIds({}, {}, null, REG), []);
});

test('watchlistSymbols accepts both the watchlist object and a bare array, and never throws', () => {
  assert.deepEqual(scopeResolution.watchlistSymbols({ symbols: [{ symbol: 'Gold' }, { symbol: 'Oil' }] }), ['Gold', 'Oil']);
  assert.deepEqual(scopeResolution.watchlistSymbols([{ symbol: 'Gold' }, 'Oil']), ['Gold', 'Oil']);
  assert.deepEqual(scopeResolution.watchlistSymbols({ symbols: [{ symbol: 'Gold' }, { symbol: 'Gold' }] }), ['Gold'],
    'a duplicate is one symbol');
  assert.deepEqual(scopeResolution.watchlistSymbols({ symbols: [{ venue: 'plus500' }, null] }), []);
  assert.deepEqual(scopeResolution.watchlistSymbols(null), []);
  assert.deepEqual(scopeResolution.watchlistSymbols({}), []);
  assert.deepEqual(scopeResolution.watchlistSymbols({ symbols: 'Gold' }), []);
});

test('every consumer DELEGATES — the rule is not restated anywhere else', () => {
  // A behaviour test cannot catch a re-implementation that happens to agree today, which is precisely how
  // this defect survived: the copies were faithful when written and drifted afterwards. So the call sites
  // are pinned as text.
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const quant = read('trading/agent/quant.js');
  const binding = read('trading/agent/binding.js');
  const analytics = read('trading/agent/analytics.js');
  const selfHealth = read('trading/agent/selfHealth.js');
  const store = read('trading/store.js');

  assert.match(quant, /return scopeResolution\.scopeIdsFor\(/, 'quant must delegate the resolution');
  assert.match(quant, /return scopeResolution\.applicableOn\(/, 'quant must delegate the predicate');
  assert.match(binding, /return scopeResolution\.applicableOn\(/);
  assert.match(binding, /scopeResolution\.resolveEntry\(/);
  assert.match(analytics, /scopeResolution\.symbolsForId\(/);
  assert.match(selfHealth, /scopeResolution\.unreachableEnabled\(/);
  assert.match(store, /scopeResolution\.newlyDeadIds\(/, 'the save-time guard must use the same rule');

  // And the hand-rolled copies themselves must be GONE, not merely unused.
  for (const [name, src] of Object.entries({ quant, binding, analytics, selfHealth })) {
    assert.doesNotMatch(src, /has\('others'\) \? scope\.others : \(has\('\*'\) \? scope\['\*'\] : null\)/,
      `${name} still re-implements the default-key lookup`);
  }
  assert.doesNotMatch(quant, /const ids = entry != null \? \(Array\.isArray\(entry\)/,
    'quant still re-implements the resolution');
});
