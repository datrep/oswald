-- 034_lab_verdict_width.sql
-- TRD-14 hotfix (2026-09-10): 'INSUFFICIENT-DATA' is 17 chars — the verdict
-- column created by migration 032 as NVARCHAR(16) cannot hold it, and the
-- first lockbox release failed on the verdict write. Widen to NVARCHAR(24).
IF COL_LENGTH('LabCandidates', 'verdict') IS NOT NULL
  ALTER TABLE LabCandidates ALTER COLUMN verdict NVARCHAR(24) NULL;
GO
