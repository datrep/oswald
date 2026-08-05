# start-detached.ps1
# Starts server.js as a DETACHED background process that survives terminal close
# and VS Code crashes. Spawned via WMI so it is NOT part of the VS Code process
# tree (which would otherwise kill it when the terminal closes).
#
# Usage:  .\start-detached.ps1
# Stop:   Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*server.js*' }
#         then Stop-Process on the node PID.

$root = $PSScriptRoot
Set-Location $root

# Load .env (same variables the app uses) into the process environment.
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^=]+)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
        }
    }
}

$hostAddr = if ($env:LOCAL_SERVER_HOST) { $env:LOCAL_SERVER_HOST } else { '0.0.0.0' }
$port = if ($env:PORT) { $env:PORT } else { '3000' }
$httpsPort = if ($env:HTTPS_PORT) { $env:HTTPS_PORT } else { '8443' }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node' }
$logOut = Join-Path $root 'server.log'
$logErr = Join-Path $root 'server.err.log'

# WMI-spawned processes inherit the SYSTEM default environment, not this shell's,
# so pass SERVER_HOST and PORT explicitly through cmd's `set`.
$cmd = "cmd.exe /c `"set SERVER_HOST=$hostAddr&& set PORT=$port&& set HTTPS_PORT=$httpsPort&& `"$node`" .\server.js > `"$logOut`" 2> `"$logErr`"`""
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $cmd
    CurrentDirectory = $root
}

if ($res.ReturnValue -ne 0) {
    Write-Host "Failed to spawn server (WMI return $($res.ReturnValue))." -ForegroundColor Red
    exit 1
}
$newPid = $res.ProcessId
Start-Sleep -Seconds 5
$alive = Get-Process -Id $newPid -ErrorAction SilentlyContinue
if ($alive) {
    Write-Host "Server started detached (PID $newPid) -> http://$hostAddr`:$port"
    Write-Host "Logs: $logOut / $logErr"
} else {
    Write-Host "Server process (PID $newPid) exited during startup. Check:" -ForegroundColor Red
    Write-Host "  $logErr"
}
