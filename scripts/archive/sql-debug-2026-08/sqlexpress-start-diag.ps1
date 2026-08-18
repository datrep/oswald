# ============================================================================
# sqlexpress-start-diag.ps1 - run sqlservr -sSQLEXPRESS MANUALLY (elevated)
# and capture the exact exit code / stderr / ERRORLOG behavior, to see WHY the
# service keeps dying before it can open its errorlog.
#   - If the manual run STAYS UP   -> engine is fine; problem is in the SCM
#     service-start path only.
#   - If it exits with a code/msg  -> that code is the answer (we capture it).
#
# Self-elevates (one UAC click). Logs to temp\sqlexpress-start-diag.log
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'sqlexpress-start-diag.log'
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

$base = 'C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL'
$exe  = "$base\Binn\sqlservr.exe"
$errLog = "$base\Log\ERRORLOG"
$sout = Join-Path $logDir 'sqlex_diag_out.txt'
$serr = Join-Path $logDir 'sqlex_diag_err.txt'
Remove-Item $sout,$serr -ErrorAction SilentlyContinue

Log "==== SQLEXPRESS START DIAG $(Get-Date) ===="
Log "exe: $exe (exists: $(Test-Path $exe))"

# ensure service stopped so we don't double-run
$svc = Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
Log "service status before: $($svc.Status)"
if ($svc.Status -ne 'Stopped') {
    Stop-Service 'MSSQL$SQLEXPRESS' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}
Get-CimInstance Win32_Process -Filter "Name='sqlservr.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-sSQLEXPRESS' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# note ERRORLOG before
$before = if (Test-Path $errLog) { "exists, $((Get-Item $errLog).Length) bytes, lastwrite $(Get-Item $errLog).LastWriteTime" } else { 'MISSING' }
Log "ERRORLOG before: $before"

Log "launching: $exe -sSQLEXPRESS"
$proc = Start-Process -FilePath $exe -ArgumentList '-sSQLEXPRESS' -PassThru -RedirectStandardOutput $sout -RedirectStandardError $serr
# wait up to 25s
$exited = $proc.WaitForExit(25000)
if ($exited) {
    $proc.Refresh()
    $code = $proc.ExitCode
    $hex = '0x{0:X8}' -f $code
    Log "RESULT: EXITED, code=$hex (decimal $code)"
    # interpret common codes
    switch ($code) {
        0xC0000135 { Log '  => STATUS_DLL_NOT_FOUND - a required DLL is missing' }
        0xC0000142 { Log '  => STATUS_DLL_INIT_FAILED - a DLL failed to initialize' }
        0xC0000005 { Log '  => access violation (crash)' }
        0xC0000409 { Log '  => fail-fast (buffer overrun / __fastfail)' }
        2          { Log '  => ERROR_FILE_NOT_FOUND (matches the original "error 2")' }
    }
} else {
    Log "RESULT: STILL RUNNING after 25s (pid $($proc.Id)) -> engine STARTS FINE"
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Log '(engine killed after test)'
}

Log '--- stderr ---'
if (Test-Path $serr) { $c = Get-Content $serr -Raw; if ($c) { Log $c } else { Log '  (empty)' } } else { Log '  (none)' }
Log '--- stdout ---'
if (Test-Path $sout) { $c = Get-Content $sout -Raw; if ($c) { Log $c } else { Log '  (empty)' } } else { Log '  (none)' }

$after = if (Test-Path $errLog) { "exists, $((Get-Item $errLog).Length) bytes, lastwrite $(Get-Item $errLog).LastWriteTime" } else { 'MISSING' }
Log "ERRORLOG after: $after"
if ((Test-Path $errLog)) {
    Log '--- ERRORLOG tail (10) ---'
    Get-Content $errLog -Tail 10 -ErrorAction SilentlyContinue | ForEach-Object { Log "  $_" }
}

Log '==== DIAG COMPLETE ===='
