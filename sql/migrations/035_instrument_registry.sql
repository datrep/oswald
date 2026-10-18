-- 035_instrument_registry.sql
-- TRD-45 Phase 1 (2026-09-14): the instrument registry — what the VENUE says an instrument IS.
--
-- WHY THIS EXISTS. `risk.js` sizes with `size = equity x riskPct / stopDist` and has NO FLOOR. It
-- assumes the smallest tradeable unit is zero and that one unit is worth one of something. Phase 0
-- measured the real universe on a single chain (Gold weekly options, 2026-09-13): the Gold spot CFD
-- trades from 0.025 Troy Ounces, while the twenty options wrapped around the SAME underlying have
-- minimums from 1.5 to 15 "Options" — a 10x spread inside one underlier, and every one of those
-- minimums is a floor the desk currently cannot express. A size the venue will reject, or worse a
-- size it will silently round, is a risk number the desk believes and the venue never agreed to.
--
-- TWO TABLES, ON PURPOSE.
--
--   Instruments      = CONTRACT METADATA. Stable for the life of the contract: unit amount, unit
--                      kind, leverage, margins, point value, strike, expiry, funding. Read once
--                      from the sidebar (`#load-sidebar` / [data-testid="Sidebar.Content"], Info
--                      tab — verified in Phase 0, no navigation required), re-read rarely.
--
--   InstrumentQuotes = QUOTES, in their own table because they are a DIFFERENT KIND OF FACT.
--                      buy/sell/spread move every second, and — the part that matters — they are
--                      MEANINGLESS while the market is shut. Phase 0 measured Gold spot's spread as
--                      2.89 with the venue simultaneously displaying "Market is closed"; adopting
--                      that as a cost constant would be a fabricated input. Keeping quotes apart
--                      means a quote can never be silently promoted into metadata: the resolver
--                      hands over only the newest quote whose `marketState = 'open'`, and a
--                      closed-market capture is stored for provenance and never consumed.
--
-- WHY `marketStateAtCapture` IS ON BOTH. On a quote it decides usability. On an instrument it is
-- provenance: knowing whether the spec was read during a live session or from a stale, closed
-- view is the difference between "re-read it" and "trust it".
--
-- WHAT IS DELIBERATELY NOT HERE.
--   * `leverage` is stored RAW ('1:5') plus the derived margin percentages. Parsing the ratio into
--     a bare number invites using it as a multiplier, which is the single most expensive way to
--     misread this table; the margin percent is the usable quantity and it is already there.
--   * No `current-rate`, no `change.item-*`, no Buy/Sell button state. Those are live quotes or UI
--     affordances, they were excluded by name in the Phase 1 inventory, and a registry that stores
--     them becomes a second, worse price feed.
--   * No 94-testid dump. The durable read is the label/value list
--     (`plus500-list-data-item` with slot="definition-item"/"value-item"), which is semantic and
--     ORDER-INDEPENDENT, plus the positional 3-column stat box for unit amount / leverage /
--     dynamic spread. Storing testids would rot on the venue's next deploy.

IF OBJECT_ID('dbo.Instruments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Instruments (
    id                   INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId               INT           NOT NULL,
    venue                NVARCHAR(32)  NOT NULL CONSTRAINT DF_Instruments_venue DEFAULT 'plus500',
    -- The venue's own `data-instrument-id` (e.g. 1116957 for `Gold | Put 4225 | Sep W3`). This is
    -- the JOIN KEY: names are display text and change with the expiry label, ids do not.
    venueInstrumentId    NVARCHAR(32)  NOT NULL,
    -- The desk's symbol (what risk/executor resolve by, e.g. 'Gold').
    symbol               NVARCHAR(128) NOT NULL,
    -- Full venue display name, e.g. 'Gold | Put 4225 | Sep W3'.
    venueName            NVARCHAR(200) NOT NULL,
    -- 'spot' | 'option'. The class dimension, mirroring plus500/matching.js. Resolving a symbol
    -- WITHOUT pinning the class is how a spot read lands on an option ticket (TRD-36).
    instrumentClass      NVARCHAR(16)  NOT NULL CONSTRAINT DF_Instruments_class DEFAULT 'spot',
    optionType           NVARCHAR(8)   NULL,     -- Call | Put
    strikePrice          DECIMAL(18,6) NULL,
    expiryAt             DATETIME2     NULL,     -- an option expires without the desk; a spot does not
    -- MINIMUM trade size, in `unitKind` units. NOT a contract multiplier (Phase 0 was explicit).
    unitAmount           DECIMAL(18,6) NULL,
    unitKind             NVARCHAR(32)  NULL,     -- Troy Ounces | Options | Contracts | Shares | Pounds
    pointValue           DECIMAL(18,6) NULL,
    pointValueUnit       NVARCHAR(16)  NULL,     -- 'USD' on every instrument measured
    initialMarginPct     DECIMAL(9,4)  NULL,     -- must equal 100 / leverage  (checked at write)
    maintenanceMarginPct DECIMAL(9,4)  NULL,
    fundingBuyPct        DECIMAL(9,4)  NULL,
    fundingSellPct       DECIMAL(9,4)  NULL,
    fundingTime          NVARCHAR(32)  NULL,
    nextSessionText      NVARCHAR(120) NULL,     -- the venue's own session text, for calendar cross-checks
    leverageRaw          NVARCHAR(16)  NULL,     -- '1:5', kept RAW — see the header note
    marketStateAtCapture NVARCHAR(12)  NOT NULL CONSTRAINT DF_Instruments_mkt DEFAULT 'unknown',
    capturedAt           DATETIME2     NOT NULL CONSTRAINT DF_Instruments_captured DEFAULT GETUTCDATE(),
    sourceUrl            NVARCHAR(200) NULL,     -- the venue's own underlying reference, when offered
    CONSTRAINT FK_Instruments_Users FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE,
    CONSTRAINT UQ_Instruments_venue UNIQUE (userId, venue, venueInstrumentId)
  );
  CREATE INDEX IX_Instruments_lookup ON dbo.Instruments (userId, venue, symbol, instrumentClass);
END
GO

IF OBJECT_ID('dbo.InstrumentQuotes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.InstrumentQuotes (
    id                BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    userId            INT           NOT NULL,
    venue             NVARCHAR(32)  NOT NULL CONSTRAINT DF_IQ_venue DEFAULT 'plus500',
    venueInstrumentId NVARCHAR(32)  NOT NULL,
    symbol            NVARCHAR(128) NOT NULL,
    buy               DECIMAL(18,6) NULL,
    sell              DECIMAL(18,6) NULL,
    -- Must equal buy - sell; Phase 0 verified that holds 21/21 on a full chain. Checked at write
    -- time, not assumed, so a misparsed cell is stored as a violation rather than a cost.
    spread            DECIMAL(18,6) NULL,
    -- open | closed | unknown. THIS is the column that stops a closed-market spread becoming a
    -- constant: usableness is a property of WHEN the quote was taken, not of the number.
    marketState       NVARCHAR(12)  NOT NULL CONSTRAINT DF_IQ_mkt DEFAULT 'unknown',
    capturedAt        DATETIME2     NOT NULL CONSTRAINT DF_IQ_captured DEFAULT GETUTCDATE(),
    CONSTRAINT FK_InstrumentQuotes_Users FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
  );
  CREATE INDEX IX_InstrumentQuotes_lookup ON dbo.InstrumentQuotes (userId, venue, symbol, capturedAt DESC);
END
GO
