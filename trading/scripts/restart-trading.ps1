# trading/scripts/restart-trading.ps1 - restart the trading service, never the Chrome bridge.
#
# Promoted out of `temp/` on 2026-09-13: this was the documented recovery path for the two
# silent outages, and it lived in a GITIGNORED folder (.gitignore line 6), so the procedure
# that fixes a failure was itself unreproducible from the repo.
#
# Now also prints the crash guard's record (trading/crash/exit.json), which is the whole
# point - before TRD-40 the restart told you nothing about why the process had stopped.
#
# Usage:  powershell -ExecutionPolicy Bypass -File trading\scripts\restart-trading.ps1
#         powershell -ExecutionPolicy Bypass -File trading\scripts\restart-trading.ps1 -Force
#
# 2026-10-01: step 0 (preflight) added. Full rationale in trading/scripts/preflight.js.
# It runs BEFORE the running instance is stopped, so a damaged tree aborts the restart and
# leaves the old process serving. Restarting into a broken tree is worse than not restarting.

param(
    # Start anyway, even if the preflight refuses the tree. For the case where you have already
    # looked at what it is complaining about and know it is harmless.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # repo root
Set-Location $root

$crashFile = Join-Path $root 'trading\crash\exit.json'
$hbFile    = Join-Path $root 'trading\crash\heartbeat.json'

# --- 1. what happened last time? -------------------------------------------
if (Test-Path $crashFile) {
    $rec = Get-Content $crashFile -Raw | ConvertFrom-Json
    Write-Host "--- last crash record ---" -ForegroundColor Cyan
    Write-Host ("  event   : {0}" -f $rec.event) -ForegroundColor Yellow
    Write-Host ("  at      : {0}   (uptime {1}s, rss {2}MB)" -f $rec.at, $rec.uptimeSec, $rec.rssMb)
    if ($rec.message) { Write-Host ("  message : {0}" -f $rec.message) -ForegroundColor Red }
    if ($rec.code -ne $null) { Write-Host ("  exit    : code {0}" -f $rec.code) }
    if ($rec.signal) { Write-Host ("  signal  : {0}" -f $rec.signal) }
    if ($rec.stack)  { Write-Host ("  stack   :`n{0}" -f $rec.stack) -ForegroundColor DarkGray }
} else {
    Write-Host "--- no crash record (trading\crash\exit.json absent) ---" -ForegroundColor DarkGray
    Write-Host "  The crash guard only writes from a process that loaded it (TRD-40, deployed 2026-09-13)." -ForegroundColor DarkGray
    if (Test-Path $hbFile) {
        $hb = Get-Content $hbFile -Raw | ConvertFrom-Json
        Write-Host ("  last heartbeat: {0}" -f $hb.at) -ForegroundColor DarkGray
    }
}

# --- 0. preflight: is this tree even safe to start? -------------------------
# Why this runs BEFORE step 2 and not after: a zero-byte module is a VALID file, so require()
# resolves it to `{}` without throwing, the server boots, and healthz answers 200 - the desk
# then dies later on `undefined is not a function`. Nothing in the 2046-test suite catches
# that (every test still requires the module successfully), so the only cheap place to catch
# it is here. Running it first means a damaged tree costs nothing: the old process keeps
# serving, and you find out before you have given anything up.
$preflight = Join-Path $root 'trading\scripts\preflight.js'
if (Test-Path $preflight) {
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) { $nodeExe = 'node' }
    & $nodeExe $preflight
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        if ($Force) {
            Write-Host "preflight FAILED (exit $LASTEXITCODE) - continuing because -Force was given." -ForegroundColor Yellow
            Write-Host "You are restarting onto a tree the preflight believes is damaged." -ForegroundColor Yellow
        } else {
            Write-Host "ABORTED: preflight refused this tree (exit $LASTEXITCODE)." -ForegroundColor Red
            Write-Host "The running instance was NOT touched and is still serving." -ForegroundColor Red
            Write-Host "Fix the tree, or re-run with -Force to start anyway." -ForegroundColor Red
            exit 1
        }
    }
} else {
    Write-Host "preflight: SKIPPED - $preflight not found" -ForegroundColor Yellow
}

# --- 2. stop any running instance (the bridge lives in Chrome, not here) ----
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*trading\server.js*' } | ForEach-Object {
    Write-Host "stopping trading server pid $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force
}
Start-Sleep -Seconds 2

# --- 3. start it, detached, so it is not a child of this shell --------------
$node = (Get-Command node).Source
if (-not $node) { $node = 'node' }
$logOut = Join-Path $root 'trading\server.log'
$logErr = Join-Path $root 'trading\server.err.log'
$cmdLine = "cmd.exe /c `"`"$node`" trading\server.js > `"$logOut`" 2> `"$logErr`"`""
# Hidden console (2026-10-16): the desk wrapper is a WMI-spawned cmd; hide its console at birth
# so no visible blank window appears (closing those windows kills the process tree).
$si = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod Win32_Process Create -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $root; ProcessStartupInformation = $si }
Write-Host "started pid $($r.ProcessId) (WMI return $($r.ReturnValue))"

Start-Sleep -Seconds 6

# --- 4. verify, the same way the supervisor does ---------------------------
$health = try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8115/healthz' -TimeoutSec 10).Content } catch { "FAILED: $($_.Exception.Message)" }
Write-Host "healthz: $health"
if (Test-Path $crashFile) {
    $now = Get-Content $crashFile -Raw | ConvertFrom-Json
    Write-Host ("crash guard: event={0} at {1} (expect 'start')" -f $now.event, $now.at) -ForegroundColor Cyan
}
Write-Host "--- server.err.log (tail) ---"
if (Test-Path $logErr) { Get-Content $logErr -Tail 15 }
