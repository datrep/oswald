// models/userModel.js
const { getPool } = require('../config/db');
const sql = require('mssql');

exports.getNextUserID = async () => {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT MAX(CAST(SUBSTRING(userID, 2, LEN(userID) - 1) AS INT)) AS maxId 
    FROM Users 
    WHERE userID LIKE 'U%' 
      AND ISNUMERIC(SUBSTRING(userID, 2, LEN(userID) - 1)) = 1
  `);
  const nextId = (result.recordset[0].maxId || 0) + 1;
  return `U${nextId}`;
};

exports.createUser = async (userID, username, passwordHash) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userID', sql.VarChar(20), userID)
    .input('username', sql.VarChar(50), username)
    .input('passwordHash', sql.VarChar(255), passwordHash).query(`
      INSERT INTO Users (userID, username, passwordHash)
      VALUES (@userID, @username, @passwordHash)
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
    .input('userID', sql.VarChar(20), userID)
    .input('username', sql.VarChar(50), username)
    .input('passwordHash', sql.VarChar(255), passwordHash).query(`
      UPDATE Users SET username = @username, passwordHash = @passwordHash, updatedAt = GETDATE()
      WHERE userID = @userID
    `);
};

exports.deleteUser = async (userID) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userID', sql.VarChar(20), userID)
    .query('DELETE FROM Users WHERE userID = @userID');
};

exports.getUserInfo = async (userID) => {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userID', sql.VarChar(20), userID)
    .query('SELECT userID, username, createdAt, updatedAt FROM Users WHERE userID = @userID');
  return result.recordset[0];
};
