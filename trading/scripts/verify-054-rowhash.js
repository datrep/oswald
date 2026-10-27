'use strict';
// trading/scripts/verify-054-rowhash.js — verify migration 054 the only way this repo accepts: BEHAVIOURALLY, as the
// APP's login, inside a transaction that is always rolled back.
//
// ⚠ WHY NOT "does the column exist". The app's SQL login has no VIEW DEFINITION, so `OBJECT_DEFINITION` and most
// catalogue reads return nothing useful — a structural check would report "missing" for a schema that is fine, which
// is the same class of wrong answer as reporting "present" for one that is not.
//
// ⚠ TWO THINGS ARE BEING PROVED, AND THE SECOND IS THE ONE THAT BITES A LIVE DESK. A FILTERED INDEX requires specific
// SET options on every session that WRITES the table, not only the one that created it. If the app's connection had
// them wrong, every capture INSERT would throw with the column happily in place. So this runs through `trading/db`,
// the pool the desk actually uses, rather than through sqlcmd.
//
// Usage: node trading/scripts/verify-054-rowhash.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { getPool, sql } = require('../db');

const PROBE_HASH = 'f'.repeat(64);   // a value no real row can carry: real hashes are sha256 hex of an observation
const PROBE_USER = 1;

async function main() {
  const pool = await getPool();
  // `sessionOptions` used to sit here as the last trace of an assertion that was replaced by a comment. A key that is
  // permanently null in a verifier's output reads as a measurement that never happened, which is the one thing this
  // script exists to refuse.
  const out = { guard: null, index: null, rowsLeft: null };

  // ── 1. The WRITER's guard: the same observation inserted twice yields ONE row, and the app session can write at
  //       all. Everything here rolls back, so the ledger is untouched — §4 forbids deleting a row to tidy up a test.
  const guard = await pool.request()
    .input('userId', sql.Int, PROBE_USER)
    .input('rowHash', sql.Char(64), PROBE_HASH)
    .input('kind', sql.NVarChar(24), 'weekly')
    .input('title', sql.NVarChar(400), 'verify-054 probe')
    .batch(`
      BEGIN TRAN;
      INSERT INTO AnalysesNotes (userId, kind, title, source, parseStatus, rowHash)
        SELECT @userId, @kind, @title, 'verify-054', 'manual', @rowHash
         WHERE NOT EXISTS (SELECT 1 FROM AnalysesNotes WHERE userId = @userId AND rowHash = @rowHash);
      INSERT INTO AnalysesNotes (userId, kind, title, source, parseStatus, rowHash)
        SELECT @userId, @kind, @title, 'verify-054', 'manual', @rowHash
         WHERE NOT EXISTS (SELECT 1 FROM AnalysesNotes WHERE userId = @userId AND rowHash = @rowHash);
      SELECT COUNT(*) AS n FROM AnalysesNotes WHERE userId = @userId AND rowHash = @rowHash;
      ROLLBACK;
    `);
  out.guard = guard.recordset[0].n;
  // The fact that this batch reached `recordset` at all IS the session-options proof: a session with the wrong SET
  // options cannot insert into a filtered-indexed table, so there is no separate assertion to write.

  // ── 2. The INDEX, with the guard bypassed. This is what stops a second writer (the vision lane, a future caller)
  //       from duplicating a row the store would have suppressed.
  const idx = await pool.request()
    .input('userId', sql.Int, PROBE_USER)
    .input('rowHash', sql.Char(64), PROBE_HASH)
    .input('kind', sql.NVarChar(24), 'weekly')
    .input('title', sql.NVarChar(400), 'verify-054 probe')
    .batch(`
      BEGIN TRAN;
      INSERT INTO AnalysesNotes (userId, kind, title, source, parseStatus, rowHash)
        SELECT @userId, @kind, @title, 'verify-054', 'manual', @rowHash;
      BEGIN TRY
        INSERT INTO AnalysesNotes (userId, kind, title, source, parseStatus, rowHash)
          SELECT @userId, @kind, @title, 'verify-054', 'manual', @rowHash;
        SELECT 'ACCEPTED' AS verdict, 0 AS err;
      END TRY
      BEGIN CATCH
        SELECT 'REJECTED' AS verdict, ERROR_NUMBER() AS err;
      END CATCH
      ROLLBACK;
    `);
  out.index = idx.recordset[0].verdict;
  out.indexError = idx.recordset[0].err;

  // ── 3. Nothing may survive the probe. Counted, not assumed.
  const left = await pool.request()
    .input('rowHash', sql.Char(64), PROBE_HASH)
    .query('SELECT COUNT(*) AS n FROM AnalysesNotes WHERE rowHash = @rowHash');
  out.rowsLeft = left.recordset[0].n;

  const ok = out.guard === 1 && out.index === 'REJECTED' && out.rowsLeft === 0;
  console.log(JSON.stringify({ ok, ...out }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('verify-054 FAILED:', e.message || e); process.exit(1); });
