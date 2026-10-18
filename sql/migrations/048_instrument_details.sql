-- 2026-10-18: InstrumentDetails - the laptop continuity run's instrument-details cycler output.
-- Source: laptop bundle data/plus500-details.jsonl (6,892 records = 689 cycles x 10 instruments,
-- 2026-10-11T03:35Z .. 2026-10-14T15:49Z). Append-only RESEARCH data: 5m/1h/1d change, per-timeframe
-- Low/High (kept as JSON), unit amount, leverage, dynamic spread, point value, initial/maintenance
-- margin, expiry, overnight funding. No runtime consumer writes here yet - the desk's own capture
-- does not populate it; this is for spread/margin/funding history analysis.
-- Applied by: sqlcmd -S <server> -E -d DB_Oswald -b -i sql\migrations\048_instrument_details.sql
IF OBJECT_ID('dbo.InstrumentDetails', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.InstrumentDetails (
    id                INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_InstrumentDetails PRIMARY KEY,
    capturedAt        DATETIME2      NOT NULL,
    instrumentId      NVARCHAR(32)   NULL,
    name              NVARCHAR(128)  NULL,
    rowName           NVARCHAR(128)  NULL,
    symbol            NVARCHAR(64)   NULL,
    currentSellRate   DECIMAL(18,6)  NULL,
    changeM5          DECIMAL(18,6)  NULL,
    changeH1          DECIMAL(18,6)  NULL,
    changeD1          DECIMAL(18,6)  NULL,
    rangesJson        NVARCHAR(MAX)  NULL,
    unitAmount        NVARCHAR(64)   NULL,
    unitAmountUnit    NVARCHAR(64)   NULL,
    leverage          NVARCHAR(32)   NULL,
    dynamicSpread     DECIMAL(18,6)  NULL,
    pointValue        NVARCHAR(64)   NULL,
    marginInitial     NVARCHAR(32)   NULL,
    marginMaintenance NVARCHAR(32)   NULL,
    expiry            NVARCHAR(64)   NULL,
    fundingBuy        NVARCHAR(32)   NULL,
    fundingSell       NVARCHAR(32)   NULL,
    fundingTime       NVARCHAR(32)   NULL,
    importedAt        DATETIME2      NOT NULL CONSTRAINT DF_InstrumentDetails_importedAt DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_InstrumentDetails_At ON dbo.InstrumentDetails (capturedAt);
  CREATE INDEX IX_InstrumentDetails_Symbol_At ON dbo.InstrumentDetails (symbol, capturedAt);
END
GO
