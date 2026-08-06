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
           COALESCE(STRING_AGG(r.name, ','), '') AS roles
    FROM Users u
    LEFT JOIN UserRoles ur ON ur.userId = u.id
    LEFT JOIN Roles r ON r.id = ur.roleId
    GROUP BY u.id, u.username, u.isActive
    ORDER BY u.username
  `);
  return result.recordset.map((u) => ({
    id: u.id,
    username: u.username,
    isActive: u.isActive !== false,
    roles: u.roles ? u.roles.split(',').filter(Boolean) : [],
  }));
};
