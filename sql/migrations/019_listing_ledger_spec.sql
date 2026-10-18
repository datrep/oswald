-- 019 — Listing Workbench: ledger to spec.             Applied: 2026-08-25
--
-- * LedgerEntries.type is LOWERCASE (sale | purchase | expense | income) per the
--   migration 017 comment, the Excel import (type.toLowerCase()) and
--   store.ledgerSummary. The UI was storing Title Case from the Lookups dropdown,
--   so normalize existing rows (and the import's lowercased values) to the
--   canonical form so the summary counts correctly.
-- * unitAmount and balance are redundant — they are inferred on read
--   (unit = amount/qty, balance = running cumulative sum). Drop the columns.
-- * Lookups 'type'/'status' seeds become lowercase codes so the Lookups editor
--   matches the canonical convention (status: draft | for_sale | reserved | sold).

-- NB: the DB collation is case-insensitive, so `type <> LOWER(type)` is always
-- false. Just LOWER everything (only the four canonical values are valid).
UPDATE LedgerEntries
SET type = LOWER(LTRIM(RTRIM(type)))
WHERE type IS NOT NULL;
GO

IF COL_LENGTH('dbo.LedgerEntries', 'unitAmount') IS NOT NULL
BEGIN
    ALTER TABLE LedgerEntries DROP COLUMN unitAmount;
    PRINT '  LedgerEntries.unitAmount dropped.';
END
GO

IF COL_LENGTH('dbo.LedgerEntries', 'balance') IS NOT NULL
BEGIN
    ALTER TABLE LedgerEntries DROP COLUMN balance;
    PRINT '  LedgerEntries.balance dropped.';
END
GO

-- Lookups type -> lowercase codes (sale|purchase|expense|income).
UPDATE Lookups SET value = LOWER(value) WHERE listKey = 'type';
-- Lookups status -> canonical Listings codes (draft|for_sale|reserved|sold).
UPDATE Lookups SET value = CASE value
    WHEN 'For Sale' THEN 'for_sale'
    WHEN 'Draft'    THEN 'draft'
    WHEN 'Sold'     THEN 'sold'
    WHEN 'Reserved' THEN 'reserved'
    ELSE LOWER(value)
  END
WHERE listKey = 'status';
GO
