# ============================================================================
# etw-registry-capture.ps1 - capture the sqlservr -sSQLEXPRESS startup with the
# built-in kernel ETW providers, ONE elevated run producing BOTH traces:
#   registry trace -> temp\reg-trace.csv
#   file trace     -> temp\file-trace.csv
# (logman rejects multiple -p in one session, so we run two sessions.)
# We then grep the CSVs for non-success results to find the exact failure.
#
# Self-elevates (one UAC click). Logs to temp\etw-registry.log
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'etw-registry.log'
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

$exe = 'C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL\Binn\sqlservr.exe'

function Stop-SqlExpress {
    $svc = Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
    if ($svc.Status -ne 'Stopped') { Stop-Service 'MSSQL$SQLEXPRESS' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
    Get-CimInstance Win32_Process -Filter "Name='sqlservr.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match '-sSQLEXPRESS' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

function Trace-Run {
    param([string]$Name, [string]$Provider)
    $etl = Join-Path $logDir "$Name.etl"
    $csv = Join-Path $logDir "$Name-trace.csv"
    Remove-Item $etl, $csv -ErrorAction SilentlyContinue
    Log ""
    Log "########## $Name trace ($Provider) ##########"
    Stop-SqlExpress
    & logman start "$Name" -p $Provider -o $etl -ets 2>&1 | Out-String | ForEach-Object { Log "  $_" }
    Start-Sleep -Seconds 2
    Log "launching: $exe -sSQLEXPRESS"
    $proc = Start-Process -FilePath $exe -ArgumentList '-sSQLEXPRESS' -PassThru
    Start-Sleep -Seconds 12
    if ($proc.HasExited) {
        $proc.Refresh(); $c = $proc.ExitCode
        Log "  sqlservr exited, code=$c"
    } else {
        Log "  sqlservr STILL RUNNING (pid $($proc.Id)) - it STARTS; stopping it"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    & logman stop "$Name" -ets 2>&1 | Out-String | ForEach-Object { Log "  $_" }
    Start-Sleep -Seconds 2
    & tracerpt $etl -o $csv -of CSV 2>&1 | Out-String | ForEach-Object { Log "  $_" }
    Log "  -> $csv ($(if (Test-Path $csv) { "$((Get-Item $csv).Length) bytes" } else { 'MISSING' }))"
}

Log "==== SQLSERVR DUAL TRACE $(Get-Date) ===="
Trace-Run -Name 'regtrace'   -Provider 'Microsoft-Windows-Kernel-Registry'
Trace-Run -Name 'filetrace'  -Provider 'Microsoft-Windows-Kernel-File'
Log ""
Log '==== COMPLETE ===='
