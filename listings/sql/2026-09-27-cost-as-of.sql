-- TRD/LST-15 (2026-09-27): the cost basis gets an AS-OF DATE, so a margin can state its vintage.
--
-- THE DEFECT: `InventoryItems.valueCost` was valued 2026-07-27..08-17 and imported 2026-08-19.
-- `ListingParts.partCost` copied those figures in and carried NO date at all, so every margin the Workbench
-- printed was anchored to a July valuation with nothing on screen saying so — in a RISING parts market. The
-- task's own measurement: a 512GB NVMe listed at S$45 on the sheet against S$60-85 live, i.e. 25-45% LOW.
--
-- ⚠⚠ WHY THERE IS NO BACKFILL, AND THIS IS THE IMPORTANT PART OF THIS FILE.
--
-- The obvious move is to look up each part's valuation date from InventoryItems. **Measured: it cannot be
-- done.** `ListingParts.partName` is FREE TEXT, not a reference:
--
--     108 part rows, 6 matched by name (5.6%), 74 distinct unmatched names
--     listing 11 (the SFF clearance this task is about): 0 of 8 parts matched
--
-- "180GB SSD + 500GB HDD" is a COMBINATION of two components, not an inventory item; "SFF", "DVD", "16GB DDR3"
-- are descriptions. So there is no key to join on, and a name match would not prove the cost came from that
-- row even where one exists. **Back-filling a date from a 5.6% name match would put a confident, wrong vintage
-- on 94% of the sheet** — the same defect as the one being fixed, one layer deeper. `costAsOf` is therefore
-- left NULL on every existing row, where NULL means exactly what it says: **the vintage is UNKNOWN.**
--
-- WHAT NULL MUST NOT BE READ AS: null is NOT "valued today", and it is NOT "no cost basis". The UI must render
-- it as unknown. A date that is unknown and a date that is today are different claims and only one is true.
--
-- Run with:  sqlcmd -S localhost -d DB_Oswald -E -i <this file> -y 0 -s "|"

SET NOCOUNT ON;
GO

IF COL_LENGTH('dbo.ListingParts', 'costAsOf') IS NULL
  ALTER TABLE dbo.ListingParts ADD costAsOf DATE NULL;
GO

IF EXISTS (SELECT 1 FROM sys.extended_properties
           WHERE major_id = OBJECT_ID('dbo.ListingParts') AND name = 'CostAsOf')
BEGIN
  EXEC sp_dropextendedproperty
    @name = N'CostAsOf',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE',  @level1name = N'ListingParts',
    @level2type = N'COLUMN', @level2name = N'costAsOf';
END
GO

EXEC sp_addextendedproperty
  @name = N'CostAsOf',
  @value = N'THE VALUATION DATE BEHIND partCost, and it exists because partCost had none: every margin printed before this was anchored to the 2026-07-27..08-17 sheet with nothing on screen saying so, in a RISING parts market. NULL MEANS THE VINTAGE IS UNKNOWN - NOT "valued today" and NOT "no cost basis"; render it as unknown, because a date that is unknown and a date that is today are different claims and only one is true. WHY NO BACKFILL WAS DONE: ListingParts.partName is FREE TEXT, not a reference to InventoryItems - measured 6 of 108 rows matched by name (5.6%), and listing 11 (the SFF clearance) matched 0 of 8, because names like "180GB SSD + 500GB HDD" are COMBINATIONS and "SFF"/"DVD" are descriptions. Back-filling from a 5.6% name match would put a confident wrong vintage on 94% of the sheet, which is the defect being fixed one layer deeper. Going forward the date is stamped at write time.',
  @level0type = N'SCHEMA', @level0name = N'dbo',
  @level1type = N'TABLE',  @level1name = N'ListingParts',
  @level2type = N'COLUMN', @level2name = N'costAsOf';
GO

-- A VIEW so the vintage travels WITH the margin, which is the task's acceptance criterion ("every margin the
-- Workbench prints carries the as-of date of the cost basis behind it").
--
-- ★ THE LISTING'S VINTAGE IS ITS OLDEST PART, and `partsWithNoVintage` is returned alongside it. A margin is
-- only as trustworthy as its STALEST input, so one un-dated part must not be averaged away by nine dated ones —
-- and the count is what lets a reader tell "all 8 parts are dated July" from "1 is dated and 7 are unknown".
-- The view reports UNKNOWN rather than substituting a date, because it cannot know one.
IF OBJECT_ID('dbo.vListingCostVintage', 'V') IS NOT NULL DROP VIEW dbo.vListingCostVintage;
GO
CREATE VIEW dbo.vListingCostVintage AS
SELECT
  l.id            AS listingId,
  l.listingNo,
  l.title,
  COUNT(p.id)                                       AS partRows,
  SUM(p.partCost)                                   AS partsTotal,
  SUM(CASE WHEN p.costAsOf IS NULL AND p.partCost IS NOT NULL THEN 1 ELSE 0 END) AS partsWithNoVintage,
  MIN(p.costAsOf)                                   AS oldestCostAsOf,
  MAX(p.costAsOf)                                   AS newestCostAsOf,
  CASE WHEN COUNT(p.id) = 0 THEN 'no_parts'
       WHEN SUM(CASE WHEN p.costAsOf IS NULL AND p.partCost IS NOT NULL THEN 1 ELSE 0 END) = 0
         THEN CONVERT(varchar(10), MIN(p.costAsOf), 23)
       WHEN MIN(p.costAsOf) IS NULL THEN 'vintage_unknown'
       ELSE 'mixed_from_' + CONVERT(varchar(10), MIN(p.costAsOf), 23) END AS costAsOfLabel
FROM dbo.Listings l
LEFT JOIN dbo.ListingParts p ON p.listingId = l.id
WHERE l.userId = 1
GROUP BY l.id, l.listingNo, l.title;
GO

-- PROOF IT LANDED AND THE STATE IT IS IN, printed rather than assumed.
SELECT
  (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ListingParts') AND name = 'costAsOf') AS column_count,
  (SELECT COUNT(*) FROM dbo.ListingParts) AS part_rows,
  (SELECT COUNT(*) FROM dbo.ListingParts WHERE costAsOf IS NOT NULL) AS rows_with_a_vintage,
  (SELECT COUNT(*) FROM dbo.vListingCostVintage WHERE costAsOfLabel = 'vintage_unknown') AS listings_unknown;
GO
