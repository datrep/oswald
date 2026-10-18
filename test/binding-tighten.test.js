'use strict';
// B5 (decision A+B) — tighten-only auto-apply.
//
// Two things are being pinned here, and they are different in kind:
//   1. THE DECLARATIONS in the real registry. `tightens` is a DOMAIN CLAIM, so the test asserts the
//      claim holds for every occurrence of a key across every strategy (any `riskPerTradePct` anywhere
//      is `'lower'`), and that the deliberately-undeclared knobs stay undeclared. If someone adds a
//      direction to `adxPeriod`, that is a behaviour change and this test has to be edited on purpose.
//   2. THE CLASSIFIER AND THE GUARDS, against a stub registry so scope/params are exact.
//
// NOTE the writer is never reached: every guard test returns BEFORE any IO, which is itself the property
// worth asserting (nothing is written when a guard refuses).
const test = require('node:test');
const assert = require('node:assert');
const binding = require('../trading/agent/binding');
const apply = require('../trading/agent/bindingApply');
const strategies = require('../trading/agent/strategies');

// ---------------------------------------------------------------- 1. the real declarations

const ALL = Object.values(strategies.REGISTRY);

test('B5-A: every occurrence of a key declares the SAME direction across all strategies', () => {
  const expectTighter = { riskPerTradePct: 'lower', adxGate: 'higher', donchianPeriod: 'higher', topN: 'lower', minBuys: 'higher', bbStd: 'higher', rsiHigh: 'higher', high: 'higher', rsiLow: 'lower', low: 'lower', squeezePct: 'lower' };
  for (const [key, dir] of Object.entries(expectTighter)) {
    const holders = ALL.filter((s) => (s.params || []).some((p) => p.key === key));
    assert.ok(holders.length, `no strategy declares "${key}" - the registry moved`);
    for (const s of holders) {
      const p = s.params.find((x) => x.key === key);
      assert.equal(p.tightens, dir, `${s.id}.${key} must declare tightens: '${dir}'`);
    }
  }
});

test('B5-A: the knobs whose direction is NOT monotonic stay UNDECLARED', () => {
  // Each of these changes behaviour without any defensible "more trades" ordering, so they must stay
  // human. adxPeriod is additionally inert in the backtester.
  const undeclared = ['adxPeriod', 'atrPeriod', 'atrStopMultiple', 'stopAtrMult', 'dirPeriod', 'momBlocks', 'blocksPerBar', 'bbPeriod', 'smaExitPeriod', 'rsiPeriod', 'fast', 'slow', 'signal', 'lookbackDays', 'squeezeLookback', 'minBars'];
  for (const key of undeclared) {
    for (const s of ALL.filter((x) => (x.params || []).some((p) => p.key === key))) {
      const p = s.params.find((x) => x.key === key);
      assert.equal(p.tightens, undefined, `${s.id}.${key} must NOT declare a direction`);
    }
  }
});

test('B5-A: booleans are never auto-appliable, however obvious the intent looks', () => {
  for (const s of ALL) {
    for (const p of s.params || []) {
      if (p.type === 'bool') assert.equal(p.tightens, undefined, `${s.id}.${p.key} is a bool and must stay undeclared`);
    }
  }
});

test('B5-A: the frozen survivors declare no params at all, so they can never be auto-applied', () => {
  for (const id of ['survgold', 'survoil']) {
    const s = strategies.get(id);
    assert.ok(s, `${id} must be in the registry`);
    assert.deepEqual(s.params, [], `${id} is frozen: params must stay []`);
  }
});

// ---------------------------------------------------------------- 2. the classifier

const TABLE = {
  alpha: { id: 'alpha', name: 'Alpha', liveSignal: () => {}, params: [
    { key: 'window', type: 'number', min: 1, max: 100, tightens: 'higher' },
    { key: 'riskPct', type: 'number', min: 0.1, max: 5, tightens: 'lower' },
    { key: 'mystery', type: 'number', min: 0, max: 10 },
  ] },
  frozen: { id: 'frozen', name: 'Frozen', liveSignal: () => {}, params: [] },
};
const REG = { get: (id) => TABLE[id] || null };
const settings = (over = {}) => ({
  bindingProposer: { enabled: true, autoTighten: true },
  strategies: {
    enabled: ['alpha'],
    symbolScope: { Gold: ['alpha'], Silver: [] },
    params: {},
    symbolParams: { Gold: { alpha: { window: 20, riskPct: 1 } } },
    ...(over.strategies || {}),
  },
  ...(over.top || {}),
});

test('B5-B: judgeParam names the direction and refuses anything it cannot prove', () => {
  const a = TABLE.alpha;
  assert.equal(binding.judgeParam(a, 'window', 20, 50).verdict, 'tightening');
  assert.equal(binding.judgeParam(a, 'window', 20, 5).verdict, 'widening');
  assert.equal(binding.judgeParam(a, 'riskPct', 1, 0.5).verdict, 'tightening');
  assert.equal(binding.judgeParam(a, 'riskPct', 1, 2).verdict, 'widening');
  assert.equal(binding.judgeParam(a, 'mystery', 1, 2).verdict, 'undeclared');
  assert.equal(binding.judgeParam(a, 'window', undefined, 30).verdict, 'addition', 'a new knob is not a narrowing');
  assert.equal(binding.judgeParam(a, 'window', 20, 20).verdict, 'noop');
  assert.equal(binding.judgeParam(a, 'nope', 1, 2).verdict, 'undeclared', 'an unknown key cannot be judged, so it is refused');
});

test('B5-B: ONE widening or ONE undeclared key disqualifies the whole operation', () => {
  const s = settings();
  const tighten = binding.classifyOps(s, [{ type: 'setParams', symbol: 'Gold', strategy: 'alpha', params: { window: 50, riskPct: 0.5 } }], REG);
  assert.equal(tighten.ops[0].verdict, 'tightening');
  assert.equal(tighten.tightening.length, 1);

  const mixed = binding.classifyOps(s, [{ type: 'setParams', symbol: 'Gold', strategy: 'alpha', params: { window: 50, riskPct: 2 } }], REG);
  assert.equal(mixed.ops[0].verdict, 'widening', 'a tightening key must not carry a widening one through');
  assert.equal(mixed.tightening.length, 0);
  assert.match(mixed.ops[0].reason, /LOOSER/);

  const unsure = binding.classifyOps(s, [{ type: 'setParams', symbol: 'Gold', strategy: 'alpha', params: { window: 50, mystery: 3 } }], REG);
  assert.equal(unsure.ops[0].verdict, 'undeclared');
  assert.equal(unsure.tightening.length, 0);

  const added = binding.classifyOps(s, [{ type: 'setParams', symbol: 'Gold', strategy: 'alpha', params: { window: 50, riskPct: 1, novel: 1 } }], REG);
  assert.equal(added.ops[0].verdict, 'undeclared', 'an unknown key is not in params[] so it cannot be judged - and an unjudgeable op must not pass');
});

test('B5-B: a pair that is not in scope is INERT, so moving its values is refused', () => {
  const s = settings({ strategies: { enabled: ['alpha'], symbolScope: { Gold: ['alpha'], Silver: [] }, symbolParams: {} } });
  const r = binding.classifyOps(s, [{ type: 'setParams', symbol: 'Silver', strategy: 'alpha', params: { window: 50 } }], REG);
  assert.equal(r.ops[0].verdict, 'inert');
  assert.equal(r.tightening.length, 0);
});

test('B5-B: unbind is a narrowing ONLY when the symbol owns its scope list', () => {
  const own = binding.classifyOps(settings(), [{ type: 'unbind', symbol: 'Gold', strategy: 'alpha' }], REG);
  assert.equal(own.ops[0].verdict, 'tightening');
  assert.deepEqual(own.ops[0].nextScope, [], 'the narrowed list is the old list minus the strategy');

  // No symbolScope at all -> the symbol inherits the GLOBAL enabled list. Writing a narrowed explicit
  // list here would also pin it, so it is a policy change and stays human.
  const inherits = binding.classifyOps(settings({ strategies: { enabled: ['alpha'], symbolScope: {}, symbolParams: {} } }), [{ type: 'unbind', symbol: 'Gold', strategy: 'alpha' }], REG);
  assert.equal(inherits.ops[0].verdict, 'held');
  assert.match(inherits.ops[0].reason, /inherits the global enabled list/);

  const notBound = binding.classifyOps(settings(), [{ type: 'unbind', symbol: 'Silver', strategy: 'alpha' }], REG);
  assert.equal(notBound.ops[0].verdict, 'noop');

  const missing = binding.classifyOps(settings(), [{ type: 'unbind', symbol: 'Gold', strategy: 'ghost' }], REG);
  assert.equal(missing.ops[0].verdict, 'error');
});

test('B5-B: tightenPatch carries ONLY the tightening operations', () => {
  const s = settings();
  const r = binding.classifyOps(s, [
    { type: 'unbind', symbol: 'Gold', strategy: 'alpha' },
    { type: 'setParams', symbol: 'Silver', strategy: 'alpha', params: { window: 5 } },   // inert
    { type: 'setParams', symbol: 'Gold', strategy: 'alpha', params: { window: 50 } },
  ], REG);
  const patch = binding.tightenPatch(r);
  assert.deepEqual(patch.strategies.symbolScope, { Gold: [] });
  assert.deepEqual(patch.strategies.symbolParams, { Gold: { alpha: { window: 50 } } });
  assert.equal(patch.symbolParams, undefined, 'REGRESSION PIN: a flat patch writes to a top-level key nobody reads, so it is "applied" and inert');
  assert.equal(JSON.stringify(patch).includes('Silver'), false, 'the inert op must not reach the writer');
});

test('B5-B: the proposal language already HAS a removal channel - `unbound`', () => {
  const ops = binding.opsFromProposal({
    bindings: [{ symbol: 'Gold', strategy: 'alpha', params: { window: 50 } }],
    unbound: [{ symbol: 'Oil', strategy: 'alpha', reason: 'no edge there' }],
  });
  assert.deepEqual(ops.map((o) => o.type), ['setParams', 'unbind']);
  assert.equal(ops[1].symbol, 'Oil');
});

// ---------------------------------------------------------------- 3. the guards

test('B5: the writer refuses on all four guards, and refuses BEFORE any IO', async () => {
  const ops = [{ type: 'setParams', symbol: 'Gold', strategy: 'alpha', params: { window: 50 } }];

  // The first case MUST switch the flag off explicitly. Leaving it on lets the writer run, which is how
  // this test wrote a bogus key into the live settings once: a guard test that reaches the writer is
  // testing the wrong thing AND damaging the thing it tests.
  const off = await apply.applyTightening(1, { settings: settings({ top: { bindingProposer: { enabled: true, autoTighten: false } } }), ops, registry: REG, accepted: true });
  assert.equal(off.applied, false);
  assert.equal(off.reason, apply.REASON.off);

  const offStrict = await apply.applyTightening(1, { settings: settings({ top: { bindingProposer: { autoTighten: 'true' } } }), ops, registry: REG, accepted: true });
  assert.equal(offStrict.applied, false, 'a truthy string must not arm a writer');
  assert.equal(offStrict.reason, apply.REASON.off);

  const unaccepted = await apply.applyTightening(1, { settings: settings(), ops, registry: REG, accepted: false });
  assert.equal(unaccepted.reason, apply.REASON.unaccepted);

  const overridden = await apply.applyTightening(1, { settings: settings(), ops, registry: REG, accepted: true, overrideRequests: [{ symbol: 'Gold', strategy: 'alpha', reason: 'please' }] });
  assert.equal(overridden.reason, apply.REASON.override);

  // Guards pass, but nothing is a narrowing -> still nothing is written.
  const nothing = await apply.applyTightening(1, { settings: settings(), ops: [{ type: 'setParams', symbol: 'Gold', strategy: 'alpha', params: { window: 5 } }], registry: REG, accepted: true });
  assert.equal(nothing.applied, false);
  assert.equal(nothing.reason, apply.REASON.nothing);
  assert.equal(nothing.wrote, null, 'the writer must not have been reached');
});
