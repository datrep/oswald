// models/apiLogModel.js
// DB access for the internal API request log (#58). Both the dashboard and the
// fileserver write here (they share DB_Oswald), and the dashboard serves it via
// GET /api/logs (admin).
//
// FUTURE SCOPE: when the logging feature grows (levels, categories, retention,
// viewer UI), extend this model — see the note in utils/apiLogger.js.

const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('ApiLogs');

async function createApiLog(record) {
  try {
    await repo.query(
      `INSERT INTO ApiLogs (source, label, method, path, status, durationMs, userId)
       VALUES (@source, @label, @method, @path, @status, @durationMs, @userId)`,
      (req) => req
        .input('source', sql.NVarChar, String(record.source || 'unknown').slice(0, 50))
        .input('label', sql.NVarChar, record.label ? String(record.label).slice(0, 100) : null)
        .input('method', sql.NVarChar, String(record.method || '').slice(0, 10))
        .input('path', sql.NVarChar, String(record.path || '').slice(0, 500))
        .input('status', sql.Int, Number(record.status) || 0)
        .input('durationMs', sql.Int, Number(record.durationMs) || 0)
        .input('userId', sql.Int, record.userId || null)
    );
  } catch (err) {
    // Logging must never break the request that triggered it.
    console.error('[apiLogger] DB write failed:', err.message);
  }
}

async function getAllApiLogs({ source, limit } = {}) {
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return repo.all({
    where: source ? 'source = @source' : '',
    order: 'id DESC',
    limit: n,
    offset: 0,
    bind: (req) => { if (source) req.input('source', sql.NVarChar, source); },
  });
}

module.exports = { createApiLog, getAllApiLogs };
