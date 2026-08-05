// fileserver/auth.js — thin re-export of the shared JWT auth (#70).
//
// Fileserver contract: missing token -> 401, present-but-invalid -> 401, and
// the token is ALSO accepted from the oswald_fs_token cookie (for <img>/<video>
// media requests that can't send an Authorization header). Logic lives in
// ../shared/auth.js, shared with the dashboard.
const { makeAuthenticateToken } = require('../shared/auth');

const authenticateToken = makeAuthenticateToken({ invalidStatus: 401, cookieName: 'oswald_fs_token' });

module.exports = { authenticateToken };
