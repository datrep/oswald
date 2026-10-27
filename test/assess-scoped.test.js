'use strict';
// test/assess-scoped.test.js — the narrower claim, and the guarantee that it cannot widen by accident.
//
// ★★ WHY THIS FILE EXISTS. There are now TWO assessment functions, and the risk is that they drift: one answers
// "did this subject honour everything that applied?" and must block on anything unknown; the other answers "did this
// subject honour THESE keys?" and lists the rest. The arithmetic must be identical — both delegate to `assessOne` —
// and only the bucketing may differ. The agreement test at the bottom is what makes that a checked property instead
// of a comment.
//
// ⚠ THE RULE THAT KEEPS THE SCOPED FORM HONEST: a REQUESTED key that is itself undated or uncertain comes back
// `unassessable`. It must never be moved into `notJudged`, because that would let a scoped check look clean by
// quietly reclassifying the very thing it was asked to judge.
const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../trading/agent/constraints');

const MIN = 'venue.minimum_trade_size';
const MARGIN = 'venue.initial_margin_pct';
const TAB = 'venue.single_tab';

const row = (o = {}) => ({
  constraintVersionId: 1,
  constraintKey: MIN,
  constraintType: 'numeric_limit',
  valueNumeric: 10,
  valueUnit: 'count',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  recordedAt: '2026-01-01T00:00:00Z',
  verificationState: 'observed',
  ...o,
});
const cand = (o = {}) => row({ effectiveFrom: null, ...o });
const bounded = (o = {}) => row({ effectiveFrom: null, effectiveFromNotBefore: '2026-01-01T00:00:00Z', effectiveFromNotAfter: '2026-03-01T00:00:00Z', ...o });
const tab = (o = {}) => row({
  constraintVersionId: 9, constraintKey: TAB, constraintType: 'prohibition',
  valueNumeric: null, valueUnit: null, effectiveFrom: null, verificationState: 'asserted', ...o,
});

const subjectAt = (rows, at = '2026-06-01T00:00:00Z') => c.resolveSubject(rows, { at });

test('★ a scoped verdict covers ONLY the requested key, and names its scope', () => {
  const s = subjectAt([row()]);
  const out = c.assessScoped({
    subject: s, checks: [MIN], observations: { [MIN]: 20 }, directions: { [MIN]: 'min' },
    at: '2026-06-01T00:00:00Z', scope: 'minimum trade size',
  });
  assert.strictEqual(out.verdict, c.SATISFIED);
  assert.strictEqual(out.scope, 'minimum trade size');
  assert.deepStrictEqual(out.results.map((r) => r.constraintKey), [MIN]);
});

test('★★ an UNDATED prohibition that applies is listed in notJudged with BOTH reasons — and never blocks', () => {
  // This is the shape `plus500.single_tab` produces: undated, a prohibition, and not something a trade can judge.
  const s = subjectAt([row(), tab()]);
  const out = c.assessScoped({
    subject: s, checks: [MIN], observations: { [MIN]: 20 }, directions: { [MIN]: 'min' }, at: '2026-06-01T00:00:00Z',
  });
  assert.strictEqual(out.verdict, c.SATISFIED, 'a constraint the audit did not ask about cannot decide its verdict');
  const nj = out.notJudged.find((x) => x.constraintKey === TAB);
  assert.ok(nj, 'but it must appear, not vanish');
  assert.ok(nj.reasons.includes('not_requested'));
  assert.ok(nj.reasons.includes('effective_date_unknown'), 'the row is undated — that reason must be present');
  assert.ok(nj.reasons.includes('prohibition_needs_an_event_observation'), 'and so must the structural one');
});

test('★ a REQUESTED key that is UNDATED is unassessable — never quietly moved to notJudged', () => {
  // ⚠ The failure this prevents: ask about an undated constraint, get it listed as "not judged", read the remaining
  // keys as satisfied, and conclude the requirement was met. A requested key that cannot be judged fails the check.
  const s = subjectAt([cand({ constraintKey: MIN })]);
  const out = c.assessScoped({ subject: s, checks: [MIN], observations: { [MIN]: 20 }, directions: { [MIN]: 'min' }, at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
  assert.strictEqual(out.results[0].reason, 'effective_date_unknown');
  assert.deepStrictEqual(out.notJudged, [], 'it is the requested key, so it is a RESULT that failed, not a bystander');
});

test('a REQUESTED key inside its bounded window is uncertain, and says which', () => {
  const s = subjectAt([bounded({ constraintKey: MIN })], '2026-02-01T00:00:00Z');
  const out = c.assessScoped({ subject: s, checks: [MIN], observations: { [MIN]: 20 }, directions: { [MIN]: 'min' }, at: '2026-02-01T00:00:00Z' });
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
  assert.strictEqual(out.results[0].reason, 'effective_date_uncertain');
});

test('a REQUESTED key the ledger holds nothing for is a failure of the CHECK, not a pass', () => {
  const s = subjectAt([row({ constraintKey: MIN })]);
  const out = c.assessScoped({ subject: s, checks: ['venue.nonexistent'], observations: {}, directions: {}, at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
  assert.strictEqual(out.results[0].reason, 'no_version_in_force');
});

test('★ a BREACH in the requested key outranks an unassessable one, as in the whole-subject form', () => {
  const s = subjectAt([row(), row({ constraintVersionId: 2, constraintKey: MARGIN, valueNumeric: 20 })]);
  const out = c.assessScoped({
    subject: s, checks: [MIN, MARGIN],
    observations: { [MIN]: 1, [MARGIN]: null }, directions: { [MIN]: 'min', [MARGIN]: 'min' }, at: '2026-06-01T00:00:00Z',
  });
  assert.strictEqual(out.verdict, c.BREACHED, 'a finding outranks an absence');
});

test('no checks is refused, not silently satisfied', () => {
  const out = c.assessScoped({ subject: subjectAt([row()]), checks: [], at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'nothing_requested');
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
});

test('★★ AGREEMENT: on the same subject and key, both functions reach the SAME per-key verdict', () => {
  // The two functions differ in BUCKETING only — both delegate the comparison to `assessOne`. This test is what keeps
  // that true. If it fails, one of them has grown its own arithmetic and the scoped verdict can no longer be trusted
  // to say the same thing about the same constraint.
  const cases = [
    { name: 'satisfied', rows: [row()], obs: 20, want: c.SATISFIED },
    { name: 'breached', rows: [row()], obs: 1, want: c.BREACHED },
    { name: 'no observation', rows: [row()], obs: null, want: c.UNASSESSABLE },
    { name: 'direction missing', rows: [row()], obs: 20, want: c.UNASSESSABLE, noDirection: true },
    { name: 'disputed evidence', rows: [row({ verificationState: 'disputed' })], obs: 20, want: c.UNASSESSABLE },
  ];
  for (const t of cases) {
    const at = '2026-06-01T00:00:00Z';
    const subject = subjectAt(t.rows, at);
    const direction = t.noDirection ? {} : { [MIN]: 'min' };
    const whole = c.assessSubject({ subject, observations: { [MIN]: t.obs }, directions: direction, checks: [MIN], at });
    const scoped = c.assessScoped({ subject, observations: { [MIN]: t.obs }, directions: direction, checks: [MIN], at });
    assert.strictEqual(whole.results[0].verdict, scoped.results[0].verdict, `${t.name}: the two must agree per key`);
    assert.strictEqual(whole.results[0].reason, scoped.results[0].reason, `${t.name}: and for the same reason`);
    assert.strictEqual(scoped.results[0].verdict, t.want, `${t.name}: expected ${t.want}`);
  }
});

test('★ where they MUST differ: a bystander candidate blocks the whole subject but not the scoped check', () => {
  // This is the entire justification for two functions, stated as a test rather than as prose.
  const at = '2026-06-01T00:00:00Z';
  const subject = subjectAt([row(), cand({ constraintVersionId: 5, constraintKey: MARGIN })], at);
  const whole = c.assessSubject({ subject, observations: { [MIN]: 20 }, directions: { [MIN]: 'min' }, checks: [MIN], at });
  const scoped = c.assessScoped({ subject, observations: { [MIN]: 20 }, directions: { [MIN]: 'min' }, checks: [MIN], at });
  assert.strictEqual(whole.verdict, c.UNASSESSABLE, 'the whole-subject claim cannot survive an unknown bystander');
  assert.strictEqual(scoped.verdict, c.SATISFIED, 'the scoped claim never made a statement about it');
});
