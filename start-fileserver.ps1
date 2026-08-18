# start-fileserver.ps1
# Starts the Oswald Fileserver (FS-1) as a DETACHED background process that
# survives terminal close and VS Code crashes (WMI spawn, like start-detached.ps1).
#
# Usage:  .\start-fileserver.ps1
# Stop:   Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*fileserver*server.js*' }
#         then Stop-Process on the node PID.

$root = $PSScriptRoot
Set-Location $root

# FS-OPS-1: refuse to double-launch — if a fileserver is already running, stop.
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*fileserver*server.js*' } |
    Select-Object -First 1
if ($existing) {
    Write-Host "A fileserver is already running (PID $($existing.ProcessId)). Refusing to start a second instance." -ForegroundColor Yellow
    Write-Host "If it is stuck, stop it first:  Stop-Process -Id $($existing.ProcessId) -Force"
    exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node' }
$logOut = Join-Path $root 'fileserver.log'
$logErr = Join-Path $root 'fileserver.err.log'

# NOTE: the leading `set FILESERVER=1&& ` is required — Win32_Process.Create
# (WMI) mangles embedded quotes unless the cmd /c line starts with a `set`
# clause (same trick as start-detached.ps1). Without it the spaced node path
# breaks and the process dies before writing any logs.
$cmd = "cmd.exe /c `"set FILESERVER=1&& `"$node`" .\fileserver\server.js > `"$logOut`" 2> `"$logErr`"`""
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $cmd
    CurrentDirectory = $root
}

if ($res.ReturnValue -ne 0) {
    Write-Host "Failed to spawn fileserver (WMI return $($res.ReturnValue))." -ForegroundColor Red
    exit 1
}
$newPid = $res.ProcessId
Start-Sleep -Seconds 4
$alive = Get-Process -Id $newPid -ErrorAction SilentlyContinue
if ($alive) {
    Write-Host "Fileserver started detached (PID $newPid) -> http://localhost:8090"
    Write-Host "Logs: $logOut / $logErr"
} else {
    Write-Host "Fileserver process (PID $newPid) exited during startup. Check:" -ForegroundColor Red
    Write-Host "  $logErr"
}
