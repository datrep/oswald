'use strict';
// ownership.test.js — ADR-0001's settings ownership rule, made checkable.
const { test } = require('node:test');
const assert = require('node:assert');
const o = require('../trading/store/ownership');

test('ownerOf: the operator namespaces from AGENTS.md §2', () => {
  assert.strictEqual(o.ownerOf('risk.maxPositions'), o.OPERATOR);
  assert.strictEqual(o.ownerOf('risk.takeProfitRR'), o.OPERATOR);
  assert.strictEqual(o.ownerOf('deliberation.chairTimeoutMs'), o.OPERATOR);
});

test('ownerOf: `watchlist.symbols` is CO-OWNED, not operator-owned — the machine edits its own entries', () => {
  // Declaring the whole key OPERATOR would flag `discoverer.js`'s legitimate, manual-preserving rewrite every
  // cycle. Ownership lives on the ENTRY (`source: 'ai'` vs manual) and `symbolsViolation` enforces it.
  assert.strictEqual(o.ownerOf('watchlist.symbols'), o.SHARED);
});

test('ownerOf: the machine namespaces, including a leaf INSIDE a namespace', () => {
  assert.strictEqual(o.ownerOf('bridge.paused'), o.MACHINE);
  assert.strictEqual(o.ownerOf('kill.initialEquity'), o.MACHINE);
  assert.strictEqual(o.ownerOf('watchlist.universe'), o.MACHINE);
  assert.strictEqual(o.ownerOf('watchlist.candidates'), o.MACHINE);
});

test('ownerOf: longest prefix wins, so two keys under `watchlist` stay apart', () => {
  // The whole point of the rule table: `watchlist` is not a namespace, its leaf keys are, and two of them have
  // DIFFERENT owners. A first-match-wins matcher would collapse them.
  assert.strictEqual(o.ownerOf('watchlist.universe'), o.MACHINE);
  assert.strictEqual(o.ownerOf('watchlist.candidates'), o.MACHINE);
  assert.strictEqual(o.ownerOf('watchlist.symbols.0'), o.SHARED);
});

test('ownerOf: unmatched paths are SHARED, the permissive default', () => {
  assert.strictEqual(o.ownerOf('llm.model'), o.SHARED);
  assert.strictEqual(o.ownerOf('wake.paused'), o.SHARED);
  assert.strictEqual(o.ownerOf(''), o.SHARED);
  assert.strictEqual(o.ownerOf(null), o.SHARED);
});

test('ownerOf: a prefix does not match a longer sibling', () => {
  // `risk` must not swallow `riskier` — path matching is segment-aware, not string-prefix.
  assert.strictEqual(o.ownerOf('riskier'), o.SHARED);
  assert.strictEqual(o.ownerOf('bridgeFan'), o.SHARED);
});

test('classifyPatch: splits a realistic save by owner', () => {
  const c = o.classifyPatch({ risk: { maxPositions: 4 }, bridge: { consecutiveFails: 3 }, llm: { model: 'x' } });
  assert.deepStrictEqual(c[o.OPERATOR], ['risk.maxPositions']);
  assert.deepStrictEqual(c[o.MACHINE], ['bridge.consecutiveFails']);
  assert.deepStrictEqual(c[o.SHARED], ['llm.model']);
});

test('violations: a MACHINE write into an operand namespace is reported', () => {
  const v = o.violations({ risk: { maxPositions: 4 } }, { by: o.MACHINE });
  assert.deepStrictEqual(v, [{ path: 'risk.maxPositions', owner: o.OPERATOR, writer: o.MACHINE }]);
});

test('violations: an OPERATOR write into a machine namespace is reported the other way', () => {
  const v = o.violations({ kill: { initialEquity: 4000 } }, { by: o.OPERATOR });
  assert.deepStrictEqual(v, [{ path: 'kill.initialEquity', owner: o.MACHINE, writer: o.OPERATOR }]);
});

test('violations: the desk\u2019s own machine writes are NOT violations', () => {
  // health.js owns the latch and must keep writing it; this is what makes the rule usable rather than noise.
  assert.deepStrictEqual(o.violations({ bridge: { paused: true, consecutiveFails: 2 } }, { by: o.MACHINE }), []);
  assert.deepStrictEqual(o.violations({ watchlist: { universe: ['a'] } }, { by: o.MACHINE }), []);
});

test('violations: an UNKNOWN writer is not judged, and a shared path is never a violation', () => {
  assert.deepStrictEqual(o.violations({ risk: { maxPositions: 4 } }, { by: null }), []);
  assert.deepStrictEqual(o.violations({ llm: { model: 'x' } }, { by: o.MACHINE }), []);
});

test('leaves: arrays and scalars terminate a path; empty objects contribute nothing', () => {
  assert.deepStrictEqual(o.leaves({ a: [1, 2] }), ['a']);
  assert.deepStrictEqual(o.leaves({ a: { b: 1, c: { d: 2 } } }), ['a.b', 'a.c.d']);
  assert.deepStrictEqual(o.leaves({ a: {} }), []);
});

test('describe: renders the split for a journal payload, and is null when nothing is owned', () => {
  assert.strictEqual(o.describe({ risk: { a: 1 }, bridge: { b: 2 } }), '1 operator / 1 machine');
  assert.strictEqual(o.describe({}), null);
});

// ── ENTRY-LEVEL OWNERSHIP INSIDE `watchlist.symbols` ───────────────────────────────────────────────────────
const manual = { symbol: 'Gold', venue: 'plus500' };
const ai = { symbol: 'Solana', venue: 'plus500', source: 'ai', addedAt: '2026-10-01T00:00:00Z' };

test('symbolsViolation: a machine write may add and drop ITS OWN entries', () => {
  assert.deepStrictEqual(o.symbolsViolation([manual, ai], [manual, { ...ai, symbol: 'BNB' }]), []);
});

test('symbolsViolation: dropping a MANUAL entry is a violation', () => {
  assert.deepStrictEqual(o.symbolsViolation([manual, ai], [ai]),
    [{ path: 'watchlist.symbols', symbol: 'Gold', reason: 'manual_entry_removed' }]);
});

test('symbolsViolation: MUTATING a manual entry is a violation', () => {
  assert.deepStrictEqual(o.symbolsViolation([manual], [{ symbol: 'Gold', venue: 'okx' }]),
    [{ path: 'watchlist.symbols', symbol: 'Gold', reason: 'manual_entry_modified' }]);
});

test('symbolsViolation: REORDERING is not a violation — discoverer rebuilds the array every cycle', () => {
  // `final = [...manual, ...ai]`. A guard comparing indices would fire every cycle with nothing lost.
  assert.deepStrictEqual(o.symbolsViolation([ai, manual], [manual, ai]), []);
});

test('symbolsViolation: no prior value means nothing can have been removed', () => {
  assert.deepStrictEqual(o.symbolsViolation(undefined, [manual]), []);
  assert.deepStrictEqual(o.symbolsViolation([], [manual]), []);
});

test('machineWriteViolations: the discoverer’s real write shape passes, and a dropped manual entry does not', () => {
  // This is the exact patch `agent/discoverer.js` issues: manual entries first, then the AI subset.
  const before = { watchlist: { symbols: [ai, manual] } };
  const ok = { watchlist: { symbols: [manual, ai] } };
  assert.deepStrictEqual(o.machineWriteViolations({ before, patch: ok, by: o.MACHINE }), []);
  const bad = { watchlist: { symbols: [ai] } };
  assert.deepStrictEqual(o.machineWriteViolations({ before, patch: bad, by: o.MACHINE }),
    [{ path: 'watchlist.symbols', symbol: 'Gold', reason: 'manual_entry_removed' }]);
  // An operator write is never judged by the machine rule.
  assert.deepStrictEqual(o.machineWriteViolations({ before, patch: bad, by: o.OPERATOR }), []);
});
