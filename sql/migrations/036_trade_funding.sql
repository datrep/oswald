-- 036_trade_funding.sql
-- TRD-45 Phase 3 (2026-09-14): REALISED overnight funding, as a column.
--
-- WHY. `venueClose.applyClose` writes `grossPnl: row.netPnl` — the venue's NetPL, which the venue has
-- already reduced by its "Actual adjustments" (funding). So the desk's own P&L column is NET of carry
-- on every venue-closed row, and the funding itself was recorded NOWHERE: it lived briefly in a
-- `trade_closed` event payload and in the venue's UI. Three consequences, in increasing order of cost:
--
--   1. An R-multiple is computed from `grossPnl`, so it is net-of-carry — which is arguably the right
--      number — but the size of the carry is unrecorded, so "why is this R small" is unanswerable.
--   2. The venue's STATED funding rates (captured into the instrument registry by Phase 1) could not
--      be checked against anything it actually charged. The sign convention was settled from eleven
--      observations and the magnitude from ONE, which is not a validation.
--   3. `grossPnl` is not gross. A field whose label disagrees with its content is exactly the class of
--      defect this desk already has a contracts module for, and the funding column is the first step
--      in making its label true again.
--
-- TWO SOURCES, AND THEY MUST NOT BE CONFUSED. `fundingSource` carries which one it is:
--   venue_actual            read from the venue's own closed-position adjustments — ground truth.
--   estimated_from_registry the desk closed the position, so there is no venue adjustment to read; the
--                           cost is COMPUTED from nights held x the venue's stated per-side rate. An
--                           estimate is useful and must never be mistaken for a measurement.
--   not_available           neither was obtainable. Stated explicitly rather than left null, because
--                           "no funding" and "funding unknown" are different facts and carry very
--                           different weights when they feed a cost model.
--
-- `swapNights` is stored rather than derived later because the derivation depends on a convention
-- (UTC day boundaries crossed) that has already been redefined once in this repo (TRD-25); recording
-- the count at close time keeps the historical rows interpretable under the convention in force when
-- they were written.

IF COL_LENGTH('Trades', 'fundingCost') IS NULL
  ALTER TABLE Trades ADD fundingCost DECIMAL(18,6) NULL;
GO
IF COL_LENGTH('Trades', 'fundingSource') IS NULL
  ALTER TABLE Trades ADD fundingSource NVARCHAR(24) NULL;
GO
IF COL_LENGTH('Trades', 'fundingRatePct') IS NULL
  ALTER TABLE Trades ADD fundingRatePct DECIMAL(9,4) NULL;
GO
IF COL_LENGTH('Trades', 'swapNights') IS NULL
  ALTER TABLE Trades ADD swapNights INT NULL;
GO
