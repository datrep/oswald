-- 025_trading_paper.sql — TRD-11: paper-trading ledger (central AI broker).
-- Idempotent (IF OBJECT_ID guard). UTC timestamps (GETUTCDATE) per migration 009.

IF OBJECT_ID('dbo.PaperTrades', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PaperTrades (
    id          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId      INT NOT NULL CONSTRAINT FK_PaperTrades_Users FOREIGN KEY REFERENCES dbo.Users(id) ON DELETE CASCADE,
    symbol      NVARCHAR(64) NOT NULL,
    venue       NVARCHAR(32) NOT NULL CONSTRAINT DF_PaperTrades_venue DEFAULT 'yahoo',
    direction   NVARCHAR(8) NOT NULL,          -- buy | sell
    size        DECIMAL(18,6) NOT NULL,        -- units
    openPrice   DECIMAL(18,6) NOT NULL,        -- fill (slippage-adjusted)
    openAt      DATETIME2 NOT NULL CONSTRAINT DF_PaperTrades_openAt DEFAULT GETUTCDATE(),
    closePrice  DECIMAL(18,6) NULL,
    closeAt     DATETIME2 NULL,
    pnl         DECIMAL(18,6) NULL,            -- net of fees
    fees        DECIMAL(18,6) NULL,
    status      NVARCHAR(16) NOT NULL CONSTRAINT DF_PaperTrades_status DEFAULT 'open', -- open | closed
    reason      NVARCHAR(255) NULL,            -- central AI's stated reason
    decisionId  INT NULL,                      -- TradingPrompts.id of the central verdict
    reasoning   NVARCHAR(MAX) NULL,            -- central AI reasoning excerpt (thinking)
    createdAt   DATETIME2 NOT NULL CONSTRAINT DF_PaperTrades_createdAt DEFAULT GETUTCDATE(),
    updatedAt   DATETIME2 NOT NULL CONSTRAINT DF_PaperTrades_updatedAt DEFAULT GETUTCDATE()
  );
  CREATE INDEX IX_PaperTrades_user ON dbo.PaperTrades(userId, status);
END
GO
