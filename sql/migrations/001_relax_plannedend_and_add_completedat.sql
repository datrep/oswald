-- ============================================================
-- Migration 001 — Relax plannedEnd + add completedAt
-- Database: DB_Oswald
--
-- Two goals:
--   1) FIX SCHEMA DRIFT: the live DB has plannedEnd NOT NULL, but the
--      repo schema (DB_init_table.sql) declares it NULL. Relax it so an
--      End date can be truly optional (blank -> NULL) in the UI.
--   2) COMPLETION HISTORY: add completedAt so we can timestamp when a
--      policy/task is completed (Archived) and chart trends over time.
--
-- Run with a sysadmin login (after recovering admin access):
--   sqlcmd -S localhost,1433 -E -i sql/migrations/001_relax_plannedend_and_add_completedat.sql
-- ============================================================

-- 1) Relax NOT NULL on plannedEnd (both tables)
ALTER TABLE dbo.Tasks  ALTER COLUMN plannedEnd DATETIME NULL;
ALTER TABLE dbo.Edicts ALTER COLUMN plannedEnd DATETIME NULL;
GO

-- 2) Add completedAt for completion history/trends
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Tasks') AND name = 'completedAt'
)
    ALTER TABLE dbo.Tasks ADD completedAt DATETIME NULL;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Edicts') AND name = 'completedAt'
)
    ALTER TABLE dbo.Edicts ADD completedAt DATETIME NULL;
GO

-- 3) Indexes for trend queries (group by month of completedAt)
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Edicts_completedAt' AND object_id = OBJECT_ID('dbo.Edicts')
)
    CREATE INDEX IX_Edicts_completedAt ON dbo.Edicts (completedAt);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Tasks_completedAt' AND object_id = OBJECT_ID('dbo.Tasks')
)
    CREATE INDEX IX_Tasks_completedAt ON dbo.Tasks (completedAt);
GO

PRINT 'Migration 001 applied: plannedEnd relaxed, completedAt added.';
GO
