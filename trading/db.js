// trading/db.js — re-export of the shared connection pool (listings/expenses pattern).
const { getPool, sql } = require('../shared/db');

module.exports = { getPool, sql };
