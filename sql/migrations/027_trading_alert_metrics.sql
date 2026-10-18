-- 027_trading_alert_metrics.sql — alert metric types (price / changePct / buyersPct).
IF COL_LENGTH('dbo.TradingAlerts', 'metric') IS NULL
  ALTER TABLE dbo.TradingAlerts ADD metric NVARCHAR(16) NOT NULL CONSTRAINT DF_TradingAlerts_metric DEFAULT 'price';
GO
