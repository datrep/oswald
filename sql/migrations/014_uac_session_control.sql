-- 014_uac_session_control.sql
-- UAC robustness (opsec): add per-user session control to Users.
--   isActive     BIT  DEFAULT 1  — disable an account (login blocked, sessions revoked)
--   tokenVersion INT  DEFAULT 0  — bumped on any access-control change (role, password,
--                                  disable, delete) to invalidate all existing JWTs
--                                  immediately (the JWT carries `v` and the auth
--                                  middleware verifies it against this value).
--
-- Applied: 2026-08-06

PRINT 'Adding Users.isActive / Users.tokenVersion...';
IF COL_LENGTH('dbo.Users', 'isActive') IS NULL
BEGIN
    ALTER TABLE dbo.Users ADD isActive BIT NOT NULL DEFAULT 1;
    PRINT '  isActive added.';
END
ELSE
    PRINT '  isActive already exists.';

IF COL_LENGTH('dbo.Users', 'tokenVersion') IS NULL
BEGIN
    ALTER TABLE dbo.Users ADD tokenVersion INT NOT NULL DEFAULT 0;
    PRINT '  tokenVersion added.';
END
ELSE
    PRINT '  tokenVersion already exists.';
GO

PRINT 'Done.';
GO
