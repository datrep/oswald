-- 006_task_reorder.sql
-- Adds a manual ordering column to Tasks so tasks can be drag-reordered
-- on the policy workspace (task #26). New tasks default to 0, so any existing
-- tasks are backfilled first in a stable order (plannedStart, then id).
--
-- Applied: 2026-08-05

PRINT 'Adding sortOrder to Tasks...';
IF COL_LENGTH('dbo.Tasks', 'sortOrder') IS NULL
BEGIN
    ALTER TABLE Tasks ADD sortOrder INT NOT NULL DEFAULT 0;
    PRINT '  sortOrder column added.';
END
ELSE
    PRINT '  sortOrder column already exists.';
GO

PRINT 'Backfilling sortOrder for existing tasks...';
UPDATE t
SET t.sortOrder = r.rn
FROM Tasks t
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY edictId ORDER BY plannedStart, id) - 1 AS rn
    FROM Tasks
) r ON r.id = t.id;
GO

PRINT 'Done.';
GO
