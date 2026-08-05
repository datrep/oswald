-- 011_career_files.sql
-- Career Files module (MOD-1): metadata for the user's career documents (resume,
-- certs, etc.) stored under /resources/career. Owner-scoped personal files.
-- Datetimes use GETUTCDATE() (UTC convention, see migration 009).
--
-- Applied: 2026-08-05

PRINT 'Creating CareerFiles table...';
IF OBJECT_ID('dbo.CareerFiles', 'U') IS NULL
BEGIN
    CREATE TABLE CareerFiles (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        fileName NVARCHAR(255) NOT NULL,
        filePath NVARCHAR(500) NOT NULL,           -- e.g. resources/career/<stored-name>
        kind NVARCHAR(20) NOT NULL DEFAULT 'other', -- resume | cert | other
        description NVARCHAR(500) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_CareerFiles_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_CareerFiles_user ON CareerFiles(userId);
    PRINT '  CareerFiles created.';
END
ELSE
    PRINT '  CareerFiles already exists.';
GO

PRINT 'Done.';
GO
