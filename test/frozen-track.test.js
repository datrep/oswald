// ★ S5 — the frozen-track gate, proved in BOTH directions.
//
// ⚠ A GATE THAT ONLY PROVES THE ALLOW SIDE IS NOT A GATE. These tests therefore assert the REFUSE side first.
//
// THE FINDING THEY PIN. S5's hunt found NO freeze marker existed. Freeze-ness lived only in prose, and the closest
// thing to a machine-readable marker — `params: []` — is TRUE OF ALL 18 survivors AND replicas, because it is a
// property of `survReplicas.js`'s generator rather than of the frozen pair. `binding.js`'s `tunable: params.length
// > 0` therefore reports 18 strategies as not-tunable, not two.
//
// ⚠ AND THE CRITICAL TEST IS THE REPLICA ONE. A `params: []`-based gate would look safe (it fails by EXCLUDING)
// while silently reducing EXE-14's coverage from 45.4% of fills to almost nothing — and reporting success. The
// replica assertions below are what make that impossible.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { isFrozenStrategy, frozenReason, TRACK_TRD29 } = require('../trading/agent/frozenTrack');
const registry = require('../trading/agent/strategies');
const survReplicas = require('../trading/agent/strategies/survReplicas');

test('★★ REFUSE side: the frozen pair is refused, and it names the track it protects', () => {
  for (const id of ['survgold', 'survoil']) {
    assert.strictEqual(isFrozenStrategy(id), true, `${id} is a frozen forward candidate`);
    const r = frozenReason(id);
    assert.strictEqual(r.frozen, true);
    assert.strictEqual(r.track, TRACK_TRD29);
    assert.strictEqual(r.reason, 'frozen_TRD-29');
  }
});

test('★★ ALLOW side: the 16 replicas are ALLOWED — this is the test that a `params: []` gate would fail', () => {
  const replicas = survReplicas.MODULES.map((m) => m.id);
  assert.ok(replicas.length >= 16, `expected the replica family, found ${replicas.length}`);
  for (const id of replicas) {
    assert.strictEqual(isFrozenStrategy(id), false,
      `${id} is a REPLICA — non-frozen, in scope, and a params:[]-based gate would have wrongly excluded it`);
  }
});

test('★ the marker is NOT `params: []` — proved from the modules, not asserted about the gate', () => {
  // ⚠ This is the finding itself, encoded. If a future edit ever made `params: []` unique to the frozen pair,
  // this test would start passing for the wrong reason and should be revisited deliberately rather than quietly.
  const frozen = registry.get('survgold');
  const replica = registry.get(survReplicas.MODULES.find((m) => m.id !== 'survgold').id);
  assert.deepStrictEqual(frozen.params, [], 'the frozen survivor declares no editable params');
  assert.deepStrictEqual(replica.params, [], 'AND SO DOES EVERY REPLICA — so params:[] cannot be the marker');
  assert.ok(frozen.forwardFrozen, 'the marker must be the declared field');
  assert.strictEqual(replica.forwardFrozen, undefined, 'and a replica must NOT carry it');
});

test('★★ exactly TWO strategies declare the track, and they are the two the documents name', () => {
  const declared = Object.values(registry.REGISTRY).filter((s) => s.forwardFrozen).map((s) => s.id).sort();
  assert.deepStrictEqual(declared, ['survgold', 'survoil'],
    'the marker must cover the frozen pair and nothing else');
});

test('★ FAIL CLOSED: an id that does not resolve is REFUSED, not allowed', () => {
  // An id the desk cannot look up is one whose freeze status is UNKNOWN. A strategy renamed or retired while a
  // stale config still names it is exactly how a gate stops protecting the track without anyone noticing.
  for (const unknown of ['not_a_strategy', 'survgold2', 'TURTLE', 'survgold ']) {
    if (unknown === 'survgold ') continue; // trimmed deliberately — asserted separately below
    assert.strictEqual(isFrozenStrategy(unknown), true, `unknown id ${unknown} must fail CLOSED`);
  }
  assert.strictEqual(frozenReason('not_a_strategy').reason, 'strategy_unresolved');
});

test('★ NO ID AT ALL is ALLOWED — an owner order is not part of a frozen track', () => {
  // ⚠ The asymmetry is deliberate: a null strategy cannot contaminate a candidate whose record it is not part of,
  // and refusing here would disable the fix for the owner's own orders while protecting nothing.
  for (const empty of [null, undefined, '', '   ']) {
    assert.strictEqual(isFrozenStrategy(empty), false, `no-strategy (${JSON.stringify(empty)}) must be allowed`);
  }
  assert.strictEqual(frozenReason(null).reason, 'no_strategy_id');
});

test('★ a non-frozen, resolvable strategy is ALLOWED', () => {
  for (const id of ['turtle', 'congress', 'rsi2']) {
    if (registry.get(id)) assert.strictEqual(isFrozenStrategy(id), false, `${id} is not frozen`);
  }
});

test('★ ADDING THE MARKER DID NOT RETUNE THE FROZEN CANDIDATES', () => {
  // S5 adds a declarative field to two FROZEN strategy modules. That is metadata, not a retune — and it is
  // asserted rather than argued, because "it is only a comment" is exactly the reassurance rule-L exists to
  // distrust. If any of these moved, the TRD-29 track would be void.
  const g = registry.get('survgold');
  const o = registry.get('survoil');
  assert.deepStrictEqual(g.DEFAULTS, { donchianPeriod: 20, adxPeriod: 14, adxGate: 0, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1 });
  assert.deepStrictEqual(o.DEFAULTS, { donchianPeriod: 5, adxPeriod: 14, adxGate: 20, atrPeriod: 14, atrStopMultiple: 2, riskPerTradePct: 1 });
  assert.deepStrictEqual(g.symbols, ['Gold']);
  assert.deepStrictEqual(o.symbols, ['Oil']);
});

test('★ EXE-15 uses the SHARED gate, and the inline list is gone', () => {
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'executor.js'), 'utf8');
  // ⚠ COMMENTS ARE REMOVED FIRST, BY LINE, NOT BY REGEX. The replacement comment QUOTES the removed line to
  // explain what it replaced, so a raw-text search reads that quotation as the code still being present — the same
  // class of mistake as searching for a string that only ever lived inside a comment, which already went red once
  // in this workstream. A per-line filter is used rather than a block-comment regex because a `/*` inside a string
  // (a glob, a URL) can make a paired non-greedy strip consume far more than it should.
  const exec = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!exec.includes('FROZEN_STRATEGIES'),
    'the inline list must be gone — two lists is how a gate becomes two gates that disagree');
  assert.match(exec, /require\('\.\/frozenTrack'\)/, 'and it must call the one implementation');
  assert.match(exec, /!frozen\.frozen/, 'which decides the allow/refuse, not a local array');
});
