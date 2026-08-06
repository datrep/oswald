-- RESET DATABASE
USE master;
GO
 

drop view tables;

IF DB_ID('DB_Oswald') IS NOT NULL
BEGIN
    PRINT 'Dropping existing DB_Oswald database...';
    ALTER DATABASE DB_Oswald SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE DB_Oswald;
END

PRINT 'Creating DB_Oswald database...';
CREATE DATABASE DB_Oswald;
GO

USE DB_Oswald;
GO

-- DROP EXISTING TABLES IN CORRECT ORDER
PRINT 'Dropping existing tables if they exist (in correct dependency order)...';

IF OBJECT_ID('dbo.AuditLogs', 'U') IS NOT NULL DROP TABLE dbo.AuditLogs;
IF OBJECT_ID('dbo.EdictResources', 'U') IS NOT NULL DROP TABLE dbo.EdictResources;
IF OBJECT_ID('dbo.Tasks', 'U') IS NOT NULL DROP TABLE dbo.Tasks;
IF OBJECT_ID('dbo.Edicts', 'U') IS NOT NULL DROP TABLE dbo.Edicts;
IF OBJECT_ID('dbo.Users', 'U') IS NOT NULL DROP TABLE dbo.Users;

PRINT 'Existing tables dropped.';
GO

-- CREATE TABLES

PRINT 'Creating Edicts table...';
CREATE TABLE Edicts (
    id INT PRIMARY KEY IDENTITY(1,1),
    name NVARCHAR(255) NOT NULL,
    createdAt DATETIME DEFAULT GETUTCDATE(),
    plannedStart DATETIME NOT NULL,
    plannedEnd DATETIME NULL,
    completedAt DATETIME NULL,
    active AS (CASE WHEN GETUTCDATE() >= plannedStart AND (plannedEnd IS NULL OR GETUTCDATE() <= plannedEnd) THEN 1 ELSE 0 END),
    info NVARCHAR(MAX),
    priority INT NULL,
    state INT NULL,
    assignedToEdictId INT NULL,
    FOREIGN KEY (assignedToEdictId) REFERENCES Edicts(id) ON DELETE NO ACTION
);

PRINT 'Creating Users table...';
CREATE TABLE Users (
    id INT PRIMARY KEY IDENTITY(1,1),
    username NVARCHAR(50) NOT NULL UNIQUE,
    passwordHash NVARCHAR(255) NOT NULL,
    createdAt DATETIME DEFAULT GETUTCDATE(),
    updatedAt DATETIME DEFAULT GETUTCDATE()
);
GO


PRINT 'Creating Tasks table...';
CREATE TABLE Tasks (
    id INT PRIMARY KEY IDENTITY(1,1),
    name NVARCHAR(255) NOT NULL,
    createdAt DATETIME DEFAULT GETUTCDATE(),
    plannedStart DATETIME NOT NULL,
    plannedEnd DATETIME NULL,
    completedAt DATETIME NULL,
    active AS (CASE WHEN GETUTCDATE() >= plannedStart AND (plannedEnd IS NULL OR GETUTCDATE() <= plannedEnd) THEN 1 ELSE 0 END),
    info NVARCHAR(MAX),
    priority INT NULL,
    state INT NULL,
    assignedToUserId INT NULL,
    edictId INT NULL,
    FOREIGN KEY (assignedToUserId) REFERENCES Users(id) ON DELETE SET NULL,
    FOREIGN KEY (edictId) REFERENCES Edicts(id) ON DELETE SET NULL
);
GO

PRINT 'Creating EdictResources table...';
CREATE TABLE EdictResources (
    id INT PRIMARY KEY IDENTITY(1,1),
    edictId INT NOT NULL,
    resourcePath NVARCHAR(255) NOT NULL,
    description NVARCHAR(255) NULL,
    FOREIGN KEY (edictId) REFERENCES Edicts(id) ON DELETE NO ACTION
);
GO

PRINT 'Creating NetworkHosts table...';
CREATE TABLE NetworkHosts (
    id INT PRIMARY KEY IDENTITY(1,1),
    label NVARCHAR(100) NOT NULL,
    ip NVARCHAR(45) NOT NULL,
    enabled BIT NOT NULL DEFAULT 1,
    sortOrder INT NOT NULL DEFAULT 0
);
GO

PRINT 'Creating AuditLogs table...';
CREATE TABLE AuditLogs (
    id INT PRIMARY KEY IDENTITY(1,1),
    edictId INT NULL,
    taskId INT NULL,
    eventType NVARCHAR(50) NOT NULL,
    notes NVARCHAR(MAX) NULL,
    createdAt DATETIME DEFAULT GETUTCDATE(),
    FOREIGN KEY (edictId) REFERENCES Edicts(id) ON DELETE SET NULL,
    FOREIGN KEY (taskId) REFERENCES Tasks(id) ON DELETE SET NULL
);
GO

-- SEED SAMPLE DATA

PRINT 'Inserting sample user...';
INSERT INTO Users (username, passwordHash) VALUES
('oswald_admin', '$2b$10$aAzmbxTi7wV9AyyhyGC4iOiSZ2Acnv27Nd2Bw69/0TQo7WI8rXlR.'); -- password: admin
GO

PRINT 'Inserting sample edicts...';
INSERT INTO Edicts (name, plannedStart, plannedEnd, info, priority, state) VALUES
('Initial Policy', GETUTCDATE(), DATEADD(day, 7, GETUTCDATE()), 'This is the first edict', 1, 2),
('Follow-up Policy', DATEADD(day, 1, GETUTCDATE()), DATEADD(day, 14, GETUTCDATE()), 'Second policy for testing', 2, 1);
GO

PRINT 'Inserting sample tasks...';
INSERT INTO Tasks (name, plannedStart, plannedEnd, info, priority, state, assignedToUserId,edictId) VALUES
('Task One', GETUTCDATE(), DATEADD(day, 3, GETUTCDATE()), 'First test task', 1, 2, 1,1),
('Task Two', DATEADD(day, 2, GETUTCDATE()), DATEADD(day, 5, GETUTCDATE()), 'Second test task', 2, 1, 1,2);
GO

PRINT 'Inserting sample resources for edicts...';
INSERT INTO EdictResources (edictId, resourcePath, description) VALUES
(1, '/resources/policy-doc-1.pdf', 'Main document for initial policy'),
(1, '/resources/policy-diagram-1.png', 'Diagram attached to initial policy'),
(2, '/resources/policy-doc-2.pdf', 'Follow-up policy document');
GO

PRINT 'Inserting sample audit logs...';
INSERT INTO AuditLogs (edictId, taskId, eventType, notes) VALUES
(1, NULL, 'created', 'Edict created by admin'),
(NULL, 1, 'created', 'Task created for Oswald admin'),
(1, NULL, 'hardReminderTriggered', 'Reminder triggered for initial policy');
GO

-- Confirm tables created
PRINT 'Verifying all base tables:';
USE DB_Oswald;
SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE';
GO


-- CREATE SQL LOGIN AND DATABASE USER

-- DROP EXISTING SQL LOGIN
PRINT 'Dropping existing SQL login (api_user) if it exists...';
USE master;
GO
IF EXISTS (SELECT * FROM sys.sql_logins WHERE name = 'api_user')
BEGIN
    DROP LOGIN api_user;
    PRINT 'Old login dropped.';
END
GO

-- CREATE SQL 
PRINT 'Creating new SQL login (api_user)...';
CREATE LOGIN api_user WITH PASSWORD = 'api_user';
GO

-- CREATE DATABASE USER AND GRANT ROLES
PRINT 'Creating database user mapped to login in DB_Oswald...';
USE DB_Oswald;
GO

IF EXISTS (SELECT * FROM sys.database_principals WHERE name = 'api_user')
BEGIN
    DROP USER api_user;
    PRINT 'Old database user dropped.';
END
GO

CREATE USER api_user FOR LOGIN api_user;
GO

ALTER ROLE db_datareader ADD MEMBER api_user;
ALTER ROLE db_datawriter ADD MEMBER api_user;
GO

PRINT 'api_user login and database user created and granted permissions successfully.';
GO

EXEC sp_help 'Tasks'
