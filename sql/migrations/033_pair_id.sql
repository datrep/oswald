-- 033_pair_id.sql
-- TRD-24: pairId tags both legs of one pair trade (ratio/hedge pairs). NULL
-- for ordinary single-instrument trades. Used by the correlation-veto
-- exemption (TRD-17/24) and the pair lifecycle sweep (agent/pairs.js).
IF COL_LENGTH('Trades','pairId') IS NULL
  ALTER TABLE Trades ADD pairId NVARCHAR(64) NULL;
GO
IF COL_LENGTH('PaperTrades','pairId') IS NULL
  ALTER TABLE PaperTrades ADD pairId NVARCHAR(64) NULL;
GO
