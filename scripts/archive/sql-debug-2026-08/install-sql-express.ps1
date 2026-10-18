# ============================================================================
# install-sql-express.ps1 — install SQL Server 2025 Express (instance SQLEXPRESS)
# from the official SSEI bootstrapper. Self-elevates, logs to temp\sql-install.log.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-sql-express.ps1
# ============================================================================

$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-install.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on the UAC prompt)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host "Install run finished. Log: $logFile"
    exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

$installer = Join-Path $env:TEMP 'SQL2025-SSEI-Expr.exe'
# SSEI installs the DEFAULT instance (MSSQLSERVER); bootstrap adapts to whatever exists.
$svcCandidates = @('MSSQL$SQLEXPRESS', 'MSSQLSERVER')

function Test-SqlRunning([int]$seconds = 30) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $seconds) {
        foreach ($n in $svcCandidates) {
            $s = Get-Service -Name $n -ErrorAction SilentlyContinue
            if ($s -and $s.Status -eq 'Running') { return $true }
        }
        Start-Sleep -Milliseconds 800
    }
    return $false
}

Log "==== SQL 2025 EXPRESS INSTALL $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (IsAdmin: $isAdmin)"
if (-not (Test-Path $installer)) { Log "FATAL: installer not found at $installer"; exit 1 }
Log "installer: $installer"

# Kill any stray installer processes first
Get-Process msiexec, setup -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'msiexec|setup' } | ForEach-Object {
    Log "  killing $($_.Name) $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

$args = @(
    '/IACCEPTSQLSERVERLICENSETERMS',
    '/ENU',
    '/ACTION=Install',
    '/quiet'
)
Log "running: $installer $($args -join ' ')"
Log "(SSEI bootstrapper: installs SQL Express default instance (MSSQLSERVER); the Oswald bootstrap auto-detects it and enables TCP on 1433)"
Log "(this downloads the full payload and installs - please be patient)"
$proc = $null
try {
    $proc = Start-Process -FilePath $installer -ArgumentList $args -PassThru -Wait -ErrorAction Stop
    $code = $proc.ExitCode
} catch {
    Log "ERROR launching installer: $($_.Exception.Message)"
    $code = -2
}
if ($null -eq $code) { $code = -2 }
Log "installer exit code: $code  (0 or 3010 = success)"

Start-Sleep -Seconds 6
Log ""
Log "--- verification ---"
$found = $null
foreach ($n in $svcCandidates) {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    if ($s) { $found = $s; break }
}
if ($found) { Log "SQL service found: $($found.Name) : $($found.Status)" } else { Log "no SQL service found (checked: $($svcCandidates -join ', '))" }
if (Test-SqlRunning 30) {
    Log "RESULT: SUCCESS - SQL Server is RUNNING."
    Log "  TCP 1433 listening: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
    if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL') {
        (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { Log "  registered instance: $($_.Name) = $($_.Value)" }
    }
} else {
    Log "RESULT: FAILED - no SQL service running."
    foreach ($n in $svcCandidates) { $q = sc.exe queryex $n 2>&1 | Out-String; Log $q }
    $logs = Get-ChildItem 'C:\Program Files\Microsoft SQL Server\170\Setup Bootstrap\Log' -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($logs) {
        Log "latest setup log folder: $($logs.Name)"
        $sf = Get-ChildItem $logs.FullName -Filter 'Summary*.txt' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($sf) { Get-Content $sf.FullName -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { Log "    $_" } }
    }
}

Log ""
Log "==== INSTALL COMPLETE $(Get-Date) ===="
Write-Host "`nLog written to: $logFile"
