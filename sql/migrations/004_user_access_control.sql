-- 004_user_access_control.sql
-- Roles, permissions, and role assignments (RBAC) for per-user access control.
-- Run against DB_Oswald.
--
--   admin  -> all permissions (oswald_admin is seeded as admin)
--   user   -> read-only baseline (no manage permissions) until promoted by an admin

-- Base tables first (dependency order), then the join tables.

IF OBJECT_ID('dbo.Permissions') IS NULL
CREATE TABLE dbo.Permissions (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  code        NVARCHAR(80) NOT NULL UNIQUE,
  description NVARCHAR(255) NULL
);

IF OBJECT_ID('dbo.Roles') IS NULL
CREATE TABLE dbo.Roles (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  name        NVARCHAR(50) NOT NULL UNIQUE,
  description NVARCHAR(255) NULL,
  createdAt   DATETIME DEFAULT GETDATE()
);

IF OBJECT_ID('dbo.UserRoles') IS NULL
CREATE TABLE dbo.UserRoles (
  userId INT NOT NULL,
  roleId INT NOT NULL,
  PRIMARY KEY (userId, roleId),
  CONSTRAINT FK_UserRoles_User FOREIGN KEY (userId) REFERENCES dbo.Users(id) ON DELETE CASCADE,
  CONSTRAINT FK_UserRoles_Role FOREIGN KEY (roleId) REFERENCES dbo.Roles(id) ON DELETE CASCADE
);

IF OBJECT_ID('dbo.RolePermissions') IS NULL
CREATE TABLE dbo.RolePermissions (
  roleId       INT NOT NULL,
  permissionId INT NOT NULL,
  PRIMARY KEY (roleId, permissionId),
  CONSTRAINT FK_RolePermissions_Role FOREIGN KEY (roleId) REFERENCES dbo.Roles(id) ON DELETE CASCADE,
  CONSTRAINT FK_RolePermissions_Permission FOREIGN KEY (permissionId) REFERENCES dbo.Permissions(id) ON DELETE CASCADE
);

-- Seed roles
IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE name = 'admin')
  INSERT INTO dbo.Roles (name, description) VALUES ('admin', 'Full access');
IF NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE name = 'user')
  INSERT INTO dbo.Roles (name, description) VALUES ('user', 'Standard read-only user');

-- Seed permissions
IF NOT EXISTS (SELECT 1 FROM dbo.Permissions)
BEGIN
  INSERT INTO dbo.Permissions (code, description) VALUES
    ('users.manage',       'Manage users, roles and permissions'),
    ('policies.manage',    'Create, edit, delete policies'),
    ('tasks.manage',       'Create, edit, delete tasks'),
    ('resources.manage',   'Upload, edit, delete resources'),
    ('services.manage',    'Manage services'),
    ('monitoring.manage',  'Manage monitored hosts'),
    ('mcp.manage',         'Start/stop the MCP server'),
    ('files.read',         'Read files from the fileserver'),
    ('files.write',        'Write files to the fileserver'),
    ('files.admin',        'Administer the fileserver');
END;

-- Admin role -> every permission
INSERT INTO dbo.RolePermissions (roleId, permissionId)
SELECT r.id, p.id
FROM dbo.Roles r CROSS JOIN dbo.Permissions p
WHERE r.name = 'admin'
  AND NOT EXISTS (SELECT 1 FROM dbo.RolePermissions rp WHERE rp.roleId = r.id AND rp.permissionId = p.id);

-- Assign the existing admin account to the admin role (idempotent)
INSERT INTO dbo.UserRoles (userId, roleId)
SELECT u.id, r.id
FROM dbo.Users u CROSS JOIN dbo.Roles r
WHERE u.username = 'oswald_admin' AND r.name = 'admin'
  AND NOT EXISTS (SELECT 1 FROM dbo.UserRoles ur WHERE ur.userId = u.id AND ur.roleId = r.id);
