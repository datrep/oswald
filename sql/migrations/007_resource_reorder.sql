-- 007_resource_reorder.sql
-- Adds a manual ordering column to EdictResources so resources can be
-- drag-reordered on the policy workspace (task #26, "other data tables").
--
-- Applied: 2026-08-05

PRINT 'Adding sortOrder to EdictResources...';
IF COL_LENGTH('dbo.EdictResources', 'sortOrder') IS NULL
BEGIN
    ALTER TABLE EdictResources ADD sortOrder INT NOT NULL DEFAULT 0;
    PRINT '  sortOrder column added.';
END
ELSE
    PRINT '  sortOrder column already exists.';
GO

PRINT 'Backfilling sortOrder for existing resources...';
UPDATE r
SET r.sortOrder = x.rn
FROM EdictResources r
JOIN (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY edictId ORDER BY id) - 1 AS rn
    FROM EdictResources
) x ON x.id = r.id;
GO

PRINT 'Done.';
GO
