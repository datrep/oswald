// listings/auth.js — shared JWT auth (fileserver contract): missing -> 401,
// invalid -> 401, token also accepted from the oswald_listings_token cookie.
// DB-backed session check so dashboard access changes revoke sessions here too.
const { makeAuthenticateToken } = require('../shared/auth');
const { getPool, sql } = require('./db');

const authenticateToken = makeAuthenticateToken({
  invalidStatus: 401,
  cookieName: 'oswald_listings_token',
  loadUser: async (userId) => {
    const pool = await getPool();
    const r = await pool.request().input('userId', sql.Int, userId).query('SELECT isActive, tokenVersion FROM Users WHERE id = @userId');
    return r.recordset[0] || null;
  },
});

module.exports = { authenticateToken };
