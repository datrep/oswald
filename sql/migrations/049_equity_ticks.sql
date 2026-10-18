-- RENUMBERED 2026-10-18: was 032_equity_ticks.sql, which collided with 032_lab_scoreboard.sql (both were already applied; migrations here are applied by hand and guard with IF OBJECT_ID, so the number was bookkeeping only). Content unchanged. Next free number after 048.
-- 032_equity_ticks.sql — fine-grained equity series (equity-curve persistence).
-- 2026-09-11: the equity chart kept its 1s-resolution tail ONLY in the browser
-- tab; a reload collapsed the curve back to the 30s/wake-cadence server
-- history ("equity curve data not saved between sessions"). The account poller
-- now banks a tick every <=5s here, so the fine curve survives page reloads,
-- browser restarts and desk restarts. Retained 30 days (hourly prune).
IF OBJECT_ID('EquityTicks', 'U') IS NULL
BEGIN
    CREATE TABLE EquityTicks (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        userId INT NOT NULL,
        equity DECIMAL(18,6) NOT NULL,
        pnl DECIMAL(18,6) NULL,
        at DATETIME2 NOT NULL CONSTRAINT DF_EquityTicks_at DEFAULT GETUTCDATE(),
        CONSTRAINT FK_EquityTicks_user FOREIGN KEY (userId) REFERENCES Users(id) ON DELETE CASCADE
    );
    CREATE INDEX IX_EquityTicks_user_at ON EquityTicks(userId, at DESC);
END
GO
