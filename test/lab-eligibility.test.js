'use strict';
// TRD-74 — what a lab verdict PERMITS, plus the two persistence defects found beside it.
//
// The rules are tested against the pure module. The persistence is tested STRUCTURALLY and scoped to
// a slice, because `lab/scoreboard.js` requires `store.js`, which opens a DB pool at require time and
// cannot be loaded from a unit test. Every slice here is guarded: a slice that silently comes back
// empty would make the assertion pass on nothing, which is the exact failure shape this test file
// exists to prevent.
const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const elig = require('../trading/agent/lab/eligibility');

const cand = (o = {}) => ({ id: 20, strategy: 'turtle', symbol: 'Gold', status: 'frozen', verdict: null, ...o });

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

test('TRD-74: PASS is the only state that grants scope on its own', () => {
  const r = elig.liveEligible(cand({ verdict: 'PASS' }));
  assert.equal(r.eligible, true);
  assert.equal(r.overrideUsed, false);
  assert.match(r.reason, /PASS/);
});

test('TRD-74: FAIL is not eligible', () => {
  const r = elig.liveEligible(cand({ verdict: 'FAIL' }));
  assert.equal(r.eligible, false);
  assert.match(r.reason, /FAIL/);
});

test('TRD-74: INSUFFICIENT-DATA is not eligible - untestable is not evidence', () => {
  const r = elig.liveEligible(cand({ verdict: 'INSUFFICIENT-DATA' }));
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no p-value|never reached/);
});

test('TRD-74: a candidate with no verdict grants nothing', () => {
  // This is the live state of the three turtle rows: archived AND verdict NULL.
  const r = elig.liveEligible(cand({ verdict: null }));
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no verdict/);
});

test('TRD-74: lowercase pass is normalised and accepted (deliberate, not accidental)', () => {
  assert.equal(elig.liveEligible(cand({ verdict: 'pass' })).eligible, true);
});

test('TRD-74: an unrecognised verdict is never a pass', () => {
  for (const v of ['PASSED', 'ok', 'MAYBE', 'TRUE', 'yes']) {
    const r = elig.liveEligible(cand({ verdict: v }));
    assert.equal(r.eligible, false, `"${v}" must not grant scope`);
    assert.match(r.reason, /unrecognised/);
  }
});

// ---------------------------------------------------------------------------
// archived — the blocker this task was written for
// ---------------------------------------------------------------------------

test('TRD-74: archived is not eligible, and says it needs an override rather than a verdict', () => {
  const r = elig.liveEligible(cand({ status: 'archived', verdict: null }));
  assert.equal(r.eligible, false);
  assert.equal(r.needsOverride, true);
  assert.match(r.reason, /archived/);
});

test('TRD-74: the withdrawal outranks a PASS - archived+PASS still needs the override', () => {
  const r = elig.liveEligible(cand({ status: 'archived', verdict: 'PASS' }));
  assert.equal(r.eligible, false);
  assert.equal(r.needsOverride, true);
});

test('TRD-74: an archived candidate CAN be enabled by an override that gives a reason', () => {
  const r = elig.liveEligible(cand({ status: 'archived', verdict: null }), { override: { reason: 'owner decision 2026-09-15' } });
  assert.equal(r.eligible, true);
  assert.equal(r.overrideUsed, true);
  assert.match(r.reason, /owner decision 2026-09-15/);
});

test('TRD-74: an override with no reason is refused - that is a silent bypass', () => {
  const r = elig.liveEligible(cand({ status: 'archived' }), { override: {} });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /no reason|must say why/);
});

test('TRD-74: a whitespace-only reason is not a reason', () => {
  const r = elig.liveEligible(cand({ status: 'archived' }), { override: { reason: '   ' } });
  assert.equal(r.eligible, false);
});

test('TRD-74: an override does NOT rescue a non-archived FAIL', () => {
  // The override is for a withdrawal, not a general bypass of the statistics.
  const r = elig.liveEligible(cand({ verdict: 'FAIL' }), { override: { reason: 'please' } });
  assert.equal(r.eligible, false);
});

test('TRD-74: every outcome explains itself', () => {
  const rows = [
    cand({ verdict: 'PASS' }), cand({ verdict: 'FAIL' }), cand({ verdict: 'INSUFFICIENT-DATA' }),
    cand({ verdict: null }), cand({ status: 'archived' }), cand({ status: 'archived', verdict: 'PASS' }),
  ];
  for (const c of rows) {
    const r = elig.liveEligible(c);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 10, 'a refusal that does not explain itself is the defect this file ends');
  }
});

test('TRD-74: eligibleAmong filters a per-symbol candidate list', () => {
  const all = [cand({ id: 1, verdict: 'PASS' }), cand({ id: 2, verdict: 'FAIL' }), cand({ id: 3, status: 'archived' })];
  assert.deepEqual(elig.eligibleAmong(all).map((c) => c.id), [1]);
});

// ---------------------------------------------------------------------------
// The persistence defects (structural)
// ---------------------------------------------------------------------------

const sliceBetween = (src, from, to) => {
  const a = src.indexOf(from);
  assert.ok(a > -1, `slice start not found: ${from}`);
  const b = to ? src.indexOf(to, a) : src.length;
  assert.ok(b > a, `slice end not found after ${from}: ${to}`);
  assert.ok(b - a > 80, 'refusing to assert against a suspiciously small slice');
  return src.slice(a, b);
};

test('TRD-74: retestCandidate persists the verdict it computed', () => {
  const src = code('trading/agent/lab/scoreboard.js');
  const slice = sliceBetween(src, 'async function retestCandidate', 'async function archiveCandidate');
  const at = slice.indexOf('updateLabCandidate');
  assert.ok(at > -1, 'retestCandidate must persist something');
  const call = slice.slice(at, at + 600);
  assert.match(call, /\bverdict\b/, 'the retest must write verdict - otherwise LabCandidates.verdict stays NULL forever and any gate reading it sees nothing');
});

test('TRD-74: releaseAll still persists the verdict too (the asymmetry was the bug)', () => {
  const src = code('trading/agent/lab/scoreboard.js');
  const slice = sliceBetween(src, 'async function releaseAll', 'async function retestCandidate');
  assert.match(slice, /\bverdict\b/, 'releaseAll must keep writing verdict');
});

test('TRD-74: archived now has a code writer, and it stamps a time', () => {
  const src = code('trading/agent/lab/scoreboard.js');
  const slice = sliceBetween(src, 'async function archiveCandidate', 'async function scoreboard');
  assert.match(slice, /status: 'archived'/, 'archiveCandidate must set the status');
  assert.match(slice, /archivedAt/, 'archiveCandidate must stamp archivedAt - the three turtle rows are NULL');
  assert.match(src, /module\.exports = \{[^}]*archiveCandidate/, 'archiveCandidate must be exported');
});

test('TRD-74: the store accepts every field the fix writes (or the fix silently no-ops)', () => {
  // updateLabCandidate builds its SET list from patch key names and IGNORES unknown ones, so a
  // renamed field would make the writes above do nothing at all - quietly.
  const slice = sliceBetween(code('trading/store.js'), 'async function updateLabCandidate', 'async function createLabRelease');
  for (const f of ['verdict', 'status', 'archivedAt']) {
    assert.ok(slice.includes(`patch.${f}`), `updateLabCandidate must accept patch.${f}`);
  }
});
