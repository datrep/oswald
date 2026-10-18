<#
.SYNOPSIS
  Rebuild the overseas-access kit on a fresh Windows laptop (OSWALD remote access).

.DESCRIPTION
  Sets up the laptop side of the remote-access chain. The authoritative record of the
  2026-10-03 readiness check is `oswald/temp/remote-access-readiness-2026-10-03.md`;
  this folder is the portable copy of the kit.

  Chain:  laptop --ZeroTier--> NAS(172.22.160.4) --magic packet--> desk computer(172.22.160.3)
          then: SSH to the computer (Bitvise server, :22), RDP via a Bitvise tunnel.

  What this script does:
    1. Context check (Windows, elevation).
    2. Ensures ZeroTier One is installed (downloads the official MSI unless -SkipInstall).
    3. Ensures the ZeroTier service is running.
    4. Joins network `b15644912eae9aa3` if needed, waits for the controller to authorize this
       member and assign a 172.22.160.x address (prints the node id to authorize).
    5. Connectivity tests: NAS + computer on :22 (over ZeroTier and the home LAN fallbacks).
    6. Prints the remaining manual steps (Bitvise client — per owner — and the wake helper).

.PARAMETER NetworkId
  ZeroTier network to join. Default: b15644912eae9aa3 (the oswald network carrying 172.22.160.x).

.PARAMETER CheckOnly
  Report only — do not install, join, or change anything.

.PARAMETER SkipInstall
  Never download/install; if ZeroTier is missing, print instructions and stop.

.PARAMETER WaitAuthorizedSeconds
  How long to poll for the 172.22.160.x address after joining (default 120). Authorize the
  member in the ZeroTier controller while this waits.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\laptop-rebuild.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\laptop-rebuild.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
  [string]$NetworkId = 'b15644912eae9aa3',
  [switch]$CheckOnly,
  [switch]$SkipInstall,
  [int]$WaitAuthorizedSeconds = 120
)

$ErrorActionPreference = 'Stop'

# --- verified 2026-10-03 (see the readiness report) ---------------------------
$NasZt          = '172.22.160.4'     # NAS over ZeroTier
$PcZt           = '172.22.160.3'     # desk computer over ZeroTier
$NasLan         = '192.168.1.12'     # NAS on the home LAN
$PcLan          = '192.168.1.26'     # desk computer on the home LAN
$NasFingerprint = 'SHA256:yZ9anO/CuVKDsZguNYpYAnHZmA1ciODbVbrOSi9l9kM'

function Say([string]$m)  { Write-Host "[rebuild] $m" }
function Hdr([string]$m)  { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Good([string]$m) { Write-Host "  OK    $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  WARN  $m" -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host "  FAIL  $m" -ForegroundColor Red }

function Find-ZtCli {
  foreach ($c in @(
      'C:\ProgramData\ZeroTier\One\zerotier-one_x64.exe',
      'C:\ProgramData\ZeroTier\One\zerotier-cli.bat',
      'C:\Program Files (x86)\ZeroTier\One\zerotier-one_x64.exe',
      'C:\Program Files\ZeroTier\One\zerotier-one_x64.exe')) {
    if (Test-Path $c) { return $c }
  }
  $cmd = Get-Command zerotier-cli -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
function zt { # zerotier-cli wrapper: `zt info`, `zt listnetworks`, `zt join <id>`
  $cli = Find-ZtCli
  if (-not $cli) { return $null }
  try { & $cli -q $args 2>$null | ForEach-Object { "$_" } } catch { return $null }
}

Hdr '0. Context'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$os = Get-CimInstance Win32_OperatingSystem
Say ("Windows : " + $os.Caption + " (" + $os.Version + ")")
if ($isAdmin) { Good 'elevated (needed for install / join)' }
else { Warn 'NOT elevated — run this script as Administrator or install/join will fail.' }

Hdr '1. ZeroTier One'
$svc = Get-Service ZeroTierOneService -ErrorAction SilentlyContinue
if ($svc) {
  Good ("service present (" + $svc.Status + ")")
} elseif ($CheckOnly) {
  Warn 'not installed (-CheckOnly: nothing changed)'
} elseif ($SkipInstall) {
  Bad 'not installed and -SkipInstall set — install from https://www.zerotier.com/download/ then re-run.'
  exit 2
} else {
  if (-not $isAdmin) { Bad 'installing needs elevation — re-run as Administrator.'; exit 2 }
  $msi = Join-Path $env:TEMP 'ZeroTierOne.msi'
  Say 'downloading official ZeroTier One MSI...'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://download.zerotier.com/dist/ZeroTier%20One.msi' -OutFile $msi
  Say 'installing (silent)...'
  Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait
  Start-Sleep -Seconds 5
  $svc = Get-Service ZeroTierOneService -ErrorAction SilentlyContinue
  if ($svc) { Good 'installed' } else { Bad 'install did not produce the service — check manually.'; exit 2 }
}
if ($svc -and $svc.Status -ne 'Running') { Start-Service ZeroTierOneService; Good 'service started' }

Hdr '2. Network membership'
$nodeId = $null
$info = zt info
foreach ($l in $info) { if ("$l" -match '^200 info ([0-9a-f]{10})') { $nodeId = $Matches[1] } }
if ($nodeId) { Say ("node id: " + $nodeId) } else { Warn 'could not read node id (is the service running / are you elevated?)' }

$joined = $false
foreach ($l in (zt listnetworks)) { if ("$l" -match [regex]::Escape($NetworkId)) { $joined = $true } }

if (-not $joined) {
  if ($CheckOnly) { Warn ("not joined to " + $NetworkId + " (-CheckOnly)") }
  else {
    Say ("joining " + $NetworkId + " ...")
    zt join $NetworkId | Out-Null
    $joined = $true
  }
} else { Good ("joined to " + $NetworkId) }

if ($joined -and -not $CheckOnly) {
  Say ("waiting up to " + $WaitAuthorizedSeconds + "s for a 172.22.160.x address...")
  if ($nodeId) {
    Say 'if this is a NEW machine, authorize it NOW in the ZeroTier controller:'
    Say ("  members list -> authorize node " + $nodeId + "  (network " + $NetworkId + ")")
  }
  $deadline = (Get-Date).AddSeconds($WaitAuthorizedSeconds)
  $ip = $null
  while ((Get-Date) -lt $deadline) {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.InterfaceAlias -like 'ZeroTier One*' -and $_.IPAddress -like '172.22.160.*' } |
      Select-Object -First 1 -ExpandProperty IPAddress
    if ($ip) { break }
    Start-Sleep -Seconds 5
  }
  if ($ip) { Good ("ZeroTier IP: " + $ip) }
  else { Warn 'no 172.22.160.x address yet — authorize the member, then re-run with -CheckOnly to verify.' }
}

Hdr '3. Connectivity tests'
function TcpTest([string]$ip, [int]$port, [string]$label) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($ip, $port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(4000) -and $c.Connected) { $c.Close(); Good ($label + " ($ip`:$port) reachable"); return $true }
    $c.Close(); Bad ($label + " ($ip`:$port) NOT reachable"); return $false
  } catch { Bad ($label + " ($ip`:$port) error: " + $_.Exception.Message); return $false }
}
[void](TcpTest $NasZt 22 'NAS over ZeroTier')
[void](TcpTest $PcZt  22 'computer over ZeroTier (fails while the computer is OFF — expected)')
[void](TcpTest $NasLan 22 'NAS on home LAN (only at home)')
[void](TcpTest $PcLan  22 'computer on home LAN (only at home / awake)')

Hdr '3b. SSH client'
$sshC = Get-Command ssh.exe -ErrorAction SilentlyContinue
$plinkC = Get-Command plink.exe -ErrorAction SilentlyContinue
if ($sshC) { Good ('ssh.exe present: ' + $sshC.Source) }
elseif ($plinkC) { Good ('plink.exe present: ' + $plinkC.Source) }
else { Warn 'neither ssh.exe nor plink.exe — run (admin): Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0   or install PuTTY.' }

Hdr '3c. Shortcut + readiness report'
try {
  $wake = Join-Path $PSScriptRoot 'wake-computer.ps1'
  if (Test-Path $wake) {
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Wake Oswald computer.lnk'
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($lnk)
    $sc.TargetPath = 'powershell.exe'
    $sc.Arguments = '-ExecutionPolicy Bypass -File "' + $wake + '"'
    $sc.WorkingDirectory = $PSScriptRoot
    $sc.Save()
    Good ('desktop shortcut created: ' + $lnk)
  } else { Warn 'wake-computer.ps1 not found next to this script — no shortcut created' }
} catch { Warn ('shortcut not created: ' + $_.Exception.Message) }

$myZt = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -like '172.22.160.*' } | Select-Object -First 1 -ExpandProperty IPAddress
$report = Join-Path $env:USERPROFILE 'oswald-remote-readiness.txt'
@(
  'OSWALD remote-access readiness check',
  '  generated : ' + (Get-Date -Format s),
  '  network   : ' + $NetworkId,
  '  node id   : ' + ($nodeId),
  '  laptop ZT : ' + ($myZt),
  '  NAS       : ' + $NasZt + ' (LAN ' + $NasLan + ')',
  '  computer  : ' + $PcZt + ' (LAN ' + $PcLan + ')',
  '  wake      : .\wake-computer.ps1   (also a Desktop shortcut)'
) | Set-Content -Path $report -Encoding UTF8
Good ('readiness report: ' + $report)

Hdr '4. Left to do by hand'
Write-Host @"
  1) Bitvise SSH Client (manual install):
       profile -> host $PcZt , port 22, your computer's SSH credentials
       RDP via tunnel: port-forward  local 3389 -> target 127.0.0.1:3389
       then:  mstsc /v:127.0.0.1:3389
  2) First SSH to the NAS shows this host-key fingerprint (accept once):
       $NasFingerprint
       NAS: admin@$NasZt   (at home: $NasLan)   password: NAS admin password
  3) Wake the desk computer:  .\wake-computer.ps1
"@

Say 'done.'
