-- 013_utc_edicts_tasks.sql
-- UTC-1 (policy 17 task 128): switch the remaining DEFAULT-generated timestamps
-- from GETDATE() to GETUTCDATE() and backfill existing rows, mirroring what
-- migration 009 did for ApiLogs.
--
-- Why: the mssql driver interprets a DATETIME wall-clock value as UTC, so values
-- written with GETDATE() (SQL Server local = Singapore, UTC+8) render 8h off in
-- the browser's UTC->local conversion. Edicts/Tasks/Users/AuditLogs timestamps
-- (createdAt/updatedAt/completedAt) and the `active` computed columns still use
-- GETDATE().
--
-- Applied: 2026-08-06

-- ============================================================
-- Helper pattern (mirrors 009): drop the auto-named GETDATE()
-- default, add a GETUTCDATE() default, backfill existing rows.
-- ============================================================

-- ---- Edicts.createdAt ----
PRINT 'Edicts.createdAt -> UTC...';
DECLARE @c sysname = (SELECT dc.name FROM sys.default_constraints dc
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Edicts')
    AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.Edicts'), 'createdAt', 'ColumnId'));
IF @c IS NOT NULL BEGIN EXEC('ALTER TABLE dbo.Edicts DROP CONSTRAINT ' + @c); END
GO
ALTER TABLE dbo.Edicts ADD CONSTRAINT DF_Edicts_createdAt DEFAULT (GETUTCDATE()) FOR createdAt;
GO
UPDATE dbo.Edicts SET createdAt = DATEADD(second, DATEDIFF(second, GETDATE(), GETUTCDATE()), createdAt);
PRINT '  Edicts.createdAt backfilled.';
GO

-- ---- Tasks.createdAt ----
PRINT 'Tasks.createdAt -> UTC...';
DECLARE @c sysname = (SELECT dc.name FROM sys.default_constraints dc
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Tasks')
    AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.Tasks'), 'createdAt', 'ColumnId'));
IF @c IS NOT NULL BEGIN EXEC('ALTER TABLE dbo.Tasks DROP CONSTRAINT ' + @c); END
GO
ALTER TABLE dbo.Tasks ADD CONSTRAINT DF_Tasks_createdAt DEFAULT (GETUTCDATE()) FOR createdAt;
GO
UPDATE dbo.Tasks SET createdAt = DATEADD(second, DATEDIFF(second, GETDATE(), GETUTCDATE()), createdAt);
PRINT '  Tasks.createdAt backfilled.';
GO

-- ---- Users.createdAt + updatedAt ----
PRINT 'Users.createdAt/updatedAt -> UTC...';
DECLARE @c sysname = (SELECT dc.name FROM sys.default_constraints dc
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Users')
    AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.Users'), 'createdAt', 'ColumnId'));
IF @c IS NOT NULL BEGIN EXEC('ALTER TABLE dbo.Users DROP CONSTRAINT ' + @c); END
GO
DECLARE @u sysname = (SELECT dc.name FROM sys.default_constraints dc
  WHERE dc.parent_object_id = OBJECT_ID('dbo.Users')
    AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.Users'), 'updatedAt', 'ColumnId'));
IF @u IS NOT NULL BEGIN EXEC('ALTER TABLE dbo.Users DROP CONSTRAINT ' + @u); END
GO
ALTER TABLE dbo.Users ADD CONSTRAINT DF_Users_createdAt DEFAULT (GETUTCDATE()) FOR createdAt;
ALTER TABLE dbo.Users ADD CONSTRAINT DF_Users_updatedAt DEFAULT (GETUTCDATE()) FOR updatedAt;
GO
UPDATE dbo.Users SET createdAt = DATEADD(second, DATEDIFF(second, GETDATE(), GETUTCDATE()), createdAt),
                     updatedAt = DATEADD(second, DATEDIFF(second, GETDATE(), GETUTCDATE()), updatedAt);
PRINT '  Users.createdAt/updatedAt backfilled.';
GO

-- ---- AuditLogs.createdAt (consistency) ----
PRINT 'AuditLogs.createdAt -> UTC...';
DECLARE @c sysname = (SELECT dc.name FROM sys.default_constraints dc
  WHERE dc.parent_object_id = OBJECT_ID('dbo.AuditLogs')
    AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID('dbo.AuditLogs'), 'createdAt', 'ColumnId'));
IF @c IS NOT NULL BEGIN EXEC('ALTER TABLE dbo.AuditLogs DROP CONSTRAINT ' + @c); END
GO
ALTER TABLE dbo.AuditLogs ADD CONSTRAINT DF_AuditLogs_createdAt DEFAULT (GETUTCDATE()) FOR createdAt;
GO
UPDATE dbo.AuditLogs SET createdAt = DATEADD(second, DATEDIFF(second, GETDATE(), GETUTCDATE()), createdAt);
PRINT '  AuditLogs.createdAt backfilled.';
GO

-- ============================================================
-- completedAt (set by the models with GETDATE()) — backfill only
-- ============================================================
PRINT 'Edicts/Tasks.completedAt -> UTC (backfill)...';
UPDATE dbo.Edicts SET completedAt = DATEADD(second, DATEDIFF(second, GETDATE(), GETUTCDATE()), completedAt) WHERE completedAt IS NOT NULL;
UPDATE dbo.Tasks  SET completedAt = DATEADD(second, DATEDIFF(second, GETDATE(), GETUTCDATE()), completedAt) WHERE completedAt IS NOT NULL;
PRINT '  completedAt backfilled.';
GO

-- ============================================================
-- `active` computed columns: compare UTC-vs-UTC now that the
-- stored dates follow the UTC convention (recreate the column).
-- ============================================================
PRINT 'Recreating Edicts.active with GETUTCDATE()...';
ALTER TABLE dbo.Edicts DROP COLUMN active;
GO
ALTER TABLE dbo.Edicts ADD active AS (CASE WHEN GETUTCDATE() >= plannedStart AND (plannedEnd IS NULL OR GETUTCDATE() <= plannedEnd) THEN 1 ELSE 0 END);
PRINT '  Edicts.active recreated.';
GO

PRINT 'Recreating Tasks.active with GETUTCDATE()...';
ALTER TABLE dbo.Tasks DROP COLUMN active;
GO
ALTER TABLE dbo.Tasks ADD active AS (CASE WHEN GETUTCDATE() >= plannedStart AND (plannedEnd IS NULL OR GETUTCDATE() <= plannedEnd) THEN 1 ELSE 0 END);
PRINT '  Tasks.active recreated.';
GO

PRINT 'Done.';
GO
