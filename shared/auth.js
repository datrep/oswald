// shared/auth.js — JWT authentication shared by the Oswald dashboard and the
// fileserver (#70). Both services share the same JWT_SECRET (repo-root .env),
// so one token works everywhere.
//
// The two services historically disagreed on the invalid-token status code and
// on cookie support, so this module exposes a factory that keeps both contracts:
//   - dashboard  -> makeAuthenticateToken({ invalidStatus: 403 })
//   - fileserver -> makeAuthenticateToken({ invalidStatus: 401, cookieName: 'oswald_fs_token' })
// (the fileserver needs the cookie fallback for <img>/<video> media requests,
// which cannot send an Authorization header).
//
// FUTURE SCOPE: refresh tokens, per-route scopes, key rotation, or an issuer
// claim would all slot in here.

const jwt = require('jsonwebtoken');
const { loadEnv, env } = require('./config');

// Ensure JWT_SECRET is loaded before any verify (idempotent .env load).
loadEnv();
const SECRET = env('JWT_SECRET');
if (!SECRET) {
  console.error('[shared/auth] JWT_SECRET missing from repo-root .env — auth disabled.');
}

/** Read the bearer token from the Authorization header, or a cookie if given. */
function readToken(req, cookieName) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (cookieName && req.headers.cookie) {
    const m = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`).exec(req.headers.cookie);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/**
 * Build an authenticateToken Express middleware.
 * @param {object} [opts]
 * @param {number} [opts.invalidStatus=401] status for a present-but-invalid token.
 * @param {string|null} [opts.cookieName=null] optional cookie name to accept as a fallback.
 * @param {Function|null} [opts.loadUser=null] async (userId) => ({isActive, tokenVersion}) —
 *   when provided, the token is ALSO verified against the DB every request:
 *   missing user, disabled account, or a `v` mismatch (access-control change) -> 401,
 *   so role/password/disable changes revoke sessions IMMEDIATELY (no stale 1h window).
 *   A token without a `v` claim is treated as version 0 (legacy / self-minted tokens).
 */
function makeAuthenticateToken({ invalidStatus = 401, cookieName = null, loadUser = null } = {}) {
  return function authenticateToken(req, res, next) {
    const token = readToken(req, cookieName);
    if (!token) return res.status(401).json({ error: 'Missing token' });
    jwt.verify(token, SECRET, (err, user) => {
      if (err) return res.status(invalidStatus).json({ error: 'Invalid or expired token' });
      if (!loadUser) {
        // Stateless fallback (no DB configured) — keeps the contract unchanged.
        req.user = user;
        return next();
      }
      loadUser(user.userID)
        .then((state) => {
          if (!state || !state.isActive) {
            return res.status(401).json({ error: 'Account disabled or removed' });
          }
          const tokenV = user.v ?? 0; // missing v = legacy/self-minted token
          if (tokenV !== state.tokenVersion) {
            return res.status(401).json({ error: 'Session revoked — please sign in again' });
          }
          req.user = user;
          next();
        })
        .catch(() => res.status(invalidStatus).json({ error: 'Auth lookup failed' }));
    });
  };
}

/** Must run AFTER authenticateToken (which sets req.user with JWT claims). */
function requirePermission(code) {
  return (req, res, next) => {
    const perms = req.user?.permissions || [];
    if (!perms.includes(code)) {
      return res.status(403).json({ error: `Missing permission: ${code}` });
    }
    next();
  };
}

module.exports = { makeAuthenticateToken, requirePermission, readToken };
