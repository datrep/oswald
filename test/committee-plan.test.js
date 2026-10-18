// test/committee-plan.test.js — TRD-55 (2026-09-14): the committee is convened
// ONLY when there is a proposal to vote on.
//
// Run with: npm run test:unit
//
// Two kinds of pin here, on purpose:
//   1. behaviour of the pure rule (committee.js)
//   2. STRUCTURE of aggregator.js, read as source text. It is NOT required:
//      aggregator pulls in the store and the connectors, so requiring it from a
//      unit test would open a DB pool and can attach to the desk's live Chrome
//      (the TRD-48 lesson). The invariants below are about call sites, which
//      only exist in the source.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  committeePlan, skipReasonText, NO_PROPOSAL_FLAT, NO_PROPOSAL_POSITIONS,
} = require('../trading/agent/committee');
const { code } = require('./_source');

// Structural assertions run against CODE, never prose — see test/_source.js for the
// CRLF trap that silently turns a comment stripper into a no-op.
const AGG = code('trading/agent/aggregator.js');

// ---------------------------------------------------------------- behaviour

test('no proposal + flat desk: do NOT convene (the answer is already in the contract)', () => {
  const plan = committeePlan({ proposals: [], hasAgentPositions: false });
  assert.strictEqual(plan.convene, false);
  assert.strictEqual(plan.reason, NO_PROPOSAL_FLAT);
  assert.strictEqual(plan.count, 0);
});

test('no proposal + open agent position: still do NOT convene', () => {
  // This is the case that cost 44% of the LLM input bill: the book round
  // convened the chairs on the full bundle with nothing to vote on.
  const plan = committeePlan({ proposals: [], hasAgentPositions: true });
  assert.strictEqual(plan.convene, false);
  assert.strictEqual(plan.reason, NO_PROPOSAL_POSITIONS);
});

test('one proposal: convene', () => {
  const plan = committeePlan({ proposals: [{ symbol: 'Gold' }], hasAgentPositions: false });
  assert.strictEqual(plan.convene, true);
  assert.strictEqual(plan.count, 1);
});

test('N proposals: convene, and the count is reported', () => {
  const plan = committeePlan({ proposals: [{ symbol: 'Gold' }, { symbol: 'Oil' }], hasAgentPositions: true });
  assert.strictEqual(plan.convene, true);
  assert.strictEqual(plan.count, 2);
});

test('a non-array proposals value is treated as empty, never as truthy', () => {
  for (const bad of [null, undefined, 0, 'Gold', {}]) {
    const plan = committeePlan({ proposals: bad, hasAgentPositions: true });
    assert.strictEqual(plan.convene, false, `proposals=${JSON.stringify(bad)} must not convene`);
  }
});

test('called with no arguments at all: does not throw and does not convene', () => {
  const plan = committeePlan();
  assert.strictEqual(plan.convene, false);
  assert.strictEqual(plan.reason, NO_PROPOSAL_FLAT);
});

test('skip reason text distinguishes the two no-proposal cases', () => {
  const flat = skipReasonText(NO_PROPOSAL_FLAT, {});
  const held = skipReasonText(NO_PROPOSAL_POSITIONS, {});
  assert.match(flat, /chairs skipped/);
  assert.match(held, /positions are covered by the review loop|position oversight runs in the review loop/);
  assert.notStrictEqual(flat, held);
});

test('an explicit blocker outranks the no-proposal explanation', () => {
  // Kill switch / session lock / bridge pause are the reason the desk stands
  // down; "there was no proposal" would be a misleading substitute.
  assert.strictEqual(skipReasonText(NO_PROPOSAL_FLAT, { blocked: 'SESSION_LOCK observation window' }), 'SESSION_LOCK observation window');
  assert.strictEqual(skipReasonText(NO_PROPOSAL_POSITIONS, { blocked: 'UI Fallback Pause (selector health)' }), 'UI Fallback Pause (selector health)');
});

test('an unknown reason still produces a usable string (never undefined)', () => {
  const s = skipReasonText('something_new', {});
  assert.strictEqual(typeof s, 'string');
  assert.ok(s.length > 0);
});

// --------------------------------------------------------------- structure

test('STRUCTURE: the committee is convened in exactly ONE place', () => {
  const calls = AGG.match(/await chairVotes\(/g) || [];
  assert.strictEqual(calls.length, 1, 'expected exactly one chair round; found ' + calls.length);
});

test('STRUCTURE: the book round (chairs with no proposal) is gone', () => {
  assert.ok(!AGG.includes('!proposalSyms.length && hasAgentPositions'), 'the no-proposal chair round is back');
  assert.ok(!AGG.includes('positions open but no proposals'), 'the old book-round comment is back');
});

test('STRUCTURE: the early return is driven by the shared rule, not an inline condition', () => {
  assert.ok(AGG.includes('committeePlan('), 'aggregator must use committeePlan');
  assert.ok(AGG.includes('if (!plan.convene)'), 'the no-proposal return must be gated on plan.convene');
  assert.ok(!AGG.includes('if (!proposal && !hasAgentPositions)'), 'the old inline flat-only condition is back');
});

test('STRUCTURE: the skipped wake still records which case it was', () => {
  // "Never silent" — a wake that spends nothing must still say why.
  assert.ok(AGG.includes('committee: plan'), 'the plan must ride into the wake event');
  assert.ok(AGG.includes('skipReasonText('), 'the reason text must come from the shared helper');
});

test('STRUCTURE: aggregator does not re-implement the reason strings', () => {
  assert.ok(!AGG.includes('no_signal (flat, no proposal'), 'the reason text was inlined again instead of coming from committee.js');
});
