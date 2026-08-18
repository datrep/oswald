// models/userModel.js
const { getPool } = require('../config/db');
const sql = require('mssql');

exports.createUser = async (username, passwordHash) => {
  const pool = await getPool();
  await pool
    .request()
    .input('username', sql.VarChar(50), username)
    .input('passwordHash', sql.VarChar(255), passwordHash).query(`
      INSERT INTO Users (username, passwordHash)
      VALUES (@username, @passwordHash)
    `);
};

exports.countUsers = async () => {
  const pool = await getPool();
  const r = await pool.request().query('SELECT COUNT(*) AS n FROM Users');
  return r.recordset[0].n;
};

exports.findUserByUsername = async (username) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('username', sql.VarChar(50), username)
    .query('SELECT * FROM Users WHERE username = @username');
  return result.recordset[0];
};

exports.updateUser = async (userID, username, passwordHash) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userID', sql.Int, userID)
    .input('username', sql.VarChar(50), username)
    .input('passwordHash', sql.VarChar(255), passwordHash).query(`
      UPDATE Users SET username = @username, passwordHash = @passwordHash, updatedAt = GETUTCDATE()
      WHERE id = @userID
    `);
};

exports.deleteUser = async (userID) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userID', sql.Int, userID)
    .query('DELETE FROM Users WHERE id = @userID');
};

exports.getUserInfo = async (userID) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userID', sql.Int, userID)
    .query('SELECT id, username, isActive, createdAt, updatedAt FROM Users WHERE id = @userID');
  return result.recordset[0];
};

// UAC session control (opsec): lightweight per-request auth check.
exports.getAuthState = async (userId) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query('SELECT isActive, tokenVersion FROM Users WHERE id = @userId');
  return result.recordset[0] || null;
};

// Invalidate every existing JWT for a user (role/password/active changes).
exports.bumpTokenVersion = async (userId) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .query('UPDATE Users SET tokenVersion = tokenVersion + 1 WHERE id = @userId');
};

// Enable/disable an account (disable also revokes all sessions).
exports.setIsActive = async (userId, isActive) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('isActive', sql.Bit, isActive)
    .query('UPDATE Users SET isActive = @isActive, tokenVersion = tokenVersion + 1 WHERE id = @userId');
};

// Admin password reset (also revokes all sessions).
exports.resetPassword = async (userId, passwordHash) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('passwordHash', sql.VarChar(255), passwordHash)
    .query('UPDATE Users SET passwordHash = @passwordHash, tokenVersion = tokenVersion + 1, updatedAt = GETUTCDATE() WHERE id = @userId');
};

exports.getAllUsersWithRoles = async () => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT u.id, u.username, u.isActive,
           COALESCE(STRING_AGG(r.name, ','), '') AS roles,
           s.loggedInAt AS lastLoginAt, s.userAgent AS lastUserAgent
    FROM Users u
    LEFT JOIN UserRoles ur ON ur.userId = u.id
    LEFT JOIN Roles r ON r.id = ur.roleId
    OUTER APPLY (SELECT TOP 1 loggedInAt, userAgent FROM UserSessions WHERE userId = u.id ORDER BY loggedInAt DESC) s
    GROUP BY u.id, u.username, u.isActive, s.loggedInAt, s.userAgent
    ORDER BY u.username
  `);
  return result.recordset.map((u) => ({
    id: u.id,
    username: u.username,
    isActive: u.isActive !== false,
    roles: u.roles ? u.roles.split(',').filter(Boolean) : [],
    lastLoginAt: u.lastLoginAt || null,
    lastUserAgent: u.lastUserAgent || null,
  }));
};

// Record a successful login (best-effort, never fails the login itself).
exports.addSession = async (userId, ip, userAgent) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('ip', sql.NVarChar, ip)
    .input('userAgent', sql.NVarChar, userAgent)
    .query('INSERT INTO UserSessions (userId, ip, userAgent) VALUES (@userId, @ip, @userAgent)');
};

// Recent login sessions for one user (admin-only view).
exports.getSessionsByUser = async (userId, limit = 10) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('limit', sql.Int, limit)
    .query('SELECT TOP (@limit) id, loggedInAt, ip, userAgent FROM UserSessions WHERE userId = @userId ORDER BY loggedInAt DESC');
  return result.recordset;
};

// UAC-5: recent login sessions across ALL users (admin "who is logged in" view).
exports.getAllSessions = async (limit = 20) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) s.id, s.userId, u.username, s.userAgent, s.ip, s.loggedInAt
      FROM UserSessions s JOIN Users u ON u.id = s.userId
      ORDER BY s.loggedInAt DESC
    `);
  return result.recordset;
};
