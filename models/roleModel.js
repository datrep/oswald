// models/roleModel.js
// RBAC lookups: roles + permissions for users, and role management.
const { getPool } = require('../config/db');
const sql = require('mssql');

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

exports.hasRole = async (userId, roleName) => {
  const roles = await this.getRolesForUser(userId);
  return roles.includes(roleName);
};

exports.getAllRoles = async () => {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT r.id, r.name, r.description,
      (SELECT COUNT(*) FROM UserRoles ur WHERE ur.userId = r.id) AS userCount,
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
