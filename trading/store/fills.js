'use strict';
// trading/store/fills.js — the FILL TELEMETRY repository.
//
// WHY A REPOSITORY AND NOT A QUERY IN THE CALLER. `test/venue-cost-basis.test.js` asserts that
// `agent/instruments.js` contains no `getPool`/`query(` — the store layer exists so that a second place querying a
// table is not a second place that can forget the filter. The first version of TRD-114's seeder added its SELECT
// directly to that file and the test caught it, which is the guard doing exactly what it was written for.
//
// ⚠ AND THE FILTERS HERE ARE THE MEASUREMENT. `slippagePct` and `spreadSubmitPct` are BOTH nullable, and
// `CAST(NULL AS FLOAT)` is NULL rather than 0 — but a row missing either one cannot produce a residual, and
// including it would contribute a zero to a median. Both are required in the WHERE clause, and the symbol comes from
// the payload because `fill_telemetry` carries it there rather than as a column.
// ⚠ `Trades.slippagePct` IS NOT THIS FIELD. `autopsy.js` overwrites it with the EXIT slippage on close (measured
// 27 of 29 rows), so a repository reading that column would silently report exit costs as entry costs.
const { getPool, sql } = require('../db');

// Raw rows shaped exactly as `agent/slipDerivation.deriveSlipBasis` consumes them: `{symbol, slippagePct,
// spreadRoundTripPct}`. Filtering and derivation stay in the caller so the rule remains PURE and testable.
async function slipRows(userId, { days = 120 } = {}) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('days', sql.Int, Number(days) > 0 ? Number(days) : 120)
    .query(`SELECT JSON_VALUE(payload,'$.symbol') AS symbol,
                   CAST(JSON_VALUE(payload,'$.slippagePct') AS FLOAT) AS slippagePct,
                   CAST(JSON_VALUE(payload,'$.spreadSubmitPct') AS FLOAT) AS spreadRoundTripPct
              FROM TradingEvents
             WHERE userId = @userId AND kind = 'fill_telemetry'
               AND createdAt >= DATEADD(day, -@days, SYSUTCDATETIME())
               AND JSON_VALUE(payload,'$.symbol') IS NOT NULL
               AND JSON_VALUE(payload,'$.slippagePct') IS NOT NULL
               AND JSON_VALUE(payload,'$.spreadSubmitPct') IS NOT NULL`);
  return r.recordset;
}

module.exports = { slipRows };
