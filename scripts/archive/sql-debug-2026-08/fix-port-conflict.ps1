# ============================================================================
# fix-port-conflict.ps1 - both SQL instances are set to static port 1433, and
# MSSQLSERVER (default) grabbed it at boot, so MSSQL$SQLEXPRESS cannot start.
# Give SQLEXPRESS its own static port (1435) so both can run together.
#
# Confirms the cause from the SQLEXPRESS ERRORLOG, then:
#   1. sets MSSQL16.SQLEXPRESS Tcp/IPAll port to 1435
#   2. clears any stuck SQLEXPRESS service/process
#   3. starts MSSQL$SQLEXPRESS
#   4. verifies both services + both ports
#
# Self-elevates (one UAC click). Logs to temp\fix-port-conflict.log
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\fix-port-conflict.ps1
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'fix-port-conflict.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on the UAC prompt)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host "Elevated run finished. Log: $logFile" -ForegroundColor Cyan
    exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

$SQLEXPR = 'MSSQL16.SQLEXPRESS'
$NEWPORT = 1435

Log "==== FIX PORT CONFLICT $(Get-Date) ===="

# --- confirm the cause from the SQLEXPRESS ERRORLOG ---
$errLog = "C:\Program Files\Microsoft SQL Server\$SQLEXPR\MSSQL\Log\ERRORLOG"
Log '--- SQLEXPRESS ERRORLOG tail (root cause) ---'
if (Test-Path $errLog) {
    Get-Content $errLog -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
} else { Log '  (no ERRORLOG)' }
Log ''

# --- clear any stuck SQLEXPRESS service state ---
$svc = Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
Log "--- service before: $($svc.Status) ---"
if ($svc.Status -ne 'Stopped') {
    try { Stop-Service 'MSSQL$SQLEXPRESS' -Force -ErrorAction Stop; Log '  stopped service' }
    catch { Log "  Stop-Service failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds 3
}
# kill a hung SQLEXPRESS sqlservr if still present (identify by command line -sSQLEXPRESS)
Get-CimInstance Win32_Process -Filter "Name='sqlservr.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-sSQLEXPRESS' } |
    ForEach-Object { Log "  killing stuck sqlservr PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# --- set SQLEXPRESS to its own static port ---
$ipAll = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$SQLEXPR\MSSQLServer\SuperSocketNetLib\Tcp\IPAll"
if (Test-Path $ipAll) {
    Set-ItemProperty -Path $ipAll -Name 'TcpPort' -Value "$NEWPORT" -Type String
    Set-ItemProperty -Path $ipAll -Name 'TcpDynamicPorts' -Value '' -Type String
    Log "  set $ipAll TcpPort = $NEWPORT"
} else { Log "  (missing IPAll key!) $ipAll" }
# legacy key too (32-bit tools / browser)
$legTcp = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp"
if (Test-Path $legTcp) {
    Set-ItemProperty -Path $legTcp -Name 'TcpPort' -Value "$NEWPORT" -Type String
    Log "  set legacy $legTcp TcpPort = $NEWPORT"
}

# --- start it ---
Log "--- starting MSSQL\$SQLEXPRESS ---"
try {
    Start-Service 'MSSQL$SQLEXPRESS' -ErrorAction Stop
    Start-Sleep -Seconds 12
    Log "  MSSQL`$SQLEXPRESS -> $((Get-Service 'MSSQL$SQLEXPRESS').Status)"
} catch {
    Log "  START FAILED: $($_.Exception.Message)"
    Log "  status: $((Get-Service 'MSSQL$SQLEXPRESS').Status)"
}

# --- verify ---
Log '--- verification ---'
Get-Service 'MSSQL$SQLEXPRESS','MSSQLSERVER' -ErrorAction SilentlyContinue | ForEach-Object {
    Log ("  {0,-20} {1}" -f $_.Name, $_.Status)
}
foreach ($port in 1433, $NEWPORT) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); Log "  TCP $port : LISTENING"; $c.Close() }
    catch { Log "  TCP $port : not listening" }
}
Log ''
Log '==== COMPLETE ===='
Log "  SQLEXPRESS now on port $NEWPORT (MSSQLSERVER on 1433)."
Log "  Connect to SQLEXPRESS as: localhost,$NEWPORT"
Log "  Connect to default as:    localhost,1433"
