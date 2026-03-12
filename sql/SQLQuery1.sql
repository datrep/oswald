SELECT name, type_desc FROM sys.server_principals WHERE name = 'imagesapi_user';
-- Should say SQL_LOGIN
USE BEDProject;
GO
SELECT name, type_desc FROM sys.database_principals WHERE name = 'imagesapi_user';
-- Should say SQL_USER
SELECT dp1.name AS RoleName, dp2.name AS MemberName
FROM sys.database_role_members drm
JOIN sys.database_principals dp1 ON drm.role_principal_id = dp1.principal_id
JOIN sys.database_principals dp2 ON drm.member_principal_id = dp2.principal_id
WHERE dp2.name = 'imagesapi_user';
USE BEDProject;
GO
EXECUTE AS USER = 'imagesapi_user';
SELECT * FROM Images;  -- should now succeed
REVERT;
