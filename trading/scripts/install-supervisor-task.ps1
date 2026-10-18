# trading/scripts/install-supervisor-task.ps1 - register the out-of-process supervisor.
#
# NOTE: keep this file pure ASCII. PowerShell 5.1 reads .ps1 without a BOM as ANSI, so a
# UTF-8 em dash inside a double-quoted string is read as three CP1252 characters and the
# script fails to parse (hit 2026-09-13: the em dash in "registered '<task>' - every 5 min").
#
# Creates a per-user Windows Scheduled Task that runs trading/scripts/supervise-task.ps1
# every 5 minutes and at logon. Per-user means NO ELEVATION is required; the trading service
# itself runs as this user, which is the only account that can read the DB credentials and
# the crash files.
#
# WHY A SCHEDULED TASK rather than a sibling node process: a supervisor process would itself
# need supervising (who watches the watcher?). Task Scheduler is a Windows service, so it
# survives logoff, reboot, crashes and the trading process dying - which is the whole point.
# A watchdog that shares fate with the thing it watches is not a watchdog.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File trading\scripts\install-supervisor-task.ps1
#   powershell ... -File trading\scripts\install-supervisor-task.ps1 -Remove
#   powershell ... -File trading\scripts\install-supervisor-task.ps1 -EveryMinutes 10

param(
    [int]$EveryMinutes = 5,
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$taskName = 'OswaldTradingSupervisor'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$wrapper = Join-Path $root 'trading\scripts\supervise-task.ps1'

if ($Status) {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host "task '$taskName' is NOT registered" -ForegroundColor Yellow; exit 1 }
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    Write-Host "task       : $taskName ($($t.State))"
    Write-Host "last run   : $($info.LastRunTime)  result=$($info.LastTaskResult)"
    Write-Host "next run   : $($info.NextRunTime)"
    exit 0
}

if ($Remove) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "removed scheduled task '$taskName'" -ForegroundColor Green
    } else {
        Write-Host "task '$taskName' was not registered" -ForegroundColor DarkGray
    }
    exit 0
}

if (-not (Test-Path $wrapper)) { throw "missing $wrapper" }

# One action: run the wrapper through powershell so the exit code reaches Task Scheduler.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$wrapper`"" `
    -WorkingDirectory $root

# Two triggers: at logon (so a reboot is covered) and on a repeating minute schedule.
# RepetitionDuration must be BOUNDED: [TimeSpan]::MaxValue serialises to
# P99999999DT23H59M59S, which Task Scheduler rejects as out of range ("the task XML contains
# a value which is incorrectly formatted"). 10 years is effectively indefinite here, and the
# AtLogOn trigger re-arms the schedule on every logon/reboot anyway.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) `
        -Settings $settings -Principal $principal -Force `
        -Description 'Out-of-process supervisor for the Oswald trading service (TRD-40, goal F). Reports a dead or hung desk with the reason; does NOT restart it (pass --restart to supervise.js to opt in).' | Out-Null
    Write-Host "registered '$taskName' - every $EveryMinutes min + at logon, as $env:USERNAME (no elevation needed)" -ForegroundColor Green
} catch {
    Write-Host "could not register '$taskName': $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "If this is a permissions error, re-run this script from an elevated PowerShell." -ForegroundColor Yellow
    exit 1
}

# Prove it works end to end rather than assuming the registration took.
Write-Host "`n--- first run, immediately (this is a real check, not a test) ---"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper
$rc = $LASTEXITCODE
Write-Host "supervisor exit code: $rc  (0 = desk up, 2 = down/hung, 3 = supervisor broken)"
Write-Host "`nInspect any time with:  powershell -File trading\scripts\install-supervisor-task.ps1 -Status"
Write-Host "Remove with:            powershell -File trading\scripts\install-supervisor-task.ps1 -Remove"
