-- 029_quarantine_flags_orderstates.sql
-- TRD-12 Phase 1: data-quality foundation + light order state machine.
-- 1. QuarantinedTicks: every rejected tick with its reason (audit trail).
-- 2. PriceBars.flagged: structurally-invalid bars are marked, skipped by
--    quant/backtest, removable via /api/trading/bars/rebuild.
-- 3. Trades: light order lifecycle — when it actually filled, why it was
--    rejected, how long the fill took.
IF OBJECT_ID('QuarantinedTicks') IS NULL
BEGIN
  CREATE TABLE QuarantinedTicks (
    id INT IDENTITY(1,1) PRIMARY KEY,
    userId INT NOT NULL,
    venue NVARCHAR(32) NOT NULL,
    symbol NVARCHAR(64) NOT NULL,
    bid DECIMAL(18,6) NULL,
    ask DECIMAL(18,6) NULL,
    source NVARCHAR(32) NULL,
    reason NVARCHAR(64) NOT NULL,
    detail NVARCHAR(200) NULL,
    capturedAt DATETIME2 NOT NULL CONSTRAINT DF_QuarantinedTicks_captured DEFAULT GETUTCDATE(),
    CONSTRAINT FK_QuarantinedTicks_User FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
  );
  CREATE INDEX IX_QuarantinedTicks_created ON QuarantinedTicks (capturedAt DESC);
END
GO
IF COL_LENGTH('PriceBars','flagged') IS NULL
  ALTER TABLE PriceBars ADD flagged BIT NOT NULL CONSTRAINT DF_PriceBars_flagged DEFAULT 0;
GO
IF COL_LENGTH('Trades','filledAt') IS NULL
  ALTER TABLE Trades ADD filledAt DATETIME2 NULL;
GO
IF COL_LENGTH('Trades','rejectReason') IS NULL
  ALTER TABLE Trades ADD rejectReason NVARCHAR(120) NULL;
GO
IF COL_LENGTH('Trades','fillDelayMs') IS NULL
  ALTER TABLE Trades ADD fillDelayMs INT NULL;
GO
