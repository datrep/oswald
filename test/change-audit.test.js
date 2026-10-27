// `changeAudit` — the guard `epoch.js` claims to have and does not.
//
// WHY. `epoch.js`'s header used to name `assertRegistryCoverage` and say it "fails when a task row that CLOSED
// carries a landing date newer than the newest entry". **That function did not exist.** The registry sat untouched from
// 2026-09-27 while six behaviour changes landed after it — including `size-contract-scale`, which changed the
// definition of the risk unit itself — and a study scoped by it pooled four sizing rules and reported one number.
//
// ⚠ THE TESTS BELOW ARE MOSTLY ABOUT WHAT THE GUARD MUST *NOT* DO, because a guard that is wrong in the permissive
// direction is invisible and a guard that cries wolf is switched off. Measured: **218 trading task rows share
// 2026-09-30** (the whole backlog bulk-closed at once), so a check keyed on `Tasks.completedAt` would fire 218
// times. And `kill.initialEquity` is rewritten several times an hour by the disaster-floor rebase.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { unaccounted, summaryLine, BOOKKEEPING_KEYS } = require('../trading/agent/changeAudit');

const B = '2026-09-27';                    // a stand-in for the newest registered boundary
const NOW = new Date('2026-10-02T03:30:00Z').getTime();
const write = (id, at, keys) => ({ id, at, keys });

test('★ a policy settings write after the boundary is an UNREGISTERED BOUNDARY, and it blocks', () => {
  const r = unaccounted({ newestLandedAt: B, now: NOW, settingsWrites: [write(1, '2026-10-01T00:00:00Z', ['risk.pointValueSweep'])] });
  assert.equal(r.ok, false, 'an unregistered policy change must not pass');
  assert.equal(r.blocking, 1);
  assert.equal(r.findings[0].severity, 'unregistered_boundary');
  assert.match(r.findings[0].what, /risk\.pointValueSweep/);
  assert.match(r.findings[0].fix, /register this as a boundary/i);
});

test('★ the BOOKKEEPING key is excluded — otherwise the guard is permanently red and therefore ignored', () => {
  // `kill.initialEquity` is rebased several times an hour by the disaster floor. Measured on 2026-10-02: four
  // writes in one hour. A guard that fires on those is a guard nobody keeps.
  assert.ok(BOOKKEEPING_KEYS.has('kill.initialEquity'));
  const r = unaccounted({ newestLandedAt: B, now: NOW, settingsWrites: [write(1, '2026-10-02T01:00:00Z', ['kill.initialEquity'])] });
  assert.equal(r.ok, true, 'the floor rebase is not a policy boundary');
  assert.equal(r.findings.length, 0);
});

test('a NON-policy settings write is not a boundary either — the key decides, not the fact of a write', () => {
  const r = unaccounted({ newestLandedAt: B, now: NOW, settingsWrites: [write(9, '2026-10-02T01:13:00Z', ['bridge.hrefMap.at'])] });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 0, 'a cache stamp is bookkeeping, not policy');
});

test('★ CODE changes are ADVISORY — they must be reported, and must NOT block', () => {
  // A comment or a test edits trading/** without changing behaviour. But it is also the ONLY signal that catches a
  // code-only boundary: EXE-19 (2026-10-02) shipped with NO task row AND NO settings write.
  const r = unaccounted({
    newestLandedAt: B, now: NOW,
    codeChanges: [{ file: 'agent/risk.js', at: '2026-10-02T00:33:00Z' }, { file: 'agent/executor.js', at: '2026-10-02T01:17:00Z' }],
  });
  assert.equal(r.ok, true, 'advisory findings must not block, or the guard is unusable day to day');
  assert.equal(r.blocking, 0);
  const f = r.findings.find((x) => x.severity === 'advisory');
  assert.ok(f, 'but they must still be REPORTED');
  assert.equal(f.files.length, 2);
  assert.match(f.fix, /code-only change/i, 'and the fix must name the case they exist for');
});

test('★ a BULK closure is not 218 boundaries — the caveat travels with the number', () => {
  const closedTasks = Array.from({ length: 218 }, (_, i) => ({ id: i + 1, name: `TRD-X${i}`, at: '2026-09-30T00:00:00Z' }));
  const r = unaccounted({ newestLandedAt: B, now: NOW, closedTasks });
  const f = r.findings.find((x) => /task row/.test(x.what));
  assert.ok(f);
  assert.equal(f.severity, 'advisory', 'a board tidy-up must not block');
  assert.match(f.note, /BULK BOARD CLOSURE/, 'the number must not be readable as 218 behaviour changes');
  assert.equal(r.ok, true);
});

test('★ A FREEZE WINDOW THAT HAS NOT OPENED IS *PENDING*, NOT A PASS', () => {
  // ⚠ THIS IS THE BUG THE GUARD SHIPPED WITH. With the freeze at 03:00Z and the clock at 02:54Z the first run
  // found nothing, printed "nothing unaccounted for", and exited 0 — true, and readable as "everything is
  // accounted for". A green tick over an empty window. Same defect as a scope that never changes its answer.
  const r = unaccounted({
    newestLandedAt: B, freeze: { at: '2026-10-02T03:00:00Z' }, now: new Date('2026-10-02T02:54:00Z').getTime(),
    settingsWrites: [write(1, '2026-10-02T01:23:38Z', ['risk.fillAnchoredStop.enabled'])],
  });
  assert.equal(r.pending, true, 'an unopened window is its own state');
  assert.equal(r.findings.length, 0);
  assert.match(r.why, /NOT STARTED/);
  assert.match(r.why, /6 min away/, 'and it says how long until the window means anything');
  assert.match(summaryLine(r), /NOT STARTED/, 'the one-line form must not read as a pass either');
  assert.doesNotMatch(summaryLine(r), /nothing unaccounted for/);
});

test('★ once the window HAS opened, a change in it is a FREEZE BREACH — not a mere registration gap', () => {
  const r = unaccounted({
    newestLandedAt: B, freeze: { at: '2026-10-02T03:00:00Z' }, now: NOW,   // NOW is 03:30Z
    settingsWrites: [write(2, '2026-10-02T03:10:00Z', ['risk.takeProfitOffsetPct'])],
  });
  assert.equal(r.pending, false);
  assert.equal(r.ok, false, 'the whole point of the freeze is that a change inside it invalidates the window');
  assert.equal(r.findings[0].severity, 'freeze_breach');
  assert.match(r.findings[0].fix, /freeze is broken/i);
});

test('the freeze SUPERSEDES the newest entry as the boundary — the later of the two governs', () => {
  // ⚠ Set the freeze EARLIER than the newest entry and the registry is still the stricter bound; set it later and
  // the window is stricter. The runner picks the later, and this pins that a change between them is caught either way.
  const r = unaccounted({
    newestLandedAt: '2026-10-02', freeze: null, now: NOW,
    settingsWrites: [write(3, '2026-10-02T12:00:00Z', ['risk.somethingNew'])],
  });
  assert.equal(r.ok, false, 'the newest registered entry still bounds the audit when there is no freeze');
});

test('★ NO boundary at all must REFUSE, not report clean — and must not RENDER as clean either', () => {
  const r = unaccounted({});
  assert.equal(r.ok, false);
  assert.match(r.why, /refusing to report a clean bill of health/);
  // ⚠ The refusal carries `findings: []`, and an empty ARRAY is truthy, so the first `summaryLine` fell through and
  // printed "0 finding(s) after undefined" — a refusal reading as a clean report. Pinned, because that is the
  // single line most callers render.
  assert.match(summaryLine(r), /REFUSED/, 'a refusal must say so in the one-line form');
  assert.doesNotMatch(summaryLine(r), /0 finding/, 'and must never read as zero findings');
});

test('summaryLine states the WINDOW it judged — the defect is a number without one', () => {
  assert.match(summaryLine({ ok: true, pending: false, boundary: B, findings: [], blocking: 0 }), /after 2026-09-27/);
  assert.match(summaryLine({ ok: false, boundary: B, findings: [{ severity: 'unregistered_boundary' }], blocking: 1 }), /BLOCKING/);
});

// ── THE THIRD SOURCE: sql/migrations/** ─────────────────────────────────────────────────────────────────────
//
// ⚠ WHY THESE EXIST. On 2026-10-26 migrations 052 and 053 were applied to the live database ACROSS a declared
// freeze boundary, and this guard printed "nothing unaccounted for after 2026-10-26T22:31:00Z". That report was
// true of its two sources and wrong about the system: DDL is applied in SSMS, so it touches no settings row and
// no file under `trading/`. The guard could not see the one class of change that alters the substrate every
// forward measurement sits on. These tests pin that it now can — AND that it does not overclaim.

test('★ a migration touched after the boundary is REPORTED — the source that was blind to 052/053', () => {
  const r = unaccounted({
    newestLandedAt: B, now: NOW,
    schemaChanges: [{ file: 'sql/migrations/052_constraint_versions.sql', at: '2026-10-26T22:32:00Z' }],
  });
  const f = r.findings.find((x) => /migration file/.test(x.what));
  assert.ok(f, 'a migration after the boundary must be NAMED, not silently ignored');
  assert.equal(f.severity, 'advisory');
  assert.deepEqual(f.files, ['sql/migrations/052_constraint_versions.sql']);
  assert.match(f.fix, /if this was APPLIED/i);
});

test('★ …but it must NOT claim the migration landed — "written" is not "applied"', () => {
  // An mtime records when the file was WRITTEN. A migration authored in September and run in October is invisible
  // to every source here. Asserting it as a boundary would be the same defect in the other direction: a number
  // standing in for a fact it cannot establish.
  const r = unaccounted({ newestLandedAt: B, now: NOW, schemaChanges: [{ file: 'sql/migrations/054_x.sql', at: '2026-10-26T22:32:00Z' }] });
  const f = r.findings.find((x) => /migration file/.test(x.what));
  assert.match(f.note, /WRITTEN, not when the DDL was APPLIED/);
  assert.equal(r.ok, true, 'advisory must not block — whether it landed is exactly what the note cannot answer');
  assert.equal(r.blocking, 0);
});

test('a migration OLDER than the boundary is silent — the guard must not cry on the standing corpus', () => {
  const r = unaccounted({ newestLandedAt: B, now: NOW, schemaChanges: [{ file: 'sql/migrations/024_trading_agent.sql', at: '2026-09-01T00:00:00Z' }] });
  assert.equal(r.findings.length, 0);
  assert.equal(r.ok, true);
});

test('★ inside a freeze a migration IS a breach — the window admits no exceptions by source', () => {
  const r = unaccounted({
    newestLandedAt: B, freeze: { at: '2026-10-02T03:00:00Z' }, now: NOW,
    schemaChanges: [{ file: 'sql/migrations/053_constraint_bounded_start.sql', at: '2026-10-02T03:10:00Z' }],
  });
  assert.equal(r.ok, false, 'a substrate change inside the window invalidates it like any other');
  assert.equal(r.findings[0].severity, 'freeze_breach');
});

test('no schemaChanges supplied at all is not the same as "no migrations exist" — and neither may block', () => {
  // The caller that predates this source passes nothing. It must behave exactly as before, never throw and never
  // imply that schema was checked.
  const r = unaccounted({ newestLandedAt: B, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.findings.filter((f) => /migration/.test(f.what)).length, 0);
});
