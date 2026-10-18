-- RESET DATABASE
USE master;
GO

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

IF OBJECT_ID('dbo.UserRoles', 'U') IS NOT NULL DROP TABLE dbo.UserRoles;
IF OBJECT_ID('dbo.RolePermissions', 'U') IS NOT NULL DROP TABLE dbo.RolePermissions;
IF OBJECT_ID('dbo.FileServerACLs', 'U') IS NOT NULL DROP TABLE dbo.FileServerACLs;
IF OBJECT_ID('dbo.FileFavorites', 'U') IS NOT NULL DROP TABLE dbo.FileFavorites;
IF OBJECT_ID('dbo.FileTags', 'U') IS NOT NULL DROP TABLE dbo.FileTags;
IF OBJECT_ID('dbo.Certifications', 'U') IS NOT NULL DROP TABLE dbo.Certifications;
IF OBJECT_ID('dbo.CareerFiles', 'U') IS NOT NULL DROP TABLE dbo.CareerFiles;
IF OBJECT_ID('dbo.JobApplications', 'U') IS NOT NULL DROP TABLE dbo.JobApplications;
IF OBJECT_ID('dbo.PolicyModules', 'U') IS NOT NULL DROP TABLE dbo.PolicyModules;
IF OBJECT_ID('dbo.ApiLogs', 'U') IS NOT NULL DROP TABLE dbo.ApiLogs;
IF OBJECT_ID('dbo.Services', 'U') IS NOT NULL DROP TABLE dbo.Services;
IF OBJECT_ID('dbo.AuditLogs', 'U') IS NOT NULL DROP TABLE dbo.AuditLogs;
IF OBJECT_ID('dbo.EdictResources', 'U') IS NOT NULL DROP TABLE dbo.EdictResources;
IF OBJECT_ID('dbo.Tasks', 'U') IS NOT NULL DROP TABLE dbo.Tasks;
IF OBJECT_ID('dbo.Edicts', 'U') IS NOT NULL DROP TABLE dbo.Edicts;
IF OBJECT_ID('dbo.Users', 'U') IS NOT NULL DROP TABLE dbo.Users;
IF OBJECT_ID('dbo.Permissions', 'U') IS NOT NULL DROP TABLE dbo.Permissions;
IF OBJECT_ID('dbo.Roles', 'U') IS NOT NULL DROP TABLE dbo.Roles;
IF OBJECT_ID('dbo.NetworkHosts', 'U') IS NOT NULL DROP TABLE dbo.NetworkHosts;
IF OBJECT_ID('dbo.TradingSettings', 'U') IS NOT NULL DROP TABLE dbo.TradingSettings;
IF OBJECT_ID('dbo.TradingAlerts', 'U') IS NOT NULL DROP TABLE dbo.TradingAlerts;
IF OBJECT_ID('dbo.TradingEvents', 'U') IS NOT NULL DROP TABLE dbo.TradingEvents;
IF OBJECT_ID('dbo.TradingPrompts', 'U') IS NOT NULL DROP TABLE dbo.TradingPrompts;
IF OBJECT_ID('dbo.PromptErrors', 'U') IS NOT NULL DROP TABLE dbo.PromptErrors;
IF OBJECT_ID('dbo.Trades', 'U') IS NOT NULL DROP TABLE dbo.Trades;
IF OBJECT_ID('dbo.PriceTicks', 'U') IS NOT NULL DROP TABLE dbo.PriceTicks;
IF OBJECT_ID('dbo.PriceBars', 'U') IS NOT NULL DROP TABLE dbo.PriceBars;
IF OBJECT_ID('dbo.BacktestRuns', 'U') IS NOT NULL DROP TABLE dbo.BacktestRuns;
IF OBJECT_ID('dbo.CorporateEvents', 'U') IS NOT NULL DROP TABLE dbo.CorporateEvents;
IF OBJECT_ID('dbo.EquitySnapshots', 'U') IS NOT NULL DROP TABLE dbo.EquitySnapshots;
IF OBJECT_ID('dbo.EquityTicks', 'U') IS NOT NULL DROP TABLE dbo.EquityTicks;
-- 035_instrument_registry.sql (TRD-45 Phase 1). Quotes are dropped BEFORE Instruments: the FK is
-- one-way (quotes reference the user, not the instrument), so order only matters for readability,
-- but keeping the child first matches the rest of this file.
IF OBJECT_ID('dbo.InstrumentQuotes', 'U') IS NOT NULL DROP TABLE dbo.InstrumentQuotes;
IF OBJECT_ID('dbo.Instruments', 'U') IS NOT NULL DROP TABLE dbo.Instruments;

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
    updatedAt DATETIME DEFAULT GETUTCDATE(),
    isActive BIT NOT NULL DEFAULT 1,
    tokenVersion INT NOT NULL DEFAULT 0
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
    sortOrder INT NOT NULL DEFAULT 0,
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
    sortOrder INT NOT NULL DEFAULT 0,
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

-- Services (created originally via sql/queries/services_table.sql, not a numbered
-- migration — folded in here so a fresh build is complete)
PRINT 'Creating Services table...';
CREATE TABLE Services (
    id INT PRIMARY KEY IDENTITY(1,1),
    name NVARCHAR(100) NOT NULL,
    description NVARCHAR(255) NULL,
    type NVARCHAR(50) NOT NULL,
    target NVARCHAR(500) NOT NULL,
    iconPath NVARCHAR(255) NULL,
    enabled BIT DEFAULT 1,
    sortOrder INT DEFAULT 0,
    createdAt DATETIME DEFAULT GETUTCDATE()
);
GO

PRINT 'Seeding Services...';
INSERT INTO Services (name, description, type, target, iconPath) VALUES
('Wikipedia', 'Online encyclopedia', 'External', 'https://wikipedia.org', '/assets/icons/wikipedia.png'),
('Danbooru', 'Image board for anime art', 'External', 'https://danbooru.donmai.us', '/assets/icons/danbooru.png'),
('Pixiv', 'Japanese online community for artists', 'External', 'https://www.pixiv.net', '/assets/icons/pixiv.png'),
('YouTube', 'Video sharing platform', 'External', 'https://www.youtube.com', '/assets/icons/youtube.png'),
('GitHub', 'Code hosting platform', 'External', 'https://github.com', '/assets/icons/github.png');
GO

-- Migrations 004-014: RBAC, fileserver metadata, ApiLogs, module tables

PRINT 'Creating RBAC tables (migration 004)...';
CREATE TABLE Permissions (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    code        NVARCHAR(80) NOT NULL UNIQUE,
    description NVARCHAR(255) NULL
);
CREATE TABLE Roles (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    name        NVARCHAR(50) NOT NULL UNIQUE,
    description NVARCHAR(255) NULL,
    createdAt   DATETIME DEFAULT GETDATE()
);
CREATE TABLE UserRoles (
    userId INT NOT NULL,
    roleId INT NOT NULL,
    PRIMARY KEY (userId, roleId),
    CONSTRAINT FK_UserRoles_User FOREIGN KEY (userId) REFERENCES dbo.Users(id) ON DELETE CASCADE,
    CONSTRAINT FK_UserRoles_Role FOREIGN KEY (roleId) REFERENCES dbo.Roles(id) ON DELETE CASCADE
);
CREATE TABLE RolePermissions (
    roleId       INT NOT NULL,
    permissionId INT NOT NULL,
    PRIMARY KEY (roleId, permissionId),
    CONSTRAINT FK_RolePermissions_Role FOREIGN KEY (roleId) REFERENCES dbo.Roles(id) ON DELETE CASCADE,
    CONSTRAINT FK_RolePermissions_Permission FOREIGN KEY (permissionId) REFERENCES dbo.Permissions(id) ON DELETE CASCADE
);
GO

PRINT 'Creating fileserver metadata tables (migration 005)...';
CREATE TABLE FileServerACLs (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    userId      INT NOT NULL,
    rootId      NVARCHAR(64)  NOT NULL,
    folderPath  NVARCHAR(512) NOT NULL DEFAULT '',
    canRead     BIT NOT NULL DEFAULT 1,
    canWrite    BIT NOT NULL DEFAULT 0,
    createdBy   INT NULL,
    createdAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_FileServerACLs UNIQUE (userId, rootId, folderPath)
);
CREATE INDEX IX_FileServerACLs_user ON dbo.FileServerACLs (userId, rootId);
CREATE TABLE FileFavorites (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    userId      INT NOT NULL,
    rootId      NVARCHAR(64)  NOT NULL,
    filePath    NVARCHAR(1024) NOT NULL,
    createdAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_FileFavorites UNIQUE (userId, rootId, filePath)
);
CREATE INDEX IX_FileFavorites_user ON dbo.FileFavorites (userId, rootId);
CREATE TABLE FileTags (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    rootId      NVARCHAR(64)  NOT NULL,
    filePath    NVARCHAR(1024) NOT NULL,
    tag         NVARCHAR(64)  NOT NULL,
    createdBy   INT NULL,
    createdAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
    CONSTRAINT UQ_FileTags UNIQUE (rootId, filePath, tag)
);
CREATE INDEX IX_FileTags_tag ON dbo.FileTags (tag);
GO

PRINT 'Creating ApiLogs table (migration 008/009)...';
CREATE TABLE ApiLogs (
    id INT PRIMARY KEY IDENTITY(1,1),
    source NVARCHAR(50) NOT NULL,
    label NVARCHAR(100) NULL,
    method NVARCHAR(10) NOT NULL,
    path NVARCHAR(500) NOT NULL,
    status INT NOT NULL,
    durationMs INT NOT NULL,
    userId INT NULL,
    createdAt DATETIME DEFAULT GETUTCDATE()
);
CREATE INDEX IX_ApiLogs_createdAt ON ApiLogs (createdAt DESC);
CREATE INDEX IX_ApiLogs_source ON ApiLogs (source);
GO

PRINT 'Creating JobApplications + PolicyModules tables (migration 010)...';
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
    resumePath NVARCHAR(500) NULL,
    tags NVARCHAR(500) NULL,
    createdAt DATETIME DEFAULT GETUTCDATE(),
    updatedAt DATETIME DEFAULT GETUTCDATE(),
    CONSTRAINT FK_JobApplications_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_JobApplications_user ON JobApplications(userId);
CREATE TABLE PolicyModules (
    id INT PRIMARY KEY IDENTITY(1,1),
    edictId INT NOT NULL,
    moduleType NVARCHAR(50) NOT NULL,
    config NVARCHAR(MAX) NULL,
    createdAt DATETIME DEFAULT GETUTCDATE(),
    CONSTRAINT FK_PolicyModules_edict FOREIGN KEY (edictId) REFERENCES Edicts(id) ON DELETE CASCADE,
    CONSTRAINT UQ_PolicyModules_edict_type UNIQUE (edictId, moduleType)
);
GO

PRINT 'Creating CareerFiles table (migration 011)...';
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
GO

PRINT 'Creating Certifications table (migration 012)...';
CREATE TABLE Certifications (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    name NVARCHAR(255) NOT NULL,
    issuer NVARCHAR(255) NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'planned', -- planned | in_progress | obtained | expired
    startAt DATETIME NULL,
    obtainedAt DATETIME NULL,
    expiryAt DATETIME NULL,
    credential NVARCHAR(500) NULL,
    careerFilePath NVARCHAR(500) NULL,
    studyLinks NVARCHAR(MAX) NULL,
    notes NVARCHAR(MAX) NULL,
    tags NVARCHAR(500) NULL,
    createdAt DATETIME DEFAULT GETUTCDATE(),
    updatedAt DATETIME DEFAULT GETUTCDATE(),
    CONSTRAINT FK_Certifications_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_Certifications_user ON Certifications(userId);
GO

-- Trading Agent tables (migration 024)
PRINT 'Creating TradingSettings table (migration 024)...';
CREATE TABLE TradingSettings (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    settings NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TradingSettings_settings DEFAULT '{}',
    updatedAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_TradingSettings_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE,
    CONSTRAINT UQ_TradingSettings_user UNIQUE (userId)
);
GO

PRINT 'Creating TradingAlerts table (migration 024)...';
CREATE TABLE TradingAlerts (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    venue NVARCHAR(32) NOT NULL DEFAULT 'plus500',
    direction NVARCHAR(16) NOT NULL,             -- above | below | crosses
    threshold DECIMAL(18,6) NOT NULL,
    metric NVARCHAR(16) NOT NULL DEFAULT 'price', -- price | changePct | buyersPct (migration 027)
    enabled BIT NOT NULL DEFAULT 1,
    cooldownMinutes INT NOT NULL DEFAULT 60,
    lastTriggeredAt DATETIME2 NULL,
    note NVARCHAR(255) NULL,
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    updatedAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_TradingAlerts_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_TradingAlerts_user ON TradingAlerts(userId, enabled);
GO

PRINT 'Creating TradingEvents table (migration 024)...';
CREATE TABLE TradingEvents (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    kind NVARCHAR(32) NOT NULL,
    payload NVARCHAR(MAX) NULL,
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_TradingEvents_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_TradingEvents_user ON TradingEvents(userId, createdAt DESC);
GO

PRINT 'Creating TradingPrompts table (migration 024)...';
CREATE TABLE TradingPrompts (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    triggerType NVARCHAR(32) NOT NULL,           -- schedule | alert | pnl | manual
    bundle NVARCHAR(MAX) NULL,
    response NVARCHAR(MAX) NULL,
    decision NVARCHAR(MAX) NULL,
    model NVARCHAR(64) NULL,
    usage NVARCHAR(MAX) NULL,
    latencyMs INT NULL,
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_TradingPrompts_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_TradingPrompts_user ON TradingPrompts(userId, createdAt DESC);
GO

PRINT 'Creating PromptErrors table (migration 024)...';
CREATE TABLE PromptErrors (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    promptId INT NULL,
    raw NVARCHAR(MAX) NULL,
    error NVARCHAR(255) NULL,
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_PromptErrors_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
GO

PRINT 'Creating Trades table (migrations 024/026/028/029/030)...';
CREATE TABLE Trades (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    venue NVARCHAR(32) NOT NULL DEFAULT 'plus500',
    symbol NVARCHAR(64) NOT NULL,
    direction NVARCHAR(8) NOT NULL,              -- buy | sell
    size DECIMAL(18,6) NOT NULL,
    units NVARCHAR(32) NULL,
    openPrice DECIMAL(18,6) NULL,
    openAt DATETIME2 NULL,
    closePrice DECIMAL(18,6) NULL,
    closeAt DATETIME2 NULL,
    grossPnl DECIMAL(18,4) NULL,
    fees DECIMAL(18,4) NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'open', -- open | closed | cancelled | rejected | phantom
    plus500PositionId NVARCHAR(64) NULL,
    decisionId INT NULL,
    note NVARCHAR(255) NULL,
    currentRate DECIMAL(18,6) NULL,              -- 026: live mirror rate
    floatingPnl DECIMAL(18,6) NULL,              -- 026: live mirror P/L
    origin NVARCHAR(20) NULL,                    -- 028: agent | venue
    stopPrice DECIMAL(18,6) NULL,                -- 028: turtle 2xATR stop
    takeProfitPrice DECIMAL(18,6) NULL,          -- 028: 3xATR target
    filledAt DATETIME2 NULL,                     -- 029: actual fill time
    rejectReason NVARCHAR(120) NULL,             -- 029: why it was rejected
    fillDelayMs INT NULL,                        -- 029: decision -> fill latency
    mfePct DECIMAL(18,6) NULL,                   -- 030: max favorable excursion
    maePct DECIMAL(18,6) NULL,                   -- 030: max adverse excursion
    holdingMinutes INT NULL,                     -- 030
    slippagePct DECIMAL(18,6) NULL,              -- 030
    strategyId NVARCHAR(32) NULL,                -- 030: which strategy opened it
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    updatedAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_Trades_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_Trades_user_status ON Trades(userId, status);
GO

PRINT 'Creating PriceTicks table (migration 024)...';
CREATE TABLE PriceTicks (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    venue NVARCHAR(32) NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    bid DECIMAL(18,6) NULL,
    ask DECIMAL(18,6) NULL,
    source NVARCHAR(32) NOT NULL DEFAULT 'frontend',
    capturedAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_PriceTicks_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_PriceTicks_captured ON PriceTicks(capturedAt DESC);
CREATE INDEX IX_PriceTicks_symbol ON PriceTicks(venue, symbol, capturedAt DESC);
GO

PRINT 'Creating PriceBars table (migration 024)...';
CREATE TABLE PriceBars (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    venue NVARCHAR(32) NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    timeframe NVARCHAR(8) NOT NULL,              -- 1h | 1d
    barStart DATETIME2 NOT NULL,
    openPrice DECIMAL(18,6) NULL,
    high DECIMAL(18,6) NULL,
    low DECIMAL(18,6) NULL,
    closePrice DECIMAL(18,6) NULL,
    volume DECIMAL(18,6) NULL,
    flagged BIT NOT NULL CONSTRAINT DF_PriceBars_flagged DEFAULT 0, -- 029: structural-invalid bars
    sourceIntervalSec INT NULL,  -- 043: seconds of the series this row was BUILT FROM; NULL = unknown
    CONSTRAINT FK_PriceBars_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE,
    CONSTRAINT UQ_PriceBars UNIQUE (userId, venue, symbol, timeframe, barStart)
);
GO

PRINT 'Creating PaperTrades table (migration 025/030/031)...';
CREATE TABLE PaperTrades (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    venue NVARCHAR(32) NOT NULL DEFAULT 'yahoo',
    direction NVARCHAR(8) NOT NULL,              -- buy | sell
    size DECIMAL(18,6) NOT NULL,                 -- units
    openPrice DECIMAL(18,6) NOT NULL,            -- fill (slippage-adjusted)
    openAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    closePrice DECIMAL(18,6) NULL,
    closeAt DATETIME2 NULL,
    pnl DECIMAL(18,6) NULL,                      -- net of fees
    fees DECIMAL(18,6) NULL,
    status NVARCHAR(16) NOT NULL DEFAULT 'open', -- open | closed
    reason NVARCHAR(255) NULL,
    decisionId INT NULL,
    reasoning NVARCHAR(MAX) NULL,
    strategyId NVARCHAR(32) NULL,                -- 030
    takeProfitPrice DECIMAL(18,6) NULL,          -- 031: 3xATR target
    createdAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    updatedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_PaperTrades_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_PaperTrades_user ON PaperTrades(userId, status);
GO

PRINT 'Creating QuarantinedTicks table (migration 029)...';
CREATE TABLE QuarantinedTicks (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    venue NVARCHAR(32) NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    bid DECIMAL(18,6) NULL,
    ask DECIMAL(18,6) NULL,
    source NVARCHAR(32) NULL,
    reason NVARCHAR(64) NOT NULL,
    detail NVARCHAR(200) NULL,
    capturedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_QuarantinedTicks_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_QuarantinedTicks_created ON QuarantinedTicks(capturedAt DESC);
GO

PRINT 'Creating EquitySnapshots table (migration 030)...';
CREATE TABLE EquitySnapshots (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    mode NVARCHAR(8) NOT NULL,                   -- demo | sim
    equity DECIMAL(18,6) NOT NULL,
    pnl DECIMAL(18,6) NULL,
    source NVARCHAR(32) NULL,                    -- wake | close | manual
    capturedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_EquitySnapshots_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_EquitySnapshots_user ON EquitySnapshots(userId, mode, capturedAt DESC);
GO

PRINT 'Creating EquityTicks table (migration 032)...';
CREATE TABLE EquityTicks (
    id BIGINT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    equity DECIMAL(18,6) NOT NULL,
    pnl DECIMAL(18,6) NULL,
    at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_EquityTicks_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_EquityTicks_user_at ON EquityTicks(userId, at DESC);
GO

PRINT 'Creating BacktestRuns table (migration 024)...';
CREATE TABLE BacktestRuns (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    strategy NVARCHAR(64) NOT NULL,
    symbols NVARCHAR(MAX) NULL,
    periodStart DATETIME2 NULL,
    periodEnd DATETIME2 NULL,
    config NVARCHAR(MAX) NULL,
    metrics NVARCHAR(MAX) NULL,
    worksheetSpot NVARCHAR(MAX) NULL,
    worksheetCfd NVARCHAR(MAX) NULL,
    provenance NVARCHAR(MAX) NULL,
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_BacktestRuns_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_BacktestRuns_user ON BacktestRuns(userId, createdAt DESC);
GO

PRINT 'Creating CorporateEvents table (migration 024)...';
CREATE TABLE CorporateEvents (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    venue NVARCHAR(32) NOT NULL DEFAULT 'plus500',
    eventType NVARCHAR(32) NOT NULL,             -- ex_dividend | earnings | split | halt | other
    eventDate DATE NOT NULL,
    note NVARCHAR(255) NULL,
    source NVARCHAR(32) NOT NULL DEFAULT 'manual', -- plus500_calendar | manual
    createdAt DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_CorporateEvents_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_CorporateEvents_symbol ON CorporateEvents(userId, venue, symbol, eventDate);
GO

PRINT 'Creating Instruments + InstrumentQuotes tables (migration 035 / TRD-45 Phase 1)...';
-- The instrument registry: what the VENUE says an instrument IS. See 035_instrument_registry.sql
-- for why metadata and quotes are separate tables — in short, a quote taken while the venue says
-- "Market is closed" is a placeholder rate (Phase 0 measured Gold spot's spread as 2.89 in exactly
-- that state), and keeping quotes apart is what stops one becoming a cost constant.
CREATE TABLE Instruments (
    id INT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    venue NVARCHAR(32) NOT NULL DEFAULT 'plus500',
    venueInstrumentId NVARCHAR(32) NOT NULL,      -- the venue's data-instrument-id: the JOIN KEY
    symbol NVARCHAR(128) NOT NULL,                -- the desk symbol (what risk/executor resolve by)
    venueName NVARCHAR(200) NOT NULL,
    instrumentClass NVARCHAR(16) NOT NULL DEFAULT 'spot', -- spot | option
    optionType NVARCHAR(8) NULL,
    strikePrice DECIMAL(18,6) NULL,
    expiryAt DATETIME2 NULL,
    unitAmount DECIMAL(18,6) NULL,                -- MINIMUM trade size in unitKind units, NOT a multiplier
    unitKind NVARCHAR(32) NULL,
    pointValue DECIMAL(18,6) NULL,
    pointValueUnit NVARCHAR(16) NULL,
    initialMarginPct DECIMAL(9,4) NULL,
    maintenanceMarginPct DECIMAL(9,4) NULL,
    fundingBuyPct DECIMAL(9,4) NULL,
    fundingSellPct DECIMAL(9,4) NULL,
    fundingTime NVARCHAR(32) NULL,
    nextSessionText NVARCHAR(120) NULL,
    leverageRaw NVARCHAR(16) NULL,                -- '1:5' kept RAW; the margin percent is the usable number
    marketStateAtCapture NVARCHAR(12) NOT NULL DEFAULT 'unknown', -- open | closed | unknown
    capturedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    sourceUrl NVARCHAR(200) NULL,
    CONSTRAINT UQ_Instruments_venue UNIQUE (userId, venue, venueInstrumentId),
    CONSTRAINT FK_Instruments_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_Instruments_lookup ON Instruments(userId, venue, symbol, instrumentClass);
GO

CREATE TABLE InstrumentQuotes (
    id BIGINT PRIMARY KEY IDENTITY(1,1),
    userId INT NOT NULL,
    venue NVARCHAR(32) NOT NULL DEFAULT 'plus500',
    venueInstrumentId NVARCHAR(32) NULL,
    symbol NVARCHAR(128) NOT NULL,
    buy DECIMAL(18,6) NULL,
    sell DECIMAL(18,6) NULL,
    spread DECIMAL(18,6) NULL,                    -- must equal buy - sell (verified 21/21 in Phase 0)
    marketState NVARCHAR(12) NOT NULL DEFAULT 'unknown', -- open | closed | unknown — the USABILITY gate
    capturedAt DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_InstrumentQuotes_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
);
CREATE INDEX IX_InstrumentQuotes_lookup ON InstrumentQuotes(userId, venue, symbol, capturedAt DESC);
GO

-- SEED SAMPLE DATA

PRINT 'Inserting sample user...';
INSERT INTO Users (username, passwordHash) VALUES
('oswald_admin', '$2b$10$aAzmbxTi7wV9AyyhyGC4iOiSZ2Acnv27Nd2Bw69/0TQo7WI8rXlR.'); -- password: admin
GO

-- RBAC seeds (migrations 004 + 005)
PRINT 'Seeding RBAC roles + permissions...';
INSERT INTO Roles (name, description) VALUES
('admin', 'Full access'),
('user', 'Standard read-only user');

INSERT INTO Permissions (code, description) VALUES
('users.manage',       'Manage users, roles and permissions'),
('policies.manage',    'Create, edit, delete policies'),
('tasks.manage',       'Create, edit, delete tasks'),
('resources.manage',   'Upload, edit, delete resources'),
('services.manage',    'Manage services'),
('monitoring.manage',  'Manage monitored hosts'),
('mcp.manage',         'Start/stop the MCP server'),
('files.read',         'Read files from the fileserver'),
('files.write',        'Write files to the fileserver'),
('files.admin',        'Administer the fileserver');

-- admin -> every permission; user -> files.read only (read-only baseline)
INSERT INTO RolePermissions (roleId, permissionId)
SELECT r.id, p.id FROM Roles r CROSS JOIN Permissions p WHERE r.name = 'admin';
INSERT INTO RolePermissions (roleId, permissionId)
SELECT r.id, p.id FROM Roles r JOIN Permissions p ON p.code = 'files.read' WHERE r.name = 'user';

-- oswald_admin -> admin role
INSERT INTO UserRoles (userId, roleId)
SELECT u.id, r.id FROM Users u CROSS JOIN Roles r
WHERE u.username = 'oswald_admin' AND r.name = 'admin';
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
