/* 055 — Trades.venueInstrumentId (2026-10-27).
 *
 * WHY. `agent/constraintAudit.js` resolved a trade's instrument by SYMBOL, against `Instruments` AS IT IS AT AUDIT
 * TIME — line 182 builds the map, line 192 looks the trade up in it. So the fact was RECONSTRUCTED later rather than
 * RECORDED at entry, and two things follow:
 *
 *   · a symbol renamed in the registry between entry and audit makes the trade unjoinable;
 *   · an OPTION contract can never join at all. `Instruments.symbol` holds the UNDERLYING ("Gold") with strike and
 *     expiry in their own columns, while `Trades.symbol` holds the venue's composite contract name
 *     ("Oil | Call 94 | Sep W2"). Measured 2026-10-27: 4 such trades, reported `instrument_unknown`.
 *
 * ⚠⚠ WHAT THIS COLUMN DOES **NOT** DO, stated because it would otherwise be assumed. It does not repair those four
 * trades: they have no id and none can be invented. And it does not fix options BY ITSELF — the id has to come from
 * the venue at submit, because the registry cannot resolve a composite contract name either (that is why the trades
 * failed). This column is the place to RECORD it; sourcing it is a separate, later change.
 *
 * ⚠ NO BACKFILL, DELIBERATELY. 316 existing rows carry no id. Filling them from `Instruments` by symbol would write
 * an association that was never observed, into the one column whose purpose is to stop associations being guessed —
 * and for the option rows it would produce exactly the plausible-looking wrong answer the column exists to prevent.
 * NULL on an old row means "entry predates the column", and the audit says so by falling back to its symbol map.
 *
 * ⚠ NVARCHAR(64) to match `plus500PositionId`, which already holds a venue identifier of the same shape.
 */

IF COL_LENGTH('dbo.Trades', 'venueInstrumentId') IS NULL
BEGIN
  ALTER TABLE dbo.Trades ADD venueInstrumentId NVARCHAR(64) NULL;
END
GO
