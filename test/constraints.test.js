'use strict';
// constraints.test.js — the resolver for the external constraint ledger (migration 052).
//
// These pin the decisions that are easy to "improve" into bugs later: an undatable row is a candidate and never in
// force, the two clocks are separate, and absent evidence is never a pass.
const { test } = require('node:test');
const assert = require('node:assert');
const fc = require('fast-check');
const c = require('../trading/agent/constraints');

const row = (o = {}) => ({
  constraintVersionId: 1,
  constraintKey: 'venue.minimum_trade_size',
  constraintType: 'numeric_limit',
  valueNumeric: 0.025,
  valueUnit: 'count',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  recordedAt: '2026-01-01T00:00:00Z',
  verificationState: 'confirmed',
  ...o,
});

// ── WINDOWS ─────────────────────────────────────────────────────────────────────────────────────────────────
test('half-open: the start instant is IN, the end instant is OUT', () => {
  const r = row({ effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-02-01T00:00:00Z' });
  assert.strictEqual(c.stateAt(r, '2026-01-01T00:00:00Z'), c.IN_FORCE);
  assert.strictEqual(c.stateAt(r, '2026-01-31T23:59:59Z'), c.IN_FORCE);
  assert.strictEqual(c.stateAt(r, '2026-02-01T00:00:00Z'), c.NOT_IN_FORCE);
});

test('an open end is unbounded, but never reaches before its start', () => {
  const r = row({ effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null });
  assert.strictEqual(c.stateAt(r, '2099-01-01T00:00:00Z'), c.IN_FORCE);
  assert.strictEqual(c.stateAt(r, '2025-12-31T23:59:59Z'), c.NOT_IN_FORCE);
});

test('an UNKNOWN start is a candidate — never in force, at any instant', () => {
  // C5. A row captured from a venue page today has no effective date; assuming it applied would invent history.
  const r = row({ effectiveFrom: null });
  for (const at of ['2020-01-01T00:00:00Z', '2026-06-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
    assert.strictEqual(c.stateAt(r, at), c.CANDIDATE);
  }
});

test('property: stateAt is in force exactly when from <= at < to', () => {
  const iso = (ms) => new Date(ms).toISOString();
  fc.assert(fc.property(
    fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
    fc.integer({ min: 0, max: 400 * 86400000 }),
    fc.integer({ min: 0, max: 400 * 86400000 }),
    fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
    (from, span, _unused, at) => {
      const to = from + span;
      const r = row({ effectiveFrom: iso(from), effectiveTo: iso(to) });
      const expected = at >= from && at < to ? c.IN_FORCE : c.NOT_IN_FORCE;
      return c.stateAt(r, iso(at)) === expected;
    },
  ));
});

// ── THE TWO CLOCKS ──────────────────────────────────────────────────────────────────────────────────────────
test('inForce and knownAt answer different questions when a fact arrives late', () => {
  // The venue changed the rule on the 1st; the desk learned on the 5th.
  const r = row({ effectiveFrom: '2026-01-01T00:00:00Z', recordedAt: '2026-01-05T00:00:00Z' });
  const tradeAt = '2026-01-03T00:00:00Z';
  assert.strictEqual(c.inForce([r], { key: r.constraintKey, at: tradeAt }).status, c.IN_FORCE);
  assert.strictEqual(c.knownAt([r], { key: r.constraintKey, at: tradeAt }).row, null, 'the desk did not know it on the 3rd');
  assert.strictEqual(c.knownAt([r], { key: r.constraintKey, at: '2026-01-06T00:00:00Z' }).row, r);
});

test('a version in force but learned later is reported as lateDiscovery', () => {
  const r = row({ effectiveFrom: '2026-01-01T00:00:00Z', recordedAt: '2026-01-05T00:00:00Z' });
  const out = c.resolveSubject([r], { venue: null, at: '2026-01-03T00:00:00Z' });
  assert.strictEqual(out.inForce.length, 1);
  assert.deepStrictEqual(out.lateDiscovery.map((x) => x.constraintVersionId), [1]);
});

test('a version known at the time is NOT late discovery', () => {
  const r = row({ effectiveFrom: '2026-01-01T00:00:00Z', recordedAt: '2026-01-01T00:00:00Z' });
  assert.deepStrictEqual(c.resolveSubject([r], { at: '2026-01-03T00:00:00Z' }).lateDiscovery, []);
});

// ── SUBJECT RESOLUTION ─────────────────────────────────────────────────────────────────────────────────────
test('a venue-wide row (no venueInstrumentId) binds a specific instrument', () => {
  const r = row({ constraintKey: 'venue.single_tab', constraintType: 'prohibition', valueNumeric: null, valueUnit: null, venueInstrumentId: null });
  const out = c.resolveSubject([r], { venue: 'plus500', venueInstrumentId: '55123', at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(out.inForce.length, 1);
});

test('an instrument row does NOT bind a different instrument', () => {
  const r = row({ venueInstrumentId: '55123' });
  assert.strictEqual(c.resolveSubject([r], { venue: 'plus500', venueInstrumentId: '99999', at: '2026-06-01T00:00:00Z' }).inForce.length, 0);
});

test('candidates are surfaced separately and never in force', () => {
  const r = row({ effectiveFrom: null });
  const out = c.resolveSubject([r], { venue: 'plus500', venueInstrumentId: '55123', at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(out.inForce.length, 0);
  assert.strictEqual(out.candidates.length, 1);
});

// ── ONE CONSTRAINT ─────────────────────────────────────────────────────────────────────────────────────────
test('assessOne: numeric_limit needs a DIRECTION, or it is unassessable', () => {
  // The row stores a value and a unit and deliberately does not encode intent; guessing a direction would turn an
  // ambiguous constraint into a verdict.
  const r = row({ valueNumeric: 0.025 });
  assert.strictEqual(c.assessOne({ constraint: r, observed: 0.05 }).verdict, c.UNASSESSABLE);
  assert.strictEqual(c.assessOne({ constraint: r, observed: 0.05, direction: 'min' }).verdict, c.SATISFIED);
  assert.strictEqual(c.assessOne({ constraint: r, observed: 0.01, direction: 'min' }).verdict, c.BREACHED);
  assert.strictEqual(c.assessOne({ constraint: r, observed: 0.01, direction: 'max' }).verdict, c.SATISFIED);
});

test('assessOne: an ABSENT observation is unassessable, not a pass', () => {
  assert.strictEqual(c.assessOne({ constraint: row(), observed: null, direction: 'min' }).verdict, c.UNASSESSABLE);
});

test('assessOne: unrecoverable or disputed evidence can never support a pass', () => {
  assert.strictEqual(c.assessOne({ constraint: row({ verificationState: 'unrecoverable' }), observed: 1, direction: 'min' }).verdict, c.UNASSESSABLE);
  assert.strictEqual(c.assessOne({ constraint: row({ verificationState: 'disputed' }), observed: 1, direction: 'min' }).verdict, c.UNASSESSABLE);
});

test('assessOne: enum, time_of_day and prohibition each judge their own shape', () => {
  const e = row({ constraintKey: 'venue.unit_kind', constraintType: 'enum', valueEnum: 'Troy Ounces', valueNumeric: null, valueUnit: null });
  assert.strictEqual(c.assessOne({ constraint: e, observed: 'Troy Ounces' }).verdict, c.SATISFIED);
  assert.strictEqual(c.assessOne({ constraint: e, observed: 'Shares' }).verdict, c.BREACHED);

  const t = row({ constraintKey: 'venue.funding_time', constraintType: 'time_of_day', valueMinutesUtc: 300, valueNumeric: null, valueUnit: null });
  assert.strictEqual(c.assessOne({ constraint: t, observed: 300 }).verdict, c.SATISFIED);
  assert.strictEqual(c.assessOne({ constraint: t, observed: 0 }).verdict, c.BREACHED);

  const p = row({ constraintKey: 'venue.single_tab', constraintType: 'prohibition', valueNumeric: null, valueUnit: null });
  assert.strictEqual(c.assessOne({ constraint: p, observed: false }).verdict, c.SATISFIED);
  assert.strictEqual(c.assessOne({ constraint: p, observed: true }).verdict, c.BREACHED);
});

// ── WHOLE SUBJECT ──────────────────────────────────────────────────────────────────────────────────────────
test('assessSubject: a breach outranks an unassessable, and both outrank satisfied', () => {
  const ok = row({ constraintVersionId: 1, constraintKey: 'a', valueNumeric: 1 });
  const bad = row({ constraintVersionId: 2, constraintKey: 'b', valueNumeric: 10 });
  const unresolved = row({ constraintVersionId: 3, constraintKey: 'c', verificationState: 'disputed', valueNumeric: 1 });
  const subject = { inForce: [ok, bad, unresolved], candidates: [], lateDiscovery: [] };
  const out = c.assessSubject({
    subject,
    observations: { a: 5, b: 5, c: 5 },
    directions: { a: 'min', b: 'min', c: 'min' },
  });
  assert.strictEqual(out.verdict, c.BREACHED);
  assert.strictEqual(out.results.length, 3);
});

// ── BOUNDED START (migration 053) ──────────────────────────────────────────────────────────────────────────
// "It changed somewhere in this interval" is the honest representation of an observation-derived change. Without it
// an observation yields either a fabricated exact date or no progress at all.
const bounded = (o = {}) => row({ effectiveFrom: null, effectiveFromNotBefore: '2026-01-01T00:00:00Z', effectiveFromNotAfter: '2026-03-01T00:00:00Z', ...o });

test('bounded: BEFORE the interval it cannot have started', () => {
  assert.strictEqual(c.stateAt(bounded(), '2025-12-31T23:59:59Z'), c.NOT_IN_FORCE);
});

test('bounded: AT OR AFTER NotAfter it had certainly started', () => {
  assert.strictEqual(c.stateAt(bounded(), '2026-03-01T00:00:00Z'), c.IN_FORCE);
  assert.strictEqual(c.stateAt(bounded(), '2030-01-01T00:00:00Z'), c.IN_FORCE);
});

test('bounded: INSIDE the interval it is UNCERTAIN — neither in force nor out', () => {
  // This is the state the whole option exists for. Saying "in force" here would invent a start date; saying "not in
  // force" would deny one.
  assert.strictEqual(c.stateAt(bounded(), '2026-02-01T00:00:00Z'), c.UNCERTAIN);
});

test('bounded: a version that already ENDED is out of force at every later instant', () => {
  const r = bounded({ effectiveTo: '2026-02-01T00:00:00Z' });
  assert.strictEqual(c.stateAt(r, '2026-06-01T00:00:00Z'), c.NOT_IN_FORCE);
});

test('bounded: an uncertain row BLOCKS a clean pass, like a candidate but reported separately', () => {
  const ok = row({ constraintKey: 'venue.minimum_trade_size', valueNumeric: 1 });
  const subject = c.resolveSubject([ok, bounded({ constraintKey: 'venue.initial_margin_pct' })], { at: '2026-02-01T00:00:00Z' });
  assert.strictEqual(subject.inForce.length, 1);
  assert.strictEqual(subject.uncertain.length, 1);
  assert.strictEqual(subject.candidates.length, 0, 'a bounded row is NOT a candidate: it has a range, not an absence');
  const out = c.assessSubject({ subject, observations: { 'venue.minimum_trade_size': 5 }, directions: { 'venue.minimum_trade_size': 'min' }, checks: ['venue.minimum_trade_size'] });
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
  assert.deepStrictEqual(out.uncertain, ['venue.initial_margin_pct']);
});

test('bounded: the SAME row is not blocking outside its interval — uncertainty is confined', () => {
  // The whole value of a bound over a bare candidate: the unassessable window is the interval, not all of time.
  const ok = row({ constraintKey: 'venue.minimum_trade_size', valueNumeric: 1 });
  const later = c.resolveSubject([ok, bounded({ constraintKey: 'venue.initial_margin_pct' })], { at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(later.uncertain.length, 0);
  const out = c.assessSubject({ subject: later, observations: { 'venue.minimum_trade_size': 5 }, directions: { 'venue.minimum_trade_size': 'min' }, checks: ['venue.minimum_trade_size'] });
  assert.strictEqual(out.verdict, c.SATISFIED);
});

test('overlaps: a bounded row is treated as its EARLIEST possible start, so the guard tightens', () => {
  const a = bounded();                                                          // [Jan, Mar) bound
  const b = { effectiveFrom: '2025-06-01T00:00:00Z', effectiveTo: '2025-12-01T00:00:00Z' };
  assert.strictEqual(c.overlaps(a, b), false, 'ends before the bound even begins');
  const clash = { effectiveFrom: '2025-06-01T00:00:00Z', effectiveTo: '2026-02-01T00:00:00Z' };
  assert.strictEqual(c.overlaps(a, clash), true, 'reaches into the interval, so it MIGHT overlap and is refused');
});

test('validateVersion: bounded and exact are mutually exclusive', () => {
  const v = c.validateVersion({ ...good, effectiveFrom: '2026-01-01T00:00:00Z', effectiveFromNotBefore: '2026-01-01T00:00:00Z' });
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /two answers to one question/);
});

test('validateVersion: an inverted bound, or one entirely after the end, is refused', () => {
  assert.strictEqual(c.validateVersion({ ...good, effectiveFromNotBefore: '2026-03-01T00:00:00Z', effectiveFromNotAfter: '2026-02-01T00:00:00Z' }).ok, false);
  assert.strictEqual(c.validateVersion({ ...good, effectiveFrom: null, effectiveTo: '2026-01-01T00:00:00Z', effectiveFromNotBefore: '2026-02-01T00:00:00Z' }).ok, false);
});

test('validateVersion: a well-formed bounded version passes', () => {
  assert.deepStrictEqual(c.validateVersion({ ...good, effectiveFrom: null, effectiveFromNotBefore: '2026-01-01T00:00:00Z', effectiveFromNotAfter: '2026-03-01T00:00:00Z' }).errors, []);
});

test('assessSubject: a CANDIDATE anywhere makes the whole assessment unassessable', () => {
  const ok = row({ constraintKey: 'a', valueNumeric: 1 });
  const subject = { inForce: [ok], candidates: [row({ constraintVersionId: 9, constraintKey: 'z', effectiveFrom: null })], lateDiscovery: [] };
  const out = c.assessSubject({ subject, observations: { a: 5 }, directions: { a: 'min' } });
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
  assert.deepStrictEqual(out.blockingCandidates, ['z'], 'the blocking row must be named');
});

test('assessSubject: constraints outside `checks` are INFORMATIONAL, not unassessable', () => {
  // ⚠ WITHOUT THIS, recording margin or funding — neither of which a trade observation covers — would make EVERY
  // trade permanently unassessable. That is not conservatism, it is a register nobody can read.
  const minSize = row({ constraintVersionId: 1, constraintKey: 'venue.minimum_trade_size', valueNumeric: 1 });
  const margin = row({ constraintVersionId: 2, constraintKey: 'venue.initial_margin_pct', valueNumeric: 20 });
  const subject = { inForce: [minSize, margin], candidates: [], lateDiscovery: [] };
  const out = c.assessSubject({
    subject,
    observations: { 'venue.minimum_trade_size': 5 },
    directions: { 'venue.minimum_trade_size': 'min' },
    checks: ['venue.minimum_trade_size'],
  });
  assert.strictEqual(out.verdict, c.SATISFIED);
  assert.deepStrictEqual(out.results.map((r) => r.constraintKey), ['venue.minimum_trade_size']);
  assert.deepStrictEqual(out.informational.map((r) => r.constraintKey), ['venue.initial_margin_pct'],
    'the un-evaluated constraint must still be LISTED, not dropped');
});

test('assessSubject: holding constraints but evaluating none is unassessable, not satisfied', () => {
  // The same failure E7 names: "we hold it but cannot judge it" is missing coverage, not a pass.
  const subject = { inForce: [row({ constraintKey: 'venue.initial_margin_pct', valueNumeric: 20 })], candidates: [], lateDiscovery: [] };
  const out = c.assessSubject({ subject, observations: {}, checks: [] });
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
  assert.strictEqual(out.reason, 'nothing_evaluated');
});

test('assessSubject: NO applicable constraints is unassessable, not satisfied', () => {
  // E7: missing coverage is the primary failure this register guards against.
  const out = c.assessSubject({ subject: { inForce: [], candidates: [], lateDiscovery: [] }, observations: {} });
  assert.strictEqual(out.verdict, c.UNASSESSABLE);
  assert.strictEqual(out.reason, 'no_applicable_constraints');
});

// ── OVERLAP — the write guard, as a pure predicate ─────────────────────────────────────────────────────────
test('overlaps: identical windows collide', () => {
  const a = { effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-02-01T00:00:00Z' };
  assert.strictEqual(c.overlaps(a, { ...a }), true);
});

test('overlaps: ABUTTING windows do not collide — the window is half-open', () => {
  // This is what makes a successor expressible at all: [Jan, Feb) then [Feb, Mar) is two versions, not an overlap.
  const a = { effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-02-01T00:00:00Z' };
  const b = { effectiveFrom: '2026-02-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z' };
  assert.strictEqual(c.overlaps(a, b), false);
  assert.strictEqual(c.overlaps(b, a), false);
});

test('overlaps: an open end covers everything after its start', () => {
  const open = { effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null };
  assert.strictEqual(c.overlaps(open, { effectiveFrom: '2030-01-01T00:00:00Z', effectiveTo: null }), true);
  assert.strictEqual(c.overlaps(open, { effectiveFrom: '2025-01-01T00:00:00Z', effectiveTo: '2025-12-31T00:00:00Z' }), false);
});

test('overlaps: an UNKNOWN start cannot overlap anything, so two undated captures may coexist', () => {
  const undated = { effectiveFrom: null, effectiveTo: null };
  const dated = { effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null };
  assert.strictEqual(c.overlaps(undated, dated), false);
  assert.strictEqual(c.overlaps(undated, undated), false);
});

test('findOverlap: only the SAME key can collide', () => {
  const existing = [{ constraintVersionId: 7, constraintKey: 'venue.other', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null }];
  const candidate = { constraintKey: 'venue.minimum_trade_size', effectiveFrom: '2026-01-15T00:00:00Z', effectiveTo: null };
  assert.strictEqual(c.findOverlap(candidate, existing), null);
  assert.strictEqual(c.findOverlap({ ...candidate, constraintKey: 'venue.other' }, existing).constraintVersionId, 7);
});

// ── VALIDATION — the CHECK mirrored in code, plus what SQL cannot say ─────────────────────────────────────
const good = {
  constraintKey: 'venue.minimum_trade_size',
  subjectKind: 'instrument',
  constraintType: 'numeric_limit',
  valueNumeric: 0.025,
  valueUnit: 'count',
  verificationState: 'observed',
  recordedBy: 'operator',
};

test('validateVersion: a well-formed numeric limit passes', () => {
  assert.deepStrictEqual(c.validateVersion(good).errors, []);
});

test('validateVersion: a numeric limit with no unit is refused — the CHECK, stated earlier and readably', () => {
  const v = c.validateVersion({ ...good, valueUnit: null });
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /requires valueNumeric AND valueUnit/);
});

test('validateVersion: a prohibition carrying a payload is refused', () => {
  const v = c.validateVersion({ ...good, constraintType: 'prohibition' });
  assert.match(v.errors.join(' '), /prohibition carries no payload/);
});

test('validateVersion: time_of_day bounds', () => {
  const base = { ...good, constraintType: 'time_of_day', valueNumeric: null, valueUnit: null };
  assert.strictEqual(c.validateVersion({ ...base, valueMinutesUtc: 300 }).ok, true);
  assert.strictEqual(c.validateVersion({ ...base, valueMinutesUtc: 1439 }).ok, true);
  assert.strictEqual(c.validateVersion({ ...base, valueMinutesUtc: 1440 }).ok, false);
  assert.strictEqual(c.validateVersion({ ...base, valueMinutesUtc: -1 }).ok, false);
});

test('validateVersion: `confirmed` requires a retained artefact — a digest is not evidence', () => {
  // D2/D5: without the artefact there is nothing to re-examine when the constraint is disputed, so the row must not
  // be able to EXIST as confirmed in the first place.
  const v = c.validateVersion({ ...good, verificationState: 'confirmed' });
  assert.strictEqual(v.ok, false);
  assert.match(v.errors.join(' '), /requires evidenceArtifactRef/);
  assert.strictEqual(c.validateVersion({ ...good, verificationState: 'confirmed', evidenceArtifactRef: 'a/b.html', evidenceDigest: 'd'.repeat(64) }).ok, true);
});

test('validateVersion: an artefact without a digest is refused', () => {
  const v = c.validateVersion({ ...good, evidenceArtifactRef: 'a/b.html' });
  assert.match(v.errors.join(' '), /requires evidenceDigest/);
});

test('validateVersion: bad key, bad subject, bad type, bad state, inverted window', () => {
  assert.strictEqual(c.validateVersion({ ...good, constraintKey: 'NoDots' }).ok, false);
  assert.strictEqual(c.validateVersion({ ...good, subjectKind: 'planet' }).ok, false);
  assert.strictEqual(c.validateVersion({ ...good, constraintType: 'schedule' }).ok, false);
  assert.strictEqual(c.validateVersion({ ...good, verificationState: 'probably' }).ok, false);
  assert.strictEqual(c.validateVersion({ ...good, effectiveFrom: '2026-02-01T00:00:00Z', effectiveTo: '2026-01-01T00:00:00Z' }).ok, false);
  assert.strictEqual(c.validateVersion({ ...good, recordedBy: null }).ok, false);
});

// ── SUPERSESSION RETIRES; `effectiveTo` CLOSES ───────────────────────────────────────────────────────────────
//
// ⚠ WHY. `resolveSubject` used to read every row and retire none. A bootstrapped row is UNDATED, so it is a
// candidate; append a correction that supersedes it and BOTH are candidates, because the correction has no date
// either. One candidate is enough to make every affected assessment UNASSESSABLE, so the correction would appear to
// work — new value present, overlap guard quiet — while the ledger refused to answer for ever, and that refusal
// reads as caution rather than as a bug. The two mechanisms must not be conflated:
//   `supersedesId` = "the row I point at was WRONG" (retire it everywhere)
//   `effectiveTo`  = "the period ENDED"            (it was true while it lasted)

const cand = (o = {}) => row({ effectiveFrom: null, verificationState: 'observed', ...o });

test('★ a SUPERSEDED candidate is retired — it is not a candidate at all', () => {
  const old = cand({ constraintVersionId: 1, valueNumeric: 0.0319 });
  const fixed = cand({ constraintVersionId: 2, supersedesId: 1, valueNumeric: 0.012 });
  const s = c.resolveSubject([old, fixed], { at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(s.candidates.length, 1, 'the corrected row survives and the wrong one does not');
  assert.strictEqual(Number(s.candidates[0].constraintVersionId), 2);
  assert.ok(!s.inForce.includes(old));
});

test('★ …which is what lets a correction actually UNBLOCK an assessment', () => {
  // The whole value of 3a: before it, fixing a wrong constraint left the ledger refusing. After it, fixing the row
  // is enough.
  const key = 'venue.minimum_trade_size';
  const old = cand({ constraintVersionId: 1, valueNumeric: 99 });
  const fixed = cand({ constraintVersionId: 2, supersedesId: 1, valueNumeric: 10 });

  const before = c.resolveSubject([old], { at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(c.assessSubject({ subject: before, observations: { [key]: 20 }, directions: { [key]: 'min' }, checks: [key] }).verdict,
    c.UNASSESSABLE, 'an undated row blocks — baseline');

  const after = c.resolveSubject([old, fixed], { at: '2026-06-01T00:00:00Z' });
  // The correction is still undated, so the assessment is STILL unassessable — but now for ONE row, not two.
  assert.strictEqual(after.candidates.length, 1);

  // Date the correction and the block lifts entirely.
  const dated = cand({ constraintVersionId: 2, supersedesId: 1, valueNumeric: 10, effectiveFrom: '2026-01-01T00:00:00Z' });
  const resolved = c.resolveSubject([old, dated], { at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(resolved.candidates.length, 0, 'nothing undated remains');
  assert.strictEqual(resolved.inForce.length, 1);
  assert.strictEqual(c.assessSubject({ subject: resolved, observations: { [key]: 20 }, directions: { [key]: 'min' }, checks: [key] }).verdict,
    c.SATISFIED, '20 >= 10');
});

test('★ supersession is TRANSITIVE through a chain — v3 retires v2, which retired v1', () => {
  const v1 = cand({ constraintVersionId: 1 });
  const v2 = cand({ constraintVersionId: 2, supersedesId: 1 });
  const v3 = cand({ constraintVersionId: 3, supersedesId: 2 });
  const s = c.resolveSubject([v1, v2, v3], { at: '2026-06-01T00:00:00Z' });
  assert.deepStrictEqual(s.candidates.map((r) => Number(r.constraintVersionId)), [3]);
});

test('`effectiveTo` CLOSES a period and does NOT retire the row — the two mechanisms stay distinct', () => {
  // If closing a period also retired the row, history would become unreadable: a version that genuinely applied
  // last quarter must still resolve for last quarter.
  const closed = row({ constraintVersionId: 1, effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z' });
  const s = c.resolveSubject([closed], { at: '2026-02-01T00:00:00Z' });
  assert.strictEqual(s.inForce.length, 1, 'inside its window it still applies');
  const later = c.resolveSubject([closed], { at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(later.inForce.length, 0, 'and after the window it simply stops');
  assert.strictEqual(later.candidates.length, 0, 'but it is NOT retired — it is not a candidate either');
});

test('★ a superseded row STILL appears in the BELIEF view — we really did believe it at the time', () => {
  // `knownAt` answers "what did the desk think then", and answering it with the correction would be a fiction: the
  // correction had not been recorded yet. This is the same two-clocks rule the schema is built on.
  const old = cand({ constraintVersionId: 1, valueNumeric: 99, recordedAt: '2026-01-01T00:00:00Z' });
  const fixed = cand({ constraintVersionId: 2, supersedesId: 1, valueNumeric: 10, recordedAt: '2026-05-01T00:00:00Z' });
  const belief = c.knownAt([old, fixed], { at: '2026-02-01T00:00:00Z' });
  assert.strictEqual(Number(belief.row.constraintVersionId), 1, 'in February we believed the wrong row');
  const now = c.knownAt([old, fixed], { at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(Number(now.row.constraintVersionId), 2, 'after the correction we believe the right one');
});

test('a row with NO id cannot be retired by accident, and a dangling reference retires nothing', () => {
  const anon = cand({ constraintVersionId: undefined });
  const dangling = cand({ constraintVersionId: 7, supersedesId: 999 });
  assert.strictEqual(c.supersededIds([anon, dangling]).has('undefined'), false, 'an absent id must not form a set key');
  const s = c.resolveSubject([anon, dangling], { at: '2026-06-01T00:00:00Z' });
  assert.strictEqual(s.candidates.length, 2, 'neither is retired');
  assert.strictEqual(c.isRetired(anon, c.supersededIds([anon])), false);
});
