# ============================================================================
# archive-old-sql-scripts.ps1 - move the one-off SQL debug/install/experiment
# scripts (and the personal download scripts) into scripts/archive/sql-debug-2026-08/,
# then clear the diagnostic artifacts out of temp/ (keeping runtime fs-* dirs
# and the api_user password file).
#
# Everything moved/deleted is logged to temp\cleanup-report.txt (well, to
# scripts\archive\cleanup-report.txt so it survives the temp wipe).
# ============================================================================

$root = 'C:\Users\datrep\Desktop\oswald'
$src  = Join-Path $root 'scripts'
$arc  = Join-Path $src 'archive\sql-debug-2026-08'
$report = Join-Path $arc 'cleanup-report.txt'
New-Item -ItemType Directory -Path $arc -Force | Out-Null
Set-Content -Path $report -Value "Archive + cleanup report $(Get-Date)"

$toArchive = @(
  'diag-sql.ps1',
  'repair-sql.ps1',
  'reinstall-sql.ps1',
  'install-mssqlserver-2022.ps1',
  'install-mssqlserver.ps1',
  'install-sql-default.ps1',
  'install-sql-default2.ps1',
  'install-sql-express.ps1',
  'install-sql2022.ps1',
  'experiment-protocol.ps1',
  'test-localdb-tcp.ps1',
  'test-sql-restart.ps1',
  'sql-decisive-test.ps1',
  'sqlexpress-start-diag.ps1',
  'etw-registry-capture.ps1',
  'etw-sqlservr-capture.ps1',
  'etw-sqlservr-capture2.ps1',
  'fix-port-conflict.ps1',
  'manual-sql-repair.ps1',
  'sql-repair-2022.ps1',
  'download-fullres-images.js',
  'download-har-images.js',
  'extract-har-images.js'
)

Write-Host '=== Archiving scripts ==='
foreach ($f in $toArchive) {
    $from = Join-Path $src $f
    if (Test-Path $from) {
        Move-Item -Path $from -Destination $arc -Force
        Add-Content -Path $report -Value "  archived: $f"
        Write-Host "  archived: $f"
    } else {
        Add-Content -Path $report -Value "  (not found): $f"
    }
}

Write-Host ''
Write-Host '=== Cleaning temp/ (keeping fs-* dirs + sqlexpress-api-password.txt) ==='
$temp = Join-Path $root 'temp'
Get-ChildItem -Path $temp -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'sqlexpress-api-password.txt' } |
    ForEach-Object {
        Remove-Item -Path $_.FullName -Force -ErrorAction SilentlyContinue
        Add-Content -Path $report -Value "  temp removed: $($_.Name)"
        Write-Host "  temp removed: $($_.Name)"
    }

Write-Host ''
Write-Host "Report: $report"
Write-Host '=== DONE ==='
