-- 030_autopsy_equity.sql
-- TRD-12 Phase 2: the learning loop.
-- 1. Trades: post-trade autopsy metrics (MFE/MAE vs entry, holding time,
--    slippage, which strategy opened it).
-- 2. PaperTrades: strategy attribution for the sim desk.
-- 3. EquitySnapshots: the equity curve (demo + sim) for the curve card and
--    the trailing high-water baseline.
IF COL_LENGTH('Trades','mfePct') IS NULL
  ALTER TABLE Trades ADD mfePct DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('Trades','maePct') IS NULL
  ALTER TABLE Trades ADD maePct DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('Trades','holdingMinutes') IS NULL
  ALTER TABLE Trades ADD holdingMinutes INT NULL;
GO
IF COL_LENGTH('Trades','slippagePct') IS NULL
  ALTER TABLE Trades ADD slippagePct DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('Trades','strategyId') IS NULL
  ALTER TABLE Trades ADD strategyId NVARCHAR(32) NULL;
GO
IF COL_LENGTH('PaperTrades','strategyId') IS NULL
  ALTER TABLE PaperTrades ADD strategyId NVARCHAR(32) NULL;
GO
IF OBJECT_ID('EquitySnapshots') IS NULL
BEGIN
  CREATE TABLE EquitySnapshots (
    id INT IDENTITY(1,1) PRIMARY KEY,
    userId INT NOT NULL,
    mode NVARCHAR(8) NOT NULL,           -- 'demo' | 'sim'
    equity DECIMAL(18,6) NOT NULL,
    pnl DECIMAL(18,6) NULL,
    source NVARCHAR(32) NULL,            -- 'wake' | 'close' | 'manual'
    capturedAt DATETIME2 NOT NULL CONSTRAINT DF_EquitySnapshots_captured DEFAULT GETUTCDATE(),
    CONSTRAINT FK_EquitySnapshots_User FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
  );
  CREATE INDEX IX_EquitySnapshots_user ON EquitySnapshots (userId, mode, capturedAt DESC);
END
GO
