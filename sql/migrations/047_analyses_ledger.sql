-- TRD-PRM-1 P0: Plus500 Premium-analyses collection ledger (write-only; NO consumer; operator-scope).
-- Append-only by convention: corrections are NEW rows (never edits). Every level row keeps its raw snippet for audit.
-- LOOKAHEAD RULE (stated here and in the brief): any study may only use levels with capturedAt strictly BEFORE
-- the trade/observation it judges. Captured-but-unused until a pre-registered study says otherwise.
IF OBJECT_ID('dbo.AnalysesNotes','U') IS NULL
BEGIN
  CREATE TABLE dbo.AnalysesNotes (
    id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AnalysesNotes PRIMARY KEY,
    userId INT NOT NULL,
    kind NVARCHAR(24) NOT NULL,          -- 'weekly' | 'instrument'
    symbol NVARCHAR(64) NULL,            -- NULL for weekly
    title NVARCHAR(400) NULL,
    url NVARCHAR(700) NULL,
    publishedAt DATETIME2 NULL,          -- NULL when the page does not state one
    capturedAt DATETIME2 NOT NULL CONSTRAINT DF_AnalysesNotes_capturedAt DEFAULT SYSUTCDATETIME(),
    source NVARCHAR(32) NOT NULL,        -- 'owner-screenshot' | 'capture' | 'manual'
    rawText NVARCHAR(MAX) NULL,
    parseStatus NVARCHAR(40) NOT NULL,   -- 'manual' | 'ok' | 'partial' | 'parse_failed' | 'no_levels' | 'page_missing'
    note NVARCHAR(600) NULL
  );
END
IF OBJECT_ID('dbo.AnalysisLevels','U') IS NULL
BEGIN
  CREATE TABLE dbo.AnalysisLevels (
    id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AnalysisLevels PRIMARY KEY,
    noteId INT NOT NULL CONSTRAINT FK_AnalysisLevels_note REFERENCES dbo.AnalysesNotes(id),
    userId INT NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    price DECIMAL(18,6) NOT NULL,
    levelKind NVARCHAR(24) NOT NULL,     -- 'resistance' | 'support' | 'pivot' | 'target' | 'high' | 'low'
    label NVARCHAR(200) NULL,            -- as the analysis stated it, e.g. 'September 29th high'
    timeframeHint NVARCHAR(24) NULL,     -- '4h' etc. when stated
    snippet NVARCHAR(400) NULL,          -- raw text the level was parsed from
    createdAt DATETIME2 NOT NULL CONSTRAINT DF_AnalysisLevels_createdAt DEFAULT SYSUTCDATETIME()
  );
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_AnalysisLevels_user_symbol' AND object_id=OBJECT_ID('dbo.AnalysisLevels'))
  CREATE INDEX IX_AnalysisLevels_user_symbol ON dbo.AnalysisLevels(userId, symbol, noteId);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_AnalysesNotes_user_kind' AND object_id=OBJECT_ID('dbo.AnalysesNotes'))
  CREATE INDEX IX_AnalysesNotes_user_kind ON dbo.AnalysesNotes(userId, kind, capturedAt DESC);
