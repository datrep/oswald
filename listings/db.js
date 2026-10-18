// listings/db.js — re-export of the shared connection pool (fileserver pattern).
const { getPool, sql } = require('../shared/db');

module.exports = { getPool, sql };
