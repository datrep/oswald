// middlewares/auth.js — thin re-export of the shared JWT auth (#70).
//
// Keeps the dashboard's existing contract: missing token -> 401, present-but-
// invalid/expired token -> 403 (the UI treats 403 as "logged out"). All logic
// now lives in ../shared/auth.js so the dashboard and fileserver share it.
//
// DB-backed session check (UAC opsec): every authenticated request also verifies
// the user still exists, is active, and that the token's `v` matches
// Users.tokenVersion — so role/password/disable changes revoke sessions
// immediately (no stale 1h window).
const { makeAuthenticateToken, requirePermission } = require('../shared/auth');
const User = require('../models/userModel');

const authenticateToken = makeAuthenticateToken({
  invalidStatus: 403,
  loadUser: (userId) => User.getAuthState(userId),
});

module.exports = authenticateToken;
module.exports.requirePermission = requirePermission;
