-- 026_trading_mirror.sql — live mirror columns on Trades (current rate + floating P/L).
IF COL_LENGTH('dbo.Trades', 'currentRate') IS NULL
  ALTER TABLE dbo.Trades ADD currentRate DECIMAL(18,6) NULL;
IF COL_LENGTH('dbo.Trades', 'floatingPnl') IS NULL
  ALTER TABLE dbo.Trades ADD floatingPnl DECIMAL(18,6) NULL;
GO
