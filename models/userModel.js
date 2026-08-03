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
      UPDATE Users SET username = @username, passwordHash = @passwordHash, updatedAt = GETDATE()
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
    .query('SELECT id, username, createdAt, updatedAt FROM Users WHERE id = @userID');
  return result.recordset[0];
};
