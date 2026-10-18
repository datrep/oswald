# ============================================================================
# repair-sql.ps1 — repair (or, if needed, reinstall) the SQL Server SQLEXPRESS
# instance using the on-disk SQL Server 2025 setup media.
#
# Self-elevates (one UAC consent) and writes progress to temp\sql-repair.log.
# Strategy: REPAIR first (least destructive). If the service still won't start
# after repair, UNINSTALL + REINSTALL the engine feature.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\repair-sql.ps1
# ============================================================================

$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-repair.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on the UAC prompt)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host "Repair run finished. Log: $logFile"
    exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

$setup   = 'C:\Program Files\Microsoft SQL Server\170\Setup Bootstrap\SQL2025\setup.exe'
$svcName = 'MSSQL$SQLEXPRESS'
$features = 'SQLENGINE'          # SQL_Engine_Core_Inst feature (Express engine)

function Test-SqlRunning([int]$seconds = 20) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $seconds) {
        $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if ($s -and $s.Status -eq 'Running') { return $true }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

function Invoke-Setup([string]$mode) {
    Log ""
    Log "==== setup /ACTION=$mode ===="
    $args = @(
        '/ACTION=' + $mode,
        '/FEATURES=' + $features,
        '/INSTANCENAME=SQLEXPRESS',
        '/Q',
        '/QUIET',
        '/IACCEPTSQLSERVERLICENSETERMS',
        '/SUPPRESSPRIVACYSTATEMENTNOTICE'
    )
    if ($mode -in @('Install')) {
        $args += '/SQLSYSADMINACCOUNTS=BUILTIN\Administrators'
        $args += '/TCPENABLED=1'
        $args += '/NPENABLED=1'
        $args += '/SECURITYMODE=SQL'
    }
    Log "  running: $setup $($args -join ' ')"
    $proc = Start-Process -FilePath $setup -ArgumentList $args -Wait -PassThru -NoNewWindow
    Log "  setup $mode exited with code $($proc.ExitCode)"
    Log "  (0 or 3010 = success; 3010 means a reboot is recommended)"
    return $proc.ExitCode
}

Log "==== SQL REPAIR $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (IsAdmin: $isAdmin)"
Log "setup: $setup"
Log "service: $svcName"

# --- Before state
$s0 = Get-Service -Name $svcName -ErrorAction SilentlyContinue
Log "Before: service status = $($s0.Status)"

# --- Phase 1: REPAIR
$code = Invoke-Setup 'Repair'

if (Test-SqlRunning 30) {
    Log "OK: service is RUNNING after Repair."
} else {
    Log "Service NOT running after Repair (setup exit $code). Trying Uninstall + Reinstall."
    $codeU = Invoke-Setup 'Uninstall'
    Log "Uninstall exit: $codeU"
    Start-Sleep -Seconds 5
    $codeI = Invoke-Setup 'Install'
    Log "Install exit: $codeI"
}

# --- After state + verify
Start-Sleep -Seconds 5
$s1 = Get-Service -Name $svcName -ErrorAction SilentlyContinue
Log ""
Log "After: service status = $($s1.Status)"
if (Test-SqlRunning 30) {
    Log "RESULT: SUCCESS - $svcName is Running."
    Log "  TCP 1433 listening: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
} else {
    Log "RESULT: FAILED - $svcName did not start. Dumping ERRORLOG tail:"
    $errLog = 'C:\Program Files\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQL\Log\ERRORLOG'
    if (Test-Path $errLog) { Get-Content $errLog -Tail 40 | ForEach-Object { Log "  $_" } } else { Log "  (no ERRORLOG)" }
    $q = sc.exe queryex $svcName 2>&1 | Out-String
    Log $q
}

Log ""
Log "==== REPAIR COMPLETE $(Get-Date) ===="
Write-Host "`nLog written to: $logFile"
