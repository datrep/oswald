-- TRD-ANC-1 (2026-09-27): put the `Trades.decisionId` parent ON THE COLUMN, where a query-writer meets it.
--
-- WHY: `Trades.decisionId` references `TradingPrompts.id`. Joining it to `TradingEvents.id` produces
-- PLAUSIBLE ROWS WITH NO ERROR AT ALL, because the two id spaces overlap. A wrong join that SUCCEEDS is worse
-- than one that fails: the first drift probe built on it returned "0 of 60 joined" and nearly concluded the
-- drift was unmeasurable, when the drift was in fact recorded by value on two event kinds all along.
--
-- MEASURED AT THE TIME OF WRITING (2026-09-27):
--   Trades.decisionId matches TradingPrompts.id  : 85 of 85
--   Trades.decisionId matches TradingEvents.id   :  0 of 85
--   TradingPrompts.id range  :     8 ..   5,308
--   TradingEvents.id  range  : 41,004 ..  97,547    <- DISJOINT, and DIVERGING
--
-- ⚠⚠ THE FALSE JOIN IS CURRENTLY IMPOSSIBLE, BUT ONLY BY ACCIDENT — AND THIS PROPERTY'S FIRST DRAFT SAID THE
-- OPPOSITE, so the correction is recorded rather than the file quietly rewritten. The first draft claimed the
-- overlap was "dormant" and that TradingEvents.id would "grow back into" the TradingPrompts range. **That is
-- WRONG and the id ranges say so:** TradingEvents now BEGINS at 41,004 while TradingPrompts tops out at 5,308,
-- so TradingEvents.id grows AWAY from the overlap. It cannot return by growing. The historical overlap existed
-- because TradingEvents.id had once reached ~5,000 (the examples were #1094 -> 5147); those ids no longer exist
-- and will never be reissued.
--
-- The residual risk is therefore NOT growth: it is a RESTORE, a TRUNCATE, or a reseed of TradingEvents, any of
-- which would put its identity back inside the TradingPrompts range. That is a narrower and more honest warning
-- than "it will come back", and it is the one worth carrying.
--
-- The rule itself is unchanged and is the point: the parent is TradingPrompts, and a wrong join here SUCCEEDS
-- silently rather than failing, which is worse.
--
-- Same shape as the EpochNotice properties: a rule attached to the object a reader is actually looking at.
-- Run with:  sqlcmd -S localhost -d DB_Oswald -E -i <this file> -y 0 -s "|"

SET NOCOUNT ON;
GO

DECLARE @notice nvarchar(4000) = N'PARENT TABLE: TradingPrompts(id) -- NOT TradingEvents(id). '
  + N'MEASURED 2026-09-27: Trades.decisionId matches TradingPrompts.id on 85 of 85 rows, and TradingEvents.id on 0 of 85. '
  + N'⚠ THE ZERO IS DORMANT, NOT SAFE: the two id spaces OVERLAP, so JOIN TradingEvents e ON e.id = t.decisionId '
  + N'returns PLAUSIBLE ROWS WITH NO ERROR. The overlap is currently empty ONLY because pre-epoch TradingEvents '
  + N'rows were pruned on 2026-09-27 for an unrelated reason (TRD-DAT-1); TradingEvents.id keeps growing and will '
  + N'grow back into the TradingPrompts range. A wrong join that SUCCEEDS is worse than one that fails: the first '
  + N'drift probe built on it reported "0 of 60 joined" and nearly concluded the fill-vs-anchor drift was '
  + N'unmeasurable, when it is recorded by value on entry_reanchored.decisionPrice and on the trade fill. '
  + N'To reach the decision, join TradingPrompts. To reach the fill/decision VALUES, read entry_reanchored.';

-- Drop-then-add so this file is idempotent and re-runnable.
-- ⚠ `sp_drop extendedproperty` is NOT a procedure name — it parses as `EXEC sp_drop` with
-- `extendedproperty` as an argument and fails with "Incorrect syntax near 'DecisionIdParent'". It is one
-- word: `sp_dropextendedproperty`, called with NAMED parameters. First run of this file hit exactly that.
IF EXISTS (SELECT 1 FROM sys.extended_properties
           WHERE major_id = OBJECT_ID('dbo.Trades') AND name = 'DecisionIdParent')
BEGIN
  EXEC sp_dropextendedproperty
    @name = N'DecisionIdParent',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE',  @level1name = N'Trades',
    @level2type = N'COLUMN', @level2name = N'decisionId';
END
GO

EXEC sp_addextendedproperty
  @name = N'DecisionIdParent',
  @value = N'PARENT TABLE: TradingPrompts(id) -- NOT TradingEvents(id). MEASURED 2026-09-27: Trades.decisionId matches TradingPrompts.id on 85 of 85 rows, and TradingEvents.id on 0 of 85. WHY THAT MATTERS: the two id spaces ONCE OVERLAPPED, so JOIN TradingEvents e ON e.id = t.decisionId used to return PLAUSIBLE ROWS WITH NO ERROR -- a wrong join that SUCCEEDS is worse than one that fails. The first drift probe built on it reported "0 of 60 joined" and nearly concluded the fill-vs-anchor drift was unmeasurable, when it is recorded by value on entry_reanchored.decisionPrice and on the trade fill. STATUS: the ranges are now DISJOINT AND DIVERGING (TradingPrompts 8..5308, TradingEvents 41004..97547), so the false join cannot occur by growth. It could return via a RESTORE, TRUNCATE or reseed of TradingEvents. TO REACH THE DECISION: join TradingPrompts, or use dbo.vTradesWithDecision. TO REACH THE FILL/DECISION VALUES: read entry_reanchored.',
  @level0type = N'SCHEMA', @level0name = N'dbo',
  @level1type = N'TABLE',  @level1name = N'Trades',
  @level2type = N'COLUMN', @level2name = N'decisionId';
GO

-- A VIEW so the CORRECT join is the easy one to write. A warning alone leaves the wrong join equally available;
-- this makes the right one one line. It names the parent in its own name.
IF OBJECT_ID('dbo.vTradesWithDecision', 'V') IS NOT NULL DROP VIEW dbo.vTradesWithDecision;
GO
CREATE VIEW dbo.vTradesWithDecision AS
SELECT
  t.id            AS tradeId,
  t.userId,
  t.symbol,
  t.direction,
  t.strategyId,
  t.openPrice,
  t.openAt,
  t.closePrice,
  t.closeAt,
  t.stopPrice,
  t.takeProfitPrice,
  t.decisionId,
  -- ★ THE CORRECT JOIN. `p` is TradingPrompts, never TradingEvents.
  p.triggerType   AS promptTriggerType,
  p.model         AS promptModel,
  p.createdAt     AS promptCreatedAt,
  p.decision      AS promptDecision
FROM dbo.Trades t
LEFT JOIN dbo.TradingPrompts p ON p.id = t.decisionId;
GO

-- PROOF THE PROPERTY LANDED, printed so a silent no-op cannot pass as a success (the TRD-ANC-1 lesson itself).
SELECT ep.name, LEN(CAST(ep.value AS nvarchar(4000))) AS value_len
FROM sys.extended_properties ep
JOIN sys.columns c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
WHERE ep.major_id = OBJECT_ID('dbo.Trades') AND c.name = 'decisionId';
GO
