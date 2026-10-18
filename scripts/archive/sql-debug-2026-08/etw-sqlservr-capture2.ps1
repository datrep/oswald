# ============================================================================
# etw-sqlservr-capture2.ps1 - WPR-based capture of sqlservr registry+file ops.
# (logman rejected multiple -p providers; WPR handles both kernel providers.)
#
#   1. wpr -start with the SqlTrace profile (KernelFile + KernelReg)
#   2. launch sqlservr.exe -sSQLEXPRESS (which exits ~1046)
#   3. wpr -stop -> temp\sqlservr.etl
#   4. tracerpt -> temp\sqlservr-trace.csv
#
# Self-elevates (one UAC click). Logs to temp\etw-sqlservr2.log
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'etw-sqlservr2.log'
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

$exe     = 'C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL\Binn\sqlservr.exe'
$profile = Join-Path $logDir 'sqltrace.wprp'
$etl     = Join-Path $logDir 'sqlservr.etl'
$csv     = Join-Path $logDir 'sqlservr-trace.csv'
Remove-Item $etl, $csv -ErrorAction SilentlyContinue

Log "==== WPR SQLSERVR CAPTURE $(Get-Date) ===="

$svc = Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
if ($svc.Status -ne 'Stopped') { Stop-Service 'MSSQL$SQLEXPRESS' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
Get-CimInstance Win32_Process -Filter "Name='sqlservr.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-sSQLEXPRESS' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Log 'starting WPR trace...'
& wpr -start $profile -filemode 2>&1 | Out-String | ForEach-Object { Log "  $_" }
Start-Sleep -Seconds 3

Log "launching: $exe -sSQLEXPRESS"
$proc = Start-Process -FilePath $exe -ArgumentList '-sSQLEXPRESS' -PassThru
Start-Sleep -Seconds 15
if ($proc.HasExited) {
    $proc.Refresh(); $c = $proc.ExitCode
    Log "sqlservr exited, code=$c"
} else {
    Log "sqlservr still running (pid $($proc.Id)) - it STARTS; stopping it"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

Log 'stopping WPR trace...'
& wpr -stop $etl 2>&1 | Out-String | ForEach-Object { Log "  $_" }
Start-Sleep -Seconds 3

Log 'converting ETL to CSV...'
& tracerpt $etl -o $csv -of CSV 2>&1 | Out-String | ForEach-Object { Log "  $_" }

Log ''
Log "ETL: $etl ($(if (Test-Path $etl) { "$((Get-Item $etl).Length) bytes" } else { 'MISSING' }))"
Log "CSV: $csv ($(if (Test-Path $csv) { "$((Get-Item $csv).Length) bytes" } else { 'MISSING' }))"
Log '==== CAPTURE COMPLETE ===='
