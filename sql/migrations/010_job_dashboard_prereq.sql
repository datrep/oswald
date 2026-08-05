-- 010_job_dashboard_prereq.sql
-- PREREQ for the Job Application Dashboard (policy 20) + the module-attachment
-- framework. Two tables:
--   JobApplications — the job tracker's data model (owner-scoped)
--   PolicyModules   — modules attached to a policy (the "+ Add module" framework)
--
-- All datetimes use GETUTCDATE() (see migration 009 lesson: mssql treats
-- DATETIME wall-clock as UTC, so storing UTC avoids the +8h display bug).
--
-- FUTURE SCOPE: new modules (e.g. certificates) just need a row in PolicyModules
-- + an entry in the frontend registry + backend allowlist — no schema change.
--
-- Applied: 2026-08-05

PRINT 'Creating JobApplications table...';
IF OBJECT_ID('dbo.JobApplications', 'U') IS NULL
BEGIN
    CREATE TABLE JobApplications (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        company NVARCHAR(255) NOT NULL,
        role NVARCHAR(255) NOT NULL,
        source NVARCHAR(50) NOT NULL DEFAULT 'other',   -- mycareersfuture | jobstreet | internsg | other
        jobUrl NVARCHAR(1000) NULL,
        status NVARCHAR(30) NOT NULL DEFAULT 'applied',  -- applied | screening | assessment | interview | offer | hired | rejected | withdrawn
        appliedAt DATETIME NULL,
        followUpAt DATETIME NULL,
        salary NVARCHAR(100) NULL,
        location NVARCHAR(255) NULL,
        notes NVARCHAR(MAX) NULL,
        contact NVARCHAR(255) NULL,
        resumePath NVARCHAR(500) NULL,                    -- points into /resources/career/...
        tags NVARCHAR(500) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        updatedAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_JobApplications_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_JobApplications_user ON JobApplications(userId);
    PRINT '  JobApplications created.';
END
ELSE
    PRINT '  JobApplications already exists.';
GO

PRINT 'Creating PolicyModules table...';
IF OBJECT_ID('dbo.PolicyModules', 'U') IS NULL
BEGIN
    CREATE TABLE PolicyModules (
        id INT PRIMARY KEY IDENTITY(1,1),
        edictId INT NOT NULL,
        moduleType NVARCHAR(50) NOT NULL,
        config NVARCHAR(MAX) NULL,
        createdAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_PolicyModules_edict FOREIGN KEY (edictId) REFERENCES Edicts(id) ON DELETE CASCADE,
        CONSTRAINT UQ_PolicyModules_edict_type UNIQUE (edictId, moduleType)
    );
    PRINT '  PolicyModules created.';
END
ELSE
    PRINT '  PolicyModules already exists.';
GO

PRINT 'Done.';
GO
