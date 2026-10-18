-- 008_api_logs.sql
-- Adds the internal API request log table (#58). BOTH the Oswald dashboard and
-- the fileserver write here (same DB), so a single GET /api/logs can show the
-- traffic from both services. `source` tells them apart; `label` carries the
-- human tag shown in the console/file line ([policy:services] vs
-- [fileserver:<operation>]).
--
-- FUTURE SCOPE: if this project expands, this table is the natural home for
-- richer observability — log levels, response bytes, route categories, request
-- IDs, or per-user audit. Add columns here (via new migrations) rather than
-- side tables so the shared log viewer keeps working.
--
-- Applied: 2026-08-05

PRINT 'Creating ApiLogs table...';
IF OBJECT_ID('dbo.ApiLogs', 'U') IS NULL
BEGIN
    CREATE TABLE ApiLogs (
        id INT PRIMARY KEY IDENTITY(1,1),
        source NVARCHAR(50) NOT NULL,
        label NVARCHAR(100) NULL,
        method NVARCHAR(10) NOT NULL,
        path NVARCHAR(500) NOT NULL,
        status INT NOT NULL,
        durationMs INT NOT NULL,
        userId INT NULL,
        createdAt DATETIME DEFAULT GETDATE()
    );
    CREATE INDEX IX_ApiLogs_createdAt ON ApiLogs (createdAt DESC);
    CREATE INDEX IX_ApiLogs_source ON ApiLogs (source);
    PRINT '  ApiLogs table created.';
END
ELSE
    PRINT '  ApiLogs table already exists.';
GO

PRINT 'Done.';
GO
