-- 015_user_sessions.sql
-- UAC: user login session history (last logged on / devices) for the dashboard.
-- One row per successful login: when, from which IP, and the raw user-agent
-- (the UI derives a short device label from it). Rows cascade away with the user.
--
-- Applied: 2026-08-07

PRINT 'Creating UserSessions table...';
IF OBJECT_ID('dbo.UserSessions', 'U') IS NULL
BEGIN
    CREATE TABLE UserSessions (
        id INT PRIMARY KEY IDENTITY(1,1),
        userId INT NOT NULL,
        userAgent NVARCHAR(500) NULL,
        ip NVARCHAR(64) NULL,
        loggedInAt DATETIME DEFAULT GETUTCDATE(),
        CONSTRAINT FK_UserSessions_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_UserSessions_user ON UserSessions(userId, loggedInAt DESC);
    PRINT '  UserSessions created.';
END
ELSE
    PRINT '  UserSessions already exists.';
GO

PRINT 'Done.';
GO
