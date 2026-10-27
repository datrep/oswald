-- 053: BOUNDED EFFECTIVE START — the honest representation of "it changed somewhere in this interval".
--
-- ★★ WHY. 052 gave a version either an exact `effectiveFrom` or nothing. Reconciliation (Phase 5) exposes why that is
-- not enough: capture at T1 shows 20%, capture at T2 shows 25%. THE CHANGE HAPPENED SOMEWHERE IN (T1, T2]. Writing
-- `effectiveFrom = T2` asserts an instant we do not know — a fabricated date, and the exact failure this ledger
-- exists to prevent. Leaving it undated records no progress and discards the one thing the observation DID establish:
-- an upper bound.
--
-- So a version may now carry the interval its true start lies within:
--     effectiveFromNotBefore <= (true start) <= effectiveFromNotAfter
--
-- ★ THREE STATES, AND THE RESOLVER MUST TELL THEM APART:
--   1. `effectiveFrom` known            -> exact. Decidable at every instant.
--   2. `effectiveFrom` NULL + bounds    -> bounded. DETERMINISTIC OUTSIDE the interval (before it cannot have started;
--                                          at or after `NotAfter` it definitely had), UNCERTAIN INSIDE it.
--   3. `effectiveFrom` NULL, no bounds  -> unknown. Never in force; a candidate. (052's behaviour, unchanged.)
--
-- The value of (2) over (3) is that the unassessable window SHRINKS to the interval instead of extending to the end of
-- time. A trade before `NotBefore` is definitively not governed by the version; a trade at or after `NotAfter` is
-- definitively governed by it if its window has not closed.
--
-- ⚠ EXACT AND BOUNDED ARE MUTUALLY EXCLUSIVE. Carrying both is not more information, it is two answers to one
-- question, and a reader would have to know which wins. The CHECK refuses it.
--
-- ⚠ AND THE OVERLAP RULE USES THE EARLIEST POSSIBLE START. A bounded row is treated as beginning at `NotBefore`,
-- which makes a collision MORE likely — the guard errs toward refusing, never toward permitting.
IF DB_NAME() <> 'DB_Oswald'
  THROW 51053, '053_constraint_bounded_start must be applied to DB_Oswald. This session is on a different database — switch it (SSMS: the database dropdown) and re-run.', 1;

IF COL_LENGTH('dbo.ConstraintVersions', 'effectiveFromNotBefore') IS NULL
BEGIN
  ALTER TABLE dbo.ConstraintVersions ADD
    effectiveFromNotBefore DATETIME2(3) NULL,
    effectiveFromNotAfter  DATETIME2(3) NULL;
END;
GO

-- An interval with its ends swapped is not an interval.
IF OBJECT_ID('dbo.CK_ConstraintVersions_bounds', 'C') IS NULL
  ALTER TABLE dbo.ConstraintVersions ADD CONSTRAINT CK_ConstraintVersions_bounds CHECK (
    effectiveFromNotAfter IS NULL
    OR effectiveFromNotBefore IS NULL
    OR effectiveFromNotAfter >= effectiveFromNotBefore);
GO

-- An exact date and a bound cannot both describe the same start: that is two answers to one question.
IF OBJECT_ID('dbo.CK_ConstraintVersions_bounds_exclusive', 'C') IS NULL
  ALTER TABLE dbo.ConstraintVersions ADD CONSTRAINT CK_ConstraintVersions_bounds_exclusive CHECK (
    effectiveFrom IS NULL
    OR (effectiveFromNotBefore IS NULL AND effectiveFromNotAfter IS NULL));
GO

-- ⚠ DELIBERATELY NO "must carry a bound" CHECK. A first draft had one, and it was a TAUTOLOGY: every branch of it
-- reduced to "the bounds are whatever they are", because the third state (unknown, no bounds at all) is legitimate and
-- the constraint had to permit it. A CHECK that cannot fail is worse than none — it reads as a guard in review and
-- enforces nothing at run time.

CREATE INDEX IX_ConstraintVersions_bounds
  ON dbo.ConstraintVersions (userId, constraintKey, effectiveFromNotBefore, effectiveFromNotAfter);
GO

-- ── THE OVERLAP VIEW, REBUILT TO USE THE EARLIEST POSSIBLE START ──────────────────────────────────────────
-- A bounded row begins at the EARLIEST instant it could, which makes a collision more likely rather than less. The
-- guard must never be made more permissive by an admission of uncertainty.
IF OBJECT_ID('dbo.vw_ConstraintOverlaps','V') IS NOT NULL DROP VIEW dbo.vw_ConstraintOverlaps;
GO
CREATE VIEW dbo.vw_ConstraintOverlaps AS
WITH s AS (
  SELECT constraintVersionId, userId, constraintKey,
         COALESCE(effectiveFrom, effectiveFromNotBefore) AS startAt,
         effectiveTo
    FROM dbo.ConstraintVersions
   WHERE COALESCE(effectiveFrom, effectiveFromNotBefore) IS NOT NULL
)
SELECT a.userId,
       a.constraintKey,
       a.constraintVersionId AS earlierId,
       b.constraintVersionId AS laterId,
       a.startAt             AS earlierFrom,
       a.effectiveTo         AS earlierTo,
       b.startAt             AS laterFrom,
       b.effectiveTo         AS laterTo
  FROM s a
  JOIN s b
    ON b.userId        = a.userId
   AND b.constraintKey = a.constraintKey
   AND b.constraintVersionId > a.constraintVersionId
   AND a.startAt  < COALESCE(b.effectiveTo, CONVERT(DATETIME2(3), '9999-12-31'))
   AND b.startAt  < COALESCE(a.effectiveTo, CONVERT(DATETIME2(3), '9999-12-31'));
GO

PRINT '053 applied: bounded effective start + rebuilt overlap view';
PRINT 'Post-apply check (must return 0 rows):  SELECT * FROM dbo.vw_ConstraintOverlaps;';
