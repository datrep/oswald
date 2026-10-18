-- 037_auto_close_off.sql
-- TRD-54 (2026-09-14): DB_Oswald is created with AUTO_CLOSE ON, so every time the
-- desk's last connection closes the entire database shuts down, and the next
-- connection pays for a full start-up - file opens, recovery, parallel redo, cold
-- caches. The desk restarts often, so this happens often.
--
-- WHY THIS MATTERS RATHER THAN BEING HOUSEKEEPING.
--
--   1. The first queries after a restart compete with database recovery. That is
--      exactly when an operator is watching to see whether the restart worked, so
--      it is exactly when a timeout is most misleading. The error log shows 13
--      DB_Oswald start-ups in the 25 hours to 2026-09-14 14:05, clustered on
--      service restarts: 09-13 12:12:57 and 12:15:00 (engine start), 16:41:52,
--      16:42:12, 16:42:41, 16:55:03, 17:04:14, 17:21:14, 19:30:01, 19:30:03,
--      19:30:54, 09-14 01:16:58, 03:22:50, 03:25:05, 03:31:10, 13:44:52.
--   2. It makes a restart-induced hiccup indistinguishable from a real start-up
--      fault. That is not hypothetical: this migration was written while
--      investigating TRD-51, where a cold start had to be explicitly RULED OUT as
--      the cause of a 4-hour wake outage (the window 09:13-13:05 had no DB_Oswald
--      start-up at all, because the desk held a connection open throughout). Every
--      future restart investigation would have to re-do that exclusion.
--   3. AUTO_CLOSE is a SQL Server Express default intended for databases that are
--      genuinely idle - a shared Express instance hosting many small databases.
--      This instance hosts one database that a long-running service holds open on
--      purpose. Reclaiming its memory between restarts buys nothing here and costs
--      a full recovery on the next start.
--
-- VERIFIED AT THE TIME OF WRITING: is_auto_close_on = 1 for DB_Oswald, and 1 also
-- for BED_database. BED_database is NOT referenced anywhere in this repository
-- (schema, migrations, service config, or .env all name DB_Oswald), so it belongs
-- to something else on this machine and is deliberately NOT touched here - altering
-- another application's memory behaviour is not this migration's call. If it is
-- ever confirmed to be held open by a long-running service of ours, the same one
-- statement applies to it.
-- is_auto_shrink_on was already 0 for both, so nothing is changed for AUTO_SHRINK;
-- the assertion below keeps it that way rather than leaving it to luck.

IF EXISTS (
  SELECT 1 FROM sys.databases
  WHERE name = N'DB_Oswald' AND is_auto_close_on = 1
)
BEGIN
  ALTER DATABASE [DB_Oswald] SET AUTO_CLOSE OFF;
END
GO

-- AUTO_SHRINK is the other Express default that causes background churn: it shrinks
-- the data file on a schedule and the file then has to grow again. It is already off
-- on this instance; asserting it here means a fresh install cannot drift into it.
IF EXISTS (
  SELECT 1 FROM sys.databases
  WHERE name = N'DB_Oswald' AND is_auto_shrink_on = 1
)
BEGIN
  ALTER DATABASE [DB_Oswald] SET AUTO_SHRINK OFF;
END
GO

-- Report the result into the setup log. Expect: autoClose=0 autoShrink=0 recovery=SIMPLE.
SELECT
  name,
  is_auto_close_on  AS autoClose,
  is_auto_shrink_on AS autoShrink,
  recovery_model_desc AS recovery
FROM sys.databases
WHERE name = N'DB_Oswald';
GO
