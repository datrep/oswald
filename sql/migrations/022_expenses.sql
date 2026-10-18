-- sql/migrations/022_expenses.sql — General Expense Sheet service.
-- Owner-scoped personal expenses (computer / investing / school / other).
-- `sourceLedgerId` links a copied row back to the Listing Workbench LedgerEntries
-- entry it was snapshotted from. Deliberately NO foreign key: snapshots are
-- independent — editing/deleting either side never affects the other.
IF OBJECT_ID('dbo.Expenses', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Expenses (
    id             INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Expenses PRIMARY KEY,
    userId         INT NOT NULL CONSTRAINT FK_Expenses_Users REFERENCES dbo.Users(id) ON DELETE CASCADE,
    category       NVARCHAR(20)  NOT NULL,          -- computer | investing | school | other
    description    NVARCHAR(255) NULL,              -- purpose of the expense
    amount         DECIMAL(10,2) NOT NULL CONSTRAINT DF_Expenses_amount DEFAULT 0,
    platform       NVARCHAR(20)  NULL,              -- debit | credit
    tags           NVARCHAR(255) NULL,              -- free-form, comma-separated
    expenseDate    DATETIME2     NULL,              -- date of the expense
    sourceLedgerId INT           NULL,              -- Listing Workbench LedgerEntries.id snapshot source
    createdAt      DATETIME2     NOT NULL CONSTRAINT DF_Expenses_createdAt DEFAULT GETUTCDATE(), -- date of input
    updatedAt      DATETIME2     NOT NULL CONSTRAINT DF_Expenses_updatedAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_Expenses_userId ON dbo.Expenses(userId);
  CREATE INDEX IX_Expenses_sync   ON dbo.Expenses(userId, sourceLedgerId);
END
