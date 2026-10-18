<#
.SYNOPSIS
  Wake the desk computer from overseas (runs the NAS wake script, waits for SSH to answer).

.DESCRIPTION
  The laptop-side trigger for the remote-access chain:
    laptop -> (ZeroTier) -> NAS 172.22.160.4 -> `python3 /volume1/scripts/wol_and_probe.py`
    -> magic packet to the computer -> port-check until SSH :22 answers.

  Prerequisites: laptop-rebuild.ps1 has been run (ZeroTier joined + authorized), and an SSH
  client exists — built-in OpenSSH `ssh.exe`, or PuTTY `plink.exe`. You will be prompted for
  the NAS admin password once per run (it is NOT stored by this script).
  Known-good on the NAS side (fixed + validated 2026-10-03): the wake script targets
  MAC e8:9c:25:3f:ec:42 / IP 172.22.160.3 with a 150 s timeout and logs to /volume1/logs/wol.log.

.PARAMETER NasHost
  NAS address. Default 172.22.160.4 (ZeroTier). At home use 192.168.1.12.

.PARAMETER ComputerZt
  The computer to wake/verify. Default 172.22.160.3.

.PARAMETER WaitSeconds
  How long to poll the computer's SSH after the wake command (default 200).

.PARAMETER CheckOnly
  Report the current state (laptop ZeroTier, NAS, computer, services) WITHOUT waking anything.

.PARAMETER LocalLog
  Run-history file (one line per run). Default: $env:USERPROFILE\oswald-wake.log

.PARAMETER OpenRdpAt
  Optional local port — if >0, launches `mstsc /v:127.0.0.1:<port>` after the computer is up
  (use the local port of your Bitvise RDP tunnel).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\wake-computer.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\wake-computer.ps1 -OpenRdpAt 3389
#>
[CmdletBinding()]
param(
  [string]$NasHost = '172.22.160.4',
  [string]$ComputerZt = '172.22.160.3',
  [int]$WaitSeconds = 200,
  [switch]$CheckOnly,
  [string]$LocalLog = (Join-Path $env:USERPROFILE 'oswald-wake.log'),
  [int]$OpenRdpAt = 0
)

$ErrorActionPreference = 'Stop'
function Say([string]$m) { Write-Host "[wake] $m" }
function TcpOk([string]$ip, [int]$port, [int]$ms) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($ip, $port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($ms) -and $c.Connected
    $c.Close(); return $ok
  } catch { return $false }
}
function Log([string]$m) {
  $line = (Get-Date -Format s) + ' ' + $m
  try { Add-Content -Path $LocalLog -Value $line -ErrorAction SilentlyContinue } catch { }
  Write-Host ('[wake] ' + $m)
}
function Services([string]$ip, [string]$label) {
  $ssh = TcpOk $ip 22 3000
  $fs = TcpOk $ip 8080 2000
  $dash = TcpOk $ip 8443 2000
  Write-Host ("  {0,-26} ssh:22 {1}   fileserver:8080 {2}   dashboards:8443 {3}" -f $label,
    $(if ($ssh) { 'UP' } else { '--' }), $(if ($fs) { 'UP' } else { '--' }), $(if ($dash) { 'UP' } else { '--' }))
  return $ssh
}

# 1. local ZeroTier sanity
$zt = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -like '172.22.160.*' } | Select-Object -First 1
if ($zt) { Say ("ZeroTier IP on this laptop: " + $zt.IPAddress) }
else { Say 'WARNING: no 172.22.160.x address — run laptop-rebuild.ps1 / check ZeroTier first.' }

# 2. NAS reachable?
Say ("checking NAS " + $NasHost + ":22 ...")
if (-not (TcpOk $NasHost 22 5000)) {
  Write-Warning ("NAS not reachable at " + $NasHost + " — check ZeroTier is up and this member is authorized.")
  exit 1
}

# 2b. -CheckOnly: report the current state and stop (nothing is woken).
if ($CheckOnly) {
  Log 'check-only run'
  Write-Host ''
  Write-Host '  current state:'
  [void](Services $NasHost 'NAS over ZeroTier')
  [void](Services $ComputerZt 'computer over ZeroTier')
  exit 0
}

# 3. run the wake script on the NAS (one retry on a transient failure)
Say 'NAS reachable. Sending the wake command (password prompt follows).'
$remote = 'python3 /volume1/scripts/wol_and_probe.py'
$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
$plink = Get-Command plink.exe -ErrorAction SilentlyContinue
function Invoke-Wake {
  if ($ssh) { & ssh.exe -o ConnectTimeout=10 ("admin@" + $NasHost) $remote; return $LASTEXITCODE }
  if ($plink) { & plink.exe -ssh ("admin@" + $NasHost) $remote; return $LASTEXITCODE }
  return 127
}
$rc = Invoke-Wake
if ($rc -eq 127) {
  Write-Warning 'No ssh.exe or plink.exe found. Enable the Windows OpenSSH client:'
  Write-Host '  Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0    (admin PowerShell)'
  Write-Warning 'or install PuTTY, then re-run.'
  exit 2
}
if ($rc -ne 0) { Say ("wake command returned code " + $rc + " — retrying once..."); $rc = Invoke-Wake }

# 4. wait for the computer to answer (progress line every ~20s)
Say ("waiting up to " + $WaitSeconds + "s for " + $ComputerZt + ":22 ...")
$ok = $false
$sw = [Diagnostics.Stopwatch]::StartNew()
$nextSay = 20
while ($sw.Elapsed.TotalSeconds -lt $WaitSeconds) {
  if (TcpOk $ComputerZt 22 3000) { $ok = $true; break }
  if ($sw.Elapsed.TotalSeconds -ge $nextSay) {
    Write-Host ("  ...still waiting (" + [int]$sw.Elapsed.TotalSeconds + "s)")
    $nextSay = [int]$sw.Elapsed.TotalSeconds + 20
  }
  Start-Sleep -Seconds 5
}
if ($ok) {
  Write-Host ''
  Write-Host ("*** COMPUTER IS AWAKE — " + $ComputerZt + ":22 answers. Connect now (Bitvise / RDP). ***") -ForegroundColor Green
  Write-Host '  service checks:'
  [void](Services $ComputerZt 'computer over ZeroTier')
  Log ("awake after " + [int]$sw.Elapsed.TotalSeconds + "s — services checked")
  if ($OpenRdpAt -gt 0) {
    Say ("launching mstsc /v:127.0.0.1:" + $OpenRdpAt + " ...")
    Start-Process mstsc.exe -ArgumentList ("/v:127.0.0.1:" + $OpenRdpAt)
  }
} else {
  Log ("timeout after " + $WaitSeconds + "s")
  Write-Warning ("computer did not answer within " + $WaitSeconds + "s.")
  Write-Host ("check the NAS log:  ssh admin@" + $NasHost + " `"tail -n 20 /volume1/logs/wol.log`"")
  exit 1
}
