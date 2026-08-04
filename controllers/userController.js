const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/userModel');
const Role = require('../models/roleModel');

const DEFAULT_ROLE = 'user';

async function registerUser(req, res, next) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.createUser(username, hashedPassword);
    // New accounts get the read-only baseline role; an admin promotes them later.
    const created = await User.findUserByUsername(username);
    await Role.assignRole(created.id, DEFAULT_ROLE);

    res.status(201).json({ message: 'User registered successfully', role: DEFAULT_ROLE });
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

    const [roles, permissions] = await Promise.all([
      Role.getRolesForUser(user.id),
      Role.getPermissionsForUser(user.id),
    ]);

    const token = jwt.sign({ userID: user.id, roles, permissions }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    res.status(200).json({ message: 'Login successful', token, roles, permissions });
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

    const [roles, permissions] = await Promise.all([
      Role.getRolesForUser(userID),
      Role.getPermissionsForUser(userID),
    ]);

    res.status(200).json({ ...user, roles, permissions });
  } catch (err) {
    next(err);
  }
}

// GET /api/users/roles — list roles + permissions (admin only).
async function getRoles(req, res, next) {
  try {
    const [roles, permissions] = await Promise.all([
      Role.getAllRoles(),
      Role.getAllPermissions(),
    ]);
    res.json({ roles, permissions });
  } catch (err) {
    next(err);
  }
}

// PUT /api/users/:userId/role — grant a role to a user (admin only).
async function assignUserRole(req, res, next) {
  const { userId } = req.params;
  const { role } = req.body;
  const parsedId = Number.parseInt(userId, 10);

  if (!Number.isInteger(parsedId)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  if (!role || typeof role !== 'string') {
    return res.status(400).json({ error: 'role is required' });
  }

  try {
    await Role.assignRole(parsedId, role);
    res.json({ message: `Role "${role}" assigned` });
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
  getRoles,
  assignUserRole,
};
