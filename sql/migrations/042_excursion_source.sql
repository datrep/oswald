-- 042_excursion_source.sql
-- TRD-117 (2026-09-22): WHICH observation produced each excursion extreme — because on a loss-exit row
-- `maePct` is not an excursion at all, it is the close restated.
--
-- WHY. `autopsy.computeMetrics` builds its path as `[...mids, closePrice]`. The close is appended on purpose:
-- ticks land on the wake cadence, so without it a trade could report MFE 1.866% while its close had achieved
-- 2.145% (id 29, 2026-09-11), which drove "capture efficiency" above 100% and read as nonsense. The
-- consequence was not noticed. On a row that exits AT ITS WORST POINT — which is exactly what a stop-out is —
-- the appended close dominates `min(path)`, so `maePct` becomes the close excursion BY CONSTRUCTION. It
-- restates WHERE THE TRADE ENDED instead of measuring HOW FAR PRICE RAN AGAINST IT.
--
-- MEASURED 2026-09-22, and the split is not random. 23 of the 39 rows carrying `maePct` had it EXACTLY equal
-- to the close excursion to 4 decimal places, and that set was every row whose close was adverse:
--   #1070  maePct -0.2657   close -0.2657   IDENTICAL
--   #1066  maePct -0.8019   close -0.8019   IDENTICAL
--   #1069  maePct -0.0680   close +0.6691   differs   (a WINNER — the adverse extreme came from a mid)
--
-- CONSEQUENCE THIS EXPOSES. Three readers consume the number, and it is degenerate for all of them on
-- stop-out rows:
--   analytics.netEdge    `netEdgePct = avgMfePct - avgAbsMaePct - costPct` (TRD-105's screen, TRD-106's
--                        blindness). The screen subtracts an accounting identity and calls it an edge.
--   hitStop              `ex.maePct <= -riskPct` in scripts/repro/byp1-veto-value.js and chair-override-value.js.
--                        On a stop-out row this is TAUTOLOGOUS: it asks whether the exit was at least as bad
--                        as the stop, having DEFINED the exit as the mae.
--   stop discipline      Any reading of "the stop held exactly" from `|maePct| ~ stopDistPct`. I made this
--                        error myself on 2026-09-22 and read an overshoot column of ~0.000 as evidence that
--                        the venue honours its resting stops. It was the metric talking to itself.
--
-- THE TWO FACTS, AND THE INVARIANT THEY CARRY:
--   mfeSource   WHICH observation produced the FAVOURABLE extreme: 'mid' or 'close'.
--   maeSource   WHICH observation produced the ADVERSE extreme: 'mid' or 'close'.
--               Written EVERY TIME mfePct/maePct is — the same discipline migration 036 imposed on the
--               funding pair and 041 on the close-fill pair, and for the same reason: a NUMBER WITH NO
--               PROVENANCE is exactly the ambiguous quantity these columns exist to eliminate. An anchored
--               extreme is not wrong (the close IS a real observed price of the thing we held); it is just
--               not an EXCURSION, and the difference must be visible rather than inferred.
--
-- RECORDED, NOT RECOMPUTED. No existing value changes and no downstream number moves — this migration adds
-- provenance only, deliberately, because `analytics.netEdge` feeds a live gate and changing what it computes
-- is a separate decision with its own evidence requirement.
--
-- BACKFILL IS EXPLICIT, NOT IN HERE. Existing rows are filled by `autopsy.backfill({ force: true })`, run
-- deliberately, so a schema change never silently rewrites history (the precedent 041 set for the close fill).
--
-- SAFE TO APPLY LIVE: two NULLable additive columns, no default, no data movement inside the migration.

IF COL_LENGTH('dbo.Trades', 'mfeSource') IS NULL
  ALTER TABLE dbo.Trades ADD mfeSource NVARCHAR(8) NULL;
GO

IF COL_LENGTH('dbo.Trades', 'maeSource') IS NULL
  ALTER TABLE dbo.Trades ADD maeSource NVARCHAR(8) NULL;
GO
