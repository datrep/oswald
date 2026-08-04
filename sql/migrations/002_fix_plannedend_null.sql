-- ============================================================
-- Migration 002 — Fix plannedEnd relaxation
-- Database: DB_Oswald
--
-- Migration 001 added completedAt + indexes, but its plannedEnd
-- ALTER failed because the computed column 'active' depends on
-- plannedEnd. This migration:
--   1. drops the computed 'active' column
--   2. relaxes plannedEnd to NULL
--   3. recreates the 'active' computed column
-- Idempotent — safe to re-run.
-- ============================================================

-- Tasks
IF EXISTS (
    SELECT 1 FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    WHERE t.name = 'Tasks' AND c.name = 'plannedEnd' AND c.is_nullable = 0
)
BEGIN
    ALTER TABLE dbo.Tasks DROP COLUMN active;
    ALTER TABLE dbo.Tasks ALTER COLUMN plannedEnd DATETIME NULL;
    ALTER TABLE dbo.Tasks ADD active AS (CASE WHEN GETDATE() >= plannedStart AND (plannedEnd IS NULL OR GETDATE() <= plannedEnd) THEN 1 ELSE 0 END);
    PRINT 'Tasks.plannedEnd relaxed.';
END
ELSE
    PRINT 'Tasks.plannedEnd already nullable - skipping.';
GO

-- Edicts
IF EXISTS (
    SELECT 1 FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    WHERE t.name = 'Edicts' AND c.name = 'plannedEnd' AND c.is_nullable = 0
)
BEGIN
    ALTER TABLE dbo.Edicts DROP COLUMN active;
    ALTER TABLE dbo.Edicts ALTER COLUMN plannedEnd DATETIME NULL;
    ALTER TABLE dbo.Edicts ADD active AS (CASE WHEN GETDATE() >= plannedStart AND (plannedEnd IS NULL OR GETDATE() <= plannedEnd) THEN 1 ELSE 0 END);
    PRINT 'Edicts.plannedEnd relaxed.';
END
ELSE
    PRINT 'Edicts.plannedEnd already nullable - skipping.';
GO

PRINT 'Migration 002 complete.';
GO
