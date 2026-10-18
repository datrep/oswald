// expenses/db.js — re-export of the shared connection pool (listings pattern).
const { getPool, sql } = require('../shared/db');

module.exports = { getPool, sql };
