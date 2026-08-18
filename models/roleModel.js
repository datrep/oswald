// models/roleModel.js
// RBAC lookups: roles + permissions for users, and role management.
const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');
const User = require('./userModel');

const repo = new Repository('Roles');

exports.getRolesForUser = async (userId) => {
  const r = await repo.query(
    `SELECT r.name FROM Roles r
     JOIN UserRoles ur ON ur.roleId = r.id
     WHERE ur.userId = @userId`,
    (req) => req.input('userId', sql.Int, userId)
  );
  return r.map((x) => x.name);
};

exports.getPermissionsForUser = async (userId) => {
  const r = await repo.query(
    `SELECT DISTINCT p.code FROM Permissions p
     JOIN RolePermissions rp ON rp.permissionId = p.id
     JOIN UserRoles ur ON ur.roleId = rp.roleId
     WHERE ur.userId = @userId`,
    (req) => req.input('userId', sql.Int, userId)
  );
  return r.map((x) => x.code);
};

exports.assignRole = async (userId, roleName) => {
  await repo.query(
    `INSERT INTO UserRoles (userId, roleId)
     SELECT @userId, id FROM Roles WHERE name = @roleName`,
    (req) => req.input('userId', sql.Int, userId).input('roleName', sql.NVarChar(50), roleName)
  );
};

// Replace a user's roles with a single role (promote/demote semantics).
// Also bumps the user's tokenVersion so old JWT claims die immediately.
exports.setRole = async (userId, roleName) => {
  await repo.query(
    `DELETE FROM UserRoles WHERE userId = @userId;
     INSERT INTO UserRoles (userId, roleId) SELECT @userId, id FROM Roles WHERE name = @roleName;`,
    (req) => req.input('userId', sql.Int, userId).input('roleName', sql.NVarChar(50), roleName)
  );
  await User.bumpTokenVersion(userId);
};

// Replace a user's roles with a set of roles (multi-role assignment).
exports.setRoles = async (userId, roleNames) => {
  const names = [...new Set((roleNames || []).filter(Boolean))];
  await repo.query(`DELETE FROM UserRoles WHERE userId = @userId`, (req) => req.input('userId', sql.Int, userId));
  for (const name of names) {
    await repo.query(
      `INSERT INTO UserRoles (userId, roleId) SELECT @userId, id FROM Roles WHERE name = @roleName`,
      (req) => req.input('userId', sql.Int, userId).input('roleName', sql.NVarChar(50), name)
    );
  }
  await User.bumpTokenVersion(userId);
};

exports.countUsersWithRole = async (roleName) => {
  const r = await repo.query(
    `SELECT COUNT(*) AS n FROM UserRoles ur
     JOIN Roles r ON r.id = ur.roleId
     WHERE r.name = @roleName`,
    (req) => req.input('roleName', sql.NVarChar(50), roleName)
  );
  return r[0].n;
};

// Count of ACTIVE users holding a role (for last-active-admin guards).
exports.countActiveUsersWithRole = async (roleName) => {
  const r = await repo.query(
    `SELECT COUNT(*) AS n FROM UserRoles ur
     JOIN Roles r ON r.id = ur.roleId
     JOIN Users u ON u.id = ur.userId
     WHERE r.name = @roleName AND u.isActive = 1`,
    (req) => req.input('roleName', sql.NVarChar(50), roleName)
  );
  return r[0].n;
};

exports.hasRole = async (userId, roleName) => {
  const roles = await exports.getRolesForUser(userId);
  return roles.includes(roleName);
};

exports.getAllRoles = async () => {
  const r = await repo.query(`
    SELECT r.id, r.name, r.description,
      (SELECT COUNT(*) FROM UserRoles ur WHERE ur.roleId = r.id) AS userCount,
      COALESCE((
        SELECT STRING_AGG(p.code, ',') WITHIN GROUP (ORDER BY p.code)
        FROM RolePermissions rp
        JOIN Permissions p ON p.id = rp.permissionId
        WHERE rp.roleId = r.id
      ), '') AS permissionCodes
    FROM Roles r
    ORDER BY r.name
  `);
  return r.map((x) => ({
    id: x.id,
    name: x.name,
    description: x.description,
    userCount: x.userCount,
    permissions: x.permissionCodes ? x.permissionCodes.split(',').filter(Boolean) : [],
  }));
};

exports.getAllPermissions = async () => {
  return repo.query('SELECT id, code, description FROM Permissions ORDER BY code');
};

// ---- Role CRUD (users.manage) ----
exports.createRole = async (name, description) => {
  const rows = await repo.query(
    `INSERT INTO Roles (name, description) OUTPUT INSERTED.id AS id VALUES (@name, @description)`,
    (req) => req.input('name', sql.NVarChar(50), name).input('description', sql.NVarChar(255), description || null)
  );
  return rows[0].id;
};

exports.updateRole = async (roleId, name, description) => {
  await repo.query(
    `UPDATE Roles SET name = @name, description = @description WHERE id = @roleId`,
    (req) => req.input('roleId', sql.Int, roleId).input('name', sql.NVarChar(50), name).input('description', sql.NVarChar(255), description || null)
  );
};

exports.deleteRole = async (roleId) => {
  await repo.query(`DELETE FROM Roles WHERE id = @roleId`, (req) => req.input('roleId', sql.Int, roleId));
};

// Replace a role's permission set. Bumps every holder's tokenVersion so the new
// permission claims are enforced on their next request (no stale-session window).
exports.setRolePermissions = async (roleId, permissionCodes) => {
  const codes = [...new Set((permissionCodes || []).filter(Boolean))];
  await repo.query(`DELETE FROM RolePermissions WHERE roleId = @roleId`, (req) => req.input('roleId', sql.Int, roleId));
  for (const code of codes) {
    await repo.query(
      `INSERT INTO RolePermissions (roleId, permissionId) SELECT @roleId, id FROM Permissions WHERE code = @code`,
      (req) => req.input('roleId', sql.Int, roleId).input('code', sql.NVarChar(80), code)
    );
  }
  await repo.query(
    `UPDATE Users SET tokenVersion = tokenVersion + 1
     WHERE id IN (SELECT ur.userId FROM UserRoles ur WHERE ur.roleId = @roleId)`,
    (req) => req.input('roleId', sql.Int, roleId)
  );
};
