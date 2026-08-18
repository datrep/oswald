# ============================================================================
# manual-sql-repair.ps1 - repair the broken SQL Server registry layer BY HAND
# (no setup media needed). Fixes exactly the defects we diagnosed:
#   1. Broken ACLs: SQL registry keys only grant BUILTIN\Users/Administrators/
#      SYSTEM - the SQL service accounts have NO rights, so sqlservr.exe can't
#      read its own config at startup ("could not find the instance - error 2")
#      and can't write its uptime key on shutdown (UpdateUptimeRegKey: Access
#      is denied). -> grant the service accounts FullControl recursively.
#   2. Missing keys: MSSQLSERVER (default) is missing its legacy CurrentVersion
#      key. -> recreate it (+ verify Parameters and Instance Names).
#   3. SQLBrowser caches the "config invalid" state. -> restart it.
#   4. Start both SQL services and verify.
#
# Self-elevates (one UAC click). Logs to temp\manual-sql-repair.log
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\manual-sql-repair.ps1
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'manual-sql-repair.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on the UAC prompt)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host "Elevated run finished. Log: $logFile" -ForegroundColor Cyan
    exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

Log "==== MANUAL SQL REPAIR $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (admin: $isAdmin)"
Log ""

# ---------------------------------------------------------------------------
# PART 1 - recursively grant the SQL service accounts (and admins/SYSTEM)
#          FullControl on the entire SQL Server registry hive.
# ---------------------------------------------------------------------------
Log '########## PART 1: registry ACL repair ##########'

$targets = @(
    'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server'
)
$accounts = @(
    'NT SERVICE\MSSQL$SQLEXPRESS',
    'NT SERVICE\MSSQLSERVER',
    'NT SERVICE\SQLAgent$SQLEXPRESS',
    'BUILTIN\Administrators',
    'NT AUTHORITY\SYSTEM'
)

function Add-Ace {
    param([string]$KeyPath, [System.Security.AccessControl.RegistryAccessRule]$Rule)
    try {
        $acl = Get-Acl $KeyPath
        $acl.AddAccessRule($Rule)
        Set-Acl -Path $KeyPath -AclObject $acl
        return $true
    } catch { return $false }
}

function Fix-AclRecursive {
    param([string]$KeyPath, [System.Security.AccessControl.RegistryAccessRule[]]$Rules)
    $ok = $true
    foreach ($r in $Rules) { if (-not (Add-Ace -KeyPath $KeyPath -Rule $r)) { $ok = $false } }
    Get-ChildItem $KeyPath -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not (Fix-AclRecursive -KeyPath $_.PSPath -Rules $Rules)) { $ok = $false }
    }
    return $ok
}

foreach ($t in $targets) {
    if (-not (Test-Path $t)) { Log "  (skip, missing) $t"; continue }
    Log "  fixing ACLs under: $t"
    $rules = foreach ($acc in $accounts) {
        New-Object System.Security.AccessControl.RegistryAccessRule($acc, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    }
    $ok = Fix-AclRecursive -KeyPath $t -Rules $rules
    if ($ok) { Log "  [ok] ACLs applied recursively under $t" }
    else { Log "  [warn] some keys under $t could not be updated (see errors above)" }
}
Log ''

# ---------------------------------------------------------------------------
# PART 2 - recreate missing registry keys
# ---------------------------------------------------------------------------
Log '########## PART 2: recreate missing keys ##########'
$instances = @(
    @{ ID = 'MSSQL16.SQLEXPRESS';  Name = 'SQLEXPRESS' },
    @{ ID = 'MSSQL16.MSSQLSERVER'; Name = 'MSSQLSERVER' }
)
foreach ($inst in $instances) {
    # legacy instance key CurrentVersion
    $legacyCV = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$($inst.Name)\MSSQLServer\CurrentVersion"
    if (-not (Test-Path $legacyCV)) {
        New-Item -Path $legacyCV -Force | Out-Null
        New-ItemProperty -Path $legacyCV -Name 'CurrentVersion' -Value '16.0.1000.6' -PropertyType String -Force | Out-Null
        Log "  [recreated] legacy CurrentVersion for $($inst.Name) -> 16.0.1000.6"
    } else {
        Log "  [ok] legacy CurrentVersion for $($inst.Name) = $((Get-ItemProperty $legacyCV).CurrentVersion)"
    }
    # versioned hive CurrentVersion
    $verCV = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$($inst.ID)\MSSQLServer\CurrentVersion"
    if (-not (Test-Path $verCV)) {
        New-Item -Path $verCV -Force | Out-Null
        New-ItemProperty -Path $verCV -Name 'CurrentVersion' -Value '16.0.1000.6' -PropertyType String -Force | Out-Null
        Log "  [recreated] versioned CurrentVersion for $($inst.ID) -> 16.0.1000.6"
    } else {
        Log "  [ok] versioned CurrentVersion for $($inst.ID) = $((Get-ItemProperty $verCV).CurrentVersion)"
    }
    # Parameters (should exist; recreate if missing)
    $par = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$($inst.ID)\MSSQLServer\Parameters"
    if (-not (Test-Path $par)) {
        $base = "C:\Program Files\Microsoft SQL Server\$($inst.ID)\MSSQL"
        New-Item -Path $par -Force | Out-Null
        New-ItemProperty -Path $par -Name 0 -Value "-d$base\DATA\master.mdf" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $par -Name 1 -Value "-e$base\Log\ERRORLOG"     -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $par -Name 2 -Value "-l$base\DATA\mastlog.ldf" -PropertyType String -Force | Out-Null
        Log "  [recreated] Parameters for $($inst.ID)"
    } else {
        Log "  [ok] Parameters for $($inst.ID)"
    }
}
Log ''

# ---------------------------------------------------------------------------
# PART 3 - verify Instance Names mapping, restart SQLBrowser, start services
# ---------------------------------------------------------------------------
Log '########## PART 3: verify + start ##########'
$im = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL' -ErrorAction SilentlyContinue
Log "  Instance Names: SQLEXPRESS=$($im.SQLEXPRESS)  MSSQLSERVER=$($im.MSSQLSERVER)"

$browser = Get-Service -Name 'SQLBrowser' -ErrorAction SilentlyContinue
if ($browser) {
    try { Restart-Service -Name 'SQLBrowser' -ErrorAction Stop; Log '  SQLBrowser restarted (clears cached "invalid config")' }
    catch { Log "  could not restart SQLBrowser: $($_.Exception.Message)" }
}

foreach ($sn in @('MSSQL$SQLEXPRESS', 'MSSQLSERVER')) {
    $s = Get-Service -Name $sn -ErrorAction SilentlyContinue
    if (-not $s) { Log "  $sn : not installed"; continue }
    try {
        Start-Service -Name $sn -ErrorAction Stop
        Start-Sleep -Seconds 12
        Log "  $sn -> $((Get-Service -Name $sn).Status)"
    } catch {
        Log "  $sn -> START FAILED: $($_.Exception.Message)"
        Log "  $sn -> status $((Get-Service -Name $sn).Status)"
    }
}
$tcp = New-Object System.Net.Sockets.TcpClient
try { $tcp.Connect('127.0.0.1', 1433); Log '  TCP 1433: LISTENING'; $tcp.Close() } catch { Log '  TCP 1433: not listening' }

Log ''
Log '==== MANUAL REPAIR COMPLETE ===='
Log "  Full log: $logFile"
Log '  Next: REBOOT, then re-run this script once more (ACL changes persist, keys persist).'
Log '  If services still fail after that, the OS registry layer is more broadly broken -> clean reinstall.'
