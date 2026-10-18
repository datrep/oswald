-- 009_api_logs_utc.sql
-- ApiLogs.createdAt defaulted to GETDATE() (SQL Server local = Singapore, UTC+8),
-- but the mssql driver interprets the DATETIME wall-clock value as UTC, so
-- timestamps rendered 8h in the future in the browser (the Oswald clock is the
-- source of truth for local time).
--
-- Fix: default new rows to GETUTCDATE() and backfill existing rows to true UTC
-- (shifted by the current local-vs-UTC delta), so the display layer's UTC->local
-- conversion lands on the correct wall time.
--
-- Applied: 2026-08-05

PRINT 'Switching ApiLogs.createdAt to UTC...';
-- Drop the old auto-named GETDATE() default constraint (if any).
DECLARE @c sysname = (
    SELECT dc.name
    FROM sys.default_constraints dc
    WHERE dc.parent_object_id = OBJECT_ID('dbo.ApiLogs')
      AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.ApiLogs'), 'createdAt', 'ColumnId')
);
IF @c IS NOT NULL
BEGIN
    EXEC('ALTER TABLE dbo.ApiLogs DROP CONSTRAINT ' + @c);
    PRINT '  Dropped old default constraint ' + @c + '.';
END
GO

ALTER TABLE dbo.ApiLogs ADD CONSTRAINT DF_ApiLogs_createdAt DEFAULT (GETUTCDATE()) FOR createdAt;
PRINT '  ApiLogs.createdAt now defaults to GETUTCDATE().';
GO

PRINT 'Backfilling existing rows to UTC...';
DECLARE @shift INT = DATEDIFF(second, GETDATE(), GETUTCDATE());
UPDATE dbo.ApiLogs SET createdAt = DATEADD(second, @shift, createdAt);
PRINT '  Shifted ' + CAST(@@ROWCOUNT AS varchar) + ' rows by ' + CAST(@shift AS varchar) + 's (to UTC).';
GO

PRINT 'Done.';
GO
