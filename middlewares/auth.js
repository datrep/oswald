// middlewares/auth.js — thin re-export of the shared JWT auth (#70).
//
// Keeps the dashboard's existing contract: missing token -> 401, present-but-
// invalid/expired token -> 403 (the UI treats 403 as "logged out"). All logic
// now lives in ../shared/auth.js so the dashboard and fileserver share it.
const { makeAuthenticateToken, requirePermission } = require('../shared/auth');

const authenticateToken = makeAuthenticateToken({ invalidStatus: 403 });

module.exports = authenticateToken;
module.exports.requirePermission = requirePermission;
