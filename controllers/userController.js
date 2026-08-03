const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/userModel');

async function registerUser(req, res, next) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.createUser(username, hashedPassword);

    res.status(201).json({ message: 'User registered successfully' });
  } catch (err) {
    next(err);
  }
}

async function loginUser(req, res, next) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }

  try {
    const user = await User.findUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign({ userID: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.status(200).json({ message: 'Login successful', token });
  } catch (err) {
    next(err);
  }
}

async function updateUser(req, res, next) {
  const { username, password } = req.body;
  const userID = req.user.userID;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.updateUser(userID, username, hashedPassword);

    res.json({ message: 'User updated successfully' });
  } catch (err) {
    next(err);
  }
}

async function deleteUser(req, res, next) {
  const userID = req.user.userID;

  try {
    await User.deleteUser(userID);
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function getUserInfo(req, res, next) {
  const { userID } = req.user;

  try {
    const user = await User.getUserInfo(userID);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json(user);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  registerUser,
  loginUser,
  updateUser,
  deleteUser,
  getUserInfo,
};
