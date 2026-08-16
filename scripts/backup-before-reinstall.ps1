# ============================================================================
# backup-before-reinstall.ps1 — copy everything needed to restore Oswald onto
# a new OS, to a destination OUTSIDE the drive you're about to wipe.
#
# Backs up:
#   1. The oswald repo (code + .env with JWT/DB config + schema/migrations),
#      excluding node_modules / .git / temp / logs.
#   2. The LocalDB data files (the actual DB_Oswald rows), so you don't have
#      to re-seed from scratch.
#   3. A restore README with the exact steps to bring it back.
#
# Usage (run from the repo root, non-elevated is fine):
#   powershell -ExecutionPolicy Bypass -File scripts\backup-before-reinstall.ps1 -Dest D:\oswald-backup
#   (use any path on a DIFFERENT drive/partition than the one being wiped)
# ============================================================================
param([string]$Dest = '')

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $Dest) {
    Write-Host "Usage:  -Dest <destination folder on another drive>"
    Write-Host "Example: powershell -ExecutionPolicy Bypass -File scripts\backup-before-reinstall.ps1 -Dest D:\oswald-backup"
    exit 1
}
$Dest = $Dest.TrimEnd('\')

# sanity: destination must not be under the repo or the LocalDB folder
if ($Dest -like "$root*" -or $Dest -like "$env:USERPROFILE\AppData\Local\Microsoft\Microsoft SQL Server*") {
    Write-Host "ERROR: destination must be on a DIFFERENT drive/partition than the source." -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Path $Dest -Force | Out-Null
$log = Join-Path $Dest 'backup-report.txt'
Set-Content -Path $log -Value "Backup started $(Get-Date)" -Encoding UTF8
function Note($m) { Add-Content -Path $log -Value $m; Write-Host $m }

# --- 1. repo (code + .env + schema), excluding heavy/transient dirs ---------
Note "=== 1/3 Repo: $root -> $Dest\oswald ==="
robocopy $root (Join-Path $Dest 'oswald') /E /XD node_modules .git temp "public\resources" /XF server.log server.err.log fileserver.log fileserver.err.log /NFL /NDL /NJH /NJS /NP | Out-Null
Note "  robocopy exit: $LASTEXITCODE (0/1 = ok)"

# user data under public\resources (uploads, fileserver storage)
if (Test-Path (Join-Path $root 'public\resources')) {
    Note "=== 1b/3 user data: public\resources -> $Dest\oswald\public\resources ==="
    robocopy (Join-Path $root 'public\resources') (Join-Path $Dest 'oswald\public\resources') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Note "  robocopy exit: $LASTEXITCODE"
}

# --- 2. LocalDB data files (actual DB_Oswald rows) ---------------------------
$ldb = "$env:USERPROFILE\AppData\Local\Microsoft\Microsoft SQL Server Local DB\Instances\MSSQLLocalDB"
Note "=== 2/3 LocalDB data: $ldb -> $Dest\localdb-data ==="
if (Test-Path $ldb) {
    robocopy $ldb (Join-Path $Dest 'localdb-data') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Note "  robocopy exit: $LASTEXITCODE (0/1 = ok)"
} else {
    Note "  LocalDB instance folder not found - skipping (you can rebuild DB_Oswald from sql\schema + sql\migrations later)"
}

# --- 3. restore README --------------------------------------------------------
$readme = Join-Path $Dest 'RESTORE-README.txt'
@'
OSWALD RESTORE (on the new OS)
==============================
1. Install Node.js LTS.
2. Copy the oswald folder back, e.g. to C:\Users\<you>\Desktop\oswald.
3. Install LocalDB (part of SQL Server Express; the Express setup includes it)
   OR use your normal SQL Server.
4. From the oswald folder:
     npm install
     cd fileserver && npm install && cd ..
5. Create the database:
   - LocalDB:   SqlLocalDB start MSSQLLocalDB
   - then run sql\schema\DB_init_table.sql  and then every sql\migrations\*.sql
     EXCEPT 001_* (drift-fix superseded by 002). sqlcmd -S "(localdb)\MSSQLLocalDB" -E -i <file>
   - .env already contains DB_DRIVER=msnodesqlv8, DB_SERVER=(localdb)\MSSQLLocalDB,
     DB_DATABASE=DB_Oswald, and your JWT_SECRET.
6. (Optional) If you also restored localdb-data, you can attach DB_Oswald instead:
     copy the .mdf/.ldf from localdb-data into a folder, then:
     CREATE DATABASE DB_Oswald ON (FILENAME='...\DB_Oswald.mdf'), (FILENAME='...\DB_Oswald_log.ldf') FOR ATTACH;
7. Start:  .\start-detached.ps1   and   .\start-fileserver.ps1
8. Verify: http://127.0.0.1:8080/api/health  -> {"db":true}
   Login: oswald_admin / admin  (change it immediately)
'@ -replace "`r`n", "`n" | Set-Content -Path $readme -Encoding UTF8
Note "=== 3/3 wrote $readme ==="

Note ""
Note "DONE. Backup contents:"
Get-ChildItem $Dest | ForEach-Object { Note "  $($_.Name) ($(if ($_.PSIsContainer) { 'folder' } else { "$($_.Length) bytes" }))" }
Note "Report: $log"
