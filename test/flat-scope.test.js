// test/flat-scope.test.js — TRD-56 (2026-09-14): the flat reason reports only the
// gates of strategies that can actually trade that symbol.
//
// The bug this pins: the owner read "flat MACD -0.3401 vs -0.2831 no cross" on
// Sugar and SGX (Basis column, Wakes tab) and reasonably concluded the desk
// trades MACD. It does not — macd has had no symbol scope since 2026-09-11 — and
// the same text rode into every chair bundle for every symbol.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  gateNoteScope, scopeSummary, GATE_OWNERS, GATELESS,
} = require('../trading/agent/quant');
const { REGISTRY } = require('../trading/agent/strategies');
const { code, read } = require('./_source');

const QUANT = code('trading/agent/quant.js');
const PB = code('trading/agent/promptBuilder.js');

test('HELPER: the comment stripper actually strips (the CRLF trap)', () => {
  // This repo is CRLF, and a split('\n') + /.*$/ stripper matches NOTHING on
  // CRLF while failing silently — so every structural assertion would be reading
  // prose. This asserts the stripper is not a no-op, on a file that has comments.
  const raw = read('trading/agent/promptBuilder.js');
  assert.ok(raw.includes('//'), 'fixture has no comments - the test would prove nothing');
  const leftovers = code('trading/agent/promptBuilder.js')
    .split('\n')
    .filter((line) => /(^|[^:])\/\//.test(line));
  assert.deepStrictEqual(leftovers, [], 'comment delimiters survived the strip: ' + leftovers.slice(0, 2).join(' | '));
});

// ------------------------------------------------------------------ the rule

test('a frozen wrapper keeps its family gates (the id would have lost them)', () => {
  // survGold delegates to turtleUltimate.liveSignal, so it IS a Donchian + ADX
  // strategy — but its id contains neither `turtle` nor `macd`. Inferring gate
  // ownership from the id would have stripped the real reasons from Gold and Oil.
  const g = gateNoteScope(['survgold']);
  assert.strictEqual(g.donchian, true);
  assert.strictEqual(g.adx, true);
  assert.strictEqual(g.macd, false);
  assert.strictEqual(g.meanrev, false);
});

test('a symbol with nothing in scope claims no gates at all', () => {
  // Sugar/SGX/CK Hutchison: symbolScope.others = [] — this is the exact case
  // that produced the misleading MACD line.
  const g = gateNoteScope([]);
  assert.deepStrictEqual(g, { donchian: false, adx: false, macd: false, meanrev: false });
});

test('macd in scope claims the MACD gate, and not the Donchian one', () => {
  const g = gateNoteScope(['macd']);
  assert.strictEqual(g.macd, true);
  assert.strictEqual(g.adx, true); // macd is ADX-gated too
  assert.strictEqual(g.donchian, false);
  assert.strictEqual(g.meanrev, false);
});

test('mean-reversion family claims only the regime note', () => {
  for (const id of ['meanrev', 'rsi2']) {
    const g = gateNoteScope([id]);
    assert.strictEqual(g.meanrev, true, id);
    assert.strictEqual(g.macd, false, id);
    assert.strictEqual(g.donchian, false, id);
  }
});

test('a non-array scope is treated as empty, never as truthy', () => {
  for (const bad of [null, undefined, 0, 'turtle', {}]) {
    assert.strictEqual(gateNoteScope(bad).donchian, false, JSON.stringify(bad));
  }
});

// ------------------------------------------------------- the summary line

test('nothing in scope says so, and says it in one line', () => {
  assert.strictEqual(scopeSummary([], ['survgold', 'survoil']), 'no strategy in scope for this symbol');
});

test('in-scope strategies keep detail; the rest are named once', () => {
  assert.strictEqual(scopeSummary(['survgold'], ['survgold', 'survoil']), 'not evaluated here: survoil');
});

test('full coverage adds no summary line at all', () => {
  assert.strictEqual(scopeSummary(['survgold', 'survoil'], ['survgold', 'survoil']), null);
});

test('a missing global list does not invent out-of-scope names', () => {
  assert.strictEqual(scopeSummary(['survgold'], undefined), null);
});

// ------------------------------------------------------------- coverage

test('COVERAGE: every registered strategy is mapped or declared GATELESS', () => {
  // Forces a new strategy to make this decision deliberately instead of
  // inheriting someone else's gates — the defect this file exists to prevent.
  const declared = new Set([...Object.values(GATE_OWNERS).flat(), ...GATELESS]);
  const missing = Object.keys(REGISTRY).filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, [], 'undeclared strategies: ' + missing.join(', '));
});

test('COVERAGE: no GATE_OWNERS entry names a strategy that does not exist', () => {
  const known = new Set(Object.keys(REGISTRY));
  const bad = [...new Set(Object.values(GATE_OWNERS).flat())].filter((id) => !known.has(id));
  assert.deepStrictEqual(bad, [], 'unknown strategies in the map: ' + bad.join(', '));
});

test('COVERAGE: the desk two live strategies are mapped in both shared gates', () => {
  for (const id of ['survgold', 'survoil']) {
    assert.ok(GATE_OWNERS.donchian.includes(id), id + ' missing from donchian');
    assert.ok(GATE_OWNERS.adx.includes(id), id + ' missing from adx');
  }
});

// ------------------------------------------------------------ structure

test('STRUCTURE: every gate note consults the scope, none is unconditional', () => {
  assert.ok(QUANT.includes('gateNoteScope('), 'quant must consult gateNoteScope');
  // The three notes that used to be emitted unconditionally.
  assert.ok(QUANT.includes('gateScope.macd && indicators && indicators.macd'), 'the MACD note must be scoped');
  assert.ok(QUANT.includes('gateScope.adx && adx14 != null'), 'the ADX note must be scoped');
  assert.ok(QUANT.includes('gateScope.meanrev && indicators'), 'the mean-rev note must be scoped');
  assert.ok(!QUANT.includes('if (indicators && indicators.macd) notes.push('), 'the unscoped MACD note is back');
});

test('STRUCTURE: the summary line is appended, not substituted', () => {
  assert.ok(QUANT.includes('const idle = scopeSummary(strategyIds, opts.globalStrategyIds)'), 'the summary must be computed from the per-symbol scope');
  assert.ok(QUANT.includes('if (idle) notes.push(idle)'), 'the summary must be appended to the scoped notes');
});

test('STRUCTURE: evaluate passes the global enabled list down', () => {
  assert.ok(QUANT.includes('globalStrategyIds: strategyIds'), 'evaluate must pass the global list');
});

test('STRUCTURE: the inverted no-proposal question is gone', () => {
  assert.ok(!PB.includes('on whether to stay flat'), 'the inverted question is back');
  assert.ok(!PB.includes('No quant proposal this cycle. VOTE'), 'a no-proposal prompt must not ask for a vote');
  assert.ok(PB.includes('this bundle is a record, not a question'), 'the record-only text should explain itself');
});
