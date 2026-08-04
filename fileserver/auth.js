// Auth for the Oswald fileserver service.
// Shares the dashboard's JWT secret (repo-root .env) so an oswald_token
// issued by the main app is valid here too.
const path = require('path');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

// Load the repo-root .env (JWT_SECRET) regardless of the cwd we were started from.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('[fileserver] JWT_SECRET missing from repo-root .env — auth disabled.');
}

// Express middleware: requires a valid oswald_token. Accepts it from the
// Authorization header (API/fetch) OR the `oswald_fs_token` same-site cookie
// (plain <img>/<video>/<a> requests, which can't send headers).
function readToken(req) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  if (req.headers.cookie) {
    const m = /(?:^|;\s*)oswald_fs_token=([^;]+)/.exec(req.headers.cookie);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

function authenticateToken(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  jwt.verify(token, SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

module.exports = { authenticateToken };
