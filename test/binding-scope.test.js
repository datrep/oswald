'use strict';
// The SCOPE op (2026-09-15) — letting the reviewer decide which strategy runs on which instrument.
//
// THE PROBLEM THIS PINS. The reviewer was asked to propose bindings and handed a `scope` map whose
// `permitted` lists were empty for everything but Gold and Oil. It answered `unbound` for every other
// symbol with the reason "scope explicitly permits no strategy" — the door read as locked, so the desk
// could only ever trade the two symbols that already had a frozen survivor.
//
// Two halves had to change together, and each is pinned here:
//   1. THE PROMPT tells the reviewer that `scope` is the CURRENT STATE, not a constraint on what it may
//      propose. (Asserted on the input and the system text, because a capability it is not told about is
//      a capability it does not have.)
//   2. THE OP MODEL can express the result. A binding for a pair that is not in scope is a `bind`, which
//      is a WIDENING — so it is classified, never dropped, and never auto-applied by the narrow-only
//      writer.
//
// The property worth the most: ARMING THE NARROW-ONLY WRITER MUST NOT PUT ANYTHING INTO SCOPE. One
// switch silently becoming two is how a "tighten-only" guarantee dies.
const test = require('node:test');
const assert = require('node:assert');
const binding = require('../trading/agent/binding');
const apply = require('../trading/agent/bindingApply');
const proposer = require('../trading/agent/bindingProposer');

const TABLE = {
  alpha: { id: 'alpha', name: 'Alpha', liveSignal: () => {}, params: [
    { key: 'window', type: 'number', min: 1, max: 100, tightens: 'higher' },
  ] },
  // Real ids, because the live-eligibility gate maps by NAME: `turtle` speaks for turtle, and `meanrev`
  // is declared UNCOVERED. A stub the gate cannot classify would test the wrong branch.
  turtle: { id: 'turtle', name: 'Turtle', liveSignal: () => {}, params: [
    { key: 'window', type: 'number', min: 1, max: 100, tightens: 'higher' },
  ] },
  meanrev: { id: 'meanrev', name: 'Mean reversion', liveSignal: () => {}, params: [
    { key: 'rsiPeriod', type: 'number', min: 2, max: 50 },
  ] },
  tied: { id: 'tied', name: 'Tied', liveSignal: () => {}, params: [], symbols: ['Gold'] },
};
const REG = { get: (id) => TABLE[id] || null };
// Enumerating what is POSSIBLE needs a registry that can be listed, not only queried by id.
const REG_FULL = { REGISTRY: TABLE, get: (id) => TABLE[id] || null };

const settings = (over = {}) => ({
  paper: { enabled: false },
  bindingProposer: { enabled: true, autoTighten: false, autoScope: false },
  strategies: {
    enabled: ['alpha'],
    symbolScope: { Gold: ['alpha'], Silver: [] },
    params: {},
    symbolParams: {},
    ...(over.strategies || {}),
  },
  ...(over.top || {}),
});

const armedScope = () => settings({ top: { bindingProposer: { enabled: true, autoScope: true } } });

// ---------------------------------------------------------------- 1. the op model

test('a bind is a WIDENING, and it carries the scope list it would produce', () => {
  const c = binding.classifyOps(settings(), [{ type: 'bind', symbol: 'Silver', strategy: 'alpha' }], REG);
  assert.equal(c.ops[0].verdict, 'widening');
  assert.deepEqual(c.ops[0].nextScope, ['alpha'], 'Silver has its own (empty) scope list, so the addition is explicit');
  assert.match(c.ops[0].reason, /would START trading Silver/);
  assert.equal(c.tightening.length, 0, 'a widening must never appear in the tightening list');
});

test('binding a pair that ALREADY runs is a noop, not a widening', () => {
  const c = binding.classifyOps(settings(), [{ type: 'bind', symbol: 'Gold', strategy: 'alpha' }], REG);
  assert.equal(c.ops[0].verdict, 'noop');
  assert.equal(c.widening.length, 0);
});

test('an IMPOSSIBLE pairing is an error, not a decision to weigh', () => {
  // `tied` declares symbols: ['Gold']. Putting it on Silver cannot ever run, so it must not enter the
  // widening list where a caller might treat it as "wanted but refused".
  const c = binding.classifyOps(settings(), [{ type: 'bind', symbol: 'Silver', strategy: 'tied' }], REG);
  assert.equal(c.ops[0].verdict, 'error');
  assert.match(c.ops[0].reason, /track-bound/);
  assert.equal(c.widening.length, 0);
});

test('opsFromProposal: ONE binding means a SCOPE ADD or a VALUE CHANGE, and only the settings say which', () => {
  const p = { bindings: [
    { symbol: 'Silver', strategy: 'alpha', params: { window: 30 } },
    { symbol: 'Gold', strategy: 'alpha', params: { window: 50 } },
  ] };
  const ops = binding.opsFromProposal(p, settings(), REG);
  assert.deepEqual(ops.map((o) => o.type), ['bind', 'setParams']);
  assert.equal(ops[0].symbol, 'Silver', 'the out-of-scope pair is the one that becomes a bind');
  // Called with no settings it keeps its original meaning EXACTLY, so existing callers are unaffected.
  assert.deepEqual(binding.opsFromProposal(p).map((o) => o.type), ['setParams', 'setParams']);
});

// ---------------------------------------------------------------- 2. the writers stay separate

test('★ ARMING THE NARROW-ONLY WRITER CANNOT PUT ANYTHING INTO SCOPE', async () => {
  const r = await apply.applyTightening(1, {
    settings: settings({ top: { bindingProposer: { enabled: true, autoTighten: true } } }),
    ops: [{ type: 'bind', symbol: 'Silver', strategy: 'alpha', params: { window: 50 } }],
    registry: REG,
    accepted: true,
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, apply.REASON.nothing, 'a bind is not a narrowing, so there is nothing to tighten');
  assert.equal(r.wrote, null, 'the writer must not have been reached');
});

test('scopePatch nests under `strategies`, because a flat patch is applied AND inert at once', () => {
  const c = binding.classifyOps(settings(), [{ type: 'bind', symbol: 'Silver', strategy: 'alpha', params: { window: 30 } }], REG);
  const patch = binding.scopePatch(c);
  assert.deepEqual(patch.strategies.symbolScope, { Silver: ['alpha'] });
  assert.deepEqual(patch.strategies.symbolParams, { Silver: { alpha: { window: 30 } } });
  assert.equal(patch.symbolScope, undefined, 'REGRESSION PIN: a flat patch writes to a top-level key nobody reads');
});

// ---------------------------------------------------------------- 3. the scope writer's guards

test('applyScope is OFF by default, and a truthy string must not arm it', async () => {
  const ops = [{ type: 'bind', symbol: 'Silver', strategy: 'alpha' }];
  for (const cfg of [{ enabled: true }, { enabled: true, autoScope: 'true' }, { enabled: true, autoScope: 1 }]) {
    const r = await apply.applyScope(1, { settings: settings({ top: { bindingProposer: cfg } }), ops, registry: REG, accepted: true });
    assert.equal(r.applied, false, `autoScope ${JSON.stringify(cfg.autoScope)} must not arm the writer`);
    assert.equal(r.reason, apply.REASON.scopeOff);
    assert.equal(r.wrote, null, 'the writer must not have been reached');
  }
});

test('applyScope: arming it is not the same as having something to write', async () => {
  const r = await apply.applyScope(1, {
    settings: armedScope(),
    ops: [{ type: 'bind', symbol: 'Gold', strategy: 'alpha' }], // already in scope -> noop
    registry: REG, accepted: true,
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, apply.REASON.scopeNothing);
  assert.equal(r.wrote, null);
});

test('applyScope writes ONLY when armed AND accepted', async (t) => {
  const store = require('../trading/store');
  const save = store.saveSettings, log = store.logEvent;
  t.after(() => { store.saveSettings = save; store.logEvent = log; });
  let written = null;
  store.saveSettings = async (_uid, patch) => { written = patch; return true; };
  store.logEvent = async () => {};

  const ops = [{ type: 'bind', symbol: 'Silver', strategy: 'alpha', params: { window: 30 } }];

  const refused = await apply.applyScope(1, { settings: armedScope(), ops, registry: REG, accepted: false });
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, apply.REASON.unaccepted);
  assert.equal(written, null, 'an unaccepted proposal must not reach the writer');

  const ok = await apply.applyScope(1, { settings: armedScope(), ops, registry: REG, accepted: true });
  assert.equal(ok.applied, true);
  assert.deepEqual(written.strategies.symbolScope, { Silver: ['alpha'] });
  assert.deepEqual(ok.added, [{ symbol: 'Silver', strategy: 'alpha' }]);
});

// ---------------------------------------------------------------- 4. TRD-91: the widener respects a retire
//
// `applyScope` is the ONE writer that may put a pair into scope without a human, and it used to do so with
// no memory of what a human had removed: rsi2 was retired and re-added by the widener 12 minutes later
// (TRD-103). Disarming the widener was a settings change, so the guard held only until a flag was flipped
// back. `strategies.retired` is that memory, and these two tests are the difference between a guard that
// changes the LOG and a guard that changes the SETTINGS.

const withRetired = (ids) => {
  const s = armedScope();
  s.strategies = { ...s.strategies, retired: ids };
  return s;
};

test('★ a scope addition naming a RETIRED strategy is refused, and the settings are not written', async (t) => {
  const store = require('../trading/store');
  const save = store.saveSettings, log = store.logEvent;
  t.after(() => { store.saveSettings = save; store.logEvent = log; });
  let written = null;
  store.saveSettings = async (_uid, patch) => { written = patch; return true; };
  store.logEvent = async () => {};

  const r = await apply.applyScope(1, {
    settings: withRetired(['meanrev']),
    ops: [{ type: 'bind', symbol: 'Silver', strategy: 'meanrev' }],
    registry: REG, accepted: true,
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, apply.REASON.scopeRetired);
  assert.equal(written, null, 'THE SETTINGS MUST NOT BE WRITTEN — writing them back is the TRD-103 defect');
  assert.equal(r.held[0].verdict, 'retired');
  assert.match(r.held[0].reason, /retired/i);
});

test('★ a retired pair is held while the rest of the proposal still applies — and never reaches the patch', async (t) => {
  const store = require('../trading/store');
  const save = store.saveSettings, log = store.logEvent;
  t.after(() => { store.saveSettings = save; store.logEvent = log; });
  let written = null;
  store.saveSettings = async (_uid, patch) => { written = patch; return true; };
  store.logEvent = async () => {};

  // ⚠ BOTH symbols need an EXPLICIT empty scope entry, and that is the subtlety the first draft of this
  // test got wrong: an ABSENT entry means "inherit the global enabled list", so `alpha` on a symbol with no
  // entry is already in scope and classifies as `noop`, not as a widening. Measured on the first run: the
  // only widening was the retired one, so the guard looked like it refused everything.
  const s = withRetired(['meanrev']);
  s.strategies = { ...s.strategies, symbolScope: { Gold: ['alpha'], Silver: [], Oil: [] } };

  const r = await apply.applyScope(1, {
    settings: s,
    ops: [
      { type: 'bind', symbol: 'Oil', strategy: 'meanrev' },   // retired -> held
      { type: 'bind', symbol: 'Silver', strategy: 'alpha' },  // permitted -> applied
    ],
    registry: REG, accepted: true,
  });
  assert.equal(r.applied, true);
  assert.deepEqual(r.added, [{ symbol: 'Silver', strategy: 'alpha' }]);
  assert.deepEqual(written.strategies.symbolScope, { Silver: ['alpha'] },
    'scopePatch reads classification.widening, so the FILTERED list has to be handed to it');
  assert.ok(r.held.some((h) => h.verdict === 'retired'), 'the hold must be visible in the event, not silently absent');
});

test('retiredIds is defensive about the settings shape, and coerces to strings', () => {
  assert.deepEqual(apply.retiredIds(undefined), []);
  assert.deepEqual(apply.retiredIds({}), []);
  assert.deepEqual(apply.retiredIds({ strategies: {} }), []);
  assert.deepEqual(apply.retiredIds({ strategies: { retired: 'rsi2' } }), [],
    'a non-array must read as "nothing retired" rather than throwing or indexing a string');
  assert.deepEqual(apply.retiredIds({ strategies: { retired: ['rsi2', 7] } }), ['rsi2', '7'],
    'ids are compared as strings, because the proposer emits what the model wrote');
});

// ---------------------------------------------------------------- 4. the reviewer is told

test('the reviewer is TOLD that scope is its decision, in its own instructions', () => {
  // A capability the reviewer is never told about is one it does not have: it answered "scope explicitly
  // permits no strategy" for every symbol but Gold and Oil, and that was a correct reading of what it
  // had been given.
  assert.match(proposer.SYSTEM, /SCOPE IS YOURS TO DECIDE/);
  assert.match(proposer.SYSTEM, /NOT a reason to propose nothing/);
  assert.ok(proposer.SYSTEM.includes('rules.mode'), 'the demo/data-collection rule must be present');
});

test('the review INPUT carries the scope rule by DEFAULT, so a caller that omits rules is not misled', () => {
  const input = proposer.buildReviewInput({ instruments: [], scope: {}, bindingTable: null });
  assert.equal(input.rules.scopeMayBeExtended, true);
  assert.match(input.rules.scopeNote, /SCOPE ADDITION/);
});

test('validateProposal names a SCOPE ADDITION instead of reporting an inert value change', () => {
  const v = proposer.validateProposal(
    { bindings: [{ symbol: 'Silver', strategy: 'alpha', params: { window: 30 }, rationale: 'demo: no lab case; proposed to generate live evidence' }] },
    { settings: settings(), symbols: ['Gold', 'Silver'], registry: REG },
  );
  assert.deepEqual(v.scopeAdd, { Silver: ['alpha'] });
  assert.deepEqual(v.patch, { Silver: { alpha: { window: 30 } } }, 'the values are still carried, for the new pair');
});

test('a binding for a pair that ALREADY runs is not reported as a scope addition', () => {
  const v = proposer.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'alpha', params: { window: 50 }, rationale: 'tightening the window' }] },
    { settings: settings(), symbols: ['Gold', 'Silver'], registry: REG },
  );
  assert.deepEqual(v.scopeAdd, {});
});

test('★ AN EXEMPT PAIR IS RECORDED, NOT REFUSED - otherwise a scope addition can never be applied', () => {
  // `meanrev` is declared UNCOVERED, so the gate returns `exempt` and can never return `allow`. When this
  // check demanded `allow`, every scope addition without a lab case came back `accepted: false` - and
  // applyScope requires accepted. The capability existed and was UNREACHABLE, which is worse than not
  // having built it: a forced live proposal proposed exactly one addition and was refused for being
  // exempt. The gate's own contract is that exemptions are non-blocking by construction, and the owner's
  // decision of 2026-09-15 was "exempt but recorded".
  const v = proposer.validateProposal(
    { bindings: [{ symbol: 'Sugar', strategy: 'meanrev', params: { rsiPeriod: 14 }, rationale: 'demo: no lab case; proposed to collect live evidence' }] },
    {
      settings: settings({ strategies: { symbolScope: { Gold: ['alpha'], Sugar: [] } } }),
      symbols: ['Gold', 'Sugar'],
      registry: REG,
      gate: { candidates: [], enforce: false, overrides: {} },
    },
  );
  const recorded = v.reasons.find((r) => r.source === 'live-eligibility gate');
  assert.ok(recorded, 'the exemption must still be RECORDED - that is what keeps the exemption share visible');
  assert.equal(recorded.level, 'warn', 'an exemption is not an error');
  assert.equal(v.accepted, true, 'an exempt pair must not make the proposal unappliable');
  assert.deepEqual(v.scopeAdd, { Sugar: ['meanrev'] });
});

test('a pair the gate genuinely DECLINES still blocks - the exemption fix did not disarm the gate', () => {
  // turtle IS mapped, and this candidate FAILED. The status must NOT be `archived`: archived is checked
  // first and an override DOES rescue it, so an archived failure would be cleared by the retry and this
  // test would pass for the wrong reason.
  const v = proposer.validateProposal(
    { bindings: [{ symbol: 'Silver', strategy: 'turtle', params: { window: 30 }, rationale: 'x', overrideReason: 'owner asked for it' }] },
    {
      settings: settings(),
      symbols: ['Gold', 'Silver'],
      registry: REG,
      gate: { candidates: [{ id: 1, strategy: 'turtle', symbol: 'Silver', status: 'active', verdict: 'FAIL' }], enforce: false, overrides: {} },
    },
  );
  const err = v.reasons.find((r) => r.source === 'live-eligibility gate' && r.level === 'error');
  assert.ok(err, `a refused pair must stay refused, got ${JSON.stringify(v.reasons)}`);
  assert.equal(v.accepted, false);
});

test('a binding carrying NO parameters is not a retune of a frozen strategy', () => {
  // The reviewer emits {Gold: {survgold: {}}} to mean "keep this binding as it is". An empty object has no
  // values in it, so it must not create a symbolParams entry and must not be read as retuning a frozen
  // survivor. Found live: the false positive made the WHOLE proposal unacceptable, which blocked the scope
  // additions travelling in the same reply - so a retention note about Gold silently killed the decision
  // about Bitcoin and Sugar.
  const v = proposer.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'tied', params: {}, rationale: 'retain the existing binding as it is' }] },
    { settings: settings(), symbols: ['Gold'], registry: REG },
  );
  assert.deepEqual(v.patch, {}, 'no values means no symbolParams entry');
  assert.equal(v.reasons.some((r) => /FROZEN/.test(r.reason)), false);
});

test('a binding WITH values for a frozen strategy is still an ERROR', () => {
  // The other direction of the same test: the guard exists because retuning a survivor voids the
  // candidate, so it must still fire the moment there is a value to retune with.
  const v = proposer.validateProposal(
    { bindings: [{ symbol: 'Gold', strategy: 'tied', params: { window: 5 }, rationale: 'retune it' }] },
    { settings: settings(), symbols: ['Gold'], registry: REG },
  );
  assert.ok(v.reasons.some((r) => /FROZEN/.test(r.reason)), 'the guard must still fire when values are present');
});

// ---------------------------------------------------------------- 5. the proposal must not be stranded

function stubEvents(t, { proposal, scoped = [] }) {
  const store = require('../trading/store');
  const orig = store.listEvents;
  t.after(() => { store.listEvents = orig; });
  store.listEvents = async (_uid, { kind }) => (kind === 'binding_proposal' ? proposal : scoped);
}

test('an accepted proposal that was never applied is RE-OFFERED, not stranded', async (t) => {
  // `applied` is hard-coded false and the apply ran only in the wake that PROPOSED, so arming a writer
  // after the fact used to do nothing until the reviewer's input moved again - possibly days. The reviewer
  // would look like it had decided and the desk would never act.
  stubEvents(t, { proposal: [{ id: 9, createdAt: new Date().toISOString(), payload: { inputSig: 'abc', accepted: true, bindings: [{ symbol: 'Sugar', strategy: 'meanrev', params: {} }] } }] });
  const p = await proposer.strandedProposal(1);
  assert.ok(p, 'an accepted, unapplied proposal must be re-offerable');
  assert.equal(p.inputSig, 'abc');
  assert.equal(p.bindings.length, 1);
});

test('an APPLIED proposal is retired by its signature, not offered again', async (t) => {
  stubEvents(t, {
    proposal: [{ id: 9, createdAt: new Date().toISOString(), payload: { inputSig: 'abc', accepted: true, bindings: [{ symbol: 'Sugar', strategy: 'meanrev' }] } }],
    scoped: [{ id: 10, payload: { inputSig: 'abc', applied: true } }],
  });
  assert.equal(await proposer.strandedProposal(1), null, 'the signature marks this proposal as done');
});

test('a REFUSED proposal is not re-offered, and neither is one with nothing to do', async (t) => {
  stubEvents(t, { proposal: [{ id: 9, createdAt: new Date().toISOString(), payload: { inputSig: 'abc', accepted: false, bindings: [{ symbol: 'Sugar', strategy: 'meanrev' }] } }] });
  assert.equal(await proposer.strandedProposal(1), null, 'a refused proposal is a human decision, not a queue item');

  stubEvents(t, { proposal: [{ id: 9, createdAt: new Date().toISOString(), payload: { inputSig: 'abc', accepted: true, bindings: [] } }] });
  assert.equal(await proposer.strandedProposal(1), null, 'an empty binding list has no ops to apply');
});

test('★ the wake APPLIES a re-offered proposal: the apply is not an `else` of the skip', () => {
  // A re-offered proposal arrives WITH a `skipped` reason - the cadence did not fire because the reviewer's
  // input had not moved, but the decision was already made and accepted. With `if (prop.skipped) {...}
  // else if (prop.proposal) {...}` the re-offer logged a skip and was never applied, reproducing the exact
  // stranding it was written to fix, one branch further along. Found live, not by reasoning.
  const { code } = require('./_source');
  const src = code('trading/agent/wakePipeline.js');
  assert.equal(
    /else\s+if\s*\(\s*prop\s*&&\s*prop\.proposal\s*\)/.test(src),
    false,
    'the apply must not be reachable only when the proposer did NOT skip',
  );
  assert.match(src, /if\s*\(prop\s*&&\s*prop\.proposal\)/, 'the apply must be an independent statement');
});

// ------------------------------------------------ 6. TRD-85: what is POSSIBLE, not only what is current

const unscopedSilver = () => settings({ strategies: { symbolScope: { Silver: [] }, enabled: ['alpha'] } });

test('★ TRD-85: an instrument with NOTHING in scope is given its candidates, not silence', () => {
  // The defect: `evidence` is built from the IN-SCOPE list, so for this symbol the reviewer received
  // scope:{permitted:[]}, evidence:[] and - for anything the physical catalogue does not cover -
  // physicalTelemetry:{declared:0}. It was asked whether a pair belonged in scope while being shown only
  // the pairs that already did, and it correctly refused. All four instruments the discoverer added were
  // refused for exactly this reason.
  const sets = proposer.candidateSets({ symbols: ['Silver'], settings: unscopedSilver(), registry: REG_FULL, gate: { candidates: [], enforce: false, overrides: {} } });
  const row = sets.bySymbol[0];
  assert.deepEqual(row.inScope, [], 'nothing is in scope - which IS the question');
  assert.equal(row.applicableCount, 3, 'alpha, turtle and meanrev can run on Silver; `tied` is track-bound to Gold');
  assert.deepEqual(row.noLabCase.sort(), ['meanrev', 'turtle'], 'both are possible and neither has a case of its own');
  assert.deepEqual(row.unmapped, ['alpha'], 'a strategy nobody classified is a DEFECT, not an exemption');
  assert.deepEqual(row.withCase, []);
});

test('TRD-85: a candidate WITH a real verdict moves into withCase, carrying its outcome', () => {
  const sets = proposer.candidateSets({
    symbols: ['Silver'],
    settings: unscopedSilver(),
    registry: REG_FULL,
    gate: { candidates: [{ id: 1, strategy: 'turtle', symbol: 'Silver', status: 'active', verdict: 'PASS' }], enforce: false, overrides: {} },
  });
  const row = sets.bySymbol[0];
  assert.deepEqual(row.withCase, [{ strategy: 'turtle', outcome: 'pass', eligible: true }]);
  assert.ok(!row.noLabCase.includes('turtle'), 'a strategy with a case is no longer part of the grouped emptiness');
});

test('TRD-85: applicableIds never offers a strategy that is track-bound elsewhere', () => {
  assert.deepEqual(binding.applicableIds('Silver', REG_FULL).sort(), ['alpha', 'meanrev', 'turtle']);
  assert.ok(binding.applicableIds('Gold', REG_FULL).includes('tied'), 'track-bound TO this symbol is fine');
});

test('TRD-85: the candidate set is part of the SIGNED input, so a new lab case forces a reconsideration', () => {
  // A candidate gaining a case is new information even when nothing in scope moved.
  const a = proposer.signature(proposer.buildReviewInput({ instruments: [], candidates: { bySymbol: [{ symbol: 'Silver', inScope: [], noLabCase: ['turtle'], withCase: [] }] } }));
  const b = proposer.signature(proposer.buildReviewInput({ instruments: [], candidates: { bySymbol: [{ symbol: 'Silver', inScope: [], noLabCase: [], withCase: [{ strategy: 'turtle', outcome: 'pass' }] }] } }));
  assert.notEqual(a, b, 'a candidate gaining a case is new information');
});

test('TRD-85: the candidates key is always present and shaped, so the whitelist cannot drift', () => {
  const input = proposer.buildReviewInput({ instruments: [], scope: {} });
  assert.ok(input.candidates, 'always present');
  assert.deepEqual(input.candidates.bySymbol, []);
  assert.match(input.candidates.note, /noLabCase/);
  assert.deepEqual(Object.keys(input).sort(), [...proposer.INPUT_KEYS].sort());
});

// ------------------------------------------------ 7. the reply is read as JSON-in-a-reply, not as JSON

test('★ a valid reply followed by prose is still a proposal, not an unparseable one', () => {
  // Measured live: a forced proposal came back as valid JSON plus a closing note, and the whole decision
  // was discarded with "Unexpected non-whitespace character after JSON at position 7288" - after the full
  // token budget had been spent producing it. The reviewer looked like it had nothing to say.
  const reply = '{"bindings":[{"symbol":"Silver","strategy":"turtle","params":{},"rationale":"demo"}],"unbound":[],"notes":"n"}\n\nI should add that Silver has no physical telemetry.';
  const p = proposer.parseProposal(reply);
  assert.equal(p.error, undefined, `expected a proposal, got ${p.error}`);
  assert.equal(p.salvaged, true, 'salvage is recorded, not silent');
  assert.equal(p.proposal.bindings.length, 1);
  assert.equal(p.proposal.bindings[0].symbol, 'Silver');
});

test('a brace inside a string does not end the object early', () => {
  const reply = '{"bindings":[],"unbound":[],"notes":"a } inside prose, and a { too"} trailing words';
  const p = proposer.parseProposal(reply);
  assert.equal(p.error, undefined);
  assert.match(p.proposal.notes, /\} inside prose/);
});

test('an ordinary exact reply is NOT flagged as salvaged', () => {
  const p = proposer.parseProposal('{"bindings":[],"unbound":[],"notes":"clean"}');
  assert.equal(p.error, undefined);
  assert.ok(!p.salvaged, 'the normal path must not be marked');
});

test('a reply that is not JSON at all still fails, and still says why', () => {
  const p = proposer.parseProposal('I am afraid I cannot help with that.');
  assert.match(p.error, /not JSON|not an object/);
  assert.equal(p.proposal, undefined);
});

test('validate catches an impossible scope entry before it is written', () => {
  // The scope add is the ONE place a pairing can be created, so it is the one place an impossible pairing
  // can be introduced and then silently never run.
  const problems = binding.validate(
    { strategies: { enabled: ['alpha'], symbolScope: { Silver: ['tied'] }, symbolParams: {} } },
    { symbols: ['Gold', 'Silver'], registry: REG },
  );
  const err = problems.find((p) => p.strategy === 'tied' && p.level === 'error');
  assert.ok(err, 'a track-bound strategy placed on the wrong symbol must be an ERROR');
  assert.match(err.reason, /track-bound/);
});
