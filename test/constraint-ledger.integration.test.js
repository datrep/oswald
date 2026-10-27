'use strict';
// test/constraint-ledger.integration.test.js — the constraint ledger, against REAL SQL.
//
// ★ WHY THIS FILE EXISTS. Every proof that the ledger works — the append guard, the overlap refusal, the bounded
// start, supersession, the dating — lived in `temp/verify-*.js`: gitignored, excluded from delivery, and one
// `Remove-Item temp/` away from being lost. Those scripts were the ONLY evidence that the schema and the resolver
// agree with each other rather than merely agreeing with the fixtures in `test/constraints.test.js`. This is that
// evidence, committed and runnable.
//
// ⚠⚠ `test:unit` IS DB-FREE BY DESIGN, AND THIS IS THE FIRST FILE THAT BREAKS THAT. Every other test stubs
// `db.getPool` (`market-session.test.js:51`, `session-24-7.test.js:31`) precisely so the suite runs anywhere. So a
// missing database here is NOT a failure — it is the normal state on any machine that is not this desk, and it is
// reported as a NAMED SKIP rather than a pass. A skip nobody can see is the defect AGENTS.md §7 names.
//
// ⚠⚠ NOTHING OUTSIDE THE `probe.integration.*` NAMESPACE IS TOUCHED. Every write uses that key prefix and every
// probe row is deleted in `after()`. The real constraint rows are read-only here, and the one assertion that reads
// them is conditional — a fresh install with an empty ledger must not fail a probe test.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

require('dotenv').config();

const cstore = require('../trading/store/constraints');
const c = require('../trading/agent/constraints');

const USER = 1;
const PREFIX = 'probe.integration.';
const CONNECT_TIMEOUT_MS = 5000;

let ready = false;
let why = 'not initialised';
let pool = null;

// A connect attempt that cannot hang the suite. `getPool()` retries in the background against an unreachable
// server, and a test runner that waits for it reports "slow" instead of "no database".
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

before(async () => {
  try {
    const db = require('../trading/db');
    pool = await withTimeout(db.getPool(), CONNECT_TIMEOUT_MS, 'getPool');
    await withTimeout(pool.request().query('SELECT 1 AS ok'), CONNECT_TIMEOUT_MS, 'liveness query');
    ready = true;
  } catch (e) {
    ready = false;
    why = `no database reachable (${String((e && e.message) || e).slice(0, 90)}) — integration-only suite, nothing to run against`;
  }
});

after(async () => {
  if (!ready || !pool) return;
  // ⚠ The namespace is the whole safety story: this deletes ONLY probe rows. If it ever deleted more, a green run
  // would have cost the ledger a real constraint.
  await pool.request().query(
    `DELETE FROM dbo.ConstraintVersions WHERE userId = ${USER} AND constraintKey LIKE '${PREFIX}%'`,
  ).catch(() => {});
  const left = await pool.request().query(
    `SELECT COUNT(*) AS n FROM dbo.ConstraintVersions WHERE userId = ${USER} AND constraintKey LIKE '${PREFIX}%'`,
  ).catch(() => null);
  if (left && Number(left.recordset[0].n) !== 0) {
    console.error(`[integration] WARNING: ${left.recordset[0].n} probe row(s) survived cleanup`);
  }
  // ⚠ CLOSE THE POOL, or the runner waits on its open sockets. Measured 2026-10-27: the suite reported 30.6s for
  // work that takes ~300ms, because `trading/db` keeps a singleton pool alive and node:test will not exit past it.
  // Each test FILE runs in its own process, so closing here cannot disturb another suite's pool.
  await pool.close().catch(() => {});
});

// A row builder so every test states only what it is about.
const mk = (key, o = {}) => ({
  constraintKey: PREFIX + key,
  subjectKind: 'venue',
  venue: 'plus500',
  venueInstrumentId: null,
  constraintType: 'numeric_limit',
  valueNumeric: 10,
  valueUnit: 'count',
  effectiveFrom: null,
  effectiveTo: null,
  verificationState: 'observed',
  recordedBy: 'integration-test',
  ...o,
});

const rowsFor = async (key) => (await cstore.subjectVersions(USER)).filter((r) => r.constraintKey === PREFIX + key);

test('★ a version appends, and `recordedAt` is defaulted by the DATABASE, not the process', async (t) => {
  if (!ready) return t.skip(why);
  const before = Date.now();
  const row = await cstore.appendVersion(USER, mk('append'));
  const at = new Date(row.recordedAt).getTime();
  assert.ok(Number(row.constraintVersionId) > 0, 'the insert returns an id');
  // The column default is SYSUTCDATETIME; a process clock could be minutes out and would stamp a backfill wrong.
  assert.ok(at >= before - 120000 && at <= Date.now() + 120000, `recordedAt (${row.recordedAt}) must be server time`);
});

test('★★ an OVERLAPPING version is REFUSED, and the refusal NAMES the conflicting version', async (t) => {
  if (!ready) return t.skip(why);
  const first = await cstore.appendVersion(USER, mk('overlap', {
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z',
  }));
  await assert.rejects(
    () => cstore.appendVersion(USER, mk('overlap', {
      valueNumeric: 20, effectiveFrom: '2026-02-01T00:00:00Z', effectiveTo: '2026-04-01T00:00:00Z',
    })),
    (e) => {
      // A refusal that does not name the other row sends a reader hunting through the table.
      assert.match(String(e.message), /overlap/i);
      assert.ok(e.conflictingVersionId != null, 'the refusal must carry the id it collided with');
      assert.equal(Number(e.conflictingVersionId), Number(first.constraintVersionId));
      return true;
    },
  );
});

test('an ABUTTING version is ACCEPTED — the window is half-open', async (t) => {
  if (!ready) return t.skip(why);
  await cstore.appendVersion(USER, mk('abut', {
    effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: '2026-03-01T00:00:00Z',
  }));
  // Shares the boundary instant. If the window were closed-interval this would be an overlap and be refused.
  const second = await cstore.appendVersion(USER, mk('abut', {
    valueNumeric: 20, effectiveFrom: '2026-03-01T00:00:00Z', effectiveTo: null,
  }));
  assert.ok(Number(second.constraintVersionId) > 0);
});

test('two UNDATED candidates coexist — a candidate is not a period', async (t) => {
  if (!ready) return t.skip(why);
  await cstore.appendVersion(USER, mk('undated', { valueNumeric: 1 }));
  await cstore.appendVersion(USER, mk('undated', { valueNumeric: 2 }));
  const s = c.resolveSubject(await rowsFor('undated'), { venue: 'plus500', at: '2026-10-27T00:00:00Z' });
  assert.equal(s.candidates.length, 2, 'both are undatable captures of one key, and both must remain visible');
});

test('★★ SUPERSESSION retires the row it corrects — this is what unblocks an assessment', async (t) => {
  if (!ready) return t.skip(why);
  const wrong = await cstore.appendVersion(USER, mk('supersede', { valueNumeric: 99 }));
  await cstore.appendVersion(USER, mk('supersede', {
    valueNumeric: 10, supersedesId: Number(wrong.constraintVersionId),
  }));
  const rows = await rowsFor('supersede');
  const s = c.resolveSubject(rows, { venue: 'plus500', at: '2026-10-27T00:00:00Z' });
  // Both are undated, so without retirement there would be TWO candidates and one of them known-wrong.
  assert.equal(s.candidates.length, 1, 'the corrected row is the only live candidate');
  assert.equal(Number(s.candidates[0].valueNumeric), 10);
});

test('★★ a BOUNDED start answers differently at three instants', async (t) => {
  if (!ready) return t.skip(why);
  await cstore.appendVersion(USER, mk('bounded', {
    effectiveFrom: null,
    effectiveFromNotBefore: '2026-09-19T00:00:00Z',
    effectiveFromNotAfter: '2026-10-26T00:00:00Z',
  }));
  const rows = await rowsFor('bounded');
  const at = (iso) => c.resolveSubject(rows, { venue: 'plus500', at: iso });

  const before = at('2026-09-01T00:00:00Z');
  assert.deepEqual([before.inForce.length, before.uncertain.length], [0, 0], 'before the interval it cannot have started');

  const inside = at('2026-10-01T00:00:00Z');
  assert.deepEqual([inside.inForce.length, inside.uncertain.length], [0, 1], 'inside it, neither answer is available');

  const afterIt = at('2026-10-27T00:00:00Z');
  assert.deepEqual([afterIt.inForce.length, afterIt.uncertain.length], [1, 0], 'after it, it had certainly started');
});

test('the overlap VIEW is empty for the probe namespace — the write guard was never bypassed', async (t) => {
  if (!ready) return t.skip(why);
  // ⚠ Scoped to the probe prefix ON PURPOSE. The view is an integrity check over the WHOLE user, and a probe test
  // asserting a global invariant would fail for a reason that has nothing to do with probes — a false red is how a
  // guard gets switched off.
  const all = await cstore.overlaps(USER);
  const probe = all.filter((r) => String(r.constraintKey || '').startsWith(PREFIX));
  assert.deepEqual(probe, [], 'no probe key may describe one instant twice');
});

test('the REAL dated constraints still resolve — read-only, and skipped on an empty ledger', async (t) => {
  if (!ready) return t.skip(why);
  const rows = await cstore.subjectVersions(USER);
  const sample = rows.filter((r) => r.constraintKey === 'plus500.11.minimum_trade_size' && r.effectiveFromNotBefore);
  if (!sample.length) {
    return t.skip('no dated `plus500.11.minimum_trade_size` row — a fresh install, nothing to check');
  }
  const s = c.resolveSubject(rows, { venue: 'plus500', venueInstrumentId: '11', at: '2026-10-27T00:00:00Z' });
  const mine = s.inForce.filter((r) => r.constraintKey === 'plus500.11.minimum_trade_size');
  assert.equal(mine.length, 1, 'exactly one version of the key is in force, and it is decisive rather than uncertain');
});
