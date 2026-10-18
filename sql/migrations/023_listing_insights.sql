-- 023 - Listing Workbench: Carousell insights snapshots.
-- Each "Pull now" stores the raw JSON returned by the puller script against
-- the owner. Payload is kept as NVARCHAR(MAX) JSON so Carousell UI changes
-- never require schema changes; the UI renders whatever shape the puller emits.

IF OBJECT_ID('dbo.ListingInsights', 'U') IS NULL
BEGIN
    CREATE TABLE ListingInsights (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        payload NVARCHAR(MAX) NOT NULL,
        capturedAt DATETIME NOT NULL DEFAULT GETUTCDATE(),
        CONSTRAINT FK_ListingInsights_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_ListingInsights_user ON ListingInsights(userId);
    PRINT '  ListingInsights created.';
END
ELSE
    PRINT '  ListingInsights already exists.';
GO

PRINT 'Done.';
GO
