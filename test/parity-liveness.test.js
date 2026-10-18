'use strict';
// TRD-41/TRD-91 (2026-09-18): the retirement safety net must act on the EFFECTIVE strategy set.
//
// The defect this pins: the retire gate read `enabled.includes(strategy)`, but an explicit symbolScope
// entry REPLACES the enabled list for that symbol. rsi2 was live on Bitcoin through `symbolScope.Bitcoin`
// while absent from `enabled` — and it was the strategy with the LARGEST closed sample (17 R-usable
// trades). So the harness could JUDGE it and could never ACT on it, and a retire would have written only
// `enabled` (which never contained it) and left the scope entry keeping it live: a retire that reports
// success and changes nothing. Both halves are pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { strategyLiveness, stripStrategy } = require('../trading/agent/analytics');

// The LIVE configuration on 2026-09-18.
const ENABLED = ['survgold', 'survoil'];
const SCOPE = { Bitcoin: ['rsi2'], Gold: ['survgold'], Oil: ['survoil'], others: [] };

test('a strategy live ONLY through symbolScope counts as live', () => {
  const L = strategyLiveness(ENABLED, SCOPE);
  assert.equal(L.isLive('rsi2'), true, 'rsi2 is live on Bitcoin — the gate must see that');
  assert.equal(ENABLED.includes('rsi2'), false, 'and it is NOT in enabled, which is why the old gate missed it');
  assert.deepEqual(L.scopeSymbolsFor('rsi2'), ['Bitcoin']);
});

test('a strategy in enabled AND scope is live, and reports no scope-only note', () => {
  const L = strategyLiveness(ENABLED, SCOPE);
  assert.equal(L.isLive('survgold'), true);
  assert.equal(L.isLive('survoil'), true);
  assert.deepEqual(L.scopeSymbolsFor('survgold'), ['Gold']);
});

test('a strategy in neither is not live', () => {
  const L = strategyLiveness(ENABLED, SCOPE);
  assert.equal(L.isLive('turtle'), false);
  assert.equal(L.isLive('multi'), false);
});

test('enabled is not a master switch — the real desk configuration proves it', () => {
  // With others:[] and every tradable symbol pinned to its own entry, `enabled` decides nothing at all.
  const L = strategyLiveness(ENABLED, SCOPE);
  assert.equal(L.isLive('rsi2'), true);
  // and emptying `enabled` would not stop the desk:
  const emptied = strategyLiveness([], SCOPE);
  assert.equal(emptied.isLive('rsi2'), true, 'clearing enabled must not read as "stopped" when scope names strategies');
  assert.equal(emptied.isLive('survgold'), true);
});

test('reachableAnywhere needs a UNIVERSE, and an ABSENT scope key falls back to enabled (TRD-116)', () => {
  // ★ TRD-116, corrected 2026-09-25. The rule is: explicit entry > 'others'/'*' default > the GLOBAL enabled
  // list. This helper implemented only the first two, so an enabled strategy on a symbol with NO entry was
  // reported as unable to run anywhere — while the resolver the desk trades on ran it on every such symbol.
  // The fix required a universe, because "can this run anywhere" is unanswerable without the symbols that can
  // trade, and the applicability filter, because a strategy can be named and still be track-bound away.
  const UNIVERSE = ['Gold', 'Bitcoin', 'Oil'];

  // (a) An explicit EMPTY entry is what makes a symbol unable to run, and `others: []` makes that true for
  //     every symbol with no entry of its own.
  const L = strategyLiveness(['turtle'], { Bitcoin: ['rsi2'], others: [] }, UNIVERSE);
  assert.equal(L.isLive('turtle'), true, 'it is in enabled...');
  assert.equal(L.reachableAnywhere('turtle'), false, '...but every symbol resolves to an empty list');

  // (b) ★ THE NON-VACUITY CASE. Drop the default key and the SAME settings now reach every symbol, because an
  //     ABSENT key falls back to `enabled`. The old reading called this unreachable, which is the defect.
  const noDefault = strategyLiveness(['turtle'], { Bitcoin: ['rsi2'] }, UNIVERSE);
  assert.equal(noDefault.reachableAnywhere('turtle'), true, 'an ABSENT key falls back to the global list');
  assert.equal(strategyLiveness(['turtle'], {}, UNIVERSE).reachableAnywhere('turtle'), true,
    'an empty scope MAP is not an empty scope');

  // (c) the 'others' / '*' default restores reachability
  const withDefault = strategyLiveness(['turtle'], { Bitcoin: ['rsi2'], others: ['turtle'] }, UNIVERSE);
  assert.equal(withDefault.reachableAnywhere('turtle'), true);
  const withStar = strategyLiveness(['turtle'], { '*': ['turtle'] }, UNIVERSE);
  assert.equal(withStar.reachableAnywhere('turtle'), true);

  // (d) ★ WITHOUT A UNIVERSE THE QUESTION IS UNANSWERABLE, AND THE ANSWER IS "UNKNOWN", NOT "NO". It fails
  //     QUIET (`false`) so that a caller which forgets to check lands on under-claiming rather than lying —
  //     and `reachabilityKnown` is the flag that lets a caller refuse to make the claim at all.
  const blind = strategyLiveness(['turtle'], { others: [] });
  assert.equal(blind.reachabilityKnown, false, 'the caller must be able to tell it measured nothing');
  assert.equal(blind.reachableAnywhere('turtle'), false);
});

test('an absent scope, or an absent enabled list, does not throw', () => {
  assert.equal(strategyLiveness().isLive('x'), false);
  assert.equal(strategyLiveness(['x']).isLive('x'), true);
  assert.equal(strategyLiveness(['x'], {}).reachableAnywhere('x'), false);
  // a non-array scope entry must not be treated as naming anything
  assert.equal(strategyLiveness([], { Gold: 'survgold' }).isLive('survgold'), false);
});
test('retiring a scope-only strategy strips the scope entry — a retire that writes nothing is a bug', () => {
  // The live case: rsi2 is NOT in enabled, so filtering `enabled` alone leaves the scope entry that
  // keeps it tradeable. The retire would log success and change nothing.
  const s = stripStrategy(ENABLED, SCOPE, 'rsi2');
  assert.deepEqual(s.removedFrom, ['symbolScope.Bitcoin']);
  assert.deepEqual(s.strategy.symbolScope, { Bitcoin: [] });
  assert.equal(s.effective, true);
  assert.equal(s.strategy.enabled.includes('rsi2'), false);
  // and Bitcoin now has NO strategies, which is the intended effect (the desk stops trading it)
  assert.deepEqual(s.strategy.symbolScope.Bitcoin, []);
});

test('retiring an enabled strategy strips it from enabled and any scope entry', () => {
  const s = stripStrategy(ENABLED, SCOPE, 'survoil');
  assert.deepEqual(s.removedFrom, ['enabled', 'symbolScope.Oil']);
  assert.deepEqual(s.strategy.enabled, ['survgold']);
  assert.deepEqual(s.strategy.symbolScope, { Oil: [] });
});

test('a strategy in neither list is reported as an INEFFECTIVE retire, not silently accepted', () => {
  const s = stripStrategy(ENABLED, SCOPE, 'multi');
  assert.equal(s.effective, false, 'nothing contained it, so the retire could not have changed anything');
  assert.deepEqual(s.removedFrom, []);
  // no scope patch is emitted when nothing needs stripping (an empty object would be a pointless write)
  assert.equal(s.strategy.symbolScope, undefined);
});

test('stripStrategy does not mutate its inputs', () => {
  const enabled = ['a', 'b'];
  const scope = { Gold: ['a'], Oil: ['b'] };
  stripStrategy(enabled, scope, 'a');
  assert.deepEqual(enabled, ['a', 'b'], 'enabled must not be mutated in place');
  assert.deepEqual(scope.Gold, ['a'], 'the scope lists must not be mutated in place');
});

test('the parity harness keys the retire gate on liveness, not on enabled', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'analytics.js'), 'utf8');
  const lines = src.split(/\r?\n/);
  const gate = lines.find((l) => l.includes("verdict.state === 'retire'"));
  assert.ok(gate, 'the retire gate is gone entirely');
  assert.doesNotMatch(
    gate,
    /enabled\.includes\(/,
    `REGRESSION: keying the gate on \`enabled\` makes a scope-live strategy unretirable. got: ${gate.trim()}`
  );
  // the condition must trace back to the effective-liveness function, whatever the local is called
  const gateVar = /&&\s*([A-Za-z_$][\w$]*)\s*\)/.exec(gate);
  assert.ok(gateVar, `could not read the gate's condition variable from: ${gate.trim()}`);
  const assignedFromLive = lines.some((l) => new RegExp(`const\\s+${gateVar[1]}\\s*=\\s*isLive\\(`).test(l));
  assert.ok(assignedFromLive, `${gateVar[1]} is not assigned from isLive(...) — the gate is not testing effective liveness`);
});

test('retiring a strategy strips it from symbolScope too, or the write is a no-op', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'analytics.js'), 'utf8');
  assert.match(src, /stripStrategy\(enabled, scope, s\.strategy, \(settings\.strategies \|\| \{\}\)\.retired\)/,
    'the retire must go through stripStrategy — and must pass the existing retired list, or the memory is lost on the first write');
  assert.match(src, /strategies: strip\.strategy/, 'the computed strip must actually be written');
  assert.match(src, /removedFrom: strip\.removedFrom/, 'the retire event must record WHERE it was removed from');
  // and an ineffective retire must not be logged as a success
  assert.match(src, /if \(!strip\.effective\)/, 'an ineffective retire must be caught, not logged');
});

// --- TRD-91: a retire must be REMEMBERED, not merely applied (added 2026-09-20) ---------------------
//
// Stripping the two lists was not durable. `bindingApply.applyScope` is the one writer that may widen
// unattended, and it could put the same pair back — which it did: rsi2 was retired, then re-added by the
// scope widener twelve minutes later (TRD-103). Disarming that widener was a SETTINGS change, so the guard
// lasted only until a flag was flipped back. The retired list is the memory the widener has to respect.

test('★ a retire RECORDS the decision, so the widener cannot put the strategy back', () => {
  const s = stripStrategy(ENABLED, SCOPE, 'rsi2', ['turtle']);
  assert.deepEqual(s.strategy.retired, ['turtle', 'rsi2'],
    'the retire must add itself to the list applyScope reads');
  assert.deepEqual(s.strategy.symbolScope, { Bitcoin: [] }, 'and it must still strip the lists');
});

test('the retired list is idempotent, and survives an absent or malformed input', () => {
  const once = stripStrategy(ENABLED, SCOPE, 'rsi2', ['turtle']);
  const twice = stripStrategy(ENABLED, SCOPE, 'rsi2', once.strategy.retired);
  assert.deepEqual(twice.strategy.retired, ['turtle', 'rsi2'],
    'a second pass must not duplicate the id, or the list grows every parity week');
  assert.deepEqual(stripStrategy(ENABLED, SCOPE, 'x').strategy.retired, ['x'], 'absent list');
  assert.deepEqual(stripStrategy(ENABLED, SCOPE, 'x', null).strategy.retired, ['x'], 'null list');
  assert.deepEqual(stripStrategy(ENABLED, SCOPE, 'x', 'rsi2').strategy.retired, ['x'],
    'a non-array (a settings round trip gone wrong) must not throw or index into a string');
});

// --- TRD-80: the run-in factor is per STRATEGY, not per desk (added 2026-09-20) ----------------------
//
// `learning.parityValidated` is DERIVED by the parity harness as "at least one enabled strategy reached
// accept", and `risk.js` read it as ONE multiplier for every symbol. So the first strategy to earn full size
// handed it to every other enabled strategy — the spillover `repro/parity-horizon.js` printed as "survgold
// hands survoil full size 89 weeks before survoil has any". The flag stays as an explicit desk-wide override
// (the tuner reads it as its live-desk gate); the default is now the strategy's own verdict.

const risk = require('../trading/agent/risk');

test("★ one strategy's parity evidence does not size another strategy", () => {
  const s = { learning: { parityValidated: false, validatedStrategies: ['survgold'] } };
  assert.strictEqual(risk.runInFactorFor('survgold', s), 1, 'its own evidence earns full size');
  assert.strictEqual(risk.runInFactorFor('survoil', s), 0.5,
    'THE DEFECT: the desk-wide flag would have spent survgold evidence on survoil');
});

test('the desk-wide flag still works, as an EXPLICIT override', () => {
  assert.strictEqual(risk.runInFactorFor('anything', { learning: { parityValidated: true } }), 1);
  assert.strictEqual(risk.runInFactorFor('anything', { learning: { parityValidated: false } }), 0.5);
});

test('runInFactorFor is fail-closed on every malformed shape', () => {
  for (const s of [undefined, {}, { learning: null }, { learning: {} },
    { learning: { validatedStrategies: 'survgold' } }, { learning: { validatedStrategies: null } }]) {
    assert.strictEqual(risk.runInFactorFor('survoil', s), 0.5, `half size for ${JSON.stringify(s)}`);
  }
});

test('★ risk.js sizes from the resolver, and analytics WRITES the evidence it reads', () => {
  const { code } = require('./_source');
  const riskSrc = code('trading/agent/risk.js');
  assert.ok(!/settings\.learning\?\.parityValidated \? 1 : 0\.5/.test(riskSrc),
    'the desk-wide expression must not size anything any more');
  assert.match(riskSrc, /const runInFactor = runInFactorFor\(proposal\.strategy, settings\)/);
  assert.match(riskSrc, /runInFactor: runInFactorFor\(proposal\.strategy, settings\)/,
    'the decision log must report the SAME factor the size used, or the log explains a different trade');

  const aSrc = code('trading/agent/analytics.js');
  assert.match(aSrc, /learning: \{ validatedStrategies: acceptedIds \}/,
    'the harness has the accepted list and must persist it, or the reader has nothing to read');
  assert.match(aSrc, /JSON\.stringify\(prevAcceptedIds\) !== JSON\.stringify\(acceptedIds\)/,
    'written on a change of the LIST, not only when the boolean flips — the set can change while it does not');
});
