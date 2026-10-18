# ============================================================================
# fix-sqlexpress-cv.ps1 - recreate the missing CurrentVersion key that the
# ETW trace proved sqlservr needs (MSSQL16.SQLEXPRESS\MSSQLServer\CurrentVersion
# -> 0xC0000034 NAME NOT FOUND -> exit 1046), then start SQLEXPRESS.
#
#   Creates:
#     HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQLServer\CurrentVersion
#         CurrentVersion (String) = 16.0.1000.6
#     (+ same under WOW6432Node, and ensure the legacy key exists)
#   Then starts MSSQL$SQLEXPRESS and verifies.
#
# Self-elevates (one UAC click). Logs to temp\fix-sqlexpress-cv.log
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'fix-sqlexpress-cv.log'
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

Log "==== FIX SQLEXPRESS CURRENTVERSION $(Get-Date) ===="

function Ensure-CurrentVersion {
    param([string]$RootPath)
    $key = "$RootPath\MSSQLServer\CurrentVersion"
    if (-not (Test-Path $key)) {
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name 'CurrentVersion' -Value '16.0.1000.6' -PropertyType String -Force | Out-Null
        Log "  [recreated] $key -> 16.0.1000.6"
    } else {
        Log "  [ok] $key = $((Get-ItemProperty $key).CurrentVersion)"
    }
}

Ensure-CurrentVersion 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS'
Ensure-CurrentVersion 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS'
# legacy instance key (some tools read it)
$legacy = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\SQLEXPRESS\MSSQLServer\CurrentVersion'
if (-not (Test-Path $legacy)) {
    New-Item -Path $legacy -Force | Out-Null
    New-ItemProperty -Path $legacy -Name 'CurrentVersion' -Value '16.0.1000.6' -PropertyType String -Force | Out-Null
    Log "  [recreated] legacy $legacy"
} else {
    Log "  [ok] legacy $legacy = $((Get-ItemProperty $legacy).CurrentVersion)"
}

Log ''
Log '--- starting MSSQL$SQLEXPRESS ---'
$svc = Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
if ($svc.Status -ne 'Stopped') { Stop-Service 'MSSQL$SQLEXPRESS' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
Get-CimInstance Win32_Process -Filter "Name='sqlservr.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-sSQLEXPRESS' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
try {
    Start-Service 'MSSQL$SQLEXPRESS' -ErrorAction Stop
    Start-Sleep -Seconds 12
    Log "  MSSQL`$SQLEXPRESS -> $((Get-Service 'MSSQL$SQLEXPRESS').Status)"
} catch {
    Log "  START FAILED: $($_.Exception.Message)"
    Log "  status: $((Get-Service 'MSSQL$SQLEXPRESS').Status)"
}

Log ''
Log '--- verify ---'
$c = New-Object System.Net.Sockets.TcpClient
foreach ($port in 1433,1435) {
    try { $c.Connect('127.0.0.1', $port); Log "  TCP $port : LISTENING"; $c.Close() } catch { Log "  TCP $port : not listening" }
}
Log '==== COMPLETE ===='
