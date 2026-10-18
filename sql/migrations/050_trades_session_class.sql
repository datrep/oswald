-- 050_trades_session_class.sql — 2026-10-18 (feature `weekend-session-class`).
--
-- Owner rule: weekend crypto is a SEPARATE SAMPLE CLASS inside the SAME era (no re-anchor). This column is
-- the separator: every trade carries the session class of its ENTRY, so any study can split cohorts with
-- one GROUP BY instead of re-deriving a calendar that might drift.
--
--   'weekend' = entry inside the venue weekend window (Fri 21:00 -> Sun 21:00 UTC, observation included)
--   'weekday' = entry outside it
--   NULL      = pre-change row that the backfill below could not classify (should be none)
--
-- Additive and NULLABLE: no consumer is required, and a missing value never means "weekday" — the reader
-- must decide what NULL means for its own question (see the rule in trading/lib/sessionClass.js).
IF COL_LENGTH('Trades', 'sessionClass') IS NULL
BEGIN
  ALTER TABLE Trades ADD sessionClass NVARCHAR(24) NULL;
END
GO

-- Backfill: the calendar is deterministic, so each existing row gets the class its openAt implies.
-- DATEFIRST-independent: (DATEDIFF(DAY,'19000101', x) % 7) has 0 = Monday because 1900-01-01 was a Monday.
-- Fri = 4, Sat = 5, Sun = 6.
UPDATE Trades
SET sessionClass = CASE
    WHEN (DATEDIFF(DAY, '19000101', openAt) % 7) = 4
         AND (DATEPART(HOUR, openAt) * 60 + DATEPART(MINUTE, openAt)) >= 1260 THEN 'weekend'
    WHEN (DATEDIFF(DAY, '19000101', openAt) % 7) = 5 THEN 'weekend'
    WHEN (DATEDIFF(DAY, '19000101', openAt) % 7) = 6
         AND (DATEPART(HOUR, openAt) * 60 + DATEPART(MINUTE, openAt)) < 1260 THEN 'weekend'
    ELSE 'weekday'
END
WHERE sessionClass IS NULL;
GO
