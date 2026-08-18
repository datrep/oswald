// fileserver/db.js — re-export of the shared connection pool (#73).
//
// The fileserver previously carried its own copy of the pool (which never
// reset on failure). It now shares ../shared/db.js with the dashboard so both
// services behave identically.

const { getPool, sql } = require('../shared/db');

module.exports = { getPool, sql };
