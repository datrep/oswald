# ============================================================================
# restart-sql.ps1 - recover the SQLEXPRESS engine on the Windows To Go box
# when it is wedged or stopped.
#
# The known failure (see docs/sql-server-wintogo-incident.md): after boot the
# auto-started engine can come up half-dead on the USB drive - it holds TCP
# port 1433 and ACCEPTS connections, but never answers the pre-login handshake
# ("unable to complete login process due to delay in prelogin response"). Every
# app connection then times out at 60s and dashboard sign-in fails.
#
# What it does:
#   1. Self-elevates (one UAC click).
#   2. Probes the engine with the app's OWN credentials (DB_USER/DB_PASSWORD/
#      DB_DATABASE from .env). If logins already work, it touches nothing.
#   3. Restarts MSSQL$SQLEXPRESS: stop (force-kill a hung owner process if the
#      stop times out) -> start -> re-probe with retries.
#   4. If the engine still refuses to start or serve, falls back to the
#      registry self-heal scripts (fix-sqlexpress-cv.ps1 then
#      fix-sqlexpress-netlib.ps1), restarts again, re-probes.
#   5. Optionally sets the service to Automatic (Delayed Start) - the standard
#      mitigation for the boot race - with -SetDelayedStart.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\restart-sql.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\restart-sql.ps1 -SetDelayedStart
#
# Logs to temp\restart-sql.log. Verify afterwards with scripts\check-sql-health.ps1.
# ============================================================================

[CmdletBinding()]
param([switch]$SetDelayedStart)

$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'restart-sql.log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host 'Requesting Administrator privileges (click Yes on the UAC prompt)...' -ForegroundColor Cyan
    $elevArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
    if ($SetDelayedStart) { $elevArgs += '-SetDelayedStart' }
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $elevArgs -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host '--- elevated run result ---' -ForegroundColor Cyan
    Get-Content $logFile -ErrorAction SilentlyContinue | Select-Object -Last 16
    exit $p.ExitCode
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

Remove-Item $logFile -ErrorAction SilentlyContinue
Log "==== RESTART SQL $(Get-Date) ===="

$svc    = 'MSSQL$SQLEXPRESS'
$sqlcmd = 'C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE'

$svcObj = Get-Service -Name $svc -ErrorAction SilentlyContinue
if (-not $svcObj) { Log "service $svc not found - is SQL Server Express installed?"; Log 'RESULT: FAILED (service missing)'; exit 1 }

# --- app credentials from .env: the probe that matters is the exact login the app uses
$user = 'api_user'; $pw = 'api_user'; $db = 'DB_Oswald'
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern '^DB_USER=(.*)$'     | Select-Object -First 1
    if ($m) { $user = $m.Matches[0].Groups[1].Value.Trim() }
    $m = Select-String -Path $envFile -Pattern '^DB_PASSWORD=(.*)$' | Select-Object -First 1
    if ($m) { $pw = $m.Matches[0].Groups[1].Value.Trim() }
    $m = Select-String -Path $envFile -Pattern '^DB_DATABASE=(.*)$' | Select-Object -First 1
    if ($m) { $db = $m.Matches[0].Groups[1].Value.Trim() }
}

$probeable = Test-Path $sqlcmd
if (-not $probeable) { Log 'WARN: sqlcmd not found at the expected path - the restart will still run, but logins cannot be verified from here.' }

function Probe-Login {
    param([int]$TimeoutSec = 10)
    & $sqlcmd -S '127.0.0.1,1433' -U $user -P $pw -d $db -l $TimeoutSec -b -h -1 -W -Q 'SET NOCOUNT ON; SELECT 1' 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Get-SvcPid {
    $s = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq $svc } | Select-Object -First 1
    if ($s) { return [int]$s.ProcessId } else { return 0 }
}

Log "1) probing engine (server=127.0.0.1,1433 user=$user db=$db)..."
$ok = $null
if ($probeable) {
    $ok = Probe-Login
    if ($ok -eq $true) { Log '   engine already answers logins - nothing to fix.'; Log 'RESULT: OK (no restart needed)'; exit 0 }
    Log '   probe failed (no login response).'
}

if ($SetDelayedStart) {
    Log '0) setting service startup to Automatic (Delayed Start)...'
    & sc.exe config $svc 'start=' 'delayed-auto' | Out-Null
}

Log "2) restarting $svc (state=$($svcObj.Status) pid=$(Get-SvcPid))..."
try { Stop-Service -Name $svc -Force -ErrorAction Stop } catch { Log "   stop request error: $($_.Exception.Message)" }
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and (Get-Service -Name $svc).Status -ne 'Stopped') { Start-Sleep -Milliseconds 500 }
$st = (Get-Service -Name $svc).Status
Log "   after stop request: $st"
if ($st -ne 'Stopped') {
    $opid = Get-SvcPid
    if ($opid -gt 0) {
        Log "   stop timed out - force-killing the hung engine process pid $opid"
        Stop-Process -Id $opid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}
try { Start-Service -Name $svc -ErrorAction Stop } catch { Log "   start error: $($_.Exception.Message)" }
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline -and (Get-Service -Name $svc).Status -ne 'Running') { Start-Sleep -Milliseconds 500 }
Log "   after start: $((Get-Service -Name $svc).Status)"

if ($probeable) {
    for ($i = 1; $i -le 6; $i++) {
        $ok = Probe-Login
        if ($ok -eq $true) { Log "   login probe #${i}: OK"; break }
        Log "   login probe #${i}: failed"
        Start-Sleep -Seconds 5
    }
}

if ($probeable -and $ok -ne $true) {
    Log '3) engine still not serving - applying registry self-heals...'
    foreach ($fix in 'fix-sqlexpress-cv.ps1','fix-sqlexpress-netlib.ps1') {
        $fixPath = Join-Path $PSScriptRoot $fix
        if (Test-Path $fixPath) { Log "   running $fix"; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fixPath | Out-Null }
        else { Log "   (missing: $fix)" }
    }
    try { Restart-Service -Name $svc -Force -ErrorAction Stop } catch { Log "   restart error: $($_.Exception.Message)" }
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and (Get-Service -Name $svc).Status -ne 'Running') { Start-Sleep -Milliseconds 500 }
    for ($i = 1; $i -le 6; $i++) {
        $ok = Probe-Login
        if ($ok -eq $true) { Log "   login probe (post-fix) #${i}: OK"; break }
        Log "   login probe (post-fix) #${i}: failed"
        Start-Sleep -Seconds 5
    }
}

if (-not $probeable) {
    Log 'RESULT: UNVERIFIED - restart completed, but sqlcmd was unavailable so logins were not tested.'
    Log 'Next: run scripts\check-sql-health.ps1 to confirm.'
    exit 0
}

if ($ok -eq $true) {
    Log 'RESULT: OK - the database answers app logins (127.0.0.1,1433 / the .env database).'
    Log 'Next: run scripts\check-sql-health.ps1; sign-in should work again (the app pools retry automatically).'
    exit 0
} else {
    Log 'RESULT: FAILED - the engine did not come back. One VERBOSE probe follows:'
    & $sqlcmd -S '127.0.0.1,1433' -U $user -P $pw -d $db -l 10 -b -Q 'SELECT 1' 2>&1 | ForEach-Object { Log "   $_" }
    Log 'Check temp\fix-sqlexpress-cv.log and temp\fix-sqlexpress-netlib.log, and the SQL ERRORLOG under:'
    Log '  C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL\Log'
    exit 1
}
