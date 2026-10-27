-- 051: ECONOMIC CALENDAR LEDGER (Plus500 / Dow Jones feed). Write-only, NO consumer.
--
-- WHY A NEW TABLE AND NOT `CorporateEvents`. That table already has a live consumer with a precise meaning —
-- `sessions.js` turns a `macro` row into `scheduledEvents` context, and a `halt` row into `state:'closed'`. It
-- stores ONE date column (`eventDate DATE`) and one note string. The Dow Jones feed is a different shape: a
-- time-of-day, an impact grade, three value fields and a related-instrument list. Widening the table the session
-- guard reads, in order to store something the session guard must not read, is how one table starts meaning two
-- things. This is a separate ledger, and it stays consumer-free until a pre-registered study says otherwise.
--
-- ★ THE SCHEMA IS COPIED FROM THE LIVE PAGE, NOT INVENTED. Read out of the authenticated frame on 2026-10-26
-- (https://www.plus500.com/en-sg/economiccalendar?isInAppView=True): the columns are, in order,
--   Time | Expected Impact | Event | Actual | Forecast | Previous | Related Instruments
-- grouped under relative day headers (Yesterday / Today / Tomorrow / This Week), with two tabs
-- (Data Releases, Corporate Events) and "Data by DOW JONES" as the source.
--
-- ⚠ THREE THINGS THE PAGE DOES THAT THE SCHEMA HAS TO ABSORB, each measured rather than assumed:
--   1. `Expected Impact` IS NOT TEXT. The dots live in the DOM; `innerText` shows only non-breaking spaces where
--      they are. So `impact` is captured from markup and `impactRaw` keeps whatever the markup actually said.
--   2. `Time` IS BROWSER-LOCAL WITH NO MARKER. 17:00 on that page is 09:00Z. `tzOffsetMin` is stored beside the
--      displayed value so `eventAt` can be re-derived; storing only one of them makes the other unrecoverable.
--   3. `Time` HAS NO DATE AND THE DAY HEADERS ARE RELATIVE. "Today" is only resolvable at capture time, so
--      `eventAt` is resolved then and `dayLabel` keeps the raw string. An unresolvable relative header stores a
--      NULL `eventAt` with a parse status rather than a guessed one — the same rule `NewsItems.publishedAt`
--      already follows.
--
-- LOOKAHEAD RULE (stated here and in the epoch entry): any study may only use events whose `capturedAt` is
-- strictly BEFORE the trade or observation it judges. These rows are records of what was knowable, and a feed
-- re-read tomorrow must not appear to have been known yesterday.
--
-- APPEND-ONLY BY CONVENTION: corrections are NEW rows, never edits. `rowHash` makes a re-capture idempotent.
--
-- ⚠ THE DATABASE GUARD BELOW WAS ADDED 2026-10-26, AFTER THIS FILE WAS RUN MANUALLY AND CREATED NOTHING.
-- "51 executed" was reported, and `DB_Oswald` still had no `CalendarEvents` table: a plain DDL batch runs against
-- whatever database the session is pointed at, so an SSMS window defaulting to `master` (or the login's default
-- database) creates the table THERE and reports success. That is the same class this repo's own runner warns
-- about in `trading/scripts/apply-migration.js` — "applied, but not where you looked" — so the file now REFUSES
-- rather than guessing. `apply-migration.js` connects to the configured database and is unaffected.
IF DB_NAME() <> 'DB_Oswald'
  THROW 51051, '051_calendar_events must be applied to DB_Oswald. This session is on a different database — switch it (SSMS: the database dropdown) and re-run.', 1;

IF OBJECT_ID('dbo.CalendarEvents','U') IS NULL
BEGIN
  CREATE TABLE dbo.CalendarEvents (
    id               INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_CalendarEvents PRIMARY KEY,
    userId           INT NOT NULL,
    -- when the event happens, in UTC, resolved at capture time from (local time + offset)
    eventAt          DATETIME2 NULL,           -- NULL when the day header could not be resolved
    -- what the page actually displayed, kept so eventAt is reproducible rather than authoritative
    dayLabel         NVARCHAR(40) NULL,        -- 'Today' | 'Tomorrow' | 'Yesterday' | '2026-10-30'
    timeLabel        NVARCHAR(12) NULL,        -- '17:00' exactly as shown
    tzOffsetMin      INT NULL,                 -- browser offset at capture; 480 for UTC+8
    -- the Dow Jones columns
    impact           TINYINT NULL,             -- 1..3 dots; NULL when the markup carried no grade
    impactRaw        NVARCHAR(60) NULL,        -- whatever the markup said, for audit
    event            NVARCHAR(200) NOT NULL,
    actual           NVARCHAR(40) NULL,        -- strings on purpose: '15.4%', '90.1', '-', '1.2M'
    forecast         NVARCHAR(40) NULL,
    previous         NVARCHAR(40) NULL,
    relatedInstruments NVARCHAR(400) NULL,     -- as listed, comma-joined
    tab              NVARCHAR(24) NOT NULL,    -- 'data_releases' | 'corporate_events'
    source           NVARCHAR(32) NOT NULL,    -- 'plus500_dowjones'
    rawText          NVARCHAR(800) NULL,       -- the row's own text, so a bad parse is diagnosable later
    parseStatus      NVARCHAR(32) NOT NULL,    -- 'ok' | 'no_event_at' | 'partial' | 'parse_failed'
    rowHash          CHAR(64) NOT NULL,        -- sha256(userId|eventAt|timeLabel|event|tab); the dedupe key
    capturedAt       DATETIME2 NOT NULL CONSTRAINT DF_CalendarEvents_capturedAt DEFAULT SYSUTCDATETIME()
  );
END
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_CalendarEvents_user_hash' AND object_id=OBJECT_ID('dbo.CalendarEvents'))
  CREATE UNIQUE INDEX UX_CalendarEvents_user_hash ON dbo.CalendarEvents(userId, rowHash);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_CalendarEvents_user_eventAt' AND object_id=OBJECT_ID('dbo.CalendarEvents'))
  CREATE INDEX IX_CalendarEvents_user_eventAt ON dbo.CalendarEvents(userId, eventAt);
