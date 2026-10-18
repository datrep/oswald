# ============================================================================
# reinstall-sql.ps1 — clean reinstall of SQL Server 2025 SQLEXPRESS after the
# failed repair/uninstall. Self-elevates, logs to temp\sql-reinstall.log.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\reinstall-sql.ps1
# ============================================================================

$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-reinstall.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on the UAC prompt)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host "Reinstall run finished. Log: $logFile"
    exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

$setup    = 'C:\Program Files\Microsoft SQL Server\170\Setup Bootstrap\SQL2025\setup.exe'
$svcName  = 'MSSQL$SQLEXPRESS'
$instFold = 'C:\Program Files\Microsoft SQL Server\MSSQL17.SQLEXPRESS'
$timeoutMin = 15

function Test-SqlRunning([int]$seconds = 25) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $seconds) {
        $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if ($s -and $s.Status -eq 'Running') { return $true }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

Log "==== SQL REINSTALL $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (IsAdmin: $isAdmin)"
Log "setup: $setup"

# --- 1. kill any hung installer processes
Log ""
Log "--- killing hung installer processes (msiexec / setup) ---"
Get-Process msiexec -ErrorAction SilentlyContinue | ForEach-Object {
    Log "  killing msiexec $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Get-Process | Where-Object { $_.Name -match '^setup|sqlsrvsetup|SqlSetup' } -ErrorAction SilentlyContinue | ForEach-Object {
    Log "  killing $($_.Name) $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# --- 2. remove leftover install folder (clean slate)
Log ""
Log "--- removing leftover instance folder ---"
if (Test-Path $instFold) {
    Remove-Item $instFold -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $instFold) { Log "  WARNING: $instFold still present (files locked?)" } else { Log "  removed $instFold" }
} else { Log "  already gone" }

# --- 3. warn if pending renames exist (usually means a reboot is required)
Log ""
$pfro = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -ErrorAction SilentlyContinue).PendingFileRenameOperations
if ($pfro) { Log "  NOTE: PendingFileRenameOperations present - if install fails, a REBOOT is required first." }
else { Log "  no pending file renames" }

# --- 4. run the fresh Install
Log ""
Log "--- setup /ACTION=Install ---"
if (-not (Test-Path $setup)) { Log "  FATAL: setup.exe not found at $setup"; exit 1 }
$args = @(
    '/ACTION=Install',
    '/FEATURES=SQLENGINE',
    '/INSTANCENAME=SQLEXPRESS',
    '/SQLSYSADMINACCOUNTS=BUILTIN\Administrators',
    '/TCPENABLED=1',
    '/NPENABLED=1',
    '/SQLCOLLATION=SQL_Latin1_General_CP1_CI_AS',
    '/Q',
    '/IACCEPTSQLSERVERLICENSETERMS',
    '/SUPPRESSPRIVACYSTATEMENTNOTICE'
)
Log "  running: $setup $($args -join ' ')"
$proc = $null
try {
    $proc = Start-Process -FilePath $setup -ArgumentList $args -PassThru -Wait -ErrorAction Stop
    $code = $proc.ExitCode
} catch {
    Log "  ERROR launching setup: $($_.Exception.Message)"
    $code = -2
}
if ($null -eq $code) { $code = -2 }
Log "  install exit code: $code  (0 or 3010 = success)"

# --- 4b. verify setup actually logged something (i.e. it really ran)
Start-Sleep -Seconds 3
$newLogs = Get-ChildItem 'C:\Program Files\Microsoft SQL Server\170\Setup Bootstrap\Log' -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-2) } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newLogs) {
    Log "  setup wrote log folder: $($newLogs.Name)"
    $s = Join-Path $newLogs.FullName 'Summary*.txt'
    $sf = Get-ChildItem $newLogs.FullName -Filter 'Summary*.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($sf) { Get-Content $sf.FullName -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { Log "    $_" } }
} else {
    Log "  WARNING: setup created NO log folder - the install did not actually run."
}

# --- 5. verify
Start-Sleep -Seconds 6
$svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
Log ""
Log "--- verification ---"
if ($svc) { Log "service $svcName exists: $($svc.Status)" } else { Log "service $svcName DOES NOT EXIST" }
if (Test-SqlRunning 30) {
    Log "RESULT: SUCCESS - SQL Server (SQLEXPRESS) is RUNNING."
    Log "  TCP 1433 listening: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
} else {
    Log "RESULT: FAILED - service did not reach Running."
    $errLog = 'C:\Program Files\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQL\Log\ERRORLOG'
    if (Test-Path $errLog) { Get-Content $errLog -Tail 35 | ForEach-Object { Log "  $_" } }
    sc.exe queryex $svcName 2>&1 | ForEach-Object { Log $_ }
}

Log ""
Log "==== REINSTALL COMPLETE $(Get-Date) ===="
Write-Host "`nLog written to: $logFile"
