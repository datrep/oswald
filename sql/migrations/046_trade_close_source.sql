-- 046_trade_close_source.sql
-- 4.22 (2026-10-03): the CLOSE's PROVENANCE as its own column — WHICH caller closed the trade.
--
-- WHY (the cost this removes). Finding C1 took a TWO-DAY investigation to attribute 7 closes, because every
-- executor close wrote the same row (`note:'executor close'`, `closePriceSource:'fill'`, `closeAtSource:
-- 'desk_observed'`) and the `trade_closed` event named no caller. The three traps were structural:
--   * lane     — wake exit-deliberation closes and position-review closes were indistinguishable in the row;
--   * post-hoc — review's record is written AFTER the close returns, so "a review exists near this close"
--                was a timing inference, not a join;
--   * probes   — session-probe closes carry no marker at all.
-- One stamped column turns the next such hunt into a single GROUP BY.
--
-- VALUES (clamped at the source; a client-supplied string is NEVER trusted — this column is written only
-- by executor.closeTrade's `source` option, and `api` is passed server-side by the route, not from the body):
--   wake:<promptId>   an exit-deliberation close during a wake
--   review            the position-review loop's near-stop cut
--   api               POST /orders/close (dashboard button, venue-price-check, repro tooling)
--   sweep:kill        the hard-tier auto-close sweep (closeAll)
--   pairs:<pairId>    leg unwind (leg-B failure) / unhedged-survivor auto-unwind
--
-- ⚠ FAIL-OPEN BY DESIGN, AND NO BACKFILL. The option is optional: an absent source never blocks a close
-- (provenance is telemetry; closing must stay cheap). Old rows stay NULL = UNKNOWN — the historic set was
-- already attributed by hand in the C1 investigation, so a labelling script is optional, not owed; and a
-- migration must never silently reinterpret history (the 044 discipline).
--
-- `note: 'executor close'` STAYS BYTE-IDENTICAL — `stopCoverage.js` exact-matches it and
-- `apply-044-close-at-source.js` startsWith-matches it. Provenance lives in this column and the events.
--
-- SAFE TO APPLY LIVE: one NULLable additive column, no default, no data movement inside the migration.

IF COL_LENGTH('dbo.Trades', 'closeSource') IS NULL
  ALTER TABLE dbo.Trades ADD closeSource NVARCHAR(32) NULL;
GO
