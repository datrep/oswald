-- 005_fileserver_metadata.sql
-- FS-2: DB metadata for the Oswald fileserver (separate service).
--   * FileServerACLs   — per-user, per-folder read/write grants/denies
--   * FileFavorites    — per-user starred files
--   * FileTags         — per-file tags
--   * Also grants files.read to the baseline 'user' role (read-only default:
--     every registered account can browse/download, but cannot write unless
--     an admin grants it via files.write or a folder ACL).
-- Run as sa:  sqlcmd -S localhost,1433 -U sa -P '<pwd>' -d DB_Oswald -i sql\migrations\005_fileserver_metadata.sql

IF OBJECT_ID(N'dbo.FileServerACLs', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FileServerACLs (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        userId      INT NOT NULL,
        rootId      NVARCHAR(64)  NOT NULL,               -- matches fileserver config.json root id
        folderPath  NVARCHAR(512) NOT NULL DEFAULT '',    -- '' = the whole root; otherwise a folder rel path
        canRead     BIT NOT NULL DEFAULT 1,
        canWrite    BIT NOT NULL DEFAULT 0,
        createdBy   INT NULL,
        createdAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_FileServerACLs UNIQUE (userId, rootId, folderPath)
    );
    CREATE INDEX IX_FileServerACLs_user ON dbo.FileServerACLs (userId, rootId);
END
GO

IF OBJECT_ID(N'dbo.FileFavorites', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FileFavorites (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        userId      INT NOT NULL,
        rootId      NVARCHAR(64)  NOT NULL,
        filePath    NVARCHAR(1024) NOT NULL,              -- rel path (file or folder)
        createdAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_FileFavorites UNIQUE (userId, rootId, filePath)
    );
    CREATE INDEX IX_FileFavorites_user ON dbo.FileFavorites (userId, rootId);
END
GO

IF OBJECT_ID(N'dbo.FileTags', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.FileTags (
        id          INT IDENTITY(1,1) PRIMARY KEY,
        rootId      NVARCHAR(64)  NOT NULL,
        filePath    NVARCHAR(1024) NOT NULL,              -- rel path (file or folder)
        tag         NVARCHAR(64)  NOT NULL,
        createdBy   INT NULL,
        createdAt   DATETIME2 NOT NULL DEFAULT SYSDATETIME(),
        CONSTRAINT UQ_FileTags UNIQUE (rootId, filePath, tag)
    );
    CREATE INDEX IX_FileTags_tag ON dbo.FileTags (tag);
END
GO

-- Give the baseline 'user' role files.read (browse + download) so registered
-- accounts are read-only by default; writes stay gated behind files.write / ACLs.
IF NOT EXISTS (
    SELECT 1 FROM dbo.RolePermissions rp
    JOIN dbo.Roles r ON r.id = rp.roleId
    JOIN dbo.Permissions p ON p.id = rp.permissionId
    WHERE r.name = 'user' AND p.code = 'files.read'
)
BEGIN
    INSERT INTO dbo.RolePermissions (roleId, permissionId)
    SELECT r.id, p.id
    FROM dbo.Roles r CROSS JOIN dbo.Permissions p
    WHERE r.name = 'user' AND p.code = 'files.read';
END
GO

-- Verify
SELECT r.name AS role, p.code AS permission
FROM dbo.RolePermissions rp
JOIN dbo.Roles r ON r.id = rp.roleId
JOIN dbo.Permissions p ON p.id = rp.permissionId
WHERE r.name IN ('admin','user')
ORDER BY r.name, p.code;
GO
