'use strict';
// TRD-71 — the live-eligibility gate, in OBSERVE mode.
//
// Two properties are tested harder than the rest, because they are the ones that decide whether this
// module can hurt the desk:
//   * observe mode CANNOT block (however damning the decision);
//   * an EXIT is never gated (refusing a stop to prove a point would trap a position).
// Everything here is pure. The registry coverage check parses source instead of requiring the
// registry, because strategies/index.js pulls congress.js -> store.js, which opens a DB pool.
const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const gate = require('../trading/agent/lab/gate');

// --- the real ids in the registry, parsed without requiring it --------------
function registryIds() {
  const src = code('trading/agent/strategies/index.js');
  const mods = {};
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/(\w+)'\)/g)) mods[m[1]] = m[2];
  const a = src.indexOf('const REGISTRY = {');
  assert.ok(a > -1, 'REGISTRY must exist');
  const b = src.indexOf('};', a);
  assert.ok(b > a, 'REGISTRY block guard');
  const keys = [...src.slice(a, b).matchAll(/\[(\w+)\.id\]\s*:/g)].map((m) => m[1]);
  assert.ok(keys.length >= 10, `registry parse found only ${keys.length} keys - the parse is broken, not the registry`);
  return keys.map((k) => {
    const file = mods[k];
    assert.ok(file, `no require() found for ${k}`);
    const body = code(`trading/agent/strategies/${file}.js`);
    const idm = body.match(/\bid:\s*'([^']+)'/);
    assert.ok(idm, `no id: found in ${file}.js`);
    return idm[1];
  });
}

// --- fixtures: the live rows as they actually stand ------------------------
const CANDS = [
  { id: 20, strategy: 'turtle', symbol: 'Gold', status: 'archived', verdict: null },
  { id: 21, strategy: 'turtle', symbol: 'Oil', status: 'archived', verdict: null },
  { id: 22, strategy: 'turtle', symbol: 'Oil', status: 'archived', verdict: null },
  { id: 99, strategy: 'turtle', symbol: 'Silver', status: 'frozen', verdict: 'PASS' },
];
const cfg = (o = {}) => ({ candidates: CANDS, overrides: {}, enforce: false, ...o });
const entry = (strategy = 'turtle') => ({ type: 'entry', direction: 'buy', basis: 'test', strategy });

test('TRD-71: every registered strategy is mapped or explicitly declared UNCOVERED', () => {
  for (const id of registryIds()) {
    const mapped = !!gate.speakersFor(id);
    const uncovered = gate.isUncovered(id);
    assert.ok(mapped || uncovered, `"${id}" is neither mapped in LAB_SPEAKERS nor declared in UNCOVERED - a new strategy must make this choice deliberately`);
    assert.ok(!(mapped && uncovered), `"${id}" is both mapped and declared uncovered`);
  }
});

test('TRD-71: no stale entries - every declared id is a real registered strategy', () => {
  const ids = registryIds();
  for (const k of Object.keys(gate.LAB_SPEAKERS)) assert.ok(ids.includes(k), `LAB_SPEAKERS["${k}"] is not a registered strategy`);
  for (const k of gate.UNCOVERED) assert.ok(ids.includes(k), `UNCOVERED lists "${k}", which is not a registered strategy`);
});

test('TRD-71: ★ survgold and survoil DO NOT inherit the turtle verdict (B1: independent)', () => {
  // This test previously asserted the OPPOSITE, and the reversal is the point of the decision. The
  // turtle candidates were archived PRECISELY SO the wrappers could run - the archival IS the promotion
  // - so under "inherits" the gate would read that archival as a refusal and the design decision that
  // created the wrappers would become the reason they are blocked. A self-blocking rule is not a rule.
  assert.equal(gate.speakersFor('survgold'), null, 'a wrapper must not speak for its parent candidates');
  assert.equal(gate.speakersFor('survoil'), null);
  assert.ok(gate.isUncovered('survgold'), 'and it must be declared UNCOVERED instead');
  assert.ok(gate.isUncovered('survoil'));
});

test('TRD-71: a wrapper is EXEMPT, not refused, even when the parent case is archived', () => {
  // The candidates ARE present with archived status - the inheritance reading would refuse. Independence
  // means they are simply not consulted.
  const r = gate.observe(cfg(), { strategyId: 'survgold', symbol: 'Gold' });
  assert.equal(r.action, 'exempt');
  assert.equal(r.outcome, 'exempt');
  assert.equal(r.candidates.length, 0, 'the archived turtle candidates are not consulted for a wrapper');
  assert.match(r.reason, /not a pass/i, 'an exemption must say it is not a validation');
});

test('TRD-71: a turtle pair is would_refuse because its candidates are archived with no verdict', () => {
  const r = gate.observe(cfg(), { strategyId: 'turtle', symbol: 'Gold' });
  assert.equal(r.action, 'would_refuse');
  assert.equal(r.outcome, 'archived');
  assert.match(r.reason, /archived/);
});

test('TRD-71: a PASS candidate is allowed', () => {
  const r = gate.observe(cfg(), { strategyId: 'turtle', symbol: 'Silver' });
  assert.equal(r.action, 'allow');
  assert.equal(r.outcome, 'pass');
});

test('TRD-71: an explicit override with a reason turns archived into an allow', () => {
  const r = gate.observe(cfg({ overrides: { 'turtle:Gold': 'owner decision 2026-09-15' } }), { strategyId: 'turtle', symbol: 'Gold' });
  assert.equal(r.action, 'allow');
  assert.equal(r.outcome, 'override');
  assert.match(r.reason, /owner decision/);
});

test('TRD-71: an override with no reason does not turn archived into an allow', () => {
  const r = gate.observe(cfg({ overrides: { 'turtle:Gold': { reason: '  ' } } }), { strategyId: 'turtle', symbol: 'Gold' });
  assert.equal(r.action, 'would_refuse');
});

test('TRD-71: unmapped vs exempt are DIFFERENT findings', () => {
  const unmapped = gate.observe(cfg(), { strategyId: 'wat', symbol: 'Gold' });
  assert.equal(unmapped.action, 'unmapped', 'an unclassified strategy is a MAPPING DEFECT');
  assert.equal(unmapped.needsMapping, true, 'and it must stay actionable rather than become exempt by accident');

  const exempt = gate.observe(cfg(), { strategyId: 'meanrev', symbol: 'Gold' });
  assert.equal(exempt.action, 'exempt', 'a DECLARED uncovered strategy is a policy outcome');
  assert.equal(exempt.needsMapping, false);
});

test('TRD-71: a declared-UNCOVERED strategy is EXEMPT and the basis is recorded (B2)', () => {
  const r = gate.observe(cfg(), { strategyId: 'meanrev', symbol: 'Gold' });
  assert.equal(r.action, 'exempt');
  assert.equal(r.outcome, 'exempt');
  assert.match(r.basis, /declared UNCOVERED/);
});

test('TRD-71: a MAPPED strategy with no candidate for this symbol is also exempt, with a different basis', () => {
  const r = gate.observe(cfg(), { strategyId: 'turtle', symbol: 'Bitcoin' });
  assert.equal(r.action, 'exempt');
  assert.match(r.basis, /mapped, but no lab candidate/);
});

test('TRD-71: an empty candidate list can never produce a refusal', () => {
  // The live failure mode this guards: a lab read that returned nothing must not read as "refuse".
  const r = gate.observe(cfg({ candidates: [] }), { strategyId: 'turtle', symbol: 'Gold' });
  assert.notEqual(r.action, 'would_refuse');
  assert.equal(r.action, 'exempt');
});

test('TRD-71: ★ an EXEMPTION cannot block, under enforce, with no special branch', () => {
  // apply() blocks only on `would_refuse`, so an exemption is non-blocking BY CONSTRUCTION rather than
  // by an extra branch that could be got wrong.
  const decision = gate.observe(cfg({ enforce: true }), { strategyId: 'survgold', symbol: 'Gold' });
  assert.equal(decision.action, 'exempt');
  const sig = entry();
  const out = gate.apply(sig, decision);
  assert.equal(out.signal, sig, 'an exempt strategy must still be able to open a position');
  assert.notEqual(out.decision.blocked, true);
});

// ---------------------------------------------------------------------------
// The two safety properties
// ---------------------------------------------------------------------------

test('TRD-71: OBSERVE MODE CANNOT BLOCK, however damning the decision', () => {
  const decision = gate.observe(cfg({ enforce: false }), { strategyId: 'turtle', symbol: 'Gold' });
  assert.equal(decision.action, 'would_refuse');
  const sig = entry();
  const out = gate.apply(sig, decision);
  assert.equal(out.signal, sig, 'the signal must come back untouched in observe mode');
  assert.equal(out.decision.action, 'would_refuse', 'and the decision must still be recorded');
  assert.notEqual(out.decision.blocked, true);
  assert.equal(out.flat, undefined);
});

test('TRD-71: ENFORCE does suppress an entry', () => {
  const decision = gate.observe(cfg({ enforce: true }), { strategyId: 'turtle', symbol: 'Gold' });
  const out = gate.apply(entry(), decision);
  assert.equal(out.signal, null);
  assert.equal(out.decision.blocked, true);
  assert.match(out.flat, /^gated: /);
});

test('TRD-71: AN EXIT IS NEVER GATED, even under enforce', () => {
  const decision = gate.observe(cfg({ enforce: true }), { strategyId: 'turtle', symbol: 'Gold' });
  for (const t of ['exit']) {
    const sig = { type: t, direction: 'sell', basis: 'stop level 4270 hit', strategy: 'desk' };
    const out = gate.apply(sig, decision);
    assert.equal(out.signal, sig, 'an exit must survive enforcement');
    assert.equal(out.decision, null, 'and the decision is dropped, so nothing downstream can act on it');
  }
});

test('TRD-71: enforce does not block an ALLOW', () => {
  const decision = gate.observe(cfg({ enforce: true }), { strategyId: 'turtle', symbol: 'Silver' });
  const out = gate.apply(entry(), decision);
  assert.ok(out.signal, 'an allowed entry must pass');
  assert.ok(!out.decision.blocked);
});

test('TRD-71: apply is null-safe and never mutates its input', () => {
  const sig = entry();
  const frozen = JSON.stringify(sig);
  gate.apply(sig, gate.observe(cfg({ enforce: true }), { strategyId: 'turtle', symbol: 'Gold' }));
  assert.equal(JSON.stringify(sig), frozen, 'apply must not mutate the signal');
  assert.equal(gate.apply(null, null).signal, null);
});

// ---------------------------------------------------------------------------
// The ledger — the "see which ones are eligible" artefact
// ---------------------------------------------------------------------------

test('TRD-71: the ledger has one row per in-scope pair, and reports the EXEMPT SHARE', () => {
  // The real shape after choosing A-prime and reverting A: the two wrappers are in scope and BOTH are
  // exempt, because neither has a lab case of its own.
  const pairs = [
    { strategyId: 'survgold', symbol: 'Gold' },
    { strategyId: 'survoil', symbol: 'Oil' },
    { strategyId: 'turtle', symbol: 'Silver' },
  ];
  const rows = gate.ledger(cfg(), pairs);
  assert.equal(rows.length, 3);
  const s = gate.summarise(rows);
  assert.equal(s.total, 3);
  assert.equal(s.exempt, 2, 'the two wrappers run on an exemption, not on a lab case');
  assert.equal(s.allow, 1, 'turtle/Silver has an actual PASS');
  assert.equal(s.would_refuse, 0);
  assert.equal(s.byOutcome.pass, 1);
  assert.equal(s.byOutcome.exempt, 2);
  assert.equal(s.exemptSharePct, 67, 'the number the ledger exists to make visible');
});

test('TRD-71: an unclassified strategy shows up as unmapped in the summary, not as exempt', () => {
  const s = gate.summarise(gate.ledger(cfg(), [{ strategyId: 'brandnew', symbol: 'Gold' }]));
  assert.equal(s.unmapped, 1);
  assert.equal(s.exempt, 0);
});

test('TRD-71: configFrom defaults to observing and NOT enforcing', () => {
  const c = gate.configFrom({}, CANDS);
  assert.equal(c.observe, true);
  assert.equal(c.enforce, false, 'enforcement must never be on by default');
  assert.equal(gate.configFrom({ gate: { enforce: true } }, CANDS).enforce, true);
  assert.equal(gate.configFrom({ gate: { observe: false } }, CANDS).observe, false);
});

test('TRD-71: the candidate read cannot throw (a lab read must never break a wake)', () => {
  const src = code('trading/agent/lab/gate.js');
  const a = src.indexOf('async function loadCandidates');
  assert.ok(a > -1, 'loadCandidates must exist');
  const slice = src.slice(a, src.indexOf('function configFrom', a));
  assert.ok(slice.length > 80, 'slice guard');
  assert.match(slice, /try\s*\{/, 'the store read must be inside a try');
  assert.match(slice, /catch/, 'and must have a catch - a throw here would break the wake');
  assert.match(slice, /candidatesUnavailable/, 'a failed read must be reported, not silently empty');
});

// ---------------------------------------------------------------------------
// The change-signature — "will adapt to change of data", made checkable
// ---------------------------------------------------------------------------

test('TRD-71: the signature is order-independent', () => {
  const pairs = [{ strategyId: 'survgold', symbol: 'Gold' }, { strategyId: 'survoil', symbol: 'Oil' }];
  const rows = gate.ledger(cfg(), pairs);
  assert.equal(gate.signature(rows), gate.signature([...rows].reverse()));
});

test('TRD-71: the signature MOVES when a verdict changes, and only then', () => {
  const pairs = [{ strategyId: 'turtle', symbol: 'Silver' }];
  const pass = gate.signature(gate.ledger(cfg(), pairs));
  const withFail = gate.signature(gate.ledger({ candidates: [{ id: 99, strategy: 'turtle', symbol: 'Silver', status: 'frozen', verdict: 'FAIL' }] }, pairs));
  assert.notEqual(pass, withFail, 'a changed verdict must move the signature, or the desk will never log it');

  // same inputs -> same signature (no clock, no ordering, no randomness)
  assert.equal(pass, gate.signature(gate.ledger(cfg(), pairs)));
});

test('TRD-71: an empty ledger has an empty signature', () => {
  assert.equal(gate.signature([]), '');
  assert.equal(gate.signature(null), '');
});

test('TRD-71: the wake logs the ledger only on a CHANGE, and cannot fail the wake', () => {
  const src = code('trading/agent/wakePipeline.js');
  const a = src.indexOf("require('./lab/gate').signature");
  assert.ok(a > -1, 'the wake must compute the ledger signature');
  const before = src.lastIndexOf('try {', a);
  assert.ok(before > -1 && a - before < 400, 'the ledger block must be inside a try');
  const slice = src.slice(before, src.indexOf('unevaluable instruments', a));
  assert.ok(slice.length > 200, 'slice guard');
  assert.match(slice, /sig\s*!==\s*live\.labGateSig/, 'it must log only when the signature changes');
  assert.match(slice, /catch/, 'and it must swallow a failure - observe mode never breaks a wake');
  assert.match(code('trading/agent/wakePipeline.js'), /labGateSig/, 'the signature must be held on the wake state');
});

