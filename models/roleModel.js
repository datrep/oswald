// models/roleModel.js
// RBAC lookups: roles + permissions for users, and role management.
const { getPool } = require('../config/db');
const sql = require('mssql');
const User = require('./userModel');

exports.getRolesForUser = async (userId) => {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT r.name FROM Roles r
    JOIN UserRoles ur ON ur.roleId = r.id
    WHERE ur.userId = @userId
  `);
  return r.recordset.map((x) => x.name);
};

exports.getPermissionsForUser = async (userId) => {
  const pool = await getPool();
  const r = await pool.request().input('userId', sql.Int, userId).query(`
    SELECT DISTINCT p.code FROM Permissions p
    JOIN RolePermissions rp ON rp.permissionId = p.id
    JOIN UserRoles ur ON ur.roleId = rp.roleId
    WHERE ur.userId = @userId
  `);
  return r.recordset.map((x) => x.code);
};

exports.assignRole = async (userId, roleName) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('roleName', sql.NVarChar(50), roleName)
    .query(`
      INSERT INTO UserRoles (userId, roleId)
      SELECT @userId, id FROM Roles WHERE name = @roleName
    `);
};

// Replace a user's roles with a single role (promote/demote semantics).
// Also bumps the user's tokenVersion so old JWT claims die immediately.
exports.setRole = async (userId, roleName) => {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('roleName', sql.NVarChar(50), roleName)
    .query(`
      DELETE FROM UserRoles WHERE userId = @userId;
      INSERT INTO UserRoles (userId, roleId) SELECT @userId, id FROM Roles WHERE name = @roleName;
    `);
  await User.bumpTokenVersion(userId);
};

// Replace a user's roles with a set of roles (multi-role assignment).
exports.setRoles = async (userId, roleNames) => {
  const pool = await getPool();
  const names = [...new Set((roleNames || []).filter(Boolean))];
  await pool.request().input('userId', sql.Int, userId).query(`DELETE FROM UserRoles WHERE userId = @userId`);
  for (const name of names) {
    await pool
      .request()
      .input('userId', sql.Int, userId)
      .input('roleName', sql.NVarChar(50), name)
      .query(`INSERT INTO UserRoles (userId, roleId) SELECT @userId, id FROM Roles WHERE name = @roleName`);
  }
  await User.bumpTokenVersion(userId);
};

exports.countUsersWithRole = async (roleName) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('roleName', sql.NVarChar(50), roleName)
    .query(`
      SELECT COUNT(*) AS n FROM UserRoles ur
      JOIN Roles r ON r.id = ur.roleId
      WHERE r.name = @roleName
    `);
  return r.recordset[0].n;
};

// Count of ACTIVE users holding a role (for last-active-admin guards).
exports.countActiveUsersWithRole = async (roleName) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('roleName', sql.NVarChar(50), roleName)
    .query(`
      SELECT COUNT(*) AS n FROM UserRoles ur
      JOIN Roles r ON r.id = ur.roleId
      JOIN Users u ON u.id = ur.userId
      WHERE r.name = @roleName AND u.isActive = 1
    `);
  return r.recordset[0].n;
};

exports.hasRole = async (userId, roleName) => {
  const roles = await this.getRolesForUser(userId);
  return roles.includes(roleName);
};

exports.getAllRoles = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
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
  return r.recordset.map((x) => ({
    id: x.id,
    name: x.name,
    description: x.description,
    userCount: x.userCount,
    permissions: x.permissionCodes ? x.permissionCodes.split(',').filter(Boolean) : [],
  }));
};

exports.getAllPermissions = async () => {
  const pool = await getPool();
  const r = await pool
    .request()
    .query('SELECT id, code, description FROM Permissions ORDER BY code');
  return r.recordset;
};

// ---- Role CRUD (users.manage) ----
exports.createRole = async (name, description) => {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('name', sql.NVarChar(50), name)
    .input('description', sql.NVarChar(255), description || null)
    .query(`INSERT INTO Roles (name, description) OUTPUT INSERTED.id VALUES (@name, @description)`);
  return r.recordset[0].id;
};

exports.updateRole = async (roleId, name, description) => {
  const pool = await getPool();
  await pool
    .request()
    .input('roleId', sql.Int, roleId)
    .input('name', sql.NVarChar(50), name)
    .input('description', sql.NVarChar(255), description || null)
    .query(`UPDATE Roles SET name = @name, description = @description WHERE id = @roleId`);
};

exports.deleteRole = async (roleId) => {
  const pool = await getPool();
  await pool.request().input('roleId', sql.Int, roleId).query(`DELETE FROM Roles WHERE id = @roleId`);
};

// Replace a role's permission set. Bumps every holder's tokenVersion so the new
// permission claims are enforced on their next request (no stale-session window).
exports.setRolePermissions = async (roleId, permissionCodes) => {
  const pool = await getPool();
  const codes = [...new Set((permissionCodes || []).filter(Boolean))];
  await pool.request().input('roleId', sql.Int, roleId).query(`DELETE FROM RolePermissions WHERE roleId = @roleId`);
  for (const code of codes) {
    await pool
      .request()
      .input('roleId', sql.Int, roleId)
      .input('code', sql.NVarChar(80), code)
      .query(`INSERT INTO RolePermissions (roleId, permissionId) SELECT @roleId, id FROM Permissions WHERE code = @code`);
  }
  await pool.request().input('roleId', sql.Int, roleId).query(`
    UPDATE Users SET tokenVersion = tokenVersion + 1
    WHERE id IN (SELECT ur.userId FROM UserRoles ur WHERE ur.roleId = @roleId)
  `);
};
