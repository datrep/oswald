-- 041_trade_close_fill.sql
-- TRD-108 (2026-09-21): the CLOSE FILL as its own column, because `closePrice` on a venue-closed row is the
-- venue's stated RATE — the level it closed at, not the price the trade got.
--
-- WHY. Measured 2026-09-20. `closePrice` equals the declared level to within 0.01 on most venue-closed rows
-- (#1064 4395.92 vs stop 4395.9244; #1036 102.48 vs stop 102.4798; #1043 4276.30 vs take-profit 4276.3087),
-- while the MONEY says the fill went past it: impliedFill = openPrice + dir * grossPnl / size is 0.002 past
-- the take-profit on #1047 but 0.235 / 0.568 / 5.46 / 7.76 past the stop on #1036 / #1063 / #1064 / #1052.
-- In R the losses land at 1.22-1.38 — a stop-out that lost 22-38% more than its own stop. That asymmetry is
-- market-order slippage on a stop (a take-profit is a limit order and fills AT its level, which is why the
-- one checkable win reconciles exactly), and it was invisible because the number the desk stored was a LEVEL.
--
-- CONSEQUENCE THIS REMOVES: realised move %, realised R and `slippagePct` were all being computed from a
-- level on those rows — `slippagePct` most absurdly of all, since comparing the exit to the market is its
-- entire purpose. Metrics derived from `grossPnl` were never affected (`expectancy.rMultiple` uses
-- openPrice/stopPrice/pnl), which is why TRD-38's counterfactual does not inherit the error.
--
-- THE TWO FACTS, AND THE INVARIANT THEY CARRY:
--   closeFillPrice    THE FILL the trade got, or NULL when it cannot be derived. On a venue close it is
--                     derived from the venue's own P&L (agent/closeFill.js); the executor writes the price
--                     it actually filled at. NULL means "unknown", never "same as closePrice".
--   closePriceSource  WHICH fact `closePrice` above is: 'venue_rate' (the level the venue states) or
--                     'fill' (the desk closed it and its own price IS the fill). Written EVERY TIME
--                     closePrice is — the same discipline migration 036 imposed on the funding pair, and for
--                     the same reason: a price with no provenance is the ambiguous number these columns exist
--                     to eliminate.
--
-- NO BACKFILL HERE. The 21 existing venue closes are derived ONCE, explicitly, by
-- temp/backfill-close-fill.js, so a schema change never silently rewrites history.
--
-- SAFE TO APPLY LIVE: two NULLable additive columns, no default, no data movement inside the migration.

IF COL_LENGTH('dbo.Trades', 'closeFillPrice') IS NULL
  ALTER TABLE dbo.Trades ADD closeFillPrice DECIMAL(18,6) NULL;
GO

IF COL_LENGTH('dbo.Trades', 'closePriceSource') IS NULL
  ALTER TABLE dbo.Trades ADD closePriceSource NVARCHAR(24) NULL;
GO
