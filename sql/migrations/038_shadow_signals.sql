-- 038_shadow_signals.sql
-- TRD-SHW-1 (2026-09-14): the SHADOW SIGNALS ledger.
--
-- WHAT THIS IS. A record of what the AI says about a symbol when it is shown
-- market structure and NOT the desk own signal. Nothing here places an order,
-- sizes a position, or is read by any trading path. It exists because the desk
-- cannot validate an LLM that originates entries: every other piece of evidence it
-- owns (the 324-config hunt, the Lab, TRD-26 fresh-data gate, walk-forward,
-- EVIDENCE_THRESHOLDS, the parity harness) scores DETERMINISTIC RULES AGAINST
-- STORED BARS. A replay at the measured cadence is 729 days x 103 wakes/day x 3
-- chairs x 12 symbols, about 2.7M paid calls, and the model training data
-- contaminates any historical replay regardless. So the only honest day-one
-- version is a recorder that scores FORWARD.
--
-- FORWARD-ONLY IS ENFORCED BY deployedAt. It is not decoration: it is the marker
-- that makes the claim checkable, because a row created before deployment cannot
-- be evidence about a question asked after it.
--
-- rawResponse IS NOT OPTIONAL (review item). direction/confidence/basis are PARSED
-- fields, so a change to the extraction rules would make every stored row
-- un-reparseable and destroy the sample. TradingPrompts.response exists for exactly
-- this reason; this table carries its own copy rather than joining.

IF OBJECT_ID('ShadowSignals', 'U') IS NULL
BEGIN
  CREATE TABLE ShadowSignals (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    userId        INT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
    createdAt     DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    deployedAt    DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
    promptVersion NVARCHAR(32)  NOT NULL,      -- 'q1-v1' — frozen; see shadow.js
    horizonBars   INT NOT NULL,                -- fixed before collection

    symbol        NVARCHAR(64)  NOT NULL,
    venue         NVARCHAR(32)  NOT NULL,

    -- the parsed answer. evidence is the model claim-o-meter: 0 = no evidence.
    evidence      BIT NULL,                    -- did it claim a move was starting
    direction     NVARCHAR(8) NULL,            -- buy | sell | NULL (no evidence)
    confidence    DECIMAL(5,4) NULL,
    basis         NVARCHAR(400) NULL,
    rawResponse   NVARCHAR(MAX) NULL,          -- VERBATIM reply

    -- market state at the call, so the row is self-contained for later analysis
    priceAtCall   DECIMAL(18,6) NULL,
    atr14         DECIMAL(18,6) NULL,
    adx14         DECIMAL(18,6) NULL,
    regime        NVARCHAR(16) NULL,
    sessionState  NVARCHAR(24) NULL,
    scheduledEvent NVARCHAR(64) NULL,          -- FOMC/halt on the call day (see §3.8)

    inputTokens   INT NULL,                    -- cost accounting
    outputTokens  INT NULL,

    -- outcome, filled FORWARD by the deterministic scorer (TRD-SHW-2). Null until
    -- the horizon has actually elapsed; never fabricated by the recorder.
    barsToHorizon INT NULL,
    horizonAt     DATETIME2 NULL,
    closeAt       DATETIME2 NULL,
    mfePct        DECIMAL(12,6) NULL,
    maePct        DECIMAL(12,6) NULL,
    realisedR     DECIMAL(12,6) NULL,
    confirmedByStrategy BIT NULL,              -- did a real entry later fire this way
    scoredAt      DATETIME2 NULL
  );

  CREATE INDEX IX_ShadowSignals_userCreated ON ShadowSignals (userId, createdAt DESC);
  -- The scorer walks rows whose horizon has elapsed but which have no score yet.
  CREATE INDEX IX_ShadowSignals_pending ON ShadowSignals (userId, scoredAt, horizonAt);
END
GO

-- Confirm into the setup log. Expect one row, 0 or 1 depending on whether the
-- table already existed.
SELECT
  CASE WHEN OBJECT_ID('ShadowSignals', 'U') IS NULL THEN 'MISSING' ELSE 'present' END AS tableState,
  (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('ShadowSignals')) AS columnCount;
GO
