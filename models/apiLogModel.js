// models/apiLogModel.js
// DB access for the internal API request log (#58). Both the dashboard and the
// fileserver write here (they share DB_Oswald), and the dashboard serves it via
// GET /api/logs (admin).
//
// FUTURE SCOPE: when the logging feature grows (levels, categories, retention,
// viewer UI), extend this model — see the note in utils/apiLogger.js.

const { getPool } = require('../config/db');
const sql = require('mssql');

async function createApiLog(record) {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('source', sql.NVarChar, String(record.source || 'unknown').slice(0, 50))
      .input('label', sql.NVarChar, record.label ? String(record.label).slice(0, 100) : null)
      .input('method', sql.NVarChar, String(record.method || '').slice(0, 10))
      .input('path', sql.NVarChar, String(record.path || '').slice(0, 500))
      .input('status', sql.Int, Number(record.status) || 0)
      .input('durationMs', sql.Int, Number(record.durationMs) || 0)
      .input('userId', sql.Int, record.userId || null)
      .query(
        `INSERT INTO ApiLogs (source, label, method, path, status, durationMs, userId)
         VALUES (@source, @label, @method, @path, @status, @durationMs, @userId)`
      );
  } catch (err) {
    // Logging must never break the request that triggered it.
    console.error('[apiLogger] DB write failed:', err.message);
  }
}

async function getAllApiLogs({ source, limit } = {}) {
  const pool = await getPool();
  const req = pool.request();
  let q = 'SELECT * FROM ApiLogs';
  const conds = [];
  if (source) {
    req.input('source', sql.NVarChar, source);
    conds.push('source = @source');
  }
  if (conds.length) q += ' WHERE ' + conds.join(' AND ');
  q += ' ORDER BY id DESC';
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  q += ` OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`;
  const result = await req.query(q);
  return result.recordset;
}

module.exports = { createApiLog, getAllApiLogs };
