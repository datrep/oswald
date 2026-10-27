'use strict';
// trading/agent/constraintReconcile.js — Phase 5: compare the ledger against what the venue currently says.
//
// ★★ WHY THIS COMES BEFORE DATING. A constraint cannot be dated from nothing: every row in the ledger is undated
// because `Instruments` upserts in place and has no history. The ONLY way to establish that a term changed — and
// therefore to bound when — is to compare two observations taken at different times. Reconciliation is that
// comparison. It is not an alternative to dating; it is the thing dating will be built on.
//
// ⚠⚠ AND IT EXPOSES A MODELLING GAP THAT MUST BE CLOSED BEFORE ANY DATE IS WRITTEN. Suppose capture at T1 says 20%
// and capture at T2 says 25%. The change happened SOMEWHERE IN (T1, T2]. Writing `effectiveFrom = T2` asserts it
// changed exactly then, which is false; writing it as another undated candidate records no progress. The honest
// representation is a BOUNDED interval, and `ConstraintVersions` has nowhere to put one. So this module reports drift
// and refuses to date it — the resolution is a schema decision, not something to guess at 03:00Z.
//
// ⚠ AND IT NEVER WRITES A CONSTRAINT. Report-only, per F2. A reconciliation job that silently authored versions
// would turn a detector into a producer, and the ledger's whole value is that every row has a human-attributable
// origin.
//
// PURE COMPARISON, IMPURE READ. `reconcile()` takes rows and returns findings; `runOnce()` reads and logs.

const PURE = { minimum_trade_size: 'unitAmount', initial_margin_pct: 'initialMarginPct', funding_buy_pct: 'fundingBuyPct', funding_sell_pct: 'fundingSellPct' };

// Field names the ledger can hold. Used to tell `venue.field` (venue-wide) from `venue.<id>.<field>`.
const FIELDS = new Set([...Object.keys(PURE), 'funding_time', 'single_tab']);

// Two shapes are legitimate:
//     plus500.<venueInstrumentId>.<field>   an instrument-scoped term
//     plus500.<field>                       a VENUE-WIDE term (e.g. the one-tab prohibition)
//
// ⚠ THE FIRST VERSION ACCEPTED ONLY THE THREE-SEGMENT FORM and reported `plus500.single_tab` as `unparsable_key`.
// A legitimate row rendered as a broken one is the same defect as a broken row rendered as a good one — it sends a
// reader to inspect the data when the bug was in the parser.
function parseKey(key) {
  const parts = String(key || '').split('.');
  if (parts.length === 3) {
    const [venue, venueInstrumentId, field] = parts;
    if (!/^[a-z][a-z0-9]*$/.test(venue) || !/^[a-z0-9][a-z0-9_]*$/.test(venueInstrumentId) || !FIELDS.has(field)) return null;
    return { venue, venueInstrumentId, field };
  }
  if (parts.length === 2) {
    const [venue, field] = parts;
    if (!/^[a-z][a-z0-9]*$/.test(venue) || !FIELDS.has(field)) return null;
    return { venue, venueInstrumentId: null, field };
  }
  return null;
}

// The value the ledger currently asserts: the version in force at `at`, else the NEWEST CANDIDATE (by recordedAt),
// else nothing. ⚠ Falling back to a candidate is deliberate: with an undated ledger the candidate IS the assertion,
// and refusing to compare it would make this module report "no copy" for all 51 rows and measure nothing.
function assertedValue(rows, at) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const t = at == null ? Date.now() : new Date(at).getTime();
  const dated = list.filter((r) => r.effectiveFrom != null);
  const live = dated.filter((r) => {
    const from = new Date(r.effectiveFrom).getTime();
    const to = r.effectiveTo == null ? Infinity : new Date(r.effectiveTo).getTime();
    return from <= t && t < to;
  }).sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom));
  if (live.length) return { row: live[0], basis: 'in_force' };
  const cands = list.filter((r) => r.effectiveFrom == null)
    .sort((a, b) => new Date(b.recordedAt || 0) - new Date(a.recordedAt || 0));
  if (cands.length) return { row: cands[0], basis: 'candidate' };
  return { row: null, basis: 'none' };
}

// One assertion against one instrument row. `null` when the field has no instrument source (the venue-wide
// prohibition) — an absent source is reported, not treated as a match.
function compareOne({ row, instrument }) {
  const parsed = parseKey(row && row.constraintKey);
  if (!parsed) return { status: 'unparsable_key' };
  // ⚠ A VENUE-WIDE KEY HAS NO INSTRUMENT BY DESIGN. Reporting it as `no_instrument` would read as a missing registry
  // row — a data gap — when it is simply a constraint that was never instrument-scoped.
  if (!parsed.venueInstrumentId) return { status: 'venue_wide' };
  if (!instrument) return { status: 'no_instrument' };

  if (parsed.field === 'funding_time') {
    // ⚠⚠ THE VENUE'S LABEL IS LOCAL AND THE STORED VALUE IS UTC. `fundingMinuteFromText('5:00 AM')` returns 1260,
    // not 300: the page shows the desk's UTC+8 wall clock and the parser converts to UTC minutes. Both this module
    // and the bootstrap go through that ONE function, which is why they agree — comparing a stored UTC minute against
    // a locally-parsed label would report a permanent 16-hour drift. My first test asserted 300 and failed, which is
    // the trap in miniature.
    const want = row.valueMinutesUtc;
    const { fundingMinuteFromText } = require('./time');
    const got = instrument.fundingTime ? fundingMinuteFromText(instrument.fundingTime) : null;
    if (want == null || got == null) return { status: 'no_source' };
    return { status: Number(want) === Number(got) ? 'match' : 'drift', stored: Number(want), current: Number(got), basis: 'minutes_utc' };
  }

  const col = PURE[parsed.field];
  if (!col) return { status: 'no_source' };          // e.g. `single_tab`, which no instrument row carries
  const stored = row.valueNumeric == null ? null : Number(row.valueNumeric);
  const current = instrument[col] == null ? null : Number(instrument[col]);
  if (stored == null || current == null) return { status: 'no_source' };
  // ⚠ STRICT EQUALITY IS WRONG FOR FLOATS. The ledger stores DECIMAL(28,10) and the source is DECIMAL(9,4); compare at
  // the coarser precision so a representation difference is not reported as a venue change.
  const same = Math.abs(stored - current) < 1e-4;
  return { status: same ? 'match' : 'drift', stored, current };
}

// Every assertion the ledger holds, against the current registry snapshot.
// Returns findings plus a census — a reconciliation that reports only "drifts" cannot distinguish a quiet venue from
// a broken read, which is the dead-feed rule this repo applies to every loop.
function reconcile({ rows = [], instruments = [], at = null } = {}) {
  const byId = new Map();
  for (const i of instruments) if (i && i.venueInstrumentId != null) byId.set(String(i.venueInstrumentId), i);

  const byKey = new Map();
  for (const r of rows) {
    if (!r || !r.constraintKey) continue;
    if (!byKey.has(r.constraintKey)) byKey.set(r.constraintKey, []);
    byKey.get(r.constraintKey).push(r);
  }

  const findings = [];
  const census = { keys: byKey.size, match: 0, drift: 0, no_source: 0, no_instrument: 0, venue_wide: 0, unparsable_key: 0 };
  for (const [key, versions] of byKey) {
    const { row, basis } = assertedValue(versions, at);
    if (!row) continue;
    const parsed = parseKey(key) || {};
    const instrument = parsed.venueInstrumentId ? byId.get(String(parsed.venueInstrumentId)) : null;
    const cmp = compareOne({ row, instrument });
    census[cmp.status] = (census[cmp.status] || 0) + 1;
    if (cmp.status === 'drift') {
      findings.push({
        constraintKey: key,
        field: parsed.field || null,
        venueInstrumentId: parsed.venueInstrumentId || null,
        symbol: instrument ? instrument.symbol : null,
        stored: cmp.stored,
        current: cmp.current,
        assertedFrom: row.effectiveFrom || null,
        // ⚠ NAMED, NOT DATED. We know it changed; we do NOT know when. See the header.
        datedChange: false,
        note: row.effectiveFrom == null
          ? 'stored assertion is UNDATED, so a change is detected but cannot be bounded to an interval'
          : 'change detected after a dated version; the change instant is still unknown',
      });
    }
  }
  return { census, findings };
}

// Read, compare, log. NEVER throws and NEVER writes a constraint — it rides a timer, and a reconciliation loop that
// can take the desk down is worse than no reconciliation.
async function runOnce(userId, { at = new Date(), venue = 'plus500' } = {}) {
  const store = require('../store');
  const cstore = require('../store/constraints');
  const registry = require('../store/instruments');
  let rows; let instruments; let error = null;
  try {
    rows = await cstore.subjectVersions(userId, { venue });
    instruments = await registry.listInstruments(userId, { venue });
  } catch (e) {
    error = String((e && e.message) || e).slice(0, 200);
  }

  const out = error
    // ⚠ A FAILED READ IS NOT AN EMPTY RESULT. "we could not read the registry" and "the venue matches the ledger"
    // would otherwise produce the same silence.
    ? { ok: false, reason: 'read_failed', error }
    : (() => {
      const r = reconcile({ rows, instruments, at });
      return {
        ok: true,
        reason: r.findings.length ? 'drift' : 'match',
        census: r.census,
        findings: r.findings.slice(0, 40),
        at: new Date(at).toISOString(),
      };
    })();

  await store.logEvent(userId, 'constraint_reconcile', out).catch(() => {});
  return out;
}

// ★ 2026-10-26 — WHY A BOOT CATCH-UP EXISTS, AND WHY IT IS THROTTLED.
//
// As a WEEKLY-ONLY tick this module went silent for seven days after every restart. Silence from a detector is
// indistinguishable from agreement: a reconcile that had broken — a renamed source field, a failed read — would
// look exactly like 51 constraints matching for a week. That is the same defect as a feed with no rows, one level
// up: an absent measurement that is not named reads as a clean result.
//
// ⚠ AND THE CATCH-UP IS NOT "RUN ON EVERY BOOT". Each run appends a `constraint_reconcile` event, and the desk has
// a crash guard that restarts a dead child — so an unthrottled boot run would turn a restart loop into event spam,
// which is how a useful signal becomes a row nobody reads. `shouldRunOnBoot` is PURE so both directions are
// testable offline, the same shape as `plus500/instrumentRefresh.shouldRun`.

// The last time this desk reconciled, from its own event log. Null means "never" — which is a real answer and
// distinct from "just now", so the caller can tell a fresh install from a throttle.
function shouldRunOnBoot({ lastAt = null, now = new Date(), minHours = 6 } = {}) {
  if (lastAt == null) return { run: true, why: 'never_reconciled' };
  const last = new Date(lastAt).getTime();
  const cur = new Date(now).getTime();
  if (!Number.isFinite(last)) return { run: true, why: 'unreadable_last_run' };
  if (!Number.isFinite(cur)) return { run: false, why: 'clock_unreadable' };
  const hours = (cur - last) / 3600000;
  if (hours < 0) return { run: true, why: 'last_run_in_the_future' };
  if (hours < minHours) return { run: false, why: 'ran_recently', hours: +hours.toFixed(2), minHours };
  return { run: true, why: 'stale', hours: +hours.toFixed(2), minHours };
}

async function lastRunAt(userId) {
  try {
    // ⚠ `sql` FROM THE POOL, NEVER `require('mssql')`. `trading/agent/waker.js` documents this trap and this
    // function walked into it: `require('mssql')` from trading/ resolves to `trading/node_modules/mssql`, a
    // DIFFERENT instance from the pool's, so the type class fails. Measured 2026-10-26 — the first version of this
    // function threw on every call, the `catch` below swallowed it, and the boot log reported `never_reconciled`
    // beside three events that existed.
    const { getPool, sql } = require('../db');
    const pool = await getPool();
    const r = await pool.request()
      .input('u', sql.Int, userId)
      .query("SELECT MAX(createdAt) AS at FROM TradingEvents WHERE userId = @u AND kind = 'constraint_reconcile'");
    return (r.recordset && r.recordset[0] && r.recordset[0].at) || null;
  } catch (e) {
    // ⚠⚠ NOT SILENT. Swallowing this reported as `never_reconciled` \u2014 a PLAUSIBLE reason, which is the worst
    // kind of wrong answer: the throttle opened, the run happened, and nothing looked broken. A failed read must
    // name itself (AGENTS.md \u00a77), and the caller stays fail-open because a corrupt log must not suppress the
    // check \u2014 it just must not do so quietly.
    console.error('[trading] constraint reconcile \u2014 last-run read FAILED (gate opens):', (e && e.message) || e);
    return null;
  }
}

// Boot entry point. Reads the log, decides, and runs at most once. NEVER throws.
async function runOnBoot(userId, { now = new Date(), minHours = 6 } = {}) {
  let lastAt = null;
  try { lastAt = await lastRunAt(userId); } catch { lastAt = null; }
  const gate = shouldRunOnBoot({ lastAt, now, minHours });
  if (!gate.run) return { ran: false, ...gate, lastAt };
  const out = await runOnce(userId, { at: now }).catch((e) => ({ ok: false, reason: 'threw', error: String((e && e.message) || e) }));
  return { ran: true, ...gate, lastAt, result: out };
}

module.exports = { PURE, parseKey, assertedValue, compareOne, reconcile, runOnce, shouldRunOnBoot, lastRunAt, runOnBoot };
