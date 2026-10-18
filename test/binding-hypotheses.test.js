// test/binding-hypotheses.test.js — TRD-86: the channel in which the reviewer says what it believes and
// what would prove it wrong.
//
// THE TWO GUARANTEES THAT MATTER, and both are structural rather than promised:
//
//   1. A HYPOTHESIS GRANTS NO SCOPE. It cannot reach `patch` or `scopeAdd`, because those are built from
//      `bindings` alone. Asserted, not asserted-in-a-comment: "the gate already enforces this" was the
//      v1 claim that turned out to be false (the gate is observe-only, `enforce:false`).
//   2. A REFUSED HYPOTHESIS IS DROPPED, NOT FATAL. One malformed claim must not make an entire reply
//      inert — the same defect class as the empty-params bug that let a retention note about Gold kill
//      the decisions about Sugar in the same response.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const bp = require('../trading/agent/bindingProposer');
const tel = require('../trading/agent/telemetrySources');

const registry = {
  REGISTRY: {
    turtle: { id: 'turtle', liveSignal() {}, DEFAULTS: { donchianPeriod: 20 }, params: [{ key: 'donchianPeriod', def: 20, min: 5, max: 100 }] },
    survgold: { id: 'survgold', liveSignal() {}, symbols: ['Gold'], DEFAULTS: {}, params: [] },
  },
  get(id) { return this.REGISTRY[id] || null; },
};
const SYMBOLS = ['Gold', 'Oil', 'Sugar', 'Arabica Coffee'];
const V = (hypotheses) => bp.validateHypotheses(hypotheses, { symbols: SYMBOLS, registry });

// ---------------------------------------------------------------- 1. the input whitelist does not move

test('TRD-86: `hypotheses` is OUTPUT, so the reviewer input whitelist is unchanged', () => {
  // Load-bearing: the whitelist is about what the reviewer may SEE. A new output field must not widen it,
  // and a test that just checked "INPUT_KEYS contains hypotheses" would have blessed the wrong thing.
  assert.equal(bp.INPUT_KEYS.length, 9);
  assert.ok(!bp.INPUT_KEYS.includes('hypotheses'));
  const input = bp.buildReviewInput({ instruments: [{ symbol: 'Gold' }] });
  assert.deepEqual(Object.keys(input).sort(), [...bp.INPUT_KEYS].sort());
});

test('TRD-86: the prompt asks for a claim and its falsifier, and says a hypothesis is not a binding', () => {
  assert.equal(bp.PROMPT_VERSION, 'binding-v3', 'the shape changed, so the signature must force a re-decision');
  assert.match(bp.SYSTEM, /"hypotheses":\[/);
  assert.match(bp.SYSTEM, /falsifiableBy/);
  assert.match(bp.SYSTEM, /needsAuthoring/);
  assert.match(bp.SYSTEM, /grants nothing/, 'the reviewer must be told a hypothesis is not a scope request');
  assert.match(bp.SYSTEM, /REFUSED/);
});

test('TRD-86: a reply carrying hypotheses still parses, and a missing list is an empty list', () => {
  const p = bp.parseProposal('{"bindings":[],"hypotheses":[{"symbol":"Sugar","statement":"x","falsifiableBy":{"strategy":"turtle"}}]}');
  assert.equal(p.proposal.hypotheses.length, 1);
  assert.deepEqual(bp.parseProposal('{"bindings":[]}').proposal.hypotheses, []);
  assert.deepEqual(bp.parseProposal('{"bindings":[],"hypotheses":"nope"}').proposal.hypotheses, []);
});

// ---------------------------------------------------------------- 2. the falsifier is mandatory

test('★ a claim with NO falsifier is refused', () => {
  const v = V([{ symbol: 'Sugar', statement: 'Sugar mean-reverts after crowded-long extremes' }]);
  assert.equal(v.rows[0].status, 'refused');
  assert.ok(v.rows[0].reasons.some((r) => /no falsifier/.test(r.reason)));
});

test('★ naming BOTH an existing strategy and needsAuthoring is refused, not resolved by preference', () => {
  const v = V([{ symbol: 'Sugar', statement: 'x', falsifiableBy: { strategy: 'turtle', needsAuthoring: true, sketch: 'y' } }]);
  assert.equal(v.rows[0].status, 'refused');
  assert.ok(v.rows[0].reasons.some((r) => /BOTH/.test(r.reason)));
});

test('needsAuthoring without a sketch is refused — a test you cannot even describe is not a hypothesis', () => {
  const ok = V([{ symbol: 'Sugar', statement: 'x', falsifiableBy: { needsAuthoring: true, sketch: 'cross-sectional carry' } }]);
  assert.equal(ok.rows[0].status, 'accepted');
  const bad = V([{ symbol: 'Sugar', statement: 'x', falsifiableBy: { needsAuthoring: true } }]);
  assert.equal(bad.rows[0].status, 'refused');
  assert.ok(bad.rows[0].reasons.some((r) => /no sketch/.test(r.reason)));
});

test('an unknown or unusable falsifier strategy is refused', () => {
  const unknown = V([{ symbol: 'Sugar', statement: 'x', falsifiableBy: { strategy: 'no_such_strategy' } }]);
  assert.equal(unknown.rows[0].status, 'refused');
  assert.ok(unknown.rows[0].reasons.some((r) => /unknown strategy/.test(r.reason)));

  // survgold is track-bound to Gold, so it is not a possible test for Sugar. A falsifier that can never
  // run is not a falsifier, and this is the same rule binding.validate applies to a binding.
  const trackBound = V([{ symbol: 'Sugar', statement: 'x', falsifiableBy: { strategy: 'survgold' } }]);
  assert.equal(trackBound.rows[0].status, 'refused');
  assert.ok(trackBound.rows[0].reasons.some((r) => /track-bound/.test(r.reason)));
});

test('a hypothesis must name a watchlist symbol and state a claim', () => {
  const noSymbol = V([{ statement: 'x', falsifiableBy: { strategy: 'turtle' } }]);
  assert.equal(noSymbol.rows[0].status, 'refused');
  const offList = V([{ symbol: 'Tesla', statement: 'x', falsifiableBy: { strategy: 'turtle' } }]);
  assert.ok(offList.rows[0].reasons.some((r) => /not on the watchlist/.test(r.reason)));
  const noStatement = V([{ symbol: 'Sugar', falsifiableBy: { strategy: 'turtle' } }]);
  assert.ok(noStatement.rows[0].reasons.some((r) => /must state a claim/.test(r.reason)));
  const notObject = V(['just a sentence']);
  assert.equal(notObject.rows[0].status, 'refused');
});

// ---------------------------------------------------------------- 3. the data the test needs

test('★ a hypothesis requiring an UNDECLARED source is refused, WITH a reason', () => {
  const v = V([{ symbol: 'Gold', statement: 'x', falsifiableBy: { strategy: 'turtle' }, requiredData: ['eua_carbon_futures'] }]);
  assert.equal(v.rows[0].status, 'refused');
  const reason = v.rows[0].reasons.find((r) => r.level === 'error').reason;
  assert.match(reason, /no source with id "eua_carbon_futures" is declared/);
  assert.ok(!/undefined/.test(reason), 'a refusal that says "undefined" is a refusal with no information in it');
});

test('★ a hypothesis requiring a NO-ROUTE source is refused in the catalogue\'s own words', () => {
  // OPEC publishes reports, not a queryable feed. Queuing a test for it is not optimism — it is a plan
  // that cannot be executed, and the refusal quotes the catalogue rather than re-wording the cause.
  const v = V([{ symbol: 'Oil', statement: 'x', falsifiableBy: { strategy: 'turtle' }, requiredData: ['opec_production'] }]);
  assert.equal(v.rows[0].status, 'refused');
  const reason = v.rows[0].reasons.find((r) => r.level === 'error').reason;
  assert.match(reason, /cannot be fetched/);
  // The catalogue's OWN sentence, not a paraphrase — asserted by identity, so a re-worded refusal here
  // becomes a failure rather than something nobody notices.
  assert.ok(reason.includes(tel.byId('opec_production').caveat), "the refusal must quote the catalogue verbatim");
  assert.match(reason, /provider has to be chosen/);
});

test('a missing adapter or credential is a TO-DO, not a refusal — the gap stays funded', () => {
  const missingAdapter = V([{ symbol: 'Gold', statement: 'x', falsifiableBy: { strategy: 'turtle' }, requiredData: ['fred_real_yield_10y'] }]);
  assert.equal(missingAdapter.rows[0].status, 'accepted');
  assert.ok(missingAdapter.rows[0].reasons.some((r) => r.level === 'warn' && /needs_adapter/.test(r.reason)));

  const ready = V([{ symbol: 'Gold', statement: 'x', falsifiableBy: { strategy: 'turtle' }, requiredData: ['cftc_cot_positioning'] }]);
  assert.equal(ready.rows[0].status, 'accepted');
  assert.equal(ready.rows[0].reasons.length, 0, 'a wired source needs no caveat');
});

test('a source declared for other instruments is a warn, not an error', () => {
  const v = V([{ symbol: 'Gold', statement: 'x', falsifiableBy: { strategy: 'turtle' }, requiredData: ['weather_brazil_frost'] }]);
  assert.equal(v.rows[0].status, 'accepted');
  assert.ok(v.rows[0].reasons.some((r) => /declares "weather_brazil_frost" for/.test(r.reason)));
});

test('requiredData accepts both shapes the model produced, and de-duplicates', () => {
  assert.deepEqual(bp.normaliseRequiredData(['a', { sourceId: 'b' }, { id: 'c' }, 'a', '', null]), ['a', 'b', 'c']);
  assert.deepEqual(bp.normaliseRequiredData('not an array'), []);
  assert.deepEqual(bp.normaliseRequiredData(undefined), []);
});

// ---------------------------------------------------------------- 4. the catalogue lookup itself

test('the catalogue can be looked up by id, which it could not before', () => {
  assert.equal(tel.byId('opec_production').id, 'opec_production');
  assert.equal(tel.byId('no_such_thing'), null);
  assert.equal(tel.byId(null), null);
  const r = tel.resolveRequirement('opec_production');
  assert.equal(r.known, true);
  assert.equal(r.testable, false);
  assert.equal(r.state, 'no_route');
  assert.ok(r.refuseReason);
  assert.ok(r.label && r.why, 'the resolution carries the catalogue context, not just a verdict');
});

test('resolveRequirement separates "cannot be done" from "not done yet"', () => {
  assert.equal(tel.resolveRequirement('cftc_cot_positioning').testable, true);
  assert.equal(tel.resolveRequirement('cftc_cot_positioning').state, 'ready');
  assert.equal(tel.resolveRequirement('venue_funding_basis').testable, true, 'wired internally, no route needed');
  assert.equal(tel.resolveRequirement('fred_cb_gold_holdings').testable, false, 'a series decision, not a credential');
  assert.equal(tel.resolveRequirement('unknown_id').testable, false);
  assert.equal(tel.resolveRequirement('unknown_id').known, false);
});

// ---------------------------------------------------------------- 5. the two structural guarantees

test('★ a REFUSED hypothesis does not make the reply unacceptable', () => {
  // The regression this exists for: an `error` on a hypothesis would flip `accepted` to false and take
  // the bindings beside it down with it — exactly how an empty-params note about Gold once killed the
  // scope decision about Sugar in the same reply.
  const v = bp.validateProposal(
    {
      bindings: [{ symbol: 'Gold', strategy: 'turtle', params: { donchianPeriod: 20 }, rationale: 'x' }],
      hypotheses: [{ symbol: 'Sugar', statement: 'no falsifier here' }],
    },
    { settings: { strategies: { enabled: ['turtle'], symbolScope: { Gold: ['turtle'] } } }, symbols: SYMBOLS, registry },
  );
  assert.equal(v.accepted, true, 'the bindings are clean and must land');
  assert.equal(v.hypotheses.refused.length, 1);
  assert.ok(!v.reasons.some((r) => r.level === 'error'), 'a refusal is a warn at reply level, never an error');
  assert.ok(v.reasons.some((r) => r.level === 'warn' && /REFUSED and recorded/.test(r.reason)), 'and it is still visible');
});

test('★ A HYPOTHESIS GRANTS NO SCOPE — structurally, not by promise', () => {
  const v = bp.validateProposal(
    {
      bindings: [],
      hypotheses: [
        { symbol: 'Sugar', statement: 'a perfectly admissible claim', falsifiableBy: { strategy: 'turtle' } },
        { symbol: 'Arabica Coffee', statement: 'another', falsifiableBy: { needsAuthoring: true, sketch: 'frost tail' } },
      ],
    },
    { settings: { strategies: { enabled: ['turtle'], symbolScope: { Gold: ['turtle'] } } }, symbols: SYMBOLS, registry },
  );
  assert.deepEqual(v.patch, {}, 'no parameter write');
  assert.deepEqual(v.scopeAdd, {}, 'and no scope addition — this is the guarantee that matters');
  assert.equal(v.hypotheses.accepted.length, 2);
  assert.equal(v.accepted, true);
});

test('an accepted hypothesis is recorded with its falsifier and its data', () => {
  const v = V([{
    symbol: 'Arabica Coffee',
    statement: 'A frost in the Brazilian belt is a tail event with no price precursor',
    falsifiableBy: { needsAuthoring: true, sketch: 'seasonal tail study' },
    requiredData: ['weather_brazil_frost'],
  }]);
  const row = v.rows[0];
  assert.equal(row.status, 'accepted');
  assert.equal(row.symbol, 'Arabica Coffee');
  assert.deepEqual(row.requiredData, ['weather_brazil_frost']);
  assert.equal(row.falsifiableBy.needsAuthoring, true);
});

// ---------------------------------------------------------------- 6. the loop closes

test('TRD-86: the reviewer RECORDS the hypotheses, not just validates them', () => {
  const src = code('trading/agent/bindingProposer.js');
  assert.match(src, /hypotheses: \(parsed\.proposal && parsed\.proposal\.hypotheses\)/, 'on the binding_proposal event');
  assert.match(src, /hypothesesVerdict:/);
  assert.match(src, /hypotheses: verdict\.hypotheses \|\|/, 'and returned to the caller');
  // The re-offer path must stay faithful to the decision it is re-offering.
  assert.match(src, /hypotheses: stranded\.hypotheses \|\| \[\]/);
});

test('TRD-86: the dashboard can actually SEE the hypotheses, which /binding could not be', () => {
  // `GET /binding` had no consumer at all before this: the reviewer has been making scope decisions — and,
  // since TRD-85, proposing additions an armed writer applies unattended — visible only to whoever called
  // the API by hand. A capability nobody can read is a capability nobody can correct.
  const js = code('trading/public/js/app.js');
  assert.match(js, /apiGet\('\/api\/trading\/binding'\)/, 'the panel reads the binding');
  assert.match(js, /hypothesesVerdict/);
  assert.match(js, /refreshBinding/);
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'trading', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('id="binding-body"'), 'and there is somewhere to render it');
  assert.ok(html.includes('id="btn-binding-propose"'));
});
