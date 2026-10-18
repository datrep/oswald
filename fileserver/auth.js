// fileserver/auth.js — thin re-export of the shared JWT auth (#70).
//
// Fileserver contract: missing token -> 401, present-but-invalid -> 401, and
// the token is ALSO accepted from the oswald_fs_token cookie (for <img>/<video>
// media requests that can't send an Authorization header). Logic lives in
// ../shared/auth.js, shared with the dashboard.
//
// DB-backed session check: verifies the user still exists, is active, and that
// the token's `v` matches Users.tokenVersion — so access changes on the
// dashboard revoke fileserver sessions immediately too.
const { makeAuthenticateToken } = require('../shared/auth');
const { getPool, sql } = require('./db');

const authenticateToken = makeAuthenticateToken({
  invalidStatus: 401,
  cookieName: 'oswald_fs_token',
  loadUser: async (userId) => {
    const pool = await getPool();
    const r = await pool.request().input('userId', sql.Int, userId).query('SELECT isActive, tokenVersion FROM Users WHERE id = @userId');
    return r.recordset[0] || null;
  },
});

module.exports = { authenticateToken };
