# ============================================================================
# setup-sqlexpress-db.ps1 - create DB_Oswald in the SQLEXPRESS instance
# (localhost,1435) from the repo schema + migrations, set a strong api_user
# password, and verify. Uses sqlcmd with Windows auth (your account is sysadmin
# via BUILTIN\Administrators).
#
#   - schema:  sql/schema/DB_init_table.sql   (creates DB + tables + seed)
#   - migrate: sql/migrations/002..015        (001 is a drift-fix, superseded)
#   - api_user login gets a strong password (written to temp)
#
# Logs to temp\setup-sqlexpress-db.log
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'setup-sqlexpress-db.log'
Remove-Item $logFile -ErrorAction SilentlyContinue
$pwFile = Join-Path $logDir 'sqlexpress-api-password.txt'

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

$sqlcmd = 'C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE'
$S = 'localhost,1435'

Log "==== SETUP DB_Oswald IN SQLEXPRESS $(Get-Date) ===="

# --- 1. sysadmin check (Windows auth) ---
Log '--- sysadmin check ---'
$role = & $sqlcmd -S $S -E -h -1 -W -Q "SELECT IS_SRVROLEMEMBER('sysadmin')" 2>&1 | Out-String
Log "  IS_SRVROLEMEMBER('sysadmin') = $($role.Trim())"
if ($role.Trim() -ne '1') {
    Log '  WARNING: not sysadmin - schema/migration may fail. Try from an elevated prompt.'
}

# --- 2. schema (creates DB_Oswald, tables, seed, api_user login) ---
Log '--- running schema ---'
& $sqlcmd -S $S -E -b -i (Join-Path $root 'sql\schema\DB_init_table.sql') 2>&1 | Out-String | ForEach-Object { Log "  $_" }
Log "  schema exit: $LASTEXITCODE"

# --- 3. migrations 002..015 ---
Log '--- running migrations (002..015) ---'
$migs = Get-ChildItem (Join-Path $root 'sql\migrations') -Filter '*.sql' | Sort-Object Name | Where-Object { $_.Name -notlike '001_*' }
foreach ($m in $migs) {
    Log "  $($m.Name) ..."
    & $sqlcmd -S $S -d DB_Oswald -E -b -i $m.FullName 2>&1 | Out-String | ForEach-Object { Log "    $_" }
    if ($LASTEXITCODE -ne 0) { Log "  MIGRATION FAILED: $($m.Name)" }
}

# --- 4. strong api_user password ---
$set = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
$b = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$pw = -join ($b | ForEach-Object { $set[$_ % $set.Length] })
Log '--- setting api_user password ---'
& $sqlcmd -S $S -E -b -Q "ALTER LOGIN [api_user] WITH PASSWORD = N'$pw'" 2>&1 | Out-String | ForEach-Object { Log "  $_" }
Log "  password written to $pwFile"
Set-Content -Path $pwFile -Value $pw -Encoding Ascii

# --- 5. verify ---
Log '--- verify ---'
& $sqlcmd -S $S -d DB_Oswald -E -h -1 -W -Q "SELECT 'tables=' + CAST(COUNT(*) AS VARCHAR) FROM sys.tables; SELECT 'users=' + CAST(COUNT(*) AS VARCHAR) FROM dbo.Users;" 2>&1 | Out-String | ForEach-Object { Log "  $_" }
# test SQL auth as api_user
& $sqlcmd -S $S -d DB_Oswald -U api_user -P $pw -h -1 -W -Q "SELECT 'sql-auth-ok' AS t" 2>&1 | Out-String | ForEach-Object { Log "  api_user sql-auth: $_" }

Log '==== COMPLETE ===='
