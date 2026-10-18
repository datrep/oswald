-- 016_user_sessions_lastseen.sql
-- UAC-5: live presence (heartbeat). Adds lastSeenAt to UserSessions so the
-- dashboard can show who is online right now. The client heartbeats its
-- session row every ~60s while logged in; a row whose lastSeenAt is within the
-- last ~3 minutes counts as "online".
--
-- Applied: 2026-08-18

PRINT 'Adding UserSessions.lastSeenAt...';
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.UserSessions') AND name = 'lastSeenAt'
)
BEGIN
    ALTER TABLE UserSessions ADD lastSeenAt DATETIME NULL;
    PRINT '  lastSeenAt column added.';
END
ELSE
    PRINT '  lastSeenAt already exists.';
GO

-- Backfill: historical sessions are treated as last seen at login time.
UPDATE UserSessions SET lastSeenAt = loggedInAt WHERE lastSeenAt IS NULL;
GO

-- Lookup index for the "online users" query (recent lastSeenAt scan).
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE name = 'IX_UserSessions_lastSeen'
)
BEGIN
    CREATE INDEX IX_UserSessions_lastSeen ON UserSessions(lastSeenAt);
    PRINT '  IX_UserSessions_lastSeen created.';
END
GO

PRINT 'Done.';
GO
