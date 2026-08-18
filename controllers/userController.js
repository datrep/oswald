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
    const created = await User.findUserByUsername(username);

    // First-run bootstrap: the very first account becomes admin so a fresh
    // install isn't locked out (the dashboard has no other sign-up path).
    const userCount = await User.countUsers();
    const roleName = userCount <= 1 ? 'admin' : DEFAULT_ROLE;
    await Role.assignRole(created.id, roleName);

    res.status(201).json({ message: 'User registered successfully', role: roleName });
  } catch (err) {
    next(err);
  }
}

// GET /api/users/bootstrap — public: whether a first-run admin needs creating.
async function bootstrapStatus(req, res, next) {
  try {
    const userCount = await User.countUsers();
    res.json({ needsSetup: userCount === 0 });
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
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Account disabled — contact an administrator' });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid username or password' });

    const [roles, permissions] = await Promise.all([
      Role.getRolesForUser(user.id),
      Role.getPermissionsForUser(user.id),
    ]);

    // `v` = Users.tokenVersion: the auth middleware re-checks it on every request,
    // so an access-control change (role/password/disable) revokes this token at once.
    const token = jwt.sign({ userID: user.id, roles, permissions, v: user.tokenVersion }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    // Record the login session (best-effort — never block login on a log failure)
    // and hand back its id so the client can heartbeat it (UAC-5 live presence).
    let sessionId = null;
    try {
      sessionId = await User.addSession(user.id, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500));
    } catch { /* logging is best-effort */ }

    res.status(200).json({ message: 'Login successful', token, roles, permissions, sessionId });
  } catch (err) {
    next(err);
  }
}

// UAC-5: POST /api/users/heartbeat — bumps lastSeenAt for the current user's
// session row (called ~every 60s while logged in). Requires a valid token;
// the sessionId must belong to the caller (the model enforces it).
async function heartbeat(req, res, next) {
  const sessionId = Number.parseInt(req.body && req.body.sessionId, 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  try {
    await User.touchSession(sessionId, req.user.userID);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// UAC-5: GET /api/users/online — distinct users online in the last 3 minutes.
async function getOnline(req, res, next) {
  try {
    const minutes = Math.max(1, Math.min(30, Number.parseInt(req.query.minutes, 10) || 3));
    const online = await User.getOnlineUsers(minutes);
    res.json({ online });
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

// DELETE /api/users/:userId — admin-only delete with guards (users.manage).
async function deleteUser(req, res, next) {
  const targetId = Number.parseInt(req.params.userId, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Invalid user id' });
  if (targetId === req.user.userID) return res.status(400).json({ error: 'You cannot delete your own account' });

  try {
    const roles = await Role.getRolesForUser(targetId);
    if (roles.includes('admin')) {
      const adminCount = await Role.countUsersWithRole('admin');
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    await User.deleteUser(targetId);
    res.json({ message: 'User deleted' });
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

// GET /api/users — list all users with their roles (admin only).
async function getAllUsers(req, res, next) {
  try {
    const users = await User.getAllUsersWithRoles();
    res.json({ users });
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

// GET /api/users/:userId/sessions — recent login sessions for one user (admin only).
async function getUserSessions(req, res, next) {
  const userId = Number.parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const limit = Math.min(Number.parseInt(req.query.limit || '10', 10) || 10, 50);
    const sessions = await User.getSessionsByUser(userId, limit);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
}

// UAC-5: GET /api/sessions — recent logins across all users (users.manage).
async function getSessions(req, res, next) {
  try {
    const limit = Math.max(1, Math.min(50, Number.parseInt(req.query.limit, 10) || 20));
    const sessions = await User.getAllSessions(limit);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
}

// PUT /api/users/:userId/role — set a user's role to exactly one role (admin only).
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
  if (parsedId === req.user.userID) {
    return res.status(400).json({ error: 'You cannot change your own role' });
  }

  try {
    // Last-admin guard: never demote the final admin.
    if (role !== 'admin') {
      const roles = await Role.getRolesForUser(parsedId);
      if (roles.includes('admin')) {
        const adminCount = await Role.countUsersWithRole('admin');
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot demote the last admin' });
        }
      }
    }
    await Role.setRole(parsedId, role);
    res.json({ message: `Role set to "${role}"` });
  } catch (err) {
    next(err);
  }
}

// PUT /api/users/:userId/roles — set a user's roles to exactly this set (multi-role).
async function setUserRoles(req, res, next) {
  const userId = Number.parseInt(req.params.userId, 10);
  const roles = req.body?.roles;
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (!Array.isArray(roles)) return res.status(400).json({ error: 'roles array is required' });
  if (userId === req.user.userID) return res.status(400).json({ error: 'You cannot change your own roles' });

  try {
    const valid = (await Role.getAllRoles()).map((r) => r.name);
    const bad = roles.filter((r) => !valid.includes(r));
    if (bad.length) return res.status(400).json({ error: 'Unknown role(s): ' + bad.join(', ') });
    // Last-admin guard when removing 'admin' from the target.
    if (!roles.includes('admin')) {
      const current = await Role.getRolesForUser(userId);
      if (current.includes('admin')) {
        const adminCount = await Role.countActiveUsersWithRole('admin');
        if (adminCount <= 1) return res.status(400).json({ error: 'Cannot remove the last active admin' });
      }
    }
    await Role.setRoles(userId, roles);
    res.json({ message: 'Roles updated — sessions revoked' });
  } catch (err) {
    next(err);
  }
}

// PUT /api/users/:userId/active — enable/disable an account (disable revokes sessions).
async function setUserActive(req, res, next) {
  const userId = Number.parseInt(req.params.userId, 10);
  const isActive = req.body?.isActive;
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (typeof isActive !== 'boolean') return res.status(400).json({ error: 'isActive boolean is required' });
  if (userId === req.user.userID) return res.status(400).json({ error: 'You cannot disable your own account' });

  try {
    if (!isActive) {
      const roles = await Role.getRolesForUser(userId);
      if (roles.includes('admin')) {
        const activeAdmins = await Role.countActiveUsersWithRole('admin');
        if (activeAdmins <= 1) return res.status(400).json({ error: 'Cannot disable the last active admin' });
      }
    }
    await User.setIsActive(userId, isActive);
    res.json({ message: isActive ? 'Account enabled' : 'Account disabled — sessions revoked' });
  } catch (err) {
    next(err);
  }
}

// PUT /api/users/:userId/password — admin password reset (revokes all sessions).
async function resetUserPassword(req, res, next) {
  const userId = Number.parseInt(req.params.userId, 10);
  const password = req.body?.password;
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const hashed = await bcrypt.hash(password, 10);
    await User.resetPassword(userId, hashed);
    res.json({ message: 'Password reset — all sessions revoked' });
  } catch (err) {
    next(err);
  }
}

// POST /api/users/roles — create a role (optional permission set).
async function createRole(req, res, next) {
  const { name, description, permissions } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  try {
    const id = await Role.createRole(name.trim(), description);
    if (Array.isArray(permissions)) await Role.setRolePermissions(id, permissions);
    res.status(201).json({ message: 'Role created', id });
  } catch (err) {
    next(err);
  }
}

// PUT /api/users/roles/:roleId — rename/redescribe + replace permission set.
async function updateRole(req, res, next) {
  const roleId = Number.parseInt(req.params.roleId, 10);
  const { name, description, permissions } = req.body || {};
  if (!Number.isInteger(roleId)) return res.status(400).json({ error: 'Invalid role id' });
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  try {
    await Role.updateRole(roleId, name.trim(), description);
    if (Array.isArray(permissions)) await Role.setRolePermissions(roleId, permissions);
    res.json({ message: 'Role updated — holders logged out' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/users/roles/:roleId — remove a role (assignments cascade away).
async function deleteRole(req, res, next) {
  const roleId = Number.parseInt(req.params.roleId, 10);
  if (!Number.isInteger(roleId)) return res.status(400).json({ error: 'Invalid role id' });
  try {
    const role = (await Role.getAllRoles()).find((r) => r.id === roleId);
    if (!role) return res.status(404).json({ error: 'Role not found' });
    if (role.name === 'admin') return res.status(400).json({ error: 'The admin role cannot be deleted' });
    await Role.deleteRole(roleId);
    res.json({ message: 'Role deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  registerUser,
  bootstrapStatus,
  loginUser,
  heartbeat,
  getOnline,
  updateUser,
  deleteUser,
  getUserInfo,
  getAllUsers,
  getRoles,
  getUserSessions,
  getSessions,
  assignUserRole,
  setUserRoles,
  setUserActive,
  resetUserPassword,
  createRole,
  updateRole,
  deleteRole,
};
