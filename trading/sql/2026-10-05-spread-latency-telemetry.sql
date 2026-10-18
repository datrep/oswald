-- 2026-10-05 — SPREAD + LATENCY TELEMETRY (owner-approved "additive telemetry", corroboration follow-up).
--
-- WHY, exactly: the three external reports (and our own corroboration, docs/trading-reports-corroboration-2026-10-05.md)
-- all lean on two quantities the desk measures EVERY trade and then throws away or never records:
--
--   1. THE SPREAD. `Trades.slippagePct` is fill vs the desk's own DECISION price — a different fact. Nothing
--      records the venue's round-trip bid/ask spread, neither at the SIGNAL (what the desk could see when it
--      decided) nor at SUBMIT (what the venue was actually quoting when the order went in). Cost-hostility
--      per symbol (report ask #16) currently has to be reconstructed from SPREAD_PCT constants and prose.
--      Measured 2026-10-05 per symbol: spread/stop runs 0.10 (Oil) to 0.29 (SGX/ETH) — from constants, not rows.
--
--   2. THE LATENCY SPLIT. `fillDelayMs` is the placeOrder call only. The audit's "31.1 s avg, 132 s max"
--      was derived by joining event logs; `anchorAgeSec` (TRD-ANC-1) exists but only inside `fill_telemetry`
--      EVENTS. Neither `signalToFillSec` (decision price as-of → fill) nor `anchorAgeSec` was ever ON the row,
--      so every future latency analysis repeats the join and can get it wrong.
--
-- ⚠ ADDITIVE AND NON-BLOCKING, BY CONSTRUCTION: every column NULLable, no backfill (old rows stay NULL =
-- unknown, never invented), no default, no index. Writes are best-effort fields on existing INSERTs. NOTHING
-- here is a decision input — the freeze (#1506) is untouched; this only makes future measurements possible.
--
-- ⚠ SIGN + UNIT CONVENTIONS (pinned here because two previous analyses inverted signs):
--   * spreadSignalPct / spreadSubmitPct: ROUND-TRIP percent of mid, POSITIVE, zero when not derivable is
--     impossible (NULL instead) — (ask − bid) / mid × 100. bid = the price you SELL at; ask = the price you BUY at.
--   * signalToFillSec / signalTickAgeSec / anchorAgeSec: SECONDS. Non-negative; NULL when underivable.
--
-- Run with:  node trading/scripts/apply-migration.js trading/sql/2026-10-05-spread-latency-telemetry.sql

SET NOCOUNT ON;
GO

IF COL_LENGTH('dbo.Trades', 'spreadSignalPct') IS NULL
  ALTER TABLE dbo.Trades ADD spreadSignalPct DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('dbo.Trades', 'signalTickAgeSec') IS NULL
  ALTER TABLE dbo.Trades ADD signalTickAgeSec INT NULL;
GO
IF COL_LENGTH('dbo.Trades', 'spreadSubmitPct') IS NULL
  ALTER TABLE dbo.Trades ADD spreadSubmitPct DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('dbo.Trades', 'spreadSubmitSource') IS NULL
  ALTER TABLE dbo.Trades ADD spreadSubmitSource NVARCHAR(32) NULL;
GO
IF COL_LENGTH('dbo.Trades', 'signalToFillSec') IS NULL
  ALTER TABLE dbo.Trades ADD signalToFillSec INT NULL;
GO
IF COL_LENGTH('dbo.Trades', 'anchorAgeSec') IS NULL
  ALTER TABLE dbo.Trades ADD anchorAgeSec DECIMAL(18,3) NULL;
GO

-- Replace the property so this file is idempotent.
IF EXISTS (SELECT 1 FROM sys.extended_properties
           WHERE major_id = OBJECT_ID('dbo.Trades') AND name = 'SpreadLatencyTelemetry')
BEGIN
  EXEC sp_dropextendedproperty
    @name = N'SpreadLatencyTelemetry',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE',  @level1name = N'Trades',
    @level2type = N'COLUMN', @level2name = N'spreadSignalPct';
END
GO

EXEC sp_addextendedproperty
  @name = N'SpreadLatencyTelemetry',
  @value = N'SPREAD + LATENCY, per entry, additive (2026-10-05). spreadSignalPct: round-trip percent of mid, (ask-bid)/mid*100, from the desk tick nearest the decision (PriceTicks.bid/ask). signalTickAgeSec: age of that tick at submit — a spread from a stale tick is a different fact; NULL when the tick could not be read. spreadSubmitPct: round-trip percent of mid from the VENUE ticket''s own Buy/Sell labels read inside placeOrder (no navigation — the card is already open); spreadSubmitSource names the read (''ticket'') or is NULL when underivable. signalToFillSec: decisionPriceAsOf to filledAt, seconds — the audit latency (2026-10-05: avg 31.1s, max 132s) made a row fact. anchorAgeSec: TRD-ANC-1 anchor age at submit, previously event-only. ALL nullable, no backfill, no decision input — measurement only.',
  @level0type = N'SCHEMA', @level0name = N'dbo',
  @level1type = N'TABLE',  @level1name = N'Trades',
  @level2type = N'COLUMN', @level2name = N'spreadSignalPct';
GO

SELECT name, system_type_id FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Trades') AND name IN
  ('spreadSignalPct','signalTickAgeSec','spreadSubmitPct','spreadSubmitSource','signalToFillSec','anchorAgeSec');
GO
