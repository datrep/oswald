-- 040_fomc_macro_events.sql
-- 2026-09-15: an FOMC meeting day is a SCHEDULED EVENT, not a venue closure.
--
-- THE INCIDENT THIS CORRECTS. On 2026-09-15 the desk recorded `skipped: market_closed`
-- on 19 consecutive wakes, from 12:24Z to at least 13:52Z, while the market was open
-- and while it was happily running LLM position reviews on an open Gold position. The
-- recorded detail was the literal string "all venues closed".
--
-- 1. Two rows in CorporateEvents said `eventType='halt'`, `symbol='*'` (every instrument),
--    note "FOMC meeting day (federalreserve.gov)" — written by agent/calendar.js.
-- 2. `agent/sessions.sessionState` treats ANY `halt` row as `state:'closed'`, and a `'*'`
--    row matches all twelve watchlist symbols, so the wake's session guard saw every venue
--    closed and skipped the whole wake.
-- 3. It had been latent since the import: the venue's own live feed takes precedence, so
--    while the Plus500 long-poll was streaming, `isTraded:true` short-circuited the check
--    and the rows were never consulted. The moment the feed went stale — Chrome
--    disconnected at 12:15Z, entries expire after STALE_MS = 10 min — the fallback reached
--    the halt rows and shut all twelve symbols at once. First skipped wake: 12:24:42Z.
--
-- WHY THE EVENT TYPE CHANGES RATHER THAN THE ROW BEING DELETED. The importer's own comment
-- states its intent: "global halt for NEW entries; existing positions keep their stop logic".
-- That intent is legitimate and is now implemented — `macro` rows produce `state:'no_entry'`,
-- which runs the entire wake and blocks only new entries. `halt` keeps its older, narrower
-- meaning: the venue is shut. One column value, one meaning.
--
-- SCOPE: `source = 'federalreserve'` only. A genuinely symbol-specific or venue-wide halt —
-- an exchange outage, a holiday, a manually-entered suspension — is a real closure and must
-- keep behaving as one. This migration deliberately cannot touch those.
--
-- IDEMPOTENT: re-running matches nothing once the rows are `macro`.

SET NOCOUNT ON;

IF OBJECT_ID('dbo.CorporateEvents', 'U') IS NULL
BEGIN
  PRINT '040: CorporateEvents absent — nothing to reclassify.';
END
ELSE
BEGIN
  DECLARE @n INT = (
    SELECT COUNT(*) FROM dbo.CorporateEvents
    WHERE source = 'federalreserve' AND eventType = 'halt'
  );

  UPDATE dbo.CorporateEvents
     SET eventType = 'macro'
   WHERE source = 'federalreserve' AND eventType = 'halt';

  PRINT '040: reclassified ' + CAST(@n AS VARCHAR(10)) + ' federalreserve row(s) from halt to macro.';
  PRINT '040: remaining venue-closing halt rows (all must be genuine closures):';

  SELECT id, symbol, venue, eventType, eventDate, source, note
  FROM dbo.CorporateEvents
  WHERE eventType = 'halt'
  ORDER BY eventDate;
END
