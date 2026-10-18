-- 028_trading_origin_stops.sql
-- Trades: record WHO opened each row (agent vs venue mirror) so reconcile
-- never rewrites an agent note to "mirrored", plus explicit stop/take-profit
-- levels for the basic buy/sell/stop/continue vocabulary.
IF COL_LENGTH('Trades','origin') IS NULL
  ALTER TABLE Trades ADD origin NVARCHAR(20) NULL;
GO
IF COL_LENGTH('Trades','stopPrice') IS NULL
  ALTER TABLE Trades ADD stopPrice DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('Trades','takeProfitPrice') IS NULL
  ALTER TABLE Trades ADD takeProfitPrice DECIMAL(18,6) NULL;
GO
-- Backfill origin from the note convention used so far.
UPDATE Trades SET origin = 'venue'
  WHERE origin IS NULL AND (note LIKE 'mirrored from Plus500%' OR note LIKE 'venue-only%');
UPDATE Trades SET origin = 'agent'
  WHERE origin IS NULL;
GO
