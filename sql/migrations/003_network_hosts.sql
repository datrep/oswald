-- ============================================================
-- Migration 003 — NetworkHosts table for configurable monitoring
-- Database: DB_Oswald
--
-- Replaces the hardcoded config/ips.txt with a DB table so hosts
-- can be labeled and managed from the dashboard UI.
-- Idempotent.
-- ============================================================

IF NOT EXISTS (
    SELECT 1 FROM sys.tables WHERE name = 'NetworkHosts'
)
BEGIN
    CREATE TABLE NetworkHosts (
        id INT PRIMARY KEY IDENTITY(1,1),
        label NVARCHAR(100) NOT NULL,
        ip NVARCHAR(45) NOT NULL,
        enabled BIT NOT NULL DEFAULT 1,
        sortOrder INT NOT NULL DEFAULT 0
    );

    -- Seed from the previous config/ips.txt values
    INSERT INTO NetworkHosts (label, ip, enabled, sortOrder) VALUES
    ('Host 1', '172.22.160.3', 1, 0),
    ('Host 2', '172.22.160.2', 1, 1),
    ('Host 3', '172.22.160.4', 1, 2);

    PRINT 'NetworkHosts created and seeded.';
END
ELSE
    PRINT 'NetworkHosts already exists - skipping.';
GO
