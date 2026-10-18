-- 024_trading_agent.sql — Oswald Trading Agent foundation tables.
-- PascalCase, owner-scoped (userId), UTC timestamps (GETUTCDATE) per migration 009 lesson.
-- Idempotent (IF OBJECT_ID guards) so it can be re-run safely.

/* ------------------------------------------------------------------------- */
/* TradingSettings — per-user trading agent configuration (JSON blob).        */
/* Kill switch tiers, disaster floor, caps, watchlist mapping, selector map.  */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.TradingSettings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.TradingSettings (
    id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId    INT NOT NULL CONSTRAINT FK_TradingSettings_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    settings  NVARCHAR(MAX) NOT NULL CONSTRAINT DF_TradingSettings_settings DEFAULT '{}',
    updatedAt DATETIME2 NOT NULL CONSTRAINT DF_TradingSettings_updatedAt DEFAULT GETUTCDATE(),
    CONSTRAINT UQ_TradingSettings_user UNIQUE (userId)
  );
END
GO

/* ------------------------------------------------------------------------- */
/* TradingAlerts — telemetry triggers (price crosses threshold, P&L stop).    */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.TradingAlerts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.TradingAlerts (
    id               INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId           INT NOT NULL CONSTRAINT FK_TradingAlerts_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    symbol           NVARCHAR(64) NOT NULL,
    venue            NVARCHAR(32) NOT NULL CONSTRAINT DF_TradingAlerts_venue DEFAULT 'plus500',
    direction        NVARCHAR(16) NOT NULL,          -- above | below | crosses
    threshold        DECIMAL(18,6) NOT NULL,
    enabled          BIT NOT NULL CONSTRAINT DF_TradingAlerts_enabled DEFAULT 1,
    cooldownMinutes  INT NOT NULL CONSTRAINT DF_TradingAlerts_cooldown DEFAULT 60,
    lastTriggeredAt  DATETIME2 NULL,
    note             NVARCHAR(255) NULL,
    createdAt        DATETIME2 NOT NULL CONSTRAINT DF_TradingAlerts_createdAt DEFAULT GETUTCDATE(),
    updatedAt        DATETIME2 NOT NULL CONSTRAINT DF_TradingAlerts_updatedAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_TradingAlerts_user ON dbo.TradingAlerts(userId, enabled);
END
GO

/* ------------------------------------------------------------------------- */
/* TradingEvents — telemetry / notes / memory / system events.                */
/* kind examples: telemetry, note, memory, wake, decision, trade, error,      */
/*                phantom_fill, system, alert                                 */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.TradingEvents', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.TradingEvents (
    id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId    INT NOT NULL CONSTRAINT FK_TradingEvents_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    kind      NVARCHAR(32) NOT NULL,
    payload   NVARCHAR(MAX) NULL,                    -- JSON
    createdAt DATETIME2 NOT NULL CONSTRAINT DF_TradingEvents_createdAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_TradingEvents_user ON dbo.TradingEvents(userId, createdAt DESC);
END
GO

/* ------------------------------------------------------------------------- */
/* TradingPrompts — wake cycle record: bundle sent to the chair, raw          */
/* response, parsed decision JSON, model + usage + latency.                   */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.TradingPrompts', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.TradingPrompts (
    id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId    INT NOT NULL CONSTRAINT FK_TradingPrompts_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    triggerType NVARCHAR(32) NOT NULL,               -- schedule | alert | pnl | manual
    bundle    NVARCHAR(MAX) NULL,                    -- JSON prompt bundle (with data timestamp)
    response  NVARCHAR(MAX) NULL,                    -- raw LLM response text
    decision  NVARCHAR(MAX) NULL,                    -- parsed JSON {vote, confidence, reason}
    model     NVARCHAR(64) NULL,
    usage     NVARCHAR(MAX) NULL,                    -- JSON token usage
    latencyMs INT NULL,
    createdAt DATETIME2 NOT NULL CONSTRAINT DF_TradingPrompts_createdAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_TradingPrompts_user ON dbo.TradingPrompts(userId, createdAt DESC);
END
GO

/* ------------------------------------------------------------------------- */
/* PromptErrors — malformed LLM responses (fail-secure debugging).            */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.PromptErrors', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PromptErrors (
    id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId    INT NOT NULL CONSTRAINT FK_PromptErrors_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    promptId  INT NULL,
    raw       NVARCHAR(MAX) NULL,
    error     NVARCHAR(255) NULL,
    createdAt DATETIME2 NOT NULL CONSTRAINT DF_PromptErrors_createdAt DEFAULT GETUTCDATE()
  );
END
GO

/* ------------------------------------------------------------------------- */
/* Trades — executions on the venue (Plus500 demo). Status enum:              */
/* open | closed | cancelled | rejected | phantom                             */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Trades', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Trades (
    id                 INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId             INT NOT NULL CONSTRAINT FK_Trades_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    venue              NVARCHAR(32) NOT NULL CONSTRAINT DF_Trades_venue DEFAULT 'plus500',
    symbol             NVARCHAR(64) NOT NULL,
    direction          NVARCHAR(8) NOT NULL,         -- buy | sell
    size               DECIMAL(18,6) NOT NULL,
    units              NVARCHAR(32) NULL,            -- e.g. '300 Options', '0.425 Troy Ounces'
    openPrice          DECIMAL(18,6) NULL,
    openAt             DATETIME2 NULL,
    closePrice         DECIMAL(18,6) NULL,
    closeAt            DATETIME2 NULL,
    grossPnl           DECIMAL(18,4) NULL,
    fees               DECIMAL(18,4) NULL,
    status             NVARCHAR(16) NOT NULL CONSTRAINT DF_Trades_status DEFAULT 'open',
    plus500PositionId  NVARCHAR(64) NULL,
    decisionId         INT NULL,                     -- TradingPrompts.id that caused it
    note               NVARCHAR(255) NULL,
    createdAt          DATETIME2 NOT NULL CONSTRAINT DF_Trades_createdAt DEFAULT GETUTCDATE(),
    updatedAt          DATETIME2 NOT NULL CONSTRAINT DF_Trades_updatedAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_Trades_user_status ON dbo.Trades(userId, status);
END
GO

/* ------------------------------------------------------------------------- */
/* PriceTicks — captured raw bid/ask snapshots. Retention 7 days (A12).       */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.PriceTicks', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PriceTicks (
    id         INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId     INT NOT NULL CONSTRAINT FK_PriceTicks_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    venue      NVARCHAR(32) NOT NULL,
    symbol     NVARCHAR(64) NOT NULL,
    bid        DECIMAL(18,6) NULL,
    ask        DECIMAL(18,6) NULL,
    source     NVARCHAR(32) NOT NULL CONSTRAINT DF_PriceTicks_source DEFAULT 'frontend',
    capturedAt DATETIME2 NOT NULL CONSTRAINT DF_PriceTicks_capturedAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_PriceTicks_captured ON dbo.PriceTicks(capturedAt DESC);
  CREATE INDEX IX_PriceTicks_symbol ON dbo.PriceTicks(venue, symbol, capturedAt DESC);
END
GO

/* ------------------------------------------------------------------------- */
/* PriceBars — aggregated hourly/daily bars, retained indefinitely (A12).     */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.PriceBars', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PriceBars (
    id       INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId   INT NOT NULL CONSTRAINT FK_PriceBars_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    venue    NVARCHAR(32) NOT NULL,
    symbol   NVARCHAR(64) NOT NULL,
    timeframe NVARCHAR(8) NOT NULL,                  -- 1h | 1d
    barStart DATETIME2 NOT NULL,
    openPrice DECIMAL(18,6) NULL,
    high      DECIMAL(18,6) NULL,
    low       DECIMAL(18,6) NULL,
    closePrice DECIMAL(18,6) NULL,
    volume   DECIMAL(18,6) NULL,
    CONSTRAINT UQ_PriceBars UNIQUE (userId, venue, symbol, timeframe, barStart)
  );
END
GO

/* ------------------------------------------------------------------------- */
/* BacktestRuns — one row per backtest, dual worksheets + metrics JSON.       */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.BacktestRuns', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.BacktestRuns (
    id            INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId        INT NOT NULL CONSTRAINT FK_BacktestRuns_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    strategy      NVARCHAR(64) NOT NULL,
    symbols       NVARCHAR(MAX) NULL,
    periodStart   DATETIME2 NULL,
    periodEnd     DATETIME2 NULL,
    config        NVARCHAR(MAX) NULL,                -- JSON (slippage, swap params etc.)
    metrics       NVARCHAR(MAX) NULL,                -- JSON (sharpe, maxDD, winRate, PF)
    worksheetSpot NVARCHAR(MAX) NULL,                -- JSON/CSV spot-baseline
    worksheetCfd  NVARCHAR(MAX) NULL,                -- JSON/CSV CFD-estimated
    provenance    NVARCHAR(MAX) NULL,                -- JSON (source URL, snapshot hash, timestamp)
    createdAt     DATETIME2 NOT NULL CONSTRAINT DF_BacktestRuns_createdAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_BacktestRuns_user ON dbo.BacktestRuns(userId, createdAt DESC);
END
GO

/* ------------------------------------------------------------------------- */
/* CorporateEvents — ex-dividend dates + other corporate actions (A10).       */
/* source: plus500_calendar | manual. Signal calc uses adjusted price,        */
/* P&L uses actual fill.                                                      */
/* ------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.CorporateEvents', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.CorporateEvents (
    id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId    INT NOT NULL CONSTRAINT FK_CorporateEvents_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    symbol    NVARCHAR(64) NOT NULL,
    venue     NVARCHAR(32) NOT NULL CONSTRAINT DF_CorporateEvents_venue DEFAULT 'plus500',
    eventType NVARCHAR(32) NOT NULL,                 -- ex_dividend | earnings | split | halt | other
    eventDate DATE NOT NULL,
    note      NVARCHAR(255) NULL,
    source    NVARCHAR(32) NOT NULL CONSTRAINT DF_CorporateEvents_source DEFAULT 'manual',
    createdAt DATETIME2 NOT NULL CONSTRAINT DF_CorporateEvents_createdAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_CorporateEvents_symbol ON dbo.CorporateEvents(userId, venue, symbol, eventDate);
END
GO
