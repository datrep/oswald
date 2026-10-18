-- 017_listing_workbench.sql
-- Listing Workbench (policy 51): the personal listing/price/profit/inventory
-- data model behind the self-contained `listings/` service. Ports the user's
-- Computer Inventory List.xlsm (7 sheets) into normalized tables + the
-- Carousell layer (own-listings + competitor comps, facts only).
--
-- Tables:
--   Listings        — a listing (PC build) + status + engagement snapshot
--   ListingParts    — component rows for a listing (the 8 X/X_Cost pairs)
--   PartPrices      — canonical component price source (PriceList sheet)
--   InventoryItems  — stock on hand (Inventory sheet)
--   LedgerEntries   — money in/out (Ledger sheet)
--   ListingComps    — competitor comps, FACTS ONLY (no third-party prose)
--   CostSettings    — global fee/shipping settings (single row, id=1)
--   Lookups         — editable dropdown lists (Lists + Config sheets)
--   GpuUpgrades     — read-only reference (GPU UPGRADE LIST sheet)
--
-- Datetimes use GETUTCDATE() (UTC convention, see migrations 009/013).
--
-- Applied: 2026-08-19

PRINT 'Creating Listings table...';
IF OBJECT_ID('dbo.Listings', 'U') IS NULL
BEGIN
    CREATE TABLE Listings (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        listingNo INT NULL,
        title NVARCHAR(255) NOT NULL,
        description NVARCHAR(MAX) NULL,       -- own listing full text (user's content)
        category NVARCHAR(50) NULL,
        condition NVARCHAR(50) NULL,
        sellingPrice DECIMAL(10,2) NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | for_sale | reserved | sold
        carousellUrl NVARCHAR(1000) NULL,
        images NVARCHAR(MAX) NULL,            -- JSON array of image URLs
        likes INT NULL,                       -- engagement snapshot (ephemeral)
        wantCount INT NULL,                   -- "X people also want this"
        capturedAt DATETIME NULL,             -- when likes/wantCount were read
        other NVARCHAR(MAX) NULL,             -- adjustment / note (Excel "Other")
        dateSold DATETIME NULL,
        notes NVARCHAR(MAX) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        updatedAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_Listings_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_Listings_user ON Listings(userId);
    PRINT '  Listings created.';
END
ELSE
    PRINT '  Listings already exists.';
GO

PRINT 'Creating ListingParts table...';
IF OBJECT_ID('dbo.ListingParts', 'U') IS NULL
BEGIN
    CREATE TABLE ListingParts (
        id INT PRIMARY KEY IDENTITY(1,1),
        listingId INT NOT NULL,
        partType NVARCHAR(20) NOT NULL,       -- cpu | gpu | ram | storage | motherboard | psu | optical | case | other
        partName NVARCHAR(255) NULL,
        partCost DECIMAL(10,2) NULL,
        sortOrder INT NOT NULL DEFAULT 0,
        CONSTRAINT FK_ListingParts_listing FOREIGN KEY (listingId) REFERENCES Listings(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_ListingParts_listing ON ListingParts(listingId);
    PRINT '  ListingParts created.';
END
ELSE
    PRINT '  ListingParts already exists.';
GO

PRINT 'Creating PartPrices table...';
IF OBJECT_ID('dbo.PartPrices', 'U') IS NULL
BEGIN
    CREATE TABLE PartPrices (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        componentName NVARCHAR(255) NOT NULL,
        currentPrice DECIMAL(10,2) NULL,
        updatedAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_PartPrices_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_PartPrices_user ON PartPrices(userId);
    CREATE UNIQUE INDEX UQ_PartPrices_user_component ON PartPrices(userId, componentName);
    PRINT '  PartPrices created.';
END
ELSE
    PRINT '  PartPrices already exists.';
GO

PRINT 'Creating InventoryItems table...';
IF OBJECT_ID('dbo.InventoryItems', 'U') IS NULL
BEGIN
    CREATE TABLE InventoryItems (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        itemName NVARCHAR(255) NOT NULL,
        category NVARCHAR(50) NULL,
        partTypeSpec NVARCHAR(255) NULL,
        quantity INT NOT NULL DEFAULT 0,
        condition NVARCHAR(50) NULL,
        location NVARCHAR(255) NULL,
        dateAdded DATETIME NULL,
        valueCost DECIMAL(10,2) NULL,
        notes NVARCHAR(MAX) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        updatedAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_InventoryItems_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_InventoryItems_user ON InventoryItems(userId);
    PRINT '  InventoryItems created.';
END
ELSE
    PRINT '  InventoryItems already exists.';
GO

PRINT 'Creating LedgerEntries table...';
IF OBJECT_ID('dbo.LedgerEntries', 'U') IS NULL
BEGIN
    CREATE TABLE LedgerEntries (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        date DATETIME NULL,
        type NVARCHAR(20) NULL,               -- purchase | sale | expense | income
        description NVARCHAR(255) NULL,
        category NVARCHAR(50) NULL,
        qty DECIMAL(10,2) NULL,
        unitAmount DECIMAL(10,2) NULL,
        amount DECIMAL(10,2) NULL,
        balance DECIMAL(10,2) NULL,
        payment NVARCHAR(50) NULL,
        ref NVARCHAR(255) NULL,
        notes NVARCHAR(MAX) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_LedgerEntries_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_LedgerEntries_user ON LedgerEntries(userId);
    PRINT '  LedgerEntries created.';
END
ELSE
    PRINT '  LedgerEntries already exists.';
GO

PRINT 'Creating ListingComps table...';
IF OBJECT_ID('dbo.ListingComps', 'U') IS NULL
BEGIN
    CREATE TABLE ListingComps (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        listingId INT NULL,                   -- optional link to one of your listings
        partType NVARCHAR(20) NULL,           -- for global part/category comps
        competitorPrice DECIMAL(10,2) NULL,
        specSummary NVARCHAR(MAX) NULL,       -- FACTS ONLY (model/spec tokens)
        condition NVARCHAR(50) NULL,
        category NVARCHAR(50) NULL,
        deliveryFee DECIMAL(10,2) NULL,
        likes INT NULL,
        wantCount INT NULL,
        sellerRating DECIMAL(3,1) NULL,
        sellerReviewCount INT NULL,
        sellerOrders INT NULL,
        sellerTenure NVARCHAR(50) NULL,
        isProfessionalSeller BIT NULL,
        sourceUrl NVARCHAR(1000) NULL,
        seenAt DATETIME NULL,
        notes NVARCHAR(MAX) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_ListingComps_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE,
        -- NO ACTION (not SET NULL/CASCADE): SQL Server rejects a second cascade
        -- path from Users through Listings. The listing-delete flow must
        -- remove/re-point comps first.
        CONSTRAINT FK_ListingComps_listing FOREIGN KEY (listingId) REFERENCES Listings(id) ON DELETE NO ACTION
    );
    CREATE INDEX IX_ListingComps_user ON ListingComps(userId);
    PRINT '  ListingComps created.';
END
ELSE
    PRINT '  ListingComps already exists.';
GO

PRINT 'Creating CostSettings table...';
IF OBJECT_ID('dbo.CostSettings', 'U') IS NULL
BEGIN
    CREATE TABLE CostSettings (
        id INT PRIMARY KEY,                   -- always 1 (single global row)
        platformFeePct DECIMAL(6,2) NOT NULL DEFAULT 0,
        paymentFeePct DECIMAL(6,2) NOT NULL DEFAULT 0,
        shippingCost DECIMAL(10,2) NOT NULL DEFAULT 0,
        updatedAt DATETIME DEFAULT GETUTCDATE()
    );
    INSERT INTO CostSettings (id, platformFeePct, paymentFeePct, shippingCost) VALUES (1, 0, 0, 0);
    PRINT '  CostSettings created (row 1 seeded).';
END
ELSE
    PRINT '  CostSettings already exists.';
GO

PRINT 'Creating Lookups table...';
IF OBJECT_ID('dbo.Lookups', 'U') IS NULL
BEGIN
    CREATE TABLE Lookups (
        id INT PRIMARY KEY IDENTITY(1,1),
        listKey NVARCHAR(50) NOT NULL,        -- e.g. type | category_inventory | category_ledger | payment | status | condition
        value NVARCHAR(255) NOT NULL,
        sortOrder INT NOT NULL DEFAULT 0,
        CONSTRAINT UQ_Lookups_key_value UNIQUE (listKey, value)
    );
    PRINT '  Lookups created.';
END
ELSE
    PRINT '  Lookups already exists.';
GO

PRINT 'Creating GpuUpgrades table...';
IF OBJECT_ID('dbo.GpuUpgrades', 'U') IS NULL
BEGIN
    CREATE TABLE GpuUpgrades (
        id INT PRIMARY KEY IDENTITY(1,1),
        gpu NVARCHAR(255) NULL,
        stockVram NVARCHAR(255) NULL,
        maxVramUpgrade NVARCHAR(255) NULL,
        feasibility NVARCHAR(MAX) NULL,
        otherMods NVARCHAR(MAX) NULL,
        sortOrder INT NOT NULL DEFAULT 0
    );
    PRINT '  GpuUpgrades created.';
END
ELSE
    PRINT '  GpuUpgrades already exists.';
GO

PRINT 'Done.';
GO
