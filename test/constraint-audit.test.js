'use strict';
// test/constraint-audit.test.js — the ledger's first CONSUMER, tested without a database.
//
// `constraintAudit.assessmentFor` is pure: trade + versions + instrument id + floors in, a named record out. The
// decision logic is the part worth pinning, and it needs no SQL.
//
// ⚠⚠ TWO CONTRACT CHANGES FROM THE FIRST VERSION, BOTH CORRECTIONS:
//   1. THE INSTANT IS ENTRY TIME (`filledAt`, else `openAt`), not `closeAt`. The constraint that governs a trade's
//      SIZE is the one in force when the order was sized; judging at close could compare a September entry against
//      an October minimum. `RULES_VERSION` 1 recorded the wrong instant and those rows are superseded, not deleted.
//   2. THE VERDICT IS SCOPED and carries its scope. `assessSubject` answers for the whole subject and must block on
//      anything unknown; a trade audit can judge one key and never answer for the others.
//
// ⚠ THE BRANCHES THAT MATTER ARE THE ONES THAT ARE NOT A VERDICT, and they are DIFFERENT FACTS: `no_instant`,
// `instrument_unknown`, `effective_date_unknown`, `effective_date_uncertain`, `no_version_in_force`, and the
// assessability floor. Collapsing them sends a reader to the wrong file.
const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../trading/agent/constraintAudit');
const c = require('../trading/agent/constraints');

const KEY = 'plus500.11.minimum_trade_size';
const row = (o = {}) => ({
  constraintVersionId: 1,
  constraintKey: KEY,
  constraintType: 'numeric_limit',
  valueNumeric: 0.025,
  valueUnit: 'Troy Ounces',
  effectiveFrom: null,
  effectiveFromNotBefore: '2026-09-19T00:00:00Z',
  effectiveFromNotAfter: '2026-10-26T00:00:00Z',
  effectiveTo: null,
  recordedAt: '2026-10-26T00:00:00Z',
  verificationState: 'observed',
  venue: 'plus500',
  venueInstrumentId: '11',
  ...o,
});
// ⚠ `filledAt` is the ENTRY instant. `closeAt` is present and LATER on purpose, so a consumer that still reached for
// it would judge at the wrong time and be caught here rather than in a study.
const trade = (o = {}) => ({
  id: 1, symbol: 'Gold', direction: 'buy', size: 0.5, status: 'closed',
  filledAt: '2026-10-27T00:00:00Z', openAt: '2026-10-26T23:59:00Z', closeAt: '2026-10-27T06:00:00Z',
  ...o,
});

test('★ a trade above the minimum is SATISFIED — and the scope says what that means', () => {
  const r = a.assessmentFor({ trade: trade(), versions: [row()], venueInstrumentId: '11' });
  assert.strictEqual(r.verdict, c.SATISFIED);
  assert.strictEqual(r.scope, 'minimum trade size', 'a scoped verdict must be readable as scoped');
  assert.deepStrictEqual(r.checked, [KEY]);
});

test('★ a trade BELOW the minimum is BREACHED, and the reason carries what was compared', () => {
  const r = a.assessmentFor({ trade: trade({ size: 0.001 }), versions: [row()], venueInstrumentId: '11' });
  assert.strictEqual(r.verdict, c.BREACHED);
  assert.match(r.results[0].reason, /0\.001|0\.025/);
});

test('★★ the instant is ENTRY, not close — a trade filled before the window closes is judged in the window', () => {
  // filledAt sits INSIDE the bounded window, closeAt sits AFTER it. Judged at close this would be SATISFIED; judged
  // at entry it is unassessable, because the minimum that applied when the order was sized is not knowable.
  const straddling = trade({
    filledAt: '2026-10-20T00:00:00Z',
    openAt: '2026-10-20T00:00:00Z',
    closeAt: '2026-10-27T06:00:00Z',
  });
  const r = a.assessmentFor({ trade: straddling, versions: [row()], venueInstrumentId: '11' });
  assert.strictEqual(r.verdict, c.UNASSESSABLE, 'judging at closeAt would have called this a pass');
  assert.strictEqual(r.results[0].reason, 'effective_date_uncertain');
  assert.strictEqual(r.at, '2026-10-20T00:00:00.000Z', 'and the record says which instant it used');
});

test('filledAt is preferred, openAt is the fallback, and closeAt is never used', () => {
  const noFill = trade({ filledAt: null, openAt: '2026-10-27T00:00:00Z' });
  const r = a.assessmentFor({ trade: noFill, versions: [row()], venueInstrumentId: '11' });
  assert.strictEqual(r.at, '2026-10-27T00:00:00.000Z', 'the fallback is explicit, not silent');

  const neither = trade({ filledAt: null, openAt: null });
  const r2 = a.assessmentFor({ trade: neither, versions: [row()], venueInstrumentId: '11' });
  assert.strictEqual(r2.verdict, c.UNASSESSABLE);
  assert.strictEqual(r2.reason, 'no_instant', 'closeAt being present must NOT rescue this');
});

test('★ an UNKNOWN instrument is named, not reported as an empty ledger', () => {
  const r = a.assessmentFor({ trade: trade(), versions: [row()], venueInstrumentId: null });
  assert.strictEqual(r.verdict, c.UNASSESSABLE);
  assert.strictEqual(r.reason, 'instrument_unknown');
});

test('★★ THE FLOOR: a trade before the desk could observe the constraint is unassessable, not satisfied', () => {
  const dated = row({ effectiveFrom: '2026-09-01T00:00:00Z', effectiveFromNotBefore: null, effectiveFromNotAfter: null });
  // 10-01 is BEFORE the floor and AFTER the row began — the only instant where the floor is what refuses.
  const withFloor = a.assessmentFor({
    trade: trade({ filledAt: '2026-10-01T00:00:00Z' }),
    versions: [dated], venueInstrumentId: '11', floors: { minimum_trade_size: '2026-10-02' },
  });
  assert.strictEqual(withFloor.verdict, c.UNASSESSABLE);
  assert.strictEqual(withFloor.results[0].reason, 'before_assessability_floor');

  const noFloor = a.assessmentFor({
    trade: trade({ filledAt: '2026-10-01T00:00:00Z' }), versions: [dated], venueInstrumentId: '11',
  });
  assert.strictEqual(noFloor.verdict, c.SATISFIED, 'without the floor this would have been a clean pass over the bug');
});

test('★ margin and funding are NOT JUDGED, listed with reasons — and they do not touch the verdict', () => {
  const rows = [
    row(),
    row({ constraintVersionId: 2, constraintKey: 'plus500.11.initial_margin_pct', valueNumeric: 20 }),
    row({ constraintVersionId: 3, constraintKey: 'plus500.11.funding_sell_pct', valueNumeric: -0.012 }),
  ];
  const r = a.assessmentFor({ trade: trade(), versions: rows, venueInstrumentId: '11' });
  assert.strictEqual(r.verdict, c.SATISFIED);
  const keys = r.notJudged.map((x) => x.constraintKey).sort();
  assert.deepStrictEqual(keys, ['plus500.11.funding_sell_pct', 'plus500.11.initial_margin_pct']);
  for (const nj of r.notJudged) assert.ok(nj.reasons.includes('not_requested'));
});

test('★★ the undated venue prohibition appears in notJudged with BOTH reasons, and never blocks', () => {
  // `plus500.single_tab` in miniature: venue-wide, a prohibition, undated. It applies to every subject, and before
  // the scoped API it made every trade unassessable for ever.
  const tab = row({
    constraintVersionId: 59, constraintKey: 'plus500.single_tab', constraintType: 'prohibition',
    valueNumeric: null, valueUnit: null, effectiveFrom: null,
    effectiveFromNotBefore: null, effectiveFromNotAfter: null, verificationState: 'asserted',
  });
  const r = a.assessmentFor({ trade: trade(), versions: [row(), tab], venueInstrumentId: '11' });
  assert.strictEqual(r.verdict, c.SATISFIED);
  const nj = r.notJudged.find((x) => x.constraintKey === 'plus500.single_tab');
  assert.ok(nj, 'it must be listed, not dropped');
  assert.ok(nj.reasons.includes('effective_date_unknown'));
  assert.ok(nj.reasons.includes('prohibition_needs_an_event_observation'));
});

test('the assessment hash is deterministic, and a rules change is carried separately', () => {
  const base = { checked: [KEY], verdict: c.SATISFIED, reason: null };
  assert.strictEqual(a.assessmentHash(7, base), a.assessmentHash(7, base));
  assert.notStrictEqual(a.assessmentHash(7, base), a.assessmentHash(7, { ...base, verdict: c.BREACHED }));
  assert.notStrictEqual(a.assessmentHash(7, base), a.assessmentHash(8, base));
  // ⚠ The rules version is NOT in the hash: it is a separate payload field the dedupe query filters on, so a corrected
  // rule set must change the version by hand rather than by accident.
  assert.ok(Number.isInteger(a.RULES_VERSION) && a.RULES_VERSION >= 2);
});

test('the check map cites a FIELD and a DIRECTION — the ledger does not encode intent', () => {
  assert.deepStrictEqual(Object.keys(a.CHECKS), ['minimum_trade_size']);
  assert.strictEqual(a.CHECKS.minimum_trade_size.direction, 'min');
  assert.strictEqual(a.CHECKS.minimum_trade_size.observation({ size: 3 }), 3);
  assert.strictEqual(a.CHECKS.minimum_trade_size.observation({}), null, 'an absent field is null, never guessed');
});

// ── THE WINDOW IS THE POPULATION, NOT A ROW COUNT ─────────────────────────────────────────────────────────────
//
// ⚠ MEASURED 2026-10-27: 247 trades had closed in 30 days and the consumer fetched `TOP 200`, so 47 were never
// assessed and nothing said so. `store.EVENT_QUERY_CAP` documents the same defect ("a caller asking for more
// silently received less and could not tell a TOTAL from a FLOOR") — it was rebuilt one file over.

test('★ windowPlan: under the cap, everything is taken and nothing is withheld', () => {
  const p = a.windowPlan({ total: 247, maxTrades: 5000 });
  assert.deepStrictEqual(p, { take: 247, truncated: false, remaining: 0, total: 247 });
});

test('★★ windowPlan: over the cap, the withholding is NAMED — the run knows it was partial', () => {
  // The whole point: a truncated pass must be distinguishable from a complete one. 200 of 247 is not 247.
  const p = a.windowPlan({ total: 247, maxTrades: 200 });
  assert.strictEqual(p.take, 200);
  assert.strictEqual(p.truncated, true);
  assert.strictEqual(p.remaining, 47);
  assert.strictEqual(p.total, 247);
});

test('windowPlan: an empty window is a complete pass, not an error', () => {
  const p = a.windowPlan({ total: 0, maxTrades: 5000 });
  assert.deepStrictEqual(p, { take: 0, truncated: false, remaining: 0, total: 0 });
});

test('windowPlan: garbage in does not become a silent zero — the cap floors at 1 and the total at 0', () => {
  assert.strictEqual(a.windowPlan({ total: null, maxTrades: null }).take, 0);
  assert.strictEqual(a.windowPlan({ total: 5, maxTrades: 0 }).take, 1, 'a zero cap must not withhold everything silently');
  assert.strictEqual(a.windowPlan({ total: 5, maxTrades: 'nonsense' }).take, 1);
});
