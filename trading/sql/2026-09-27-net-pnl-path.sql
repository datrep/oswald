-- TRD-PNL-1 (2026-09-27): the NET P/L PATH, in currency, as a range that cannot be lost.
--
-- THE DEFECT: `Trades.floatingPnl` IS the venue's NetPL (dynamic spread and overnight funding are already
-- inside it), and it was being READ every ~2.4s and then OVERWRITTEN by the next sample. accountPoller.js says
-- so in its own header: "so every earlier sample of a trade's path was overwritten and discarded".
--
-- WHY THE EXISTING RANGE DOES NOT COVER IT: `mfePct`/`maePct` DO hold a min and a max, but they are
--   * percentages of the ENTRY PRICE, not currency;
--   * GROSS — no fees, no funding, no swap;
--   * on a SAMPLED tick path; and
--   * `maePct` is CIRCULAR on a loss-exit row, because the close is appended to the path and then dominates
--     the minimum (measured 2026-09-22: 23 of the 39 rows carrying `maePct` had it exactly equal to the close
--     excursion, to 4dp).
-- So a NET, currency, min/max/terminal range did not exist anywhere. This adds it.
--
-- ⚠ WHY min/max ARE NOT IN THE APP-SIDE `updatable` LIST: a caller that could SET a maximum could also LOWER
-- it, and a maximum that can go down is not a maximum. They are widened only, in SQL, by `store.updateTrade`.
-- `netPnlSamples` is the count of observations, so a range over ONE sample is distinguishable from a range
-- over five hundred — a range whose coverage is unknown is the defect class this desk keeps closing.
--
-- Run with:  sqlcmd -S localhost -d DB_Oswald -E -i <this file> -y 0 -s "|"

SET NOCOUNT ON;
GO

IF COL_LENGTH('dbo.Trades', 'netPnlMin') IS NULL
  ALTER TABLE dbo.Trades ADD netPnlMin DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('dbo.Trades', 'netPnlMax') IS NULL
  ALTER TABLE dbo.Trades ADD netPnlMax DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('dbo.Trades', 'netPnlSamples') IS NULL
  ALTER TABLE dbo.Trades ADD netPnlSamples INT NULL;
GO
IF COL_LENGTH('dbo.Trades', 'netPnlTerminal') IS NULL
  ALTER TABLE dbo.Trades ADD netPnlTerminal DECIMAL(18,6) NULL;
GO

-- Replace the property so this file is idempotent.
IF EXISTS (SELECT 1 FROM sys.extended_properties
           WHERE major_id = OBJECT_ID('dbo.Trades') AND name = 'NetPnlPath')
BEGIN
  EXEC sp_dropextendedproperty
    @name = N'NetPnlPath',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE',  @level1name = N'Trades',
    @level2type = N'COLUMN', @level2name = N'netPnlMin';
END
GO

EXEC sp_addextendedproperty
  @name = N'NetPnlPath',
  @value = N'THE VENUE NET P/L AS A RANGE, IN CURRENCY. netPnlMin/netPnlMax are widened by store.updateTrade every time floatingPnl is written (the venue NetPL, ~2.4s cadence); they can only ever WIDEN, never narrow, and they are deliberately NOT settable by callers. netPnlSamples counts the observations, so min==max over 1 sample is distinguishable from min==max over 500. netPnlTerminal is the value at the close. WHY THIS EXISTS ALONGSIDE mfePct/maePct: those are percentages of the ENTRY PRICE, are GROSS (no fees/funding/swap), sit on a SAMPLED tick path, and maePct is CIRCULAR on a loss-exit row because the close is appended to the path and dominates the minimum (measured: 23 of 39 rows had maePct equal to the close excursion to 4dp). BEFORE THIS, every earlier sample of a trade path was OVERWRITTEN AND DISCARDED - accountPoller.js said so in its own header.',
  @level0type = N'SCHEMA', @level0name = N'dbo',
  @level1type = N'TABLE',  @level1name = N'Trades',
  @level2type = N'COLUMN', @level2name = N'netPnlMin';
GO

SELECT c.name, t.name AS typ, c.max_length
FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('dbo.Trades') AND c.name IN ('netPnlMin','netPnlMax','netPnlSamples','netPnlTerminal')
ORDER BY c.name;
GO
