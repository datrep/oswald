-- 021 - Listing Workbench: "Parts to order" list.
-- A standalone shopping list of parts to order; entries can be sent to the
-- ledger (as a purchase) from the UI via the existing /api/listings/ledger.

IF OBJECT_ID('dbo.PartsToOrder', 'U') IS NULL
BEGIN
    CREATE TABLE PartsToOrder (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        componentName NVARCHAR(255) NOT NULL,
        qty INT NOT NULL DEFAULT 1,
        estCost DECIMAL(10,2) NULL,
        sourceUrl NVARCHAR(1000) NULL,
        notes NVARCHAR(MAX) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_PartsToOrder_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_PartsToOrder_user ON PartsToOrder(userId);
    PRINT '  PartsToOrder created.';
END
ELSE
    PRINT '  PartsToOrder already exists.';
GO

PRINT 'Done.';
GO
