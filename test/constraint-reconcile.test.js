'use strict';
// constraint-reconcile.test.js — Phase 5. Report drift; never date it, never write a constraint.
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../trading/agent/constraintReconcile');

const row = (o = {}) => ({
  constraintKey: 'plus500.11.minimum_trade_size',
  constraintType: 'numeric_limit',
  valueNumeric: 0.025,
  valueUnit: 'Troy Ounces',
  effectiveFrom: null,
  effectiveTo: null,
  recordedAt: '2026-10-26T22:13:53Z',
  ...o,
});
const inst = (o = {}) => ({ venueInstrumentId: '11', symbol: 'Gold', unitAmount: 0.025, ...o });

test('parseKey: both shapes are legitimate, and a venue-wide key is NOT unparsable', () => {
  assert.deepStrictEqual(r.parseKey('plus500.11.minimum_trade_size'),
    { venue: 'plus500', venueInstrumentId: '11', field: 'minimum_trade_size' });
  // ⚠ The first version accepted only three segments and reported `plus500.single_tab` as `unparsable_key`, which
  // sends a reader to inspect the data when the parser was the bug.
  assert.deepStrictEqual(r.parseKey('plus500.single_tab'),
    { venue: 'plus500', venueInstrumentId: null, field: 'single_tab' });
  assert.strictEqual(r.parseKey('plus500.11.not_a_field'), null);
  assert.strictEqual(r.parseKey('garbage'), null);
});

test('assertedValue: prefers the version IN FORCE, falls back to the newest candidate', () => {
  const dated = row({ constraintVersionId: 2, effectiveFrom: '2026-01-01T00:00:00Z', recordedAt: '2026-01-01T00:00:00Z' });
  const undated = row({ constraintVersionId: 1, valueNumeric: 9 });
  const a = r.assertedValue([dated, undated], '2026-06-01T00:00:00Z');
  assert.strictEqual(a.basis, 'in_force');
  assert.strictEqual(Number(a.row.constraintVersionId), 2);
  // With nothing dated, the candidate IS the assertion — refusing to compare it would measure nothing at all.
  const b = r.assertedValue([undated], '2026-06-01T00:00:00Z');
  assert.strictEqual(b.basis, 'candidate');
  assert.strictEqual(r.assertedValue([], '2026-06-01T00:00:00Z').basis, 'none');
});

test('compareOne: an identical value matches, at the coarser precision', () => {
  // The ledger is DECIMAL(28,10); the source is DECIMAL(9,4). A representation difference is not a venue change.
  assert.strictEqual(r.compareOne({ row: row({ valueNumeric: 0.0250000000 }), instrument: inst() }).status, 'match');
});

test('compareOne: a changed value is DRIFT, and reports both sides', () => {
  const out = r.compareOne({ row: row({ valueNumeric: 0.05 }), instrument: inst() });
  assert.strictEqual(out.status, 'drift');
  assert.strictEqual(out.stored, 0.05);
  assert.strictEqual(out.current, 0.025);
});

test('compareOne: a venue-wide key is `venue_wide`, not a missing instrument', () => {
  const out = r.compareOne({ row: row({ constraintKey: 'plus500.single_tab', constraintType: 'prohibition', valueNumeric: null, valueUnit: null }), instrument: null });
  assert.strictEqual(out.status, 'venue_wide');
});

test('compareOne: an instrument the registry does not know is `no_instrument`', () => {
  assert.strictEqual(r.compareOne({ row: row(), instrument: null }).status, 'no_instrument');
});

test('compareOne: absent on either side is `no_source`, never a match', () => {
  assert.strictEqual(r.compareOne({ row: row({ valueNumeric: null }), instrument: inst() }).status, 'no_source');
  assert.strictEqual(r.compareOne({ row: row(), instrument: inst({ unitAmount: null }) }).status, 'no_source');
});

test('compareOne: funding time compares in UTC MINUTES — the venue label is LOCAL', () => {
  // ⚠ `fundingMinuteFromText('5:00 AM')` is 1260, not 300: the page shows the desk's UTC+8 wall clock and the parser
  // converts to UTC. Both the bootstrap and this module go through that one function, which is why they agree. A test
  // that asserted 300 would have encoded the bug.
  const { fundingMinuteFromText } = require('../trading/agent/time');
  const utc = fundingMinuteFromText('5:00 AM');
  assert.strictEqual(utc, 1260, 'the parser owns the local->UTC conversion, and this asserts it stayed 1260');
  const t = row({ constraintKey: 'plus500.11.funding_time', constraintType: 'time_of_day', valueNumeric: null, valueUnit: null, valueMinutesUtc: utc });
  assert.strictEqual(r.compareOne({ row: t, instrument: inst({ fundingTime: '5:00 AM' }) }).status, 'match');
  assert.strictEqual(r.compareOne({ row: t, instrument: inst({ fundingTime: '6:00 AM' }) }).status, 'drift');
  // A locally-parsed 300 against a stored 1260 would be a 16-hour phantom drift — exactly what the shared parser prevents.
  assert.strictEqual(r.compareOne({ row: { ...t, valueMinutesUtc: 300 }, instrument: inst({ fundingTime: '5:00 AM' }) }).status, 'drift');
});

test('reconcile: a drift finding is NAMED but never dated', () => {
  const out = r.reconcile({
    rows: [row({ valueNumeric: 0.05 })],
    instruments: [inst()],
  });
  assert.strictEqual(out.findings.length, 1);
  const f = out.findings[0];
  assert.strictEqual(f.datedChange, false, 'we know it changed; we do not know when');
  assert.match(f.note, /UNDATED/);
  assert.strictEqual(f.symbol, 'Gold');
});

test('reconcile: the census separates a quiet venue from a broken read', () => {
  // A reconciliation that reports only drifts cannot tell "nothing moved" from "we could not look".
  const out = r.reconcile({
    rows: [row(), row({ constraintKey: 'plus500.12.minimum_trade_size', valueNumeric: 1 })],
    instruments: [inst(), inst({ venueInstrumentId: '12', unitAmount: 2 })],
  });
  assert.strictEqual(out.census.keys, 2);
  assert.strictEqual(out.census.match, 1);
  assert.strictEqual(out.census.drift, 1);
  assert.strictEqual(out.census.no_source, 0);
});

test('reconcile: many versions of one key are compared ONCE, using the asserted one', () => {
  const out = r.reconcile({
    rows: [
      row({ constraintVersionId: 1, valueNumeric: 0.025, recordedAt: '2026-10-26T22:13:53Z' }),
      row({ constraintVersionId: 2, valueNumeric: 0.025, recordedAt: '2026-10-26T22:20:00Z' }),
    ],
    instruments: [inst()],
  });
  assert.strictEqual(out.census.keys, 1);
  assert.strictEqual(out.census.match, 1);
});

// ── THE BOOT CATCH-UP ──────────────────────────────────────────────────────────────────────────────────────
//
// ⚠ WHY. Weekly-only meant seven days of silence after a restart, and silence from a detector reads as
// agreement. But an unthrottled boot run turns a restart loop into event spam (each run appends an event), so the
// gate is pure and tested in BOTH directions — the same shape as `instrumentRefresh.shouldRun`.

test('★ shouldRunOnBoot: never reconciled means RUN — "never" is not "recently"', () => {
  const g = r.shouldRunOnBoot({ lastAt: null, now: '2026-10-27T00:00:00Z' });
  assert.strictEqual(g.run, true);
  assert.strictEqual(g.why, 'never_reconciled');
});

test('★ shouldRunOnBoot: a recent run is SKIPPED, or a crash loop becomes event spam', () => {
  const g = r.shouldRunOnBoot({ lastAt: '2026-10-26T23:00:00Z', now: '2026-10-27T00:00:00Z', minHours: 6 });
  assert.strictEqual(g.run, false);
  assert.strictEqual(g.why, 'ran_recently');
  assert.strictEqual(g.hours, 1);
});

test('shouldRunOnBoot: six hours is the boundary, and it is INCLUSIVE — a stale run runs', () => {
  assert.strictEqual(r.shouldRunOnBoot({ lastAt: '2026-10-26T18:00:00Z', now: '2026-10-27T00:00:00Z', minHours: 6 }).run, true);
  assert.strictEqual(r.shouldRunOnBoot({ lastAt: '2026-10-26T18:00:01Z', now: '2026-10-27T00:00:00Z', minHours: 6 }).run, false);
});

test('shouldRunOnBoot: an unreadable last-run RUNS, because a bad row must not suppress the check', () => {
  // ⚠ Fail OPEN here, unlike most guards. A throttled detector that cannot read its own log is exactly the state
  // where it must still look — the alternative is a corrupt timestamp disabling reconciliation indefinitely.
  assert.strictEqual(r.shouldRunOnBoot({ lastAt: 'not-a-date', now: '2026-10-27T00:00:00Z' }).run, true);
  assert.strictEqual(r.shouldRunOnBoot({ lastAt: 'not-a-date', now: '2026-10-27T00:00:00Z' }).why, 'unreadable_last_run');
});

test('shouldRunOnBoot: a last-run in the FUTURE runs rather than muting the loop for ever', () => {
  const g = r.shouldRunOnBoot({ lastAt: '2027-01-01T00:00:00Z', now: '2026-10-27T00:00:00Z', minHours: 6 });
  assert.strictEqual(g.run, true);
  assert.strictEqual(g.why, 'last_run_in_the_future');
});

test('shouldRunOnBoot: an unreadable clock does NOT run — a broken clock is not evidence of staleness', () => {
  const g = r.shouldRunOnBoot({ lastAt: '2026-10-01T00:00:00Z', now: 'nope' });
  assert.strictEqual(g.run, false);
  assert.strictEqual(g.why, 'clock_unreadable');
});

test('the boot entry point is exported and announces its trigger, not just its result', () => {
  // The server logs `(boot)` / `(weekly)`. A reason without a trigger cannot answer "why did this fire at 3am".
  assert.strictEqual(typeof r.runOnBoot, 'function');
  assert.strictEqual(typeof r.lastRunAt, 'function');
});
