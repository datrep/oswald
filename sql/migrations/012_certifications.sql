-- 012_certifications.sql
-- Certificate Dashboard (MOD-1): owner-scoped certification records. Reuses the
-- Career Files module (careerFilePath) for the actual cert document. Status is a
-- lifecycle: planned -> in_progress -> obtained -> expired.
-- Datetimes use GETUTCDATE() (UTC convention, see migration 009).
--
-- Applied: 2026-08-05

PRINT 'Creating Certifications table...';
IF OBJECT_ID('dbo.Certifications', 'U') IS NULL
BEGIN
    CREATE TABLE Certifications (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        name NVARCHAR(255) NOT NULL,
        issuer NVARCHAR(255) NULL,
        status NVARCHAR(20) NOT NULL DEFAULT 'planned', -- planned | in_progress | obtained | expired
        startAt DATETIME NULL,
        obtainedAt DATETIME NULL,
        expiryAt DATETIME NULL,
        credential NVARCHAR(500) NULL,     -- credential ID or a verification URL
        careerFilePath NVARCHAR(500) NULL, -- path to the cert PDF in Career Files (resources/career/...)
        studyLinks NVARCHAR(MAX) NULL,     -- free-text study-material URLs (one per line)
        notes NVARCHAR(MAX) NULL,
        tags NVARCHAR(500) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        updatedAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_Certifications_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_Certifications_user ON Certifications(userId);
    PRINT '  Certifications created.';
END
ELSE
    PRINT '  Certifications already exists.';
GO

PRINT 'Done.';
GO
