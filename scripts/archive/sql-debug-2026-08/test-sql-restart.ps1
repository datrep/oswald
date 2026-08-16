# test-sql-restart.ps1 — controlled test: does the SQLEXPRESS service instance
# survive a plain stop/start (NO registry changes)? Logs to temp\sql-starttest.log.
$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-starttest.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on UAC)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation declined.'; exit 1 }
    Write-Host "Test finished. Log: $logFile"; exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }
function SvcStatus { (Get-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue).Status }

Log "==== SQL RESTART TEST $(Get-Date) ===="
Log "Initial status: $(SvcStatus)"

# Test 1: plain start
Log "--- TEST 1: plain Start-Service (no registry changes) ---"
try { Start-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction Stop; Log "  Start-Service: OK" } catch { Log "  Start-Service FAILED: $($_.Exception.Message)" }
Start-Sleep -Seconds 10
Log "  status after start: $(SvcStatus)"
$t = (Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue)
Log "  TCP 1433 listening: $([bool]$t)"

if ((SvcStatus) -eq 'Running') {
    Log "  -> plain START WORKS."
    # Test 2: plain stop then start again (restart without -Force)
    Log "--- TEST 2: Stop-Service then Start-Service ---"
    Stop-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 5
    Log "  status after stop: $(SvcStatus)"
    try { Start-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction Stop; Log "  Start-Service: OK" } catch { Log "  Start-Service FAILED: $($_.Exception.Message)" }
    Start-Sleep -Seconds 10
    Log "  status after second start: $(SvcStatus)"
} else {
    Log "  -> plain START FAILS. The instance cannot start at all after the installer's first start."
}

# Capture any SQL error popups / events
Log "--- recent System log SQL events ---"
Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddMinutes(-3)} -MaxEvents 30 -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match 'SQLEXPRESS|sqlservr|MSSQL' } |
    Select-Object -First 8 |
    ForEach-Object { Log "[$($_.TimeCreated.ToString('HH:mm:ss'))] #$($_.Id) $($_.ProviderName): $($_.Message)" }

Log "==== TEST COMPLETE ===="
