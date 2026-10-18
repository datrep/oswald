// config/db.js — re-export of the shared connection pool (#73).
//
// Kept as the dashboard's entry point for backward compatibility: models do
// `const { getPool } = require('../config/db')`. The implementation now lives in
// ../shared/db.js so the dashboard and fileserver share one pool (which also
// resets on failure so future calls can retry).

const { getPool } = require('../shared/db');

module.exports = { getPool };
