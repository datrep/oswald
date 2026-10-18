-- trading/sql/2026-09-27-feature-epochs.sql
--
-- THE RAW-SQL HALF OF THE EPOCH MECHANISM (TRD-DAT-1).
--
-- Why it exists: `trading/agent/epoch.js` can annotate a caller, and an endpoint can announce a window, but an agent
-- doing `SELECT AVG(...) FROM Trades` sees NEITHER. The failure this whole mechanism is aimed at happened exactly
-- that way — a mean computed across two policy regimes, reported without a window. So the boundary is made
-- JOINABLE, and the annotated views are the read path that carries the label on every row.
--
-- ⚠ RUN AS THE OWNER (`sqlcmd -E`), because the app's SQL login has no DDL rights.
-- ⚠ IDEMPOTENT: safe to re-run. The table is created only if absent, and the views are dropped and recreated so a
--   column added to a source table is picked up by the next run.

IF OBJECT_ID('dbo.FeatureEpochs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.FeatureEpochs (
    id            NVARCHAR(64)    NOT NULL CONSTRAINT PK_FeatureEpochs PRIMARY KEY,
    landedAt      DATETIME2(0)    NOT NULL,
    -- ⚠ MATERIALISED so a range join is a plain inequality. A correlated subquery per row over 278k PriceBars rows
    -- is the kind of thing that turns an annotation into a performance defect, and this table exists to be joined.
    nextLandedAt  DATETIME2(0)    NOT NULL,
    rowId         INT             NULL,          -- the Tasks row that records the change, so the claim is checkable
    title         NVARCHAR(400)   NOT NULL,
    invalidates   NVARCHAR(1200)  NOT NULL,      -- what a number computed from EARLIER rows cannot mean
    syncedAt      DATETIME2(0)    NOT NULL CONSTRAINT DF_FeatureEpochs_syncedAt DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_FeatureEpochs_range ON dbo.FeatureEpochs (landedAt, nextLandedAt);
END
GO

-- ---- annotated views: the read path that carries the label on EVERY row ------------------------------
-- ⚠ THESE ARE ADDITIVE. Nothing is renamed and no existing query changes behaviour; a reader opts IN by naming the
-- view. `SELECT t.*` is expanded at creation, so re-running this file after a source-table change refreshes them.

IF OBJECT_ID('dbo.vTradingEventsWithEpoch', 'V') IS NOT NULL DROP VIEW dbo.vTradingEventsWithEpoch;
GO
CREATE VIEW dbo.vTradingEventsWithEpoch AS
SELECT t.*, e.id AS epochId, e.landedAt AS epochLandedAt,
       CASE WHEN e.id IS NULL THEN 1 ELSE 0 END AS epochUnrecorded
FROM dbo.TradingEvents t
LEFT JOIN dbo.FeatureEpochs e ON t.createdAt >= e.landedAt AND t.createdAt < e.nextLandedAt;
GO

IF OBJECT_ID('dbo.vTradesWithEpoch', 'V') IS NOT NULL DROP VIEW dbo.vTradesWithEpoch;
GO
CREATE VIEW dbo.vTradesWithEpoch AS
SELECT t.*, e.id AS epochId, e.landedAt AS epochLandedAt,
       CASE WHEN e.id IS NULL THEN 1 ELSE 0 END AS epochUnrecorded
FROM dbo.Trades t
LEFT JOIN dbo.FeatureEpochs e ON t.openAt >= e.landedAt AND t.openAt < e.nextLandedAt;
GO

IF OBJECT_ID('dbo.vTradingPromptsWithEpoch', 'V') IS NOT NULL DROP VIEW dbo.vTradingPromptsWithEpoch;
GO
CREATE VIEW dbo.vTradingPromptsWithEpoch AS
SELECT t.*, e.id AS epochId, e.landedAt AS epochLandedAt,
       CASE WHEN e.id IS NULL THEN 1 ELSE 0 END AS epochUnrecorded
FROM dbo.TradingPrompts t
LEFT JOIN dbo.FeatureEpochs e ON t.createdAt >= e.landedAt AND t.createdAt < e.nextLandedAt;
GO

IF OBJECT_ID('dbo.vPriceBarsWithEpoch', 'V') IS NOT NULL DROP VIEW dbo.vPriceBarsWithEpoch;
GO
CREATE VIEW dbo.vPriceBarsWithEpoch AS
SELECT t.*, e.id AS epochId, e.landedAt AS epochLandedAt,
       CASE WHEN e.id IS NULL THEN 1 ELSE 0 END AS epochUnrecorded
FROM dbo.PriceBars t
LEFT JOIN dbo.FeatureEpochs e ON t.barStart >= e.landedAt AND t.barStart < e.nextLandedAt;
GO

-- ---- the "comments" half, for a human in SSMS ------------------------------------------------------
-- An extended property shows in the object explorer beside the table. It is not visible to a SELECT, which is why
-- the views above exist — this is the note for the person, not the mechanism for the query.
IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id = OBJECT_ID('dbo.TradingEvents') AND name = 'EpochNotice')
  EXEC sp_dropextendedproperty 'EpochNotice', 'SCHEMA', 'dbo', 'TABLE', 'TradingEvents';
EXEC sp_addextendedproperty
  @name = 'EpochNotice', @level0type = 'SCHEMA', @level0name = 'dbo', @level1type = 'TABLE', @level1name = 'TradingEvents',
  @value = 'Rows before 2026-09-21 were REMOVED (archived in trading/archive/pruned/). Within a range that spans the policy epoch, most stats on this table are invalidated by DUPLICATE wake events: one wake could write TWO rows until 2026-09-27. Read via vTradingEventsWithEpoch, which carries epochId per row, and cluster by the second before counting.';
GO

IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id = OBJECT_ID('dbo.Trades') AND name = 'EpochNotice')
  EXEC sp_dropextendedproperty 'EpochNotice', 'SCHEMA', 'dbo', 'TABLE', 'Trades';
EXEC sp_addextendedproperty
  @name = 'EpochNotice', @level0type = 'SCHEMA', @level0name = 'dbo', @level1type = 'TABLE', @level1name = 'Trades',
  @value = 'The venue stop has been CAPPED since 2026-09-19 and sizes are computed against the CAPPED distance, so reward:risk and per-trade risk before and after that date are different quantities. Read via vTradesWithEpoch and report the window.';
GO

IF EXISTS (SELECT 1 FROM sys.extended_properties WHERE major_id = OBJECT_ID('dbo.PriceBars') AND name = 'EpochNotice')
  EXEC sp_dropextendedproperty 'EpochNotice', 'SCHEMA', 'dbo', 'TABLE', 'PriceBars';
EXEC sp_addextendedproperty
  @name = 'EpochNotice', @level0type = 'SCHEMA', @level0name = 'dbo', @level1type = 'TABLE', @level1name = 'PriceBars',
  @value = 'Do NOT prune this table: strategies compute Donchian(20) and ATR(14) over 1h bars and need the warm-up. The timeframe and sourceIntervalSec labels are unreliable before 2026-09-25, when nothing pinned the chart interval — a 15m tab wrote 15m rows while the only structure venue read 1h.';
GO

-- ---- verification, printed so the run is self-checking -------------------------------------------------
SELECT 'FeatureEpochs rows' AS what, COUNT(*) AS n, CAST(NULL AS DATETIME2(0)) AS earliest FROM dbo.FeatureEpochs
UNION ALL SELECT 'earliest landedAt', NULL, MIN(landedAt) FROM dbo.FeatureEpochs
UNION ALL SELECT 'latest landedAt', NULL, MAX(landedAt) FROM dbo.FeatureEpochs;
GO

SELECT TOP 6 id, landedAt, nextLandedAt, rowId, LEFT(title, 58) AS title FROM dbo.FeatureEpochs ORDER BY landedAt;
GO
