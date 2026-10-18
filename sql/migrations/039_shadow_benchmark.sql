-- 039_shadow_benchmark.sql
-- TRD-SHW-2 (2026-09-14): the per-row BENCHMARK column.
--
-- WHY A COLUMN AND NOT A REPORT CALCULATION. The plan names three baselines:
--   A — confirmation (did a deterministic strategy later enter this direction)  = confirmedByStrategy (038)
--   B — the naive benchmark at the SAME timestamps                             = THIS column
--   C — the same rule at RANDOMISED timestamps                                 = sample-level, computed at report time
--
-- C is deliberately NOT a column: it is a property of the whole sample (a Monte
-- Carlo over the window), not of one row. Putting it in the table would imply a
-- per-row fact that does not exist. B is per-row, so it belongs here.
--
-- WHAT B IS, EXACTLY — and the correction this encodes. The plan's rev-3 wording
-- said B was "long for long calls, short for short calls", which is not a baseline
-- at all: mirroring the call's own direction makes B identical to the treatment's
-- payoff. The thing B has to answer is "did the asset simply drift in the calls'
-- favour over these windows?", so B is the UNMIRRORED long return of the same
-- window, matching the backtester's long-only benchmark semantics.
-- A short call whose window rose is therefore B-positive and treatment-negative,
-- which is exactly the information the gate needs.

IF COL_LENGTH('ShadowSignals', 'benchmarkLongR') IS NULL
  ALTER TABLE ShadowSignals ADD benchmarkLongR DECIMAL(12,6) NULL;
GO

SELECT
  CASE WHEN COL_LENGTH('ShadowSignals', 'benchmarkLongR') IS NULL THEN 'MISSING' ELSE 'present' END AS benchmarkColumn,
  CASE WHEN COL_LENGTH('ShadowSignals', 'realisedR') IS NULL THEN 'MISSING' ELSE 'present' END AS realisedColumn;
GO
