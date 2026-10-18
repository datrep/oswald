// models/userModel.js
const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('Users');

exports.createUser = async (username, passwordHash) => {
  await repo.query(
    `INSERT INTO Users (username, passwordHash) VALUES (@username, @passwordHash)`,
    (req) => req.input('username', sql.VarChar(50), username).input('passwordHash', sql.VarChar(255), passwordHash)
  );
};

exports.countUsers = async () => {
  const r = await repo.query('SELECT COUNT(*) AS n FROM Users');
  return r[0].n;
};

exports.findUserByUsername = async (username) => {
  return repo.one('SELECT * FROM Users WHERE username = @username', (req) => req.input('username', sql.VarChar(50), username));
};

exports.updateUser = async (userID, username, passwordHash) => {
  await repo.query(
    `UPDATE Users SET username = @username, passwordHash = @passwordHash, updatedAt = GETUTCDATE() WHERE id = @userID`,
    (req) => req.input('userID', sql.Int, userID).input('username', sql.VarChar(50), username).input('passwordHash', sql.VarChar(255), passwordHash)
  );
};

exports.deleteUser = async (userID) => {
  await repo.query('DELETE FROM Users WHERE id = @userID', (req) => req.input('userID', sql.Int, userID));
};

exports.getUserInfo = async (userID) => {
  return repo.one('SELECT id, username, isActive, createdAt, updatedAt FROM Users WHERE id = @userID', (req) => req.input('userID', sql.Int, userID));
};

// UAC session control (opsec): lightweight per-request auth check.
exports.getAuthState = async (userId) => {
  return repo.one('SELECT isActive, tokenVersion FROM Users WHERE id = @userId', (req) => req.input('userId', sql.Int, userId));
};

// Invalidate every existing JWT for a user (role/password/active changes).
exports.bumpTokenVersion = async (userId) => {
  await repo.query('UPDATE Users SET tokenVersion = tokenVersion + 1 WHERE id = @userId', (req) => req.input('userId', sql.Int, userId));
};

// Enable/disable an account (disable also revokes all sessions).
exports.setIsActive = async (userId, isActive) => {
  await repo.query(
    'UPDATE Users SET isActive = @isActive, tokenVersion = tokenVersion + 1 WHERE id = @userId',
    (req) => req.input('userId', sql.Int, userId).input('isActive', sql.Bit, isActive)
  );
};

// Admin password reset (also revokes all sessions).
exports.resetPassword = async (userId, passwordHash) => {
  await repo.query(
    'UPDATE Users SET passwordHash = @passwordHash, tokenVersion = tokenVersion + 1, updatedAt = GETUTCDATE() WHERE id = @userId',
    (req) => req.input('userId', sql.Int, userId).input('passwordHash', sql.VarChar(255), passwordHash)
  );
};

exports.getAllUsersWithRoles = async () => {
  const result = await repo.query(`
    SELECT u.id, u.username, u.isActive,
           COALESCE(STRING_AGG(r.name, ','), '') AS roles,
           s.loggedInAt AS lastLoginAt, s.userAgent AS lastUserAgent,
           CASE WHEN s.lastSeenAt >= DATEADD(MINUTE, -3, GETUTCDATE()) THEN 1 ELSE 0 END AS online
    FROM Users u
    LEFT JOIN UserRoles ur ON ur.userId = u.id
    LEFT JOIN Roles r ON r.id = ur.roleId
    OUTER APPLY (SELECT TOP 1 loggedInAt, userAgent, lastSeenAt FROM UserSessions WHERE userId = u.id ORDER BY loggedInAt DESC) s
    GROUP BY u.id, u.username, u.isActive, s.loggedInAt, s.userAgent, s.lastSeenAt
    ORDER BY u.username
  `);
  return result.map((u) => ({
    id: u.id,
    username: u.username,
    isActive: u.isActive !== false,
    roles: u.roles ? u.roles.split(',').filter(Boolean) : [],
    lastLoginAt: u.lastLoginAt || null,
    lastUserAgent: u.lastUserAgent || null,
    online: !!u.online,
  }));
};

// Record a successful login (best-effort, never fails the login itself).
// Returns the new session id so the client can heartbeat it for live presence.
exports.addSession = async (userId, ip, userAgent) => {
  const rows = await repo.query(
    'INSERT INTO UserSessions (userId, ip, userAgent) OUTPUT INSERTED.id AS id VALUES (@userId, @ip, @userAgent)',
    (req) => req.input('userId', sql.Int, userId).input('ip', sql.NVarChar, ip).input('userAgent', sql.NVarChar, userAgent)
  );
  return rows[0]?.id || null;
};

// UAC-5: heartbeat — bump lastSeenAt for one of the current user's sessions.
// The userId guard stops a user from touching someone else's session row.
exports.touchSession = async (sessionId, userId) => {
  await repo.query(
    'UPDATE UserSessions SET lastSeenAt = GETUTCDATE() WHERE id = @id AND userId = @userId',
    (req) => req.input('id', sql.Int, sessionId).input('userId', sql.Int, userId)
  );
};

// UAC-5: distinct users with a session seen within the last N minutes.
exports.getOnlineUsers = async (minutes = 3) => {
  return repo.query(
    `SELECT s.userId, u.username, MAX(s.lastSeenAt) AS lastSeenAt
     FROM UserSessions s JOIN Users u ON u.id = s.userId
     WHERE s.lastSeenAt >= DATEADD(MINUTE, -@minutes, GETUTCDATE())
     GROUP BY s.userId, u.username
     ORDER BY u.username`,
    (req) => req.input('minutes', sql.Int, minutes)
  );
};

// Recent login sessions for one user (admin-only view).
exports.getSessionsByUser = async (userId, limit = 10) => {
  return repo.query(
    'SELECT TOP (@limit) id, loggedInAt, lastSeenAt, ip, userAgent FROM UserSessions WHERE userId = @userId ORDER BY loggedInAt DESC',
    (req) => req.input('userId', sql.Int, userId).input('limit', sql.Int, limit)
  );
};

// UAC-5: recent login sessions across ALL users (admin "who is logged in" view).
exports.getAllSessions = async (limit = 20) => {
  return repo.query(
    `SELECT TOP (@limit) s.id, s.userId, u.username, s.userAgent, s.ip, s.loggedInAt, s.lastSeenAt
     FROM UserSessions s JOIN Users u ON u.id = s.userId
     ORDER BY s.loggedInAt DESC`,
    (req) => req.input('limit', sql.Int, limit)
  );
};
