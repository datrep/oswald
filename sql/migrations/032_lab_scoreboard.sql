-- 032_lab_scoreboard.sql
-- TRD-14: Strategy Lab candidate scoreboard (walk-forward + BCa bootstrap +
-- batch BH + lockbox + archive/retest).
--   LabCandidates: one row per (candidate x symbol) PAIR; registrationNo =
--   the cumulative shots-on-goal counter k (352 prior configs + sequence).
--   LabReleases: one row per BH pass — familyType 'batch' (the single lockbox
--   release) or 'fresh' (fresh-data gate re-score, family k').
IF OBJECT_ID('LabCandidates') IS NULL
BEGIN
  CREATE TABLE LabCandidates (
    id INT IDENTITY(1,1) PRIMARY KEY,
    userId INT NOT NULL,
    strategy NVARCHAR(64) NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    venue NVARCHAR(32) NOT NULL CONSTRAINT DF_LabCandidates_venue DEFAULT 'yahoo',
    params NVARCHAR(MAX) NULL,
    label NVARCHAR(128) NULL,
    registrationNo INT NOT NULL,
    status NVARCHAR(16) NOT NULL CONSTRAINT DF_LabCandidates_status DEFAULT 'registered', -- registered|frozen|archived|retired|promoted
    score NVARCHAR(MAX) NULL,        -- stage results JSON (A/B/lockbox per window)
    verdict NVARCHAR(16) NULL,       -- PASS|FAIL|INSUFFICIENT-DATA at release
    releaseId INT NULL,
    createdAt DATETIME2 NOT NULL CONSTRAINT DF_LabCandidates_created DEFAULT SYSUTCDATETIME(),
    updatedAt DATETIME2 NOT NULL CONSTRAINT DF_LabCandidates_updated DEFAULT SYSUTCDATETIME(),
    frozenAt DATETIME2 NULL,
    archivedAt DATETIME2 NULL
  );
END
GO
IF OBJECT_ID('LabReleases') IS NULL
BEGIN
  CREATE TABLE LabReleases (
    id INT IDENTITY(1,1) PRIMARY KEY,
    userId INT NOT NULL,
    familyType NVARCHAR(8) NOT NULL CONSTRAINT DF_LabReleases_family DEFAULT 'batch', -- batch | fresh
    m INT NOT NULL,                    -- BH family size (pairs with a lockbox p)
    mFrozen INT NOT NULL,              -- frozen pairs at the release (incl. INSUFFICIENT-DATA)
    kCounter INT NOT NULL,             -- cumulative shots-on-goal counter at release
    q FLOAT NOT NULL CONSTRAINT DF_LabReleases_q DEFAULT 0.10,
    bhResult NVARCHAR(MAX) NULL,       -- BH pass detail JSON
    prdsCheck NVARCHAR(MAX) NULL,      -- W4 cross-correlation check JSON
    summary NVARCHAR(MAX) NULL,        -- per-pair verdict summary JSON
    releasedAt DATETIME2 NOT NULL CONSTRAINT DF_LabReleases_released DEFAULT SYSUTCDATETIME()
  );
END
GO
