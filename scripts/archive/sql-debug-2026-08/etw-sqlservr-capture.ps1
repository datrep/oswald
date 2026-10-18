# ============================================================================
# etw-sqlservr-capture.ps1 - capture EVERY registry + file operation sqlservr
# makes while trying to start -sSQLEXPRESS, using the built-in Windows kernel
# ETW providers (no GUI needed, output is a CSV I can read).
#
#   1. start a kernel-registry + kernel-file trace
#   2. launch sqlservr.exe -sSQLEXPRESS manually (elevated)
#   3. stop the trace
#   4. tracerpt converts the ETL to CSV -> temp\sqlservr-trace.csv
#
# Then we grep the CSV for sqlservr operations whose Result is NOT success
# (e.g. NAME NOT FOUND / ACCESS DENIED) - that pinpoints the exact failure.
#
# Self-elevates (one UAC click). Logs to temp\etw-sqlservr.log
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'etw-sqlservr.log'
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

$exe    = 'C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL\Binn\sqlservr.exe'
$etl    = Join-Path $logDir 'sqlservr.etl'
$csv    = Join-Path $logDir 'sqlservr-trace.csv'
Remove-Item $etl, $csv -ErrorAction SilentlyContinue

Log "==== ETW SQLSERVR CAPTURE $(Get-Date) ===="

# make sure service stopped + no lingering sqlservr for SQLEXPRESS
$svc = Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
if ($svc.Status -ne 'Stopped') { Stop-Service 'MSSQL$SQLEXPRESS' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
Get-CimInstance Win32_Process -Filter "Name='sqlservr.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-sSQLEXPRESS' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# start trace
Log 'starting ETW trace (kernel-registry + kernel-file)...'
& logman start trace sqltrace -p "Microsoft-Windows-Kernel-Registry" -p "Microsoft-Windows-Kernel-File" -o $etl -ets 2>&1 | Out-String | ForEach-Object { Log "  $_" }
Start-Sleep -Seconds 2

# launch sqlservr manually
Log "launching: $exe -sSQLEXPRESS"
$proc = Start-Process -FilePath $exe -ArgumentList '-sSQLEXPRESS' -PassThru
Start-Sleep -Seconds 15
if ($proc.HasExited) {
    $proc.Refresh()
    $c = $proc.ExitCode
    Log "sqlservr exited, code=$c"
} else {
    Log "sqlservr still running after 15s (pid $($proc.Id)) - it STARTS; stopping it"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

# stop trace
Log 'stopping trace...'
& logman stop sqltrace -ets 2>&1 | Out-String | ForEach-Object { Log "  $_" }
Start-Sleep -Seconds 2

# convert
Log 'converting ETL to CSV...'
& tracerpt $etl -o $csv -of CSV 2>&1 | Out-String | ForEach-Object { Log "  $_" }

Log ''
Log "ETL: $etl  ($(if (Test-Path $etl) { "$((Get-Item $etl).Length) bytes" } else { 'MISSING' }))"
Log "CSV: $csv  ($(if (Test-Path $csv) { "$((Get-Item $csv).Length) bytes" } else { 'MISSING' }))"
Log '==== CAPTURE COMPLETE ===='
