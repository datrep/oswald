// test/exit-tolerance-precheck.test.js — TRD-TRL-1 defect 1(b): the small-loss tolerance must be evaluated
// BEFORE the chair, not after it.
//
// THE MEASUREMENT THIS PINS. Over the 23 trailing-stop fires in the ledger: 12 placed, 10 deferred by the
// tolerance gate, 1 already closed. Every one of the 10 deferrals carried `chairVote: "yes"` (0.69-0.82) and the
// executor then refused to place the order — and on 7 of them the deferred exit was the wake's ONLY signal, so
// the whole three-call deliberation bought a decision that could never be placed.
//
// WHAT IS ASSERTED, AND WHY EACH HALF IS NEEDED.
//   1. `deliberationSymbols` drops a suppressed exit and keeps everything else — by BEHAVIOUR. This is possible
//      only because the rule was extracted to its own module; `aggregator` opens a DB pool and cannot be
//      required from a unit test (test/_source.js says so), so an inline copy would be unpinnable here.
//   2. The pre-check provably runs BEFORE the deliberation in `wakePipeline`. Text-only, but the ORDER is the
//      entire fix, and a later refactor that moves the block back would otherwise be invisible.
//   3. The EXECUTION-step gate is still present. The pre-check is a cost gate; deleting the safety gate while
//      adding it would look identical from the outside and would be a far worse change.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const { deliberationSymbols, suppressedCount } = require('../trading/agent/deliberationScope');

const sym = (symbol, type) => ({ symbol, status: 'ok', signal: { type, direction: 'sell', basis: `${type} basis` } });
const noSignal = (symbol) => ({ symbol, status: 'ok', signal: null });
const errored = (symbol) => ({ symbol, status: 'error', signal: { type: 'exit' } });

test('a suppressed exit is not proposed to the chairs, and nothing else is disturbed', () => {
  const quant = { symbols: [sym('Bitcoin', 'exit'), sym('Gold', 'entry'), sym('Oil', 'exit')] };
  const before = deliberationSymbols(quant).map((s) => s.symbol);
  assert.deepStrictEqual(before, ['Bitcoin', 'Oil', 'Gold'], 'control: exits first, then entries');

  const after = deliberationSymbols(quant, { suppressedExits: ['Bitcoin'] }).map((s) => s.symbol);
  assert.deepStrictEqual(after, ['Oil', 'Gold'], 'only the suppressed exit is removed');

  // NON-VACUITY: the suppression must be what removed it. If the symbol had vanished for an unrelated reason
  // (a status filter, a bad fixture) this assertion fails.
  assert.ok(before.includes('Bitcoin') && !after.includes('Bitcoin'));
});

test('suppression is by symbol, is not a prefix match, and tolerates junk', () => {
  const quant = { symbols: [sym('Bitcoin Cash', 'exit'), sym('Bitcoin', 'exit')] };
  const out = deliberationSymbols(quant, { suppressedExits: ['Bitcoin'] }).map((s) => s.symbol);
  assert.deepStrictEqual(out, ['Bitcoin Cash'], 'an exact symbol is suppressed, a longer one is not');
  for (const junk of [null, undefined, 'Bitcoin', 7, {}]) {
    assert.deepStrictEqual(
      deliberationSymbols(quant, { suppressedExits: junk }).map((s) => s.symbol),
      ['Bitcoin Cash', 'Bitcoin'],
      `a non-array suppression (${JSON.stringify(junk)}) suppresses NOTHING — the safe direction`,
    );
  }
});

test('the existing locks still behave, and rows without a signal are never proposed', () => {
  const quant = { symbols: [sym('Gold', 'entry'), noSignal('Silver'), errored('Oil')] };
  assert.deepStrictEqual(deliberationSymbols(quant).map((s) => s.symbol), ['Gold']);
  assert.deepStrictEqual(deliberationSymbols(quant, { blocked: 'session_closed' }), [], 'blocked removes entries');
  assert.deepStrictEqual(deliberationSymbols({}).map((s) => s.symbol), [], 'absent quantResult is not a crash');
  assert.strictEqual(suppressedCount(null), 0);
  assert.strictEqual(suppressedCount(['Bitcoin']), 1);
});

test('wakePipeline evaluates the tolerance BEFORE the deliberation, and keeps the execution gate', () => {
  const src = code('trading/agent/wakePipeline.js');

  const precheck = src.indexOf('suppressedExits');
  // ⚠ Anchor on `aggregator.decide(` and NOT on `step('deliberate'`: the PAPER desk has its own deliberate step
  // (central AI) earlier in the file, so the cheaper anchor is satisfied by a step that this fix never touches.
  const deliberate = src.indexOf('aggregator.decide(');
  assert.ok(precheck > -1, 'the pre-check must exist');
  assert.ok(deliberate > -1, 'the demo deliberation step must exist');
  assert.ok(precheck < deliberate, 'the suppression must be computed BEFORE the chairs are convened');

  // The gate itself is called in BOTH places: once as the cost gate, once as the unchanged safety gate at
  // execution. One call site would mean one of the two was removed.
  const calls = src.match(/exitWithinTolerance\(/g) || [];
  assert.ok(calls.length >= 2, `expected the rule at both the pre-check and the execution gate, found ${calls.length}`);

  assert.match(src, /loss_within_tolerance \(/, 'the recorded reason must keep its existing shape');
  assert.match(src, /preDeliberation: true/, 'a pre-deliberation deferral must be distinguishable in the record');
});

test('a suppressed-only wake reports the exit, never `no_signal`', () => {
  const agg = code('trading/agent/aggregator.js');
  assert.match(agg, /deferred_before_deliberation/, 'the wake reason must name the suppression');
  // The failure mode this prevents: `decisions` is empty for a suppressed-only wake, so the naive reading
  // reports `no_signal` — telling the ledger the desk saw nothing on a wake where the trail fired.
  assert.match(agg, /suppressedOnly \? 'exit' : 'none'/, 'the wake action must stay `exit`');
});
