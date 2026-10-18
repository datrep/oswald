-- 031_sim_takeprofit.sql
-- TRD-12 Phase 3: take-profit levels for the sim desk (PaperTrades).
IF COL_LENGTH('PaperTrades','takeProfitPrice') IS NULL
  ALTER TABLE PaperTrades ADD takeProfitPrice DECIMAL(18,6) NULL;
GO
