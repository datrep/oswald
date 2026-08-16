# experiment-protocol.ps1 — determine which bootstrap protocol change breaks SQL restart.
# Steps: (0) plain start with current (changed) state; if fail, (1) revert ALL, start,
# (2) re-apply one change at a time, restart each, find culprit. Logs to temp\proto-exp.log
$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'proto-exp.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on UAC)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation declined.'; exit 1 }
    Write-Host "Experiment finished. Log: $logFile"; exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }
$svc = 'MSSQL$SQLEXPRESS'
$regBase = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQLServer'
$tcp = "$regBase\SuperSocketNetLib\Tcp"
$np  = "$regBase\SuperSocketNetLib\Np"
$ipAll = "$tcp\IPAll"

function TryStart([string]$label) {
    $ev = Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddSeconds(-90)} -MaxEvents 20 -ErrorAction SilentlyContinue | Where-Object { $_.Id -in 7034,26 -and $_.Message -match 'SQLEXPRESS' } | Select-Object -First 2
    # clear recent popup count by snapshot approach: just record before
    Start-Service -Name $svc -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 12
    $s = (Get-Service -Name $svc -ErrorAction SilentlyContinue).Status
    $pop = (Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=(Get-Date).AddSeconds(-30)} -MaxEvents 20 -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 26 -and $_.Message -match 'could not find the specified named instance' } | Measure-Object).Count
    Log "  [$label] status=$s  newNotFoundPopup=$pop  tcp1433=$([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
    if ($s -eq 'Running') { Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 4 }
    return ($s -eq 'Running')
}

Log "==== PROTOCOL EXPERIMENT $(Get-Date) ===="
Log "regBase: $regBase"

# 0. plain start with current (bootstrap-changed) state
Log "--- state before: ---"
Log "  LoginMode = $((Get-ItemProperty $regBase -ErrorAction SilentlyContinue).LoginMode)"
Log "  Tcp.Enabled = $((Get-ItemProperty $tcp -ErrorAction SilentlyContinue).Enabled)"
Log "  IPAll.TcpPort = $((Get-ItemProperty $ipAll -ErrorAction SilentlyContinue).TcpPort)"
Log "  IPAll.TcpDynamicPorts = '$((Get-ItemProperty $ipAll -ErrorAction SilentlyContinue).TcpDynamicPorts)'"
Log "  Np.Enabled = $((Get-ItemProperty $np -ErrorAction SilentlyContinue).Enabled)"
Log "--- TEST 0: plain start with changed state ---"
$ok0 = TryStart 'changed-state'

# 1. revert ALL bootstrap changes, start
Log "--- TEST 1: revert all, start ---"
Set-ItemProperty -Path $regBase -Name 'LoginMode' -Value 1 -Type DWord
Set-ItemProperty -Path $tcp -Name 'Enabled' -Value 0 -Type DWord
Set-ItemProperty -Path $np -Name 'Enabled' -Value 0 -Type DWord
Remove-ItemProperty -Path $ipAll -Name 'TcpPort' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $ipAll -Name 'TcpDynamicPorts' -ErrorAction SilentlyContinue
$ok1 = TryStart 'all-reverted'
if (-not $ok1) {
    Log "  All-reverted start FAILED too -> the problem is NOT the protocol changes (revert didn't help)."
    Log "RESULT: NOT the protocol changes. Machine cannot restart SQL service at all (even 2022)."
    exit 0
}
Log "  All-reverted start OK. Now re-apply one at a time to find the culprit."

# 2. LoginMode=2
Log "--- TEST 2: LoginMode=2 only ---"
Set-ItemProperty -Path $regBase -Name 'LoginMode' -Value 2 -Type DWord
$ok2 = TryStart 'loginmode=2'
if (-not $ok2) { Log "  CULPRIT: LoginMode=2"; exit 0 }

# 3. + TCP Enabled=1
Log "--- TEST 3: + TCP Enabled=1 ---"
Set-ItemProperty -Path $tcp -Name 'Enabled' -Value 1 -Type DWord
$ok3 = TryStart 'tcp-enabled'
if (-not $ok3) { Log "  CULPRIT: Tcp.Enabled=1"; exit 0 }

# 4. + TcpPort=1433
Log "--- TEST 4: + TcpPort=1433 ---"
Set-ItemProperty -Path $ipAll -Name 'TcpPort' -Value '1433' -Type String
$ok4 = TryStart 'tcpport-1433'
if (-not $ok4) { Log "  CULPRIT: TcpPort=1433"; exit 0 }

# 5. + TcpDynamicPorts=''
Log "--- TEST 5: + TcpDynamicPorts='' ---"
Set-ItemProperty -Path $ipAll -Name 'TcpDynamicPorts' -Value '' -Type String
$ok5 = TryStart 'tcpdynamicports-empty'
if (-not $ok5) { Log "  CULPRIT: TcpDynamicPorts=''"; exit 0 }

# 6. + Np Enabled=1
Log "--- TEST 6: + Np Enabled=1 ---"
Set-ItemProperty -Path $np -Name 'Enabled' -Value 1 -Type DWord
$ok6 = TryStart 'np-enabled'
if (-not $ok6) { Log "  CULPRIT: Np.Enabled=1"; exit 0 }

Log "  All changes applied individually did not break it. RESULT: inconclusive (combo?)."
Log "==== EXPERIMENT COMPLETE ===="
