-- 020 - Listing Workbench: persist discovered hardware inventory per listing.
--
-- Adds Listings.inventory (JSON string) written by the hardware discovery
-- action ("option 6" of the firmware scripts, run in discover-only mode).
-- The listings service also self-heals this column on first use, so this
-- migration is idempotence/documentation rather than a hard prerequisite.

IF COL_LENGTH('dbo.Listings', 'inventory') IS NULL
BEGIN
    ALTER TABLE dbo.Listings ADD inventory NVARCHAR(MAX) NULL;
    PRINT '  Listings.inventory added.';
END
ELSE
    PRINT '  Listings.inventory already exists.';
GO
