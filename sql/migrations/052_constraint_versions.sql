-- 052: EXTERNAL CONSTRAINT LEDGER — an append-only record of the facts that come from OUTSIDE the desk
-- (venue contract terms and operational limits), versioned, so any trade can name which constraints were in force
-- when it happened and whether it honoured them.
--
-- ★ WHY A NEW TABLE. `FeatureEpochs` records INTERNAL policy eras; `Instruments` is a live lookup that UPSERTS in
-- place (`store/instruments.js` 71-77 rewrites the row and moves `capturedAt`), so it cannot say what was true last
-- month. Neither can hold an externally authored fact with its own effective window, evidence and verification
-- state. This is that ledger, and it is audit-first: NOTHING ON THE DECISION PATH READS IT.
--
-- ★ THE PURPOSE IS ONE QUESTION: "what applied at this trade, and was it honoured?" The answer has THREE outcomes —
-- satisfied | breached | unassessable — and missing or unrecoverable evidence must land in the third, never in the
-- first. A clean pass from absent history is the failure this table exists to prevent.
--
-- ---- DECISIONS BAKED INTO THE SHAPE (each traceable to the scoping register) --------------------------------
--
-- TWO CLOCKS, NEVER CONFLATED. `effectiveFrom`/`effectiveTo` say when the WORLD changed; `recordedAt` says when the
-- desk LEARNED. A venue that changes a margin on the 1st and is discovered on the 5th produces two different
-- answers for a trade on the 3rd, and only "in force" answers "did we honour it". `constraintsKnownAt` is the
-- separately named belief view; the difference between them is `late_discovery`.
--
-- ⚠ `effectiveFrom IS NULL` MEANS UNKNOWN, AND AN UNKNOWN IS NEVER "IN FORCE". A row captured today from a venue
-- page carries no effective date, so it is a CANDIDATE: visible, excluded from every as-of answer, and enough to
-- make an affected audit UNASSESSABLE. Backfilling a guessed effective date would invent history the evidence does
-- not support.
--
-- APPEND-ONLY. A correction is a NEW row with `supersedesId` set; nothing is ever UPDATEd. Retracting a version
-- without replacing it closes it with `effectiveTo` plus `verificationState = 'disputed'`.
--
-- ⚠ SUPERSESSION NEEDS A STABLE TARGET, HENCE `constraintKey`. It is AUTHORED and IMMUTABLE, never derived from a
-- symbol name or a venue id: this repo holds `Bitcoin` beside `Bitcoin Cash ABC`, `Gold` beside `PAX Gold`, and a
-- spot row beside an option row with the SAME symbol name. A derived key collides or splits on all three.
--
-- FOUR TYPES ONLY. `numeric_limit`, `enum`, `prohibition`, `time_of_day`. Ranges and rates are a limit with a unit;
-- a rate-per-night is a unit, not a comparator. ⚠ `schedule` (a set of windows) and `textual_obligation` (legal) are
-- deliberately OUT of v1.
--
-- ⚠ NO OVERLAP FOR ONE KEY, AND NO RESOLVER TIE-BREAK. A period with two answers is a mistake, not a fact, so the
-- write path rejects it inside the append transaction. `dbo.vw_ConstraintOverlaps` below is the audit of that guard:
-- it must return ZERO rows, and it is the only way to prove the guard was never bypassed.
--
-- ---- EVIDENCE ----------------------------------------------------------------------------------------------
-- The artefact is RETAINED, and a digest is NOT a substitute. A digest proves only that something existed; it cannot
-- be re-examined when a constraint is disputed. Layout:
--     trading/archive/constraint-evidence/<constraintKey>/<recordedAt>-<digest>.html
-- (gitignored on the same precedent as `trading/archive/`). The row records the reference, the capture time, the
-- source and the digest; `evidenceExcerpt` supports quick review. If the artefact is gone the row is
-- `verificationState = 'unrecoverable'` and CANNOT support a satisfied verdict.
--
-- ⚠ THE DATABASE GUARD IS UNCONDITIONAL, for the reason 051 discovered the hard way: a plain DDL batch runs against
-- whatever database the session is pointed at, so an SSMS window defaulting to `master` creates the table THERE and
-- reports success. This file refuses rather than guessing; `trading/scripts/apply-migration.js` connects to the
-- configured database and is unaffected.
IF DB_NAME() <> 'DB_Oswald'
  THROW 51052, '052_constraint_versions must be applied to DB_Oswald. This session is on a different database — switch it (SSMS: the database dropdown) and re-run.', 1;

IF OBJECT_ID('dbo.ConstraintVersions','U') IS NULL
BEGIN
  CREATE TABLE dbo.ConstraintVersions (
    constraintVersionId BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ConstraintVersions PRIMARY KEY,
    userId              INT            NOT NULL,

    -- IDENTITY. Authored, immutable, never re-derived. Validated on write, not by a format CHECK, so the rule can
    -- change without a migration.
    constraintKey       NVARCHAR(160)  NOT NULL,
    -- WHAT IT BINDS. Query columns, not identity. `instrument` rows should carry venueInstrumentId.
    subjectKind         NVARCHAR(24)   NOT NULL,   -- instrument | venue | account
    venue               NVARCHAR(32)   NULL,
    venueInstrumentId   NVARCHAR(64)   NULL,

    constraintType      NVARCHAR(24)   NOT NULL,   -- numeric_limit | enum | prohibition | time_of_day
    -- the payload, exactly one of which is populated per type (see CK_ConstraintVersions_payload)
    valueNumeric        DECIMAL(28,10) NULL,
    valueUnit           NVARCHAR(32)   NULL,       -- count | percent_of_price | pct_per_night
    valueEnum           NVARCHAR(64)   NULL,       -- validated against a pinned list in code, NOT a CHECK here:
                                                   -- a seventh `unitKind` must be a deliberate change, not a broken capture
    valueMinutesUtc     SMALLINT       NULL,       -- 0..1439 — a stated time-of-day, e.g. funding at 05:00

    -- THE WINDOW. Half-open: >= effectiveFrom AND < effectiveTo. NULL from = UNKNOWN, never "in force".
    effectiveFrom       DATETIME2(3)   NULL,
    effectiveTo         DATETIME2(3)   NULL,
    -- WHEN WE LEARNED. Never conflated with the window above.
    recordedAt          DATETIME2(3)   NOT NULL CONSTRAINT DF_ConstraintVersions_recordedAt DEFAULT (SYSUTCDATETIME()),

    supersedesId        BIGINT         NULL CONSTRAINT FK_ConstraintVersions_supersedes
                                       REFERENCES dbo.ConstraintVersions (constraintVersionId),

    verificationState   NVARCHAR(16)   NOT NULL,   -- asserted | observed | confirmed | disputed | expired | unrecoverable
    issuer              NVARCHAR(128)  NULL,       -- who states it (the venue), distinct from who recorded it
    recordedBy          NVARCHAR(64)   NOT NULL,
    confirmedAt         DATETIME2(3)   NULL,

    evidenceExcerpt     NVARCHAR(1000) NULL,
    evidenceArtifactRef NVARCHAR(260)  NULL,       -- path under trading/archive/constraint-evidence/
    evidenceDigest      CHAR(64)       NULL,       -- integrity check ONLY — never evidence on its own
    sourceUrl           NVARCHAR(500)  NULL,
    note                NVARCHAR(1000) NULL,

    -- ⚠ THE TYPE/PAYLOAD PAIRING IS A CONSTRAINT, so "a numeric limit with no unit" is UNREPRESENTABLE rather than
    -- merely discouraged. This is the unit-and-population rule from `agent/measurement.js` applied at the schema.
    CONSTRAINT CK_ConstraintVersions_payload CHECK (
         (constraintType = 'numeric_limit' AND valueNumeric    IS NOT NULL AND valueUnit   IS NOT NULL
                                            AND valueEnum      IS NULL     AND valueMinutesUtc IS NULL)
      OR (constraintType = 'enum'          AND valueEnum      IS NOT NULL AND valueNumeric IS NULL
                                            AND valueUnit      IS NULL     AND valueMinutesUtc IS NULL)
      OR (constraintType = 'prohibition'   AND valueNumeric    IS NULL     AND valueUnit    IS NULL
                                            AND valueEnum      IS NULL     AND valueMinutesUtc IS NULL)
      OR (constraintType = 'time_of_day'   AND valueMinutesUtc IS NOT NULL AND valueNumeric IS NULL
                                            AND valueUnit      IS NULL     AND valueEnum      IS NULL)),
    CONSTRAINT CK_ConstraintVersions_minutes CHECK (valueMinutesUtc IS NULL OR (valueMinutesUtc >= 0 AND valueMinutesUtc <= 1439)),
    CONSTRAINT CK_ConstraintVersions_window  CHECK (effectiveTo IS NULL OR effectiveFrom IS NULL OR effectiveTo > effectiveFrom),
    CONSTRAINT CK_ConstraintVersions_state   CHECK (verificationState IN ('asserted','observed','confirmed','disputed','expired','unrecoverable')),
    CONSTRAINT CK_ConstraintVersions_subject CHECK (subjectKind IN ('instrument','venue','account'))
  );

  -- One row per (key, start). Filtered because `effectiveFrom IS NULL` is a legitimate, repeatable state: every
  -- capture from a venue page carries no effective date, and several such captures may accumulate before any of
  -- them can be dated.
  CREATE UNIQUE INDEX UX_ConstraintVersions_key_from
    ON dbo.ConstraintVersions (userId, constraintKey, effectiveFrom)
    WHERE effectiveFrom IS NOT NULL;

  -- The as-of read: one key, a range, ordered.
  CREATE INDEX IX_ConstraintVersions_key_window
    ON dbo.ConstraintVersions (userId, constraintKey, effectiveFrom, effectiveTo);

  -- The subject read: everything that binds one instrument or venue.
  CREATE INDEX IX_ConstraintVersions_scope
    ON dbo.ConstraintVersions (userId, venue, venueInstrumentId, recordedAt DESC);
END;
GO

-- THE AUDIT OF THE OVERLAP GUARD. The write path rejects an overlapping version inside the append transaction; this
-- view is how a reader proves that it did. IT MUST RETURN ZERO ROWS. Rows with an unknown `effectiveFrom` are
-- excluded on purpose — an undatable row is a candidate, not a period, and cannot overlap anything.
IF OBJECT_ID('dbo.vw_ConstraintOverlaps','V') IS NOT NULL DROP VIEW dbo.vw_ConstraintOverlaps;
GO
CREATE VIEW dbo.vw_ConstraintOverlaps AS
SELECT a.userId,
       a.constraintKey,
       a.constraintVersionId AS earlierId,
       b.constraintVersionId AS laterId,
       a.effectiveFrom       AS earlierFrom,
       a.effectiveTo         AS earlierTo,
       b.effectiveFrom       AS laterFrom,
       b.effectiveTo         AS laterTo
  FROM dbo.ConstraintVersions a
  JOIN dbo.ConstraintVersions b
    ON b.userId        = a.userId
   AND b.constraintKey = a.constraintKey
   AND b.constraintVersionId > a.constraintVersionId
   -- interval intersection: a.start < b.end AND b.start < a.end, with an open end read as unbounded
   AND a.effectiveFrom < COALESCE(b.effectiveTo, CONVERT(DATETIME2(3), '9999-12-31'))
   AND b.effectiveFrom < COALESCE(a.effectiveTo, CONVERT(DATETIME2(3), '9999-12-31'))
 WHERE a.effectiveFrom IS NOT NULL
   AND b.effectiveFrom IS NOT NULL;
GO

PRINT '052 applied: ConstraintVersions + vw_ConstraintOverlaps';
PRINT 'Post-apply check (must return 0 rows):  SELECT * FROM dbo.vw_ConstraintOverlaps;';
