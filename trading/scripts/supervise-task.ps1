# trading/scripts/supervise-task.ps1 - the Task Scheduler entry point for supervise.js.
# Kept as a wrapper so the scheduled action is a single powershell invocation with an
# explicit working directory (Task Scheduler's default cwd is C:\Windows\System32, which
# would break both the relative DB/config paths and dotenv).
#
# Exit codes (surfaced as "Last Run Result" in Task Scheduler):
#   0 = service up      2 = down or hung      3 = the supervisor itself failed
# Anything other than 0 or 2 means the supervisor is broken, not the desk.

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node' }

# 2026-10-06: --restart is now ENABLED for the scheduled task, and it is safe to do so because the
# decision lives in supervise-policy.js and only acts when the desk is PROVABLY GONE (down + heartbeat
# pid dead). A hung but ALIVE desk is never killed by the supervisor (an in-flight order could be
# interrupted); that case pages the operator instead. Backoff: max one auto-restart per 10 minutes.
& $node 'trading\scripts\supervise.js' '--quiet' '--restart'
exit $LASTEXITCODE
