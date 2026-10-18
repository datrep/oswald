# scripts/watchers-guard.ps1 — OSWALD fleet guardian (2026-10-08).
#
# WHY: at 13:46:25Z on 2026-10-08 the ENTIRE detached watcher fleet died in one instant (every err log holds
# `^C` — a console-group interrupt, almost certainly a closed/recycled VS Code terminal whose console the
# WMI-spawned children had inherited). The desk was resurrected by its own supervisor 4 minutes later; the
# watchers had NO rescuer and stayed dark 2.5 hours — a silent monitoring gap that only ended when the operator
# noticed. This guardian is that rescuer.
#
# RUN BY: Task Scheduler, user-level, every 10 minutes (see the schtasks line in the session log). It checks each
# lane by command-line filter and re-arms ONLY the missing ones via the same start scripts the operator uses.
# It is idempotent (every start script has its own singleton guard) and console-independent when launched by the
# task scheduler.
#
# SKIPS BY DESIGN: pip-sampler (one-shot 12h job, completed) and t25-watch (terminal/idle after its verdict),
# and profit-watch once its log shows the era trigger fired (exit-on-trigger is its correct end state).
#
# Log: logs\watchers-guard.log

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logFile = Join-Path $root 'logs\watchers-guard.log'
$log = { param($s) $line = "$(Get-Date -Format o) $s"; Write-Host $line; Add-Content -Path $logFile -Value $line }

function NodeCount([string]$pattern) {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like $pattern }).Count
}

$rearmed = @()

# observer (no start script exists; spawn with the house WMI pattern)
if ((NodeCount '*bridge-state-watch*') -eq 0) {
    $cmd = 'cmd.exe /c "set BSW=1&& node .\temp\bridge-state-watch.js > .\temp\bridge-state-watch.out.log 2> .\temp\bridge-state-watch.err.log"'
    # Hidden console (2026-10-16): WMI spawns get a visible blank console otherwise; closing it kills the lane.
    $si = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root; ProcessStartupInformation = $si }
    $rearmed += "observer(wmi=$($r.ReturnValue))"
}

# mirror-export (desk mirror feed: DB -> trading/public/desk-mirror.json + temp copy, read-only, every 4 s; no start script)
if ((NodeCount '*mirror-export*') -eq 0) {
    $cmd = 'cmd.exe /c "node .\trading\scripts\mirror-export.js > .\logs\mirror-export.out.log 2> .\logs\mirror-export.err.log"'
    # Hidden console (2026-10-16): same hide-at-birth as the observer above.
    $si = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root; ProcessStartupInformation = $si }
    $rearmed += "mirror-export(wmi=$($r.ReturnValue))"
}

# lanes with start scripts: name = filter, action = script + args
# (hashtable splat: array-splat does NOT bind '-Quiet' as a parameter name in PS 5.1 — fixed 2026-10-16)
$lanes = @(
    @{ n = 'autonomous'; f = '*autonomous-watch*';   s = '.\start-autonomous-watch.ps1'; h = @{ Quiet = $true } },
    @{ n = 'ds';         f = '*ds-watch*';           s = '.\start-ds-watch.ps1';         h = @{ Proxy = $true } },
    @{ n = 'ops';        f = '*ops-watch*';          s = '.\start-ops-watch.ps1';        h = @{} },
    @{ n = 'milestone';  f = '*milestone-watch*';    s = '.\start-milestone-watch.ps1';  h = @{} },
    @{ n = 'shadow';     f = '*shadow-exit-watch*';  s = '.\start-shadow-exit.ps1';      h = @{} },
    @{ n = 'capture';    f = '*candidate-capture-watch*'; s = '.\start-candidate-capture.ps1'; h = @{} },
    @{ n = 'touch-probe'; f = '*touch-probe-watch*'; s = '.\start-touch-probe.ps1';      h = @{} }
)
foreach ($l in $lanes) {
    if ((NodeCount $l.f) -eq 0) {
        try {
            $largs = $l.h
            & (Join-Path $root $l.s) @largs | Out-Null
            $rearmed += $l.n
        } catch { & $log "re-arm $($l.n) FAILED: $($_.Exception.Message)" }
    }
}

# profit-watch: re-arm unless its log shows the era trigger already fired (its correct terminal state)
$profitState = Join-Path $root 'temp\profit-rule-n30-watch.log'
$profitTriggered = $false
if (Test-Path $profitState) {
    $profitTriggered = [bool](Select-String -Path $profitState -Pattern 'TRIGGER|triggered' -Quiet)
}
if (-not $profitTriggered -and (NodeCount '*profit-watch*') -eq 0) {
    try { & (Join-Path $root '.\start-profit-watch.ps1') '-Since' '2026-10-08T00:45:51Z' | Out-Null; $rearmed += 'profit' } catch { & $log "re-arm profit FAILED: $($_.Exception.Message)" }
}

if ($rearmed.Count -gt 0) {
    & $log ("fleet guard re-armed: " + ($rearmed -join ', '))
} else {
    & $log 'fleet guard: all lanes alive'
}

# Telegram ONLY when a re-arm happened, deduped to once per 6h (a flapping lane must not spam the owner)
if ($rearmed.Count -gt 0) {
    $stampFile = Join-Path $root 'temp\watchers-guard-last-tg.txt'
    $lastTg = [DateTime]::MinValue
    if (Test-Path $stampFile) { try { $lastTg = [DateTime]::Parse((Get-Content $stampFile -Raw).Trim()) } catch { } }
    if (((Get-Date) - $lastTg).TotalHours -ge 6) {
        Set-Content -Path $stampFile -Value (Get-Date -Format o)
        $msg = "OSWALD fleet guard: re-armed $($rearmed -join ', ') (fleet interruption detected - logs: logs\watchers-guard.log)"
        node -e "require('./trading/lib/http').telegramAlert(process.argv[1]).catch(()=>{})" $msg | Out-Null
    }
}
