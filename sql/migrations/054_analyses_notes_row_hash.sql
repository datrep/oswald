/* 054 — AnalysesNotes gains a dedupe key (2026-10-27).
 *
 * WHY. `AGENTS.md` §4 says a capture ledger's WRITER owns idempotence: a deterministic hash and a `NOT EXISTS`
 * guard, because re-capturing the same page must be a no-op. `AnalysesNotes` is a capture ledger by that same
 * paragraph's own classification and it had NEITHER — `store.insertAnalysesNote` was a plain `INSERT ... VALUES`
 * and `plus500/analysesCapture.js` did not check before calling it. Measured 2026-10-27, over every row ever
 * written (2026-10-03T16:39Z → 2026-10-26T07:06Z): 163 rows over 34 distinct titles.
 *
 * ⚠⚠ THE INDEX IS FILTERED, AND THAT IS THE LOAD-BEARING DETAIL. A plain UNIQUE index over (userId, rowHash)
 * could not be created at all: SQL Server treats NULLs as equal for uniqueness, so the 163 legacy rows — which all
 * get NULL — would collide immediately. The obvious fix (delete the duplicates so the index fits) would have broken
 * §4 to enforce §4, because a ledger is append-only and corrections are new rows. The filter keeps every legacy row
 * exactly as it was and constrains only rows written from now on.
 *
 * ⚠ BECAUSE OF THAT, THIS MIGRATION CHANGES NO EXISTING ROW. It adds a nullable column and an index over a subset.
 * There is deliberately no backfill: a computed hash over rows whose text was captured by an older parser would
 * assert that two observations were identical without having compared them the way the writer now does.
 *
 * ⚠ AND THE ANSWER TO "IS IT APPLIED" IS BEHAVIOURAL, NOT STRUCTURAL. This login has no VIEW DEFINITION, so
 * `OBJECT_DEFINITION` and most catalogue reads return nothing useful — the check is that inserting the same note
 * twice yields one row, which `trading/scripts/verify-054-rowhash.js` performs.
 */

-- ⚠⚠ FILTERED INDEXES REQUIRE THESE SET OPTIONS — on the session that CREATES the index and on every session that
-- WRITES the table. Omitted, `CREATE INDEX` fails outright: the first run of this file failed Msg 1934 because
-- sqlcmd defaults QUOTED_IDENTIFIER OFF. Stated here rather than assumed, because the failure is silent in the other
-- direction: a session with the wrong options cannot insert into a filtered-indexed table at all.
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
GO

-- 1. The column. NULLable on purpose: see the filter note above.
IF COL_LENGTH('dbo.AnalysesNotes', 'rowHash') IS NULL
BEGIN
  ALTER TABLE dbo.AnalysesNotes ADD rowHash CHAR(64) NULL;
END
GO

-- 2. The uniqueness. Filtered so legacy NULLs neither collide with each other nor with future rows.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.AnalysesNotes') AND name = 'UX_AnalysesNotes_user_hash'
)
BEGIN
  CREATE UNIQUE INDEX UX_AnalysesNotes_user_hash
    ON dbo.AnalysesNotes(userId, rowHash)
    WHERE rowHash IS NOT NULL;
END
GO
