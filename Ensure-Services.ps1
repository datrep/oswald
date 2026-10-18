# Ensure-Services.ps1
#
# CONTINUITY 2026-10-12 - service watchdog for the unattended run.
#
# WHY
#   The "Oswald stack (logon)" task only covers a reboot. It does nothing if a
#   service dies mid-run, and that has now happened twice for real:
#     - expenses died silently and was never restarted (it was not registered
#       with the dashboard, so nothing noticed)
#     - trading crashed at boot with ETIMEOUT on SQL Server, wrongly concluded
#       "migration 024 not applied", and exited (it starts before SQL is ready)
#
# WHAT IT DOES
#   Every 10 minutes: for each service, if its port is not listening AND no
#   matching node process exists, start it. Logs every check and every action.
#
# SAFETY
#   * It never starts a service whose node process already exists - that would
#     double-spawn and cause a port conflict. A service mid-startup is left alone.
#   * It handles the dashboard FIRST and waits, because the dashboard also
#     auto-starts its children; checking children before it settles would
#     double-start them.
#   * Before starting trading it waits for SQL Server, since that is the exact
#     race that killed it (ETIMEOUT -> false "migration missing" -> exit).
#   * It only ever STARTS things. It never stops, kills or restarts a running
#     service, so it cannot take down a healthy stack.
#
# USAGE
#   powershell -NoProfile -ExecutionPolicy Bypass -File Ensure-Services.ps1
#   ( -Quiet to suppress console output, for the scheduled task )

[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\datrep\Desktop\oswald'
$logDir = Join-Path $repo 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir 'service-watchdog.log'

# 2026-10-18: SQL port for the trading start gate, read from .env (this desk is 1433; the file used to probe
# 1435, the laptop's port, so the gate never opened and trading starts were deferred one full cycle).
$sqlPort = 1433
try {
    $m = Select-String -Path (Join-Path $repo '.env') -Pattern '^\s*DB_PORT\s*=\s*(\d+)'
    if ($m) { $sqlPort = [int]$m.Matches[0].Groups[1].Value }
} catch { }

# 2026-10-18: the dashboard binds the machine's own interface (LOCAL_SERVER_HOST, 172.22.160.3), NOT loopback
# — a loopback-only probe always reported it "down" while it was healthy. (REMOTE_SERVER_HOST is the NAS, not
# this desk.) Liveness checks loopback and the configured local host.
$localHost = '127.0.0.1'
try {
    $mh = Select-String -Path (Join-Path $repo '.env') -Pattern '^\s*LOCAL_SERVER_HOST\s*=\s*(\S+)'
    if ($mh) { $localHost = $mh.Matches[0].Groups[1].Value.Trim() }
} catch { }

function Log($msg) {
    $line = '{0}  {1}' -f (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss'), $msg
    try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
    if (-not $Quiet) { Write-Host $line }
}

# Each service: a friendly name, the ports that prove it is alive, the script to
# launch, and a token that appears in its node command line.
$services = @(
    @{ Name = 'dashboard';  Ports = @(8080, 8443); Script = 'server.js';            Match = '.\server.js' }
    @{ Name = 'fileserver'; Ports = @(8090);       Script = 'fileserver\server.js'; Match = 'fileserver\server.js' }
    @{ Name = 'listings';   Ports = @(8110);       Script = 'listings\server.js';   Match = 'listings\server.js' }
    @{ Name = 'expenses';   Ports = @(8112);       Script = 'expenses\server.js';   Match = 'expenses\server.js' }
    @{ Name = 'trading';    Ports = @(8114, 8115); Script = 'trading\server.js';    Match = 'trading\server.js' }
)

function Test-PortOn($hostName, $port) {
    # TcpClient probing is far quicker than Get-NetTCPConnection and avoids the
    # cmdlet's occasional slowness on a busy box.
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($hostName, $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(300)
        if ($ok) { try { $client.EndConnect($iar) } catch { $ok = $false } }
        $client.Close()
        return [bool]$ok
    } catch { return $false }
}

function Test-Port($port) { return (Test-PortOn '127.0.0.1' $port) }

function Test-ServicePort($svc) {
    foreach ($port in $svc.Ports) {
        if (Test-Port $port) { return $true }
        if ($localHost -and $localHost -ne '127.0.0.1' -and (Test-PortOn $localHost $port)) { return $true }
    }
    return $false
}

function Test-Process($match) {
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.CommandLine -and $p.CommandLine -like "*$match*") { return $true }
        }
    } catch { }
    return $false
}

function Start-Service-For($svc) {
    $inner = 'cd /d "{0}" && node {1} >> {2}.log 2>> {2}.err.log' -f $repo, $svc.Script, $svc.Name
    # Hidden console at birth (2026-10-16 lesson, applied here 2026-10-18): a WMI spawn otherwise gets a
    # VISIBLE blank console window, and closing that window kills the child (console-group Ctrl+C).
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = ('cmd.exe /c ' + $inner)
        ProcessStartupInformation = $startup
    }
}

function Wait-ForSql {
    # trading exits if SQL is not accepting connections yet. Rather than let it
    # fail and wait a whole cycle, give SQL a moment first.
    # 2026-10-18 FIX: this probed port 1435 — the LAPTOP's SQL port. This desk runs
    # DB_PORT=1433 (see .env), so the wait always timed out and every watchdog start of
    # `trading` was deferred one full cycle. The port is now read from .env.
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-Port $sqlPort) { return $true }
        Start-Sleep -Seconds 3
    }
    return $false
}

$started = @()

# Dashboard first: it also auto-starts its registered children, so let it settle
# before judging whether the others are really missing.
$dash = $services[0]
if (-not (Test-ServicePort $dash)) {
    if (Test-Process $dash.Match) {
        Log 'dashboard: port down but process exists (starting) - leaving alone'
    } else {
        Log 'dashboard: DOWN and no process - starting via start-detached.ps1'
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'start-detached.ps1') *> $null
        $started += 'dashboard'
        Start-Sleep -Seconds 25
    }
} else {
    Log 'dashboard: ok'
}

foreach ($svc in $services[1..($services.Count - 1)]) {
    $alive = Test-ServicePort $svc

    if ($alive) { Log ("{0}: ok" -f $svc.Name); continue }

    if (Test-Process $svc.Match) {
        Log ("{0}: port down but process exists (starting) - leaving alone" -f $svc.Name)
        continue
    }

    if ($svc.Name -eq 'trading') {
        if (-not (Wait-ForSql)) {
            Log 'trading: DOWN, and SQL Server is not accepting connections yet - deferring to next cycle'
            continue
        }
    }

    Log ("{0}: DOWN (no port, no process) - starting" -f $svc.Name)
    Start-Service-For $svc
    $started += $svc.Name
    Start-Sleep -Seconds 6
}

# Verify what we started, and say so plainly.
foreach ($name in $started) {
    $svc = $services | Where-Object { $_.Name -eq $name }
    Start-Sleep -Seconds 4
    $up = Test-ServicePort $svc
    if ($up) { Log ("{0}: started OK" -f $name) } else { Log ("{0}: started but port still not listening (it may need longer)" -f $name) }
}

if ($started.Count -eq 0) { Log 'all services healthy' }


