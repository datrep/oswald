-- 018_listing_workbench_refine.sql
-- Feedback batch on the Listing Workbench (policy 51):
--   * ListingComps gains a title (replaces partType in the UI)
--   * CostSettings gains margin thresholds for the GROSS/NET colouring
--   * PartPurchases logs component purchases; PartPrices.currentPrice becomes
--     the (floor, 2dp) weighted-average cost of those purchases
--   * Lookups 'location' seeded from the existing InventoryItems
--
-- Applied: 2026-08-20

PRINT 'Adding ListingComps.title...';
IF COL_LENGTH('dbo.ListingComps', 'title') IS NULL
BEGIN
    ALTER TABLE ListingComps ADD title NVARCHAR(255) NULL;
    PRINT '  ListingComps.title added.';
END
ELSE
    PRINT '  ListingComps.title already present.';
GO

PRINT 'Adding CostSettings margin thresholds...';
IF COL_LENGTH('dbo.CostSettings', 'profitWarn') IS NULL
BEGIN
    ALTER TABLE CostSettings ADD profitWarn DECIMAL(10,2) NOT NULL CONSTRAINT DF_CostSettings_profitWarn DEFAULT 0;
    PRINT '  profitWarn added.';
END
ELSE
    PRINT '  profitWarn already present.';
IF COL_LENGTH('dbo.CostSettings', 'profitDanger') IS NULL
BEGIN
    ALTER TABLE CostSettings ADD profitDanger DECIMAL(10,2) NOT NULL CONSTRAINT DF_CostSettings_profitDanger DEFAULT -20;
    PRINT '  profitDanger added.';
END
ELSE
    PRINT '  profitDanger already present.';
GO

PRINT 'Creating PartPurchases table...';
IF OBJECT_ID('dbo.PartPurchases', 'U') IS NULL
BEGIN
    CREATE TABLE PartPurchases (
        id INT PRIMARY KEY IDENTITY(1,1),
        partPriceId INT NOT NULL,
        qty INT NOT NULL DEFAULT 1,
        unitPrice DECIMAL(10,2) NOT NULL DEFAULT 0,
        purchasedAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_PartPurchases_price FOREIGN KEY (partPriceId) REFERENCES PartPrices(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_PartPurchases_price ON PartPurchases(partPriceId);
    PRINT '  PartPurchases created.';
END
ELSE
    PRINT '  PartPurchases already exists.';
GO

PRINT 'Seeding Lookups location from InventoryItems...';
;WITH loc AS (
    SELECT location, ROW_NUMBER() OVER (ORDER BY MIN(id)) - 1 AS rn
    FROM InventoryItems
    WHERE location IS NOT NULL AND location <> ''
    GROUP BY location
)
INSERT INTO Lookups (listKey, value, sortOrder)
SELECT 'location', l.location, l.rn
FROM loc l
WHERE NOT EXISTS (SELECT 1 FROM Lookups x WHERE x.listKey = 'location' AND x.value = l.location);
PRINT '  location lookups seeded.';
GO

PRINT 'Done.';
GO
