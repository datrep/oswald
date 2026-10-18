// trading/store/instruments.js — TRD-45 Phase 1: the instrument registry repository.
//
// Thin by design: all judgement about whether a spec is usable lives in the pure
// `plus500/instrumentSpec.js`. This module only writes and reads.
//
// THE ONE NON-OBVIOUS RULE — PARTIAL READS MUST NOT CLOBBER GOOD ONES.
// The sidebar exposes different fields depending on what the operator clicked and which tab is
// open: a spot CFD has no strike or expiry, and a collapsed sidebar has nothing at all. A naive
// `UPDATE SET unitAmount = @unitAmount` from a partial read would therefore BLANK a minimum trade
// size the desk is actively sizing against. This exact trap already fired once in this codebase
// (`sessionFeed`'s upsert let a shallower payload overwrite a richer one), so every column here is
// written as `COALESCE(@incoming, existing)`: a null means "this read did not include it", never
// "the venue says there is none". Clearing a field is a deliberate act and has no path here.
'use strict';

const { getPool, sql } = require('../db');
const spec = require('../plus500/instrumentSpec');

const VENUE_DEFAULT = 'plus500';

// Writable instrument columns. The list is explicit so a new probe field cannot be persisted by
// accident — the registry is a CONTRACT, not a scratch pad for whatever the DOM happened to expose.
const SPEC_COLUMNS = [
  'venueName', 'symbol', 'instrumentClass', 'optionType', 'strikePrice', 'expiryAt',
  'unitAmount', 'unitKind', 'unitAmountLabel', 'pointValue', 'pointValueUnit', 'initialMarginPct',
  'maintenanceMarginPct', 'fundingBuyPct', 'fundingSellPct', 'fundingTime',
  'nextSessionText', 'leverageRaw', 'marketStateAtCapture', 'sourceUrl',
];

async function upsertInstrument(userId, row) {
  const r = row || {};
  if (!r.venueInstrumentId) return { ok: false, reason: 'venue_instrument_id_required' };
  if (!r.symbol) return { ok: false, reason: 'symbol_required' };
  const venue = r.venue || VENUE_DEFAULT;

  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('venueInstrumentId', sql.NVarChar(32), String(r.venueInstrumentId))
    .input('venueName', sql.NVarChar(200), r.venueName || r.symbol)
    .input('symbol', sql.NVarChar(128), String(r.symbol))
    .input('instrumentClass', sql.NVarChar(16), r.instrumentClass === 'option' ? 'option' : 'spot')
    .input('optionType', sql.NVarChar(8), r.optionType ?? null)
    .input('strikePrice', sql.Decimal(18, 6), spec.isNum(r.strikePrice) ? spec.num(r.strikePrice) : null)
    .input('expiryAt', sql.DateTime2, r.expiryAt instanceof Date ? r.expiryAt : null)
    .input('unitAmount', sql.Decimal(18, 6), spec.isNum(r.unitAmount) ? spec.num(r.unitAmount) : null)
    .input('unitKind', sql.NVarChar(32), r.unitKind ?? null)
    // Migration 045. `unitKind` is the UNIT ("Troy Ounces"); this is the vendor's LABEL for the field
    // (whatever word column-0 carries). Both NULLable and both COALESCEd, so a partial read cannot blank
    // a good one — the trap this file's header documents.
    .input('unitAmountLabel', sql.NVarChar(60), r.unitAmountLabel ?? null)
    .input('pointValue', sql.Decimal(18, 6), spec.isNum(r.pointValue) ? spec.num(r.pointValue) : null)
    .input('pointValueUnit', sql.NVarChar(16), r.pointValueUnit ?? null)
    .input('initialMarginPct', sql.Decimal(9, 4), spec.isNum(r.initialMarginPct) ? spec.num(r.initialMarginPct) : null)
    .input('maintenanceMarginPct', sql.Decimal(9, 4), spec.isNum(r.maintenanceMarginPct) ? spec.num(r.maintenanceMarginPct) : null)
    .input('fundingBuyPct', sql.Decimal(9, 4), spec.isNum(r.fundingBuyPct) ? spec.num(r.fundingBuyPct) : null)
    .input('fundingSellPct', sql.Decimal(9, 4), spec.isNum(r.fundingSellPct) ? spec.num(r.fundingSellPct) : null)
    .input('fundingTime', sql.NVarChar(32), r.fundingTime ?? null)
    .input('nextSessionText', sql.NVarChar(120), r.nextSessionText ?? null)
    .input('leverageRaw', sql.NVarChar(16), r.leverageRaw ?? null)
    .input('marketStateAtCapture', sql.NVarChar(12), r.marketStateAtCapture || 'unknown')
    .input('sourceUrl', sql.NVarChar(200), r.sourceUrl ?? null);

  // COALESCE everywhere: null means "not in this read", so the stored value survives. `symbol` and
  // `instrumentClass` are the exceptions — they define WHICH instrument this row is, so a new read
  // is authoritative for them.
  const sets = SPEC_COLUMNS
    .filter((c) => c !== 'symbol' && c !== 'instrumentClass')
    .map((c) => `${c} = COALESCE(@${c}, ${c})`);
  sets.push('symbol = @symbol', 'instrumentClass = @instrumentClass', 'capturedAt = GETUTCDATE()');

  const q = `
    UPDATE dbo.Instruments SET ${sets.join(', ')}
      WHERE userId = @userId AND venue = @venue AND venueInstrumentId = @venueInstrumentId;
    IF @@ROWCOUNT = 0
      INSERT INTO dbo.Instruments (userId, venue, venueInstrumentId, ${SPEC_COLUMNS.join(', ')})
      VALUES (@userId, @venue, @venueInstrumentId, ${SPEC_COLUMNS.map((c) => '@' + c).join(', ')});`;
  await req.query(q);
  return { ok: true };
}

// Quotes are append-only. They are never merged, because a quote is a fact about an INSTANT — the
// only thing that matters about it is when it was taken, and that is the column the resolver filters
// on. Storing the derived spread alongside the buy/sell it came from keeps the venue's own
// arithmetic auditable (the invariant was verified 21/21 in Phase 0).
async function recordQuote(userId, q) {
  const r = q || {};
  if (!r.venueInstrumentId && !r.symbol) return { ok: false, reason: 'symbol_or_id_required' };
  const venue = r.venue || VENUE_DEFAULT;
  const check = spec.usableQuote({ buy: r.buy, sell: r.sell, spread: r.spread, marketState: r.marketState });
  const pool = await getPool();
  await pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('venueInstrumentId', sql.NVarChar(32), r.venueInstrumentId ? String(r.venueInstrumentId) : null)
    .input('symbol', sql.NVarChar(128), r.symbol ? String(r.symbol) : null)
    .input('buy', sql.Decimal(18, 6), spec.isNum(r.buy) ? spec.num(r.buy) : null)
    .input('sell', sql.Decimal(18, 6), spec.isNum(r.sell) ? spec.num(r.sell) : null)
    .input('spread', sql.Decimal(18, 6), spec.isNum(r.spread) ? spec.num(r.spread) : null)
    .input('marketState', sql.NVarChar(12), r.marketState || 'unknown')
    .query(`INSERT INTO dbo.InstrumentQuotes (userId, venue, venueInstrumentId, symbol, buy, sell, spread, marketState)
            VALUES (@userId, @venue, @venueInstrumentId, @symbol, @buy, @sell, @spread, @marketState)`);
  // The gate result is RETURNED rather than acted on, so the caller learns that a quote it just
  // stored is not consumable instead of assuming storage implies validity.
  return { ok: true, usable: check.usable, reason: check.reason };
}

// The resolver's read. Prefers the most recent capture, and prefers an OPTION row over a spot row
// only when the caller asked for one — class is a required filter, not a tiebreak, because the two
// share a symbol and differ by 600x in minimum size.
async function getInstrument(userId, { venue = VENUE_DEFAULT, symbol, instrumentClass = null } = {}) {
  if (!symbol) return null;
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('symbol', sql.NVarChar(128), String(symbol));
  const cls = instrumentClass ? ` AND instrumentClass = @cls` : '';
  if (instrumentClass) req.input('cls', sql.NVarChar(16), instrumentClass);
  const r = await req.query(`SELECT TOP 1 * FROM dbo.Instruments
                             WHERE userId = @userId AND venue = @venue AND symbol = @symbol${cls}
                             ORDER BY capturedAt DESC`);
  return r.recordset[0] || null;
}

// Exact lookup for when the caller names the instrument. This is the ONLY unambiguous way to reach
// an OPTION: twenty of them share one symbol, and picking one off an unordered list would size a
// trade against a strike nobody chose.
async function getInstrumentById(userId, { venue = VENUE_DEFAULT, venueInstrumentId } = {}) {
  if (!venueInstrumentId) return null;
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('id', sql.NVarChar(32), String(venueInstrumentId))
    .query(`SELECT TOP 1 * FROM dbo.Instruments
            WHERE userId = @userId AND venue = @venue AND venueInstrumentId = @id`);
  return r.recordset[0] || null;
}

// How many DISTINCT instruments match (symbol, class). Exists so the resolver can tell "one" from
// "twenty" BEFORE it reads one: an ambiguous class must be refused, not resolved by luck.
async function countInstruments(userId, { venue = VENUE_DEFAULT, symbol, instrumentClass = null } = {}) {
  if (!symbol) return 0;
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('symbol', sql.NVarChar(128), String(symbol));
  const cls = instrumentClass ? ` AND instrumentClass = @cls` : '';
  if (instrumentClass) req.input('cls', sql.NVarChar(16), instrumentClass);
  const r = await req.query(`SELECT COUNT(*) AS n FROM dbo.Instruments
                             WHERE userId = @userId AND venue = @venue AND symbol = @symbol${cls}`);
  return Number(r.recordset[0] && r.recordset[0].n) || 0;
}

async function listInstruments(userId, { venue = VENUE_DEFAULT, limit = 500 } = {}) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('limit', sql.Int, Math.min(Math.max(Number(limit) || 500, 1), 2000))
    .query(`SELECT TOP (@limit) * FROM dbo.Instruments WHERE userId = @userId AND venue = @venue ORDER BY symbol, instrumentClass`);
  return r.recordset;
}

// The newest quote that was captured while the venue said the market was OPEN. The filter is in SQL
// so no closed-market row is ever handed to a caller who might forget to check, and it is re-run
// through `usableQuote` in JS so the arithmetic is verified on the way out too — belt and braces on
// the one field that would otherwise become a fabricated cost.
async function getUsableQuote(userId, { venue = VENUE_DEFAULT, symbol, maxAgeHours = 72 } = {}) {
  if (!symbol) return null;
  const pool = await getPool();
  const hours = Math.min(Math.max(Number(maxAgeHours) || 72, 1), 24 * 30);
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('symbol', sql.NVarChar(128), String(symbol))
    .input('maxAge', sql.Int, Math.round(hours))
    .query(`SELECT TOP 1 * FROM dbo.InstrumentQuotes
            WHERE userId = @userId AND venue = @venue AND symbol = @symbol
              AND marketState = 'open'
              AND capturedAt >= DATEADD(hour, -@maxAge, GETUTCDATE())
            ORDER BY capturedAt DESC`);
  const row = r.recordset[0];
  if (!row) return null;
  const check = spec.usableQuote(row);
  return check.usable ? row : null;
}

async function listQuotes(userId, { venue = VENUE_DEFAULT, symbol = null, limit = 200 } = {}) {
  const pool = await getPool();
  const req = pool.request()
    .input('userId', sql.Int, userId)
    .input('venue', sql.NVarChar(32), venue)
    .input('limit', sql.Int, Math.min(Math.max(Number(limit) || 200, 1), 5000));
  const bySym = symbol ? ' AND symbol = @symbol' : '';
  if (symbol) req.input('symbol', sql.NVarChar(128), String(symbol));
  const r = await req.query(`SELECT TOP (@limit) * FROM dbo.InstrumentQuotes
                             WHERE userId = @userId AND venue = @venue${bySym}
                             ORDER BY capturedAt DESC`);
  return r.recordset;
}

module.exports = { VENUE_DEFAULT, SPEC_COLUMNS, upsertInstrument, recordQuote, getInstrument, getInstrumentById, countInstruments, listInstruments, getUsableQuote, listQuotes };
