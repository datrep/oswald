-- LST-8 (2026-09-27): a component that CAME WITH THE UNIT has nowhere to live, so its cost is parked on
-- another row and the margin becomes unreadable.
--
-- THE DEFECT, MEASURED. On listing #15 (HP ProDesk 600 G1 SFF) four part rows sit at S$0.00 with the word
-- "bundled" written into their NAMES (id 1002 cpu 4770, 1004 storage, 1005 psu, 1007 motherboard), while the
-- S$58 those components actually cost sits on the CASE row (id 1008). 5 + 0 + 55 + 0 + 0 + 5 + 0 + 58 = 123,
-- so the TOTAL is right and the ATTRIBUTION is not.
--
-- WHY THAT IS A MARGIN PROBLEM AND NOT A TIDINESS PROBLEM: the same S$123 can be read as components-only or as
-- full cost — a spread of S$5 vs S$77 margin, roughly 15x — and the Workbench margin column then lies, which
-- is the exact failure `docs/pc-inspection-automation.md` §1.1 exists to prevent. Costing a bulk buy of 10
-- units is impossible from the record.
--
-- WHAT THIS ADDS: `provenance`, so a part can SAY where it came from instead of encoding it in its name, and
-- `allocatedCost`, so a lot/batch price can sit on the row it belongs to without being confused with a
-- per-part purchase price. The two together make the S$5-vs-S$77 question answerable from the row.
--
-- ⚠ NO BACKFILL, AND NO VALUE IS INVENTED. The four rows' provenance is INFERRED by the task (their names say
-- "bundled") but the cost allocation is not recoverable: the S$58 on the case row is not split anywhere, and
-- guessing a split would fabricate the very number the margin depends on. `provenance` is left NULL on every
-- existing row, meaning "not recorded" — which is TRUE — and the Workbench must render it as such rather than
-- defaulting to `sourced`, because defaulting would assert a purchase that may never have happened.
--
-- Run with:  sqlcmd -S localhost -d DB_Oswald -E -i <this file> -y 0 -s "|"

SET NOCOUNT ON;
GO

IF COL_LENGTH('dbo.ListingParts', 'provenance') IS NULL
  ALTER TABLE dbo.ListingParts ADD provenance NVARCHAR(24) NULL;
GO

IF COL_LENGTH('dbo.ListingParts', 'allocatedCost') IS NULL
  ALTER TABLE dbo.ListingParts ADD allocatedCost DECIMAL(10,2) NULL;
GO

IF EXISTS (SELECT 1 FROM sys.extended_properties
           WHERE major_id = OBJECT_ID('dbo.ListingParts') AND name = 'PartProvenance')
BEGIN
  EXEC sp_dropextendedproperty
    @name = N'PartProvenance',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE',  @level1name = N'ListingParts',
    @level2type = N'COLUMN', @level2name = N'provenance';
END
GO

EXEC sp_addextendedproperty
  @name = N'PartProvenance',
  @value = N'WHERE THIS PART CAME FROM, so provenance stops being encoded in partName (four rows on listing 15 carry the word "bundled" in their NAME while sitting at cost 0.00, with the real S$58 parked on the case row). NULL MEANS NOT RECORDED - render it as unknown, do NOT default to sourced, because defaulting asserts a purchase that may never have happened. Suggested vocabulary (NOT yet a Lookups list): sourced | came_with_unit | bundled | allocated. allocatedCost carries a lot/batch share so it is never confused with a per-part purchase price. WHY NO BACKFILL: the cost allocation is not recoverable anywhere - the S$58 is not split on any row, and guessing a split would fabricate the very number the margin depends on. With total correct and attribution wrong, the same S$123 reads as S$5 or S$77 margin, a 15x spread.',
  @level0type = N'SCHEMA', @level0name = N'dbo',
  @level1type = N'TABLE',  @level1name = N'ListingParts',
  @level2type = N'COLUMN', @level2name = N'provenance';
GO

-- ★ THE ATTRIBUTION GAP, MADE VISIBLE — which is the half that stops the margin lying.
-- The task's own finding is that the TOTAL is right and the ATTRIBUTION is not, so a reader needs to see WHEN
-- a listing's cost cannot be attributed per part: rows at cost 0 with a NULL provenance are exactly the
-- "bundled" case, and a listing carrying them cannot state a per-part margin honestly.
IF OBJECT_ID('dbo.vListingCostAttribution', 'V') IS NOT NULL DROP VIEW dbo.vListingCostAttribution;
GO
CREATE VIEW dbo.vListingCostAttribution AS
SELECT
  l.id            AS listingId,
  l.listingNo,
  l.title,
  COUNT(p.id)                                                    AS partRows,
  SUM(p.partCost)                                                AS partsTotal,
  SUM(ISNULL(p.allocatedCost, 0))                                AS allocatedTotal,
  SUM(p.partCost) + SUM(ISNULL(p.allocatedCost, 0))              AS costBasis,
  SUM(CASE WHEN p.partCost = 0 AND p.provenance IS NULL THEN 1 ELSE 0 END) AS zeroCostNoProvenance,
  SUM(CASE WHEN p.provenance IS NULL AND p.partCost IS NOT NULL THEN 1 ELSE 0 END) AS rowsWithoutProvenance,
  CASE WHEN COUNT(p.id) = 0 THEN 'no_parts'
       WHEN SUM(CASE WHEN p.partCost = 0 AND p.provenance IS NULL THEN 1 ELSE 0 END) > 0
         THEN 'attribution_unrecorded'
       WHEN SUM(CASE WHEN p.provenance IS NULL AND p.partCost IS NOT NULL THEN 1 ELSE 0 END) > 0
         THEN 'attribution_partial'
       ELSE 'attribution_complete' END AS attributionLabel
FROM dbo.Listings l
LEFT JOIN dbo.ListingParts p ON p.listingId = l.id
WHERE l.userId = 1
GROUP BY l.id, l.listingNo, l.title;
GO

SELECT
  (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ListingParts') AND name IN ('provenance','allocatedCost')) AS new_columns,
  (SELECT COUNT(*) FROM dbo.ListingParts) AS part_rows,
  (SELECT COUNT(*) FROM dbo.ListingParts WHERE provenance IS NOT NULL) AS with_provenance,
  (SELECT COUNT(*) FROM dbo.vListingCostAttribution WHERE attributionLabel = 'attribution_unrecorded') AS listings_unattributed;
GO
