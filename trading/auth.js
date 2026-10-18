// trading/auth.js — shared JWT auth: missing -> 401, invalid -> 401, token also
// accepted from the oswald_trading_token cookie. DB-backed session check so
// dashboard access changes revoke sessions here too.
const { makeAuthenticateToken, readToken } = require('../shared/auth');
const { getPool, sql } = require('./db');

// One name, used by the verifier and by `ifToken`, so the two cannot disagree about which cookie counts.
const COOKIE_NAME = 'oswald_trading_token';

const authenticateToken = makeAuthenticateToken({
  invalidStatus: 401,
  cookieName: COOKIE_NAME,
  loadUser: async (userId) => {
    const pool = await getPool();
    const r = await pool.request().input('userId', sql.Int, userId).query('SELECT isActive, tokenVersion FROM Users WHERE id = @userId');
    return r.recordset[0] || null;
  },
});

// F12 (2026-09-18): "is this the owner?" as a QUESTION, not a refusal.
//
// `authenticateToken` is written to 401 (it must), so a route that wants to answer everyone READ-ONLY and
// act for nobody else cannot use it directly. This lets a request with NO token through with `req.user`
// undefined, while still refusing a token that is present and bad — a downgrade must never be silent.
// (The three `/ping` routes are the only callers: on a listener bound to 0.0.0.0:8114 they were reachable
// without a token, and every one of them has a side effect — a Chrome probe, or an LLM call.)
function ifToken(req, res, next) {
  if (!readToken(req, COOKIE_NAME)) return next();
  return authenticateToken(req, res, next);
}

module.exports = { authenticateToken, ifToken, COOKIE_NAME };
