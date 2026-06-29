const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const sql = require('mssql');
const { getPool } = require('../config/db');

async function registerUser(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const pool = await getPool();

    // Filter to only valid U-prefixed IDs with numeric suffixes
    const result = await pool.request().query(`
      SELECT MAX(CAST(SUBSTRING(userID, 2, LEN(userID) - 1) AS INT)) AS maxId 
      FROM Users 
      WHERE userID LIKE 'U%' 
        AND ISNUMERIC(SUBSTRING(userID, 2, LEN(userID) - 1)) = 1
    `);

    const nextId = (result.recordset[0].maxId || 0) + 1;
    const userID = `U${nextId}`;

    await pool.request()
      .input('userID', sql.VarChar(20), userID)
      .input('username', sql.VarChar(50), username)
      .input('passwordHash', sql.VarChar(255), hashedPassword)
      .query(`
        INSERT INTO Users (userID, username, passwordHash)
        VALUES (@userID, @username, @passwordHash)
      `);

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

async function loginUser(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('username', sql.VarChar(50), username)
      .query('SELECT * FROM Users WHERE username = @username');

    const user = result.recordset[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ userID: user.userID }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.status(200).json({ message: 'Login successful', token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

async function updateUser(req, res) {
  const { username, password } = req.body;
  const userID = req.user.userID;

  try {
    const pool = await getPool();
    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.request()
      .input('userID', sql.VarChar(20), userID)
      .input('username', sql.VarChar(50), username)
      .input('passwordHash', sql.VarChar(255), hashedPassword)
      .query(`
        UPDATE Users SET username = @username, passwordHash = @passwordHash, updatedAt = GETDATE()
        WHERE userID = @userID
      `);

    res.json({ message: 'User updated successfully' });
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

async function deleteUser(req, res) {
  const userID = req.user.userID;

  try {
    const pool = await getPool();
    await pool.request()
      .input('userID', sql.VarChar(20), userID)
      .query(`DELETE FROM Users WHERE userID = @userID`);

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

async function getUserInfo(req, res) {
  const { userID } = req.user;

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('userID', sql.VarChar(20), userID)
      .query('SELECT userID, username, createdAt, updatedAt FROM Users WHERE userID = @userID');

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json(result.recordset[0]);
  } catch (err) {
    console.error('Error fetching user info:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = {
  registerUser,
  loginUser,
  updateUser,
  deleteUser,
  getUserInfo
};
