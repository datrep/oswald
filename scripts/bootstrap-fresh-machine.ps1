# ============================================================================
# bootstrap-fresh-machine.ps1 — one-click setup of Oswald from a brand-new
# Windows machine (no Node, no SQL Server, nothing pre-configured).
#
# What this script does, in order:
#   1. Elevates itself to Administrator (one UAC consent).
#   2. Installs Node.js LTS via winget if `node` is missing.
#   3. Installs SQL Server 2022 Express via winget if no instance is found —
#      or, if the SQL service path is unusable (or -UseLocalDB is passed),
#      falls back to SQL Server Express LocalDB (on-demand engine, no service)
#      with mssql/msnodesqlv8 + Windows auth.
#   4. Fixes the four classic "SQL Server isn't reachable" problems:
#        - service stopped          -> Start-Service + Automatic startup
#        - TCP/IP disabled          -> registry Enabled=1 + static port
#        - Named Pipes disabled     -> registry Enabled=1
#        - Windows-auth only        -> LoginMode=2 (mixed: SQL + Windows)
#   5. Bootstraps the database over Windows auth (Integrated Security) with
#      System.Data.SqlClient (no sqlcmd dependency):
#        - runs sql/schema/DB_init_table.sql  (fresh DB only, or -ResetDb)
#        - applies sql/migrations/002..015    (idempotent, always; 001 is a
#          drift-fix superseded by 002 and is skipped)
#        - sets a strong api_user password + generates JWT_SECRET
#   6. Writes .env (never overwrites an existing one).
#   7. Creates gitignored runtime dirs and regenerates fileserver/config.json
#      (it ships with the OLD machine's absolute paths + dashboard IP).
#   8. npm install (repo root + fileserver).
#   9. Trusts the self-signed cert, opens firewall ports for remote access,
#      starts both servers detached, waits for /api/health, runs the
#      regression suite, and (optionally) registers logon auto-start tasks.
#
# Safe to RE-RUN on an existing machine: it detects what's already there,
# skips finished stages, and never touches data unless you pass -ResetDb.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap-fresh-machine.ps1
#
# Optional switches:
#   -Instance <name>   SQL Server instance (default SQLEXPRESS)
#   -SqlPort <n>       static TCP port (default 1433)
#   -DbName <name>     database (default DB_Oswald)
#   -DbUser <name>     SQL login (default api_user)
#   -DbPassword <pw>   SQL login password (default: generate a strong one)
#   -AppPort <n>       dashboard HTTP port (default 8080)
#   -HttpsPort <n>     dashboard HTTPS port (default 8443)
#   -ListenHost <addr> bind address written to .env (default 0.0.0.0)
#   -InstallNode / -NoInstallNode        (default: auto-install if missing)
#   -InstallSqlServer / -NoInstallSqlServer  (default: auto-install if missing)
#   -UseLocalDB          force LocalDB (on-demand, no SQL service) mode
#   -NoUseLocalDB        never fall back to LocalDB
#   -ResetDb           DESTRUCTIVE: drop + recreate DB_Oswald from schema
#   -ResetConfig       force-regenerate fileserver/config.json
#   -SkipFirewallRules do NOT open inbound firewall ports (8080/8443/8090/8091)
#   -RegisterAutoStart register logon scheduled tasks to start both servers
#   -SkipServerStart   do not start the servers at the end
#   -SkipSmokeTest     do not run the regression suite at the end
# ============================================================================

# The DB password is auto-generated and written to .env (never typed interactively),
# so the plain-String parameter is intentional.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'Auto-generated secret persisted to .env')]
[CmdletBinding()]
param(
    [string]$Instance   = 'SQLEXPRESS',
    [int]$SqlPort       = 1433,
    [string]$DbName     = 'DB_Oswald',
    [string]$DbUser     = 'api_user',
    [string]$DbPassword = '',
    [string]$SaPassword = '',        # fallback admin login if Windows auth is unavailable
    [int]$AppPort       = 8080,
    [int]$HttpsPort     = 8443,
    [string]$ListenHost = '0.0.0.0',
    [switch]$InstallNode,
    [switch]$NoInstallNode,
    [switch]$InstallSqlServer,
    [switch]$NoInstallSqlServer,
    [switch]$UseLocalDB,
    [switch]$NoUseLocalDB,
    [switch]$ResetDb,
    [switch]$ResetConfig,
    [switch]$SkipFirewallRules,
    [switch]$RegisterAutoStart,
    [switch]$SkipServerStart,
    [switch]$SkipSmokeTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$ErrColor = 'Red'
$Warn     = 'Yellow'
$Ok       = 'Green'
$Info     = 'Cyan'

function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor $Info }
function Write-Ok([string]$msg)   { Write-Host "  [ok]  $msg" -ForegroundColor $Ok }
function Write-Warn([string]$msg) { Write-Host "  [!!]  $msg" -ForegroundColor $Warn }
function Write-Fail([string]$msg) { Write-Host "  [FAIL] $msg" -ForegroundColor $ErrColor }

# ---------------------------------------------------------------------------
# Elevation — everything below touches the registry/services, so we need admin.
# ---------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (one UAC prompt)..." -ForegroundColor $Info
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    # Forward every named parameter so the elevated run behaves identically.
    foreach ($k in $PSBoundParameters.Keys) {
        $v = $PSBoundParameters[$k]
        if ($v -is [switch]) { if ($v) { $argList += "-$k" } }
        else { $argList += "-$k"; $argList += "`"$v`"" }
    }
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -PassThru
    if (-not $p) { Write-Fail 'Elevation was declined.'; exit 1 }
    exit 0
}

Write-Host ""
Write-Host "==============================================================" -ForegroundColor $Info
Write-Host "  Oswald - fresh machine bootstrap" -ForegroundColor $Info
Write-Host "  root: $root" -ForegroundColor $Info
Write-Host "==============================================================" -ForegroundColor $Info

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Update-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-RandomHex([int]$bytes = 48) {
    $b = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

function Get-RandomPassword([int]$len = 24) {
    $set = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $b = New-Object byte[] $len
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    $sb = New-Object System.Text.StringBuilder
    foreach ($x in $b) { [void]$sb.Append($set[$x % $set.Length]) }
    $sb.ToString()
}

function Invoke-SqlBatch {
    param([string]$ConnectionString, [string]$Sql)
    $conn = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
    try {
        $conn.Open()
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $Sql
        $cmd.CommandTimeout = 300
        [void]$cmd.ExecuteNonQuery()
    } finally {
        $conn.Dispose()
    }
}

# SqlClient doesn't understand `GO`, so split a .sql file into batches and run
# them on ONE connection (NOT one connection per batch — that resets the USE
# context back to the connection-string default, so a schema's `USE DB_Oswald`
# would be lost and its CREATE TABLEs would land in master).
function Invoke-SqlScript {
    param([string]$ConnectionString, [string]$Path, [switch]$ContinueOnError)
    if (-not (Test-Path $Path)) { throw "Script not found: $Path" }
    $content = (Get-Content $Path -Raw) -replace "`r`n", "`n"
    $batches = $content -split "(?m)^\s*GO\s*$"
    $conn = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
    try {
        $conn.Open()
        $n = 0
        foreach ($b in $batches) {
            $b = $b.Trim()
            if (-not $b) { continue }
            $n++
            try {
                $cmd = $conn.CreateCommand()
                $cmd.CommandText = $b
                $cmd.CommandTimeout = 300
                [void]$cmd.ExecuteNonQuery()
            } catch {
                if ($ContinueOnError) {
                    Write-Warn "batch $n failed (continuing): $($_.Exception.Message)"
                } else {
                    throw
                }
            }
        }
        Write-Ok "$n batch(es) executed from $(Split-Path $Path -Leaf)"
    } finally {
        $conn.Dispose()
    }
}

function Get-SqlInstances {
    $hits = @()
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server\Instance Names\SQL'
    )
    foreach ($p in $paths) {
        if (Test-Path $p) {
            $props = Get-ItemProperty $p
            foreach ($prop in $props.PSObject.Properties) {
                if ($prop.Name -match '^PS') { continue }
                $hits += [PSCustomObject]@{ Instance = $prop.Name; InstanceID = $prop.Value }
            }
        }
    }
    return $hits
}

function Wait-TcpPort {
    param([int]$Port, [int]$TimeoutSec = 90)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $c.Connect('127.0.0.1', $Port)
            $c.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 800 }
    }
    return $false
}

function Confirm-Present([string]$Cmd) {
    return [bool](Get-Command $Cmd -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# LocalDB helpers — on-demand, no SQL service. Fallback for machines that
# cannot run a SQL Server *service* instance (e.g. Windows To Go), and the
# explicit `-UseLocalDB` path.
# ---------------------------------------------------------------------------
$script:LocalDbInstance = 'MSSQLLocalDB'
$script:UseLocalDB = $false

function Get-LocalDbExe {
    $c = Get-Command SqlLocalDB -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @(
            "$env:ProgramFiles\Microsoft SQL Server\170\Tools\Binn\SqlLocalDB.exe",
            "$env:ProgramFiles\Microsoft SQL Server\160\Tools\Binn\SqlLocalDB.exe",
            "$env:ProgramFiles\Microsoft SQL Server\150\Tools\Binn\SqlLocalDB.exe",
            "$env:ProgramFiles\Microsoft SQL Server\140\Tools\Binn\SqlLocalDB.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Start-LocalDb {
    $exe = Get-LocalDbExe
    if (-not $exe) {
        Write-Warn 'SqlLocalDB.exe not found — SQL Server Express LocalDB is not installed.'
        return $false
    }
    try {
        & $exe start $script:LocalDbInstance 2>&1 | Out-Null
        $info = & $exe info $script:LocalDbInstance 2>&1 | Out-String
        if ($info -match 'State:\s*Running') { return $true }
        Write-Warn "LocalDB instance '$($script:LocalDbInstance)' did not reach Running: $($info.Trim())"
    } catch {
        Write-Warn "LocalDB start error: $($_.Exception.Message)"
    }
    return $false
}

# Switch the whole bootstrap into LocalDB mode: start the instance, set the
# script-level flags, and build the master connection string. Returns $true on
# success, $false if LocalDB isn't usable.
function Enable-LocalDbMode {
    if ($script:UseLocalDB) { return $true }   # already on
    if (-not (Start-LocalDb)) { return $false }
    $script:UseLocalDB = $true
    $script:LocalDbServer = '(localdb)\' + $script:LocalDbInstance
    $script:masterCs = "Server=$($script:LocalDbServer);Database=master;Integrated Security=true;TrustServerCertificate=true"
    Write-Ok "using LocalDB '$($script:LocalDbServer)' (Windows auth, no SQL service)"
    return $true
}

# Start (or restart) a SQL Server service with retries. A fresh SQL Express
# install frequently isn't ready until a REBOOT, so on persistent failure we
# dump the ERRORLOG + event log and tell the user to reboot and re-run (the
# script is idempotent and resumes from where it left off).
function Show-SqlStartDiagnostics {
    param([string]$Name, [string]$InstanceID)
    Write-Fail "SQL Server service '$Name' did not reach 'Running'."
    $errLog = "C:\Program Files\Microsoft SQL Server\$InstanceID\MSSQL\Log\ERRORLOG"
    if (Test-Path $errLog) {
        Write-Host "  Last lines of ${errLog}:" -ForegroundColor $Warn
        Get-Content $errLog -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor $Warn }
    } else {
        Write-Warn "ERRORLOG not found at '$errLog'"
    }
    Write-Host "  Service config:" -ForegroundColor $Warn
    sc.exe qc $Name 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor $Warn }
    Write-Host "  Recent Application event log (SQL/$Name):" -ForegroundColor $Warn
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddMinutes(-30) } -MaxEvents 30 -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match [regex]::Escape($Name) -or $_.ProviderName -match 'SQL|MSSQL' } |
        Select-Object -First 6 |
        ForEach-Object { Write-Host "    [$($_.TimeCreated.ToString('HH:mm:ss'))] $($_.ProviderName): $($_.Message)" -ForegroundColor $Warn }
    Write-Host ""
    Write-Host "  ================================================================" -ForegroundColor $Info
    Write-Host "  SQL Server service would not start." -ForegroundColor $Info
    Write-Host "  Most common cause right after a fresh SQL Express install: a REBOOT is required." -ForegroundColor $Info
    Write-Host "  Restart the machine, then re-run this script - it resumes where it left off." -ForegroundColor $Info
    Write-Host "  (If it still fails after reboot, the ERRORLOG/event-log lines above say why.)" -ForegroundColor $Info
    Write-Host "  ================================================================" -ForegroundColor $Info
}

function Start-SqlService {
    param([string]$Name, [string]$InstanceID, [switch]$Restart)
    try { Set-Service -Name $Name -StartupType Automatic } catch { Write-Warn "could not set '$Name' to Automatic: $($_.Exception.Message)" }
    $attempts = 3
    for ($i = 1; $i -le $attempts; $i++) {
        if (-not $Restart -and (Get-Service -Name $Name).Status -eq 'Running') {
            Write-Ok "'$Name' already running"
            return $true
        }
        try {
            if ($Restart) {
                Write-Host "  restarting '$Name' to apply protocol changes (attempt $i/$attempts)..."
                Restart-Service -Name $Name -Force -ErrorAction Stop
            } else {
                Write-Host "  starting '$Name' (attempt $i/$attempts)..."
                Start-Service -Name $Name -ErrorAction Stop
            }
        } catch { Write-Warn "  attempt $i failed: $($_.Exception.Message)" }
        Start-Sleep -Seconds 4
        if ((Get-Service -Name $Name).Status -eq 'Running') { break }
    }
    # Bounded poll (NOT a long WaitForStatus) so a failed start surfaces quickly
    # instead of looking hung for 90s.
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        if ((Get-Service -Name $Name).Status -eq 'Running') { Write-Ok "'$Name' is running"; return $true }
        Start-Sleep -Milliseconds 500
    } while ($sw.Elapsed.TotalSeconds -lt 15)
    Show-SqlStartDiagnostics -Name $Name -InstanceID $InstanceID
    return $false
}

# ---------------------------------------------------------------------------
# Stage 1 — Node.js
# ---------------------------------------------------------------------------
Write-Step "Stage 1/9  Node.js"
if (Confirm-Present 'node') {
    Write-Ok "node $((node --version))"
} elseif ($NoInstallNode) {
    Write-Fail "node is required but -NoInstallNode was set."
    exit 1
} else {
    if (-not (Confirm-Present 'winget')) {
        Write-Fail 'winget is not available (Windows 10 1809+/11 required). Install Node.js manually: https://nodejs.org'
        exit 1
    }
    Write-Host "  Installing Node.js LTS via winget..."
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 0x8A150011) {
        Write-Fail "winget node install failed (exit $LASTEXITCODE)."
        exit 1
    }
    Update-Path
    if (-not (Confirm-Present 'node')) {
        Write-Fail 'node still not on PATH after install — open a new terminal and re-run.'
        exit 1
    }
    Write-Ok "node $((node --version))"
}

# ---------------------------------------------------------------------------
# Stage 2 — SQL Server: detect, install, enable, start
# ---------------------------------------------------------------------------
Write-Step "Stage 2/9  SQL Server ($Instance)"

# LocalDB mode uses the on-demand engine (no SQL service). Forced via -UseLocalDB,
# or auto-fallback below whenever the service path proves unusable.
if ($UseLocalDB) {
    if (-not (Enable-LocalDbMode)) { Write-Fail 'LocalDB requested (-UseLocalDB) but could not be started.'; exit 1 }
}

if (-not $script:UseLocalDB) {
# The whole service flow runs inside this loop so an auto-fallback to LocalDB
# (which sets $script:UseLocalDB) can `break` out and skip the rest cleanly.
:stage2 while ($true) {
$instances = Get-SqlInstances
$inst = $instances | Where-Object { $_.Instance -eq $Instance } | Select-Object -First 1

if (-not $inst -and $instances.Count) {
    # No instance named $Instance, but at least one exists (e.g. a manual install
    # under a different name, like a default instance) - use it rather than
    # installing a second one.
    $inst = @($instances)[0]
    Write-Warn "No instance named '$Instance'; using '$($inst.Instance)' instead (found: $($instances.Instance -join ', '))"
    Write-Host "  Re-run with -Instance <name> to target a specific instance." -ForegroundColor $Warn
}

if (-not $inst) {
    if ($NoInstallSqlServer) {
        if ($instances.Count) { Write-Host "  Instances found: $($instances.Instance -join ', '). Re-run with -Instance <name> to use one." -ForegroundColor $Warn }
        if ($NoUseLocalDB) { Write-Fail "SQL instance '$Instance' not found and -NoInstallSqlServer was set (LocalDB disabled with -NoUseLocalDB)."; exit 1 }
        Write-Warn "No SQL instance and -NoInstallSqlServer was set — attempting LocalDB fallback..."
        if (Enable-LocalDbMode) { Write-Warn 'Continuing with LocalDB instead of a SQL service.'; break }
        Write-Fail "SQL instance '$Instance' not found, -NoInstallSqlServer set, and LocalDB is unavailable."; exit 1
    }
    if ($instances.Count) {
        Write-Warn "No instance named '$Instance', but these exist: $($instances.Instance -join ', ')"
        Write-Host "  Re-run with -Instance <one-of-those> to use an existing install, or let the script install a new one:" -ForegroundColor $Warn
    }
    if (-not (Confirm-Present 'winget')) {
        if ($NoUseLocalDB) { Write-Fail 'winget not available. Install SQL Server Express (2022 or 2025) manually, then re-run.'; exit 1 }
        Write-Warn 'winget not available — attempting LocalDB fallback...'
        if (Enable-LocalDbMode) { Write-Warn 'Continuing with LocalDB instead of a SQL service.'; break }
        Write-Fail 'winget not available and LocalDB could not be started. Install SQL Server Express (2022 or 2025) manually, then re-run.'; exit 1
    }
    # Try the latest Express first, then the previous release (winget ids vary by source).
    $installed = $false
    foreach ($pkg in @('Microsoft.SQLServer.2025.Express', 'Microsoft.SQLServer.2022.Express')) {
        Write-Host "  No SQL instance found — installing '$pkg' (this takes several minutes)..."
        winget install --id $pkg -e --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 0x8A150011) { $installed = $true; break }
        Write-Warn "  winget could not install '$pkg' (exit $LASTEXITCODE); trying next..."
    }
    if (-not $installed) {
        if ($NoUseLocalDB) {
            Write-Fail 'Could not auto-install SQL Server Express via winget.'
            Write-Host "  Install SQL Server 2025 or 2022 Express manually from https://www.microsoft.com/en-us/sql-server/sql-server-downloads" -ForegroundColor $Warn
            Write-Host "  (accept the defaults, instance name '$Instance'), then REBOOT and re-run this script - it will detect the instance and continue." -ForegroundColor $Warn
            exit 1
        }
        Write-Warn 'Could not auto-install SQL Server Express via winget — attempting LocalDB fallback...'
        if (Enable-LocalDbMode) { Write-Warn 'Continuing with LocalDB instead of a SQL service.'; break }
        Write-Fail 'Could not auto-install SQL Server Express via winget and LocalDB is unavailable.'
        Write-Host "  Install SQL Server 2025 or 2022 Express manually from https://www.microsoft.com/en-us/sql-server/sql-server-downloads" -ForegroundColor $Warn
        exit 1
    }
    # Re-detect (install creates the instance; service may take a moment to appear)
    $instances = Get-SqlInstances
    $inst = $instances | Where-Object { $_.Instance -eq $Instance } | Select-Object -First 1
}

if (-not $inst) {
    if ($NoUseLocalDB) { Write-Fail "Instance '$Instance' still not detected after install. Restart the machine and re-run."; exit 1 }
    Write-Warn "Instance '$Instance' still not detected after install — attempting LocalDB fallback..."
    if (Enable-LocalDbMode) { Write-Warn 'Continuing with LocalDB instead of a SQL service.'; break }
    Write-Fail "Instance '$Instance' still not detected after install and LocalDB is unavailable. Restart the machine and re-run."; exit 1
}
Write-Ok "found instance '$($inst.Instance)' (InstanceID '$($inst.InstanceID)')"

$serviceName = if ($inst.Instance -eq 'MSSQLSERVER') { 'MSSQLSERVER' } else { "MSSQL`$$($inst.Instance)" }
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $svc) {
    if ($NoUseLocalDB) { Write-Fail "Service '$serviceName' not found. Check the instance name."; exit 1 }
    Write-Warn "Service '$serviceName' not found — attempting LocalDB fallback..."
    if (Enable-LocalDbMode) { Write-Warn 'Continuing with LocalDB instead of a SQL service.'; break }
    Write-Fail "Service '$serviceName' not found and LocalDB is unavailable. Check the instance name."; exit 1
}

# (a0) SELF-HEAL a tampered/corrupt instance registry. sqlservr.exe needs the
# MSSQLServer\Parameters key (values 0/1/2 = -d/-e/-l startup paths) to locate
# master.mdf. If it has been deleted (registry tampering / aborted installer),
# the service dies with exit 1067 + "could not find the specified named
# instance (X) - error 2" (error 2 = file not found). Must run BEFORE the first
# Start-SqlService, or that call fails fast and aborts the whole script.
$instanceRegKey = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$($inst.InstanceID)"
$setupKey       = "$instanceRegKey\Setup"
$sqlPath        = (Get-ItemProperty $setupKey -ErrorAction SilentlyContinue).SQLPath
if (-not $sqlPath) { $sqlPath = "C:\Program Files\Microsoft SQL Server\$($inst.InstanceID)\MSSQL" }
$paramsKey = "$instanceRegKey\MSSQLServer\Parameters"
if (-not (Test-Path $paramsKey)) {
    Write-Warn "MSSQLServer\Parameters missing (tampered registry) - recreating startup parameters"
    New-Item -Path $paramsKey -Force | Out-Null
    New-ItemProperty -Path $paramsKey -Name 0 -Value "-d$sqlPath\DATA\master.mdf" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $paramsKey -Name 1 -Value "-e$sqlPath\Log\ERRORLOG" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $paramsKey -Name 2 -Value "-l$sqlPath\DATA\mastlog.ldf" -PropertyType String -Force | Out-Null
    Write-Ok "recreated Parameters (-d/-e/-l under $sqlPath)"
} else {
    $params = Get-Item $paramsKey
    foreach ($idx in 0,1,2) {
        if (-not $params.GetValueNames().Contains([string]$idx)) {
            $v = switch ($idx) { 0 { "-d$sqlPath\DATA\master.mdf" } 1 { "-e$sqlPath\Log\ERRORLOG" } 2 { "-l$sqlPath\DATA\mastlog.ldf" } }
            Write-Warn "Parameters value '$idx' missing - restoring to '$v'"
            New-ItemProperty -Path $paramsKey -Name $idx -Value $v -PropertyType String -Force | Out-Null
        }
    }
    Write-Ok "MSSQLServer\Parameters present"
}

# Also restore the 32-bit instance-name mapping if it was removed (needed for
# SQL Browser enumeration and 32-bit client tools).
$wowMap = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server\Instance Names\SQL'
if (-not (Test-Path (Join-Path $wowMap $inst.Instance))) {
    New-Item -Path $wowMap -Force | Out-Null
    New-ItemProperty -Path $wowMap -Name $inst.Instance -Value $inst.InstanceID -PropertyType String -Force | Out-Null
    Write-Ok "restored WOW6432Node instance mapping '$($inst.Instance)' -> '$($inst.InstanceID)'"
}

# Sanity-check the engine's data files so a fully-wiped install fails loudly
# with a useful message instead of a cryptic 1067.
foreach ($needle in @("$sqlPath\DATA\master.mdf", "$sqlPath\DATA\mastlog.ldf", "$sqlPath\Log\ERRORLOG")) {
    if (-not (Test-Path $needle)) {
        Write-Warn "expected file missing: $needle (if data was deleted too, restore a backup or use -ResetDb to rebuild from schema)"
    }
}

# (a) service on + automatic start (retries + diagnostics on failure)
#     If the service refuses to start (this machine's actual failure mode), fall
#     back to LocalDB instead of aborting.
if (-not (Start-SqlService -Name $serviceName -InstanceID $($inst.InstanceID))) {
    if ($NoUseLocalDB) { Show-SqlStartDiagnostics -Name $serviceName -InstanceID $($inst.InstanceID); exit 1 }
    Write-Warn "SQL service '$serviceName' failed to start — attempting LocalDB fallback..."
    if (Enable-LocalDbMode) { Write-Warn 'Continuing with LocalDB instead of the SQL service.'; break }
    Show-SqlStartDiagnostics -Name $serviceName -InstanceID $($inst.InstanceID)
    exit 1
}

# (a1) SQL Server Browser — needed for SSMS "Browse for servers" / instance discovery.
$browser = Get-Service -Name 'SQLBrowser' -ErrorAction SilentlyContinue
if ($browser) {
    try { Set-Service -Name 'SQLBrowser' -StartupType Automatic } catch { Write-Warn "could not set SQLBrowser to Automatic: $($_.Exception.Message)" }
    if ($browser.Status -ne 'Running') {
        Write-Host "  Starting SQL Server Browser (for SSMS instance discovery)..."
        try { Start-Service -Name 'SQLBrowser' -ErrorAction Stop; Write-Ok 'SQL Browser started' } catch { Write-Warn "could not start SQLBrowser: $($_.Exception.Message)" }
    } else {
        Write-Ok 'SQL Browser already running'
    }
} else {
    Write-Warn 'SQLBrowser service not found (SSMS browse list may stay empty; type the server name manually)'
}

# (b)/(c)/(d) TCP/IP + Named Pipes + mixed-mode auth via registry
$regBase = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$($inst.InstanceID)\MSSQLServer"
Write-Host "  Enabling mixed-mode auth, TCP/IP (static port $SqlPort) and Named Pipes..."
# Mixed mode (2 = SQL + Windows)
New-Item -Path $regBase -Force | Out-Null
Set-ItemProperty -Path $regBase -Name 'LoginMode' -Value 2 -Type DWord
# TCP enabled + static port on all IPs
$tcp = "$regBase\SuperSocketNetLib\Tcp"
New-Item -Path $tcp -Force | Out-Null
Set-ItemProperty -Path $tcp -Name 'Enabled' -Value 1 -Type DWord
$ipAll = "$tcp\IPAll"
New-Item -Path $ipAll -Force | Out-Null
Set-ItemProperty -Path $ipAll -Name 'TcpPort' -Value "$SqlPort" -Type String
Set-ItemProperty -Path $ipAll -Name 'TcpDynamicPorts' -Value '' -Type String
# Named Pipes
$np = "$regBase\SuperSocketNetLib\Np"
New-Item -Path $np -Force | Out-Null
Set-ItemProperty -Path $np -Name 'Enabled' -Value 1 -Type DWord

# Registry changes take effect on service restart
if (-not (Start-SqlService -Name $serviceName -InstanceID $($inst.InstanceID) -Restart)) { exit 1 }

if (-not (Wait-TcpPort -Port $SqlPort)) {
    Write-Fail "SQL Server is not accepting TCP connections on port $SqlPort yet. Restart the machine and re-run."
    exit 1
}
Write-Ok "SQL Server listening on TCP $SqlPort"
break
} # /stage2
} # /if (-not $script:UseLocalDB)

# ---------------------------------------------------------------------------
# Stage 3 — database bootstrap (Windows auth, no sqlcmd needed)
# ---------------------------------------------------------------------------
Write-Step "Stage 3/9  Database ($DbName)"

Add-Type -AssemblyName System.Data

# Windows-auth connection as the sysadmin running this script.
# NOTE: use `localhost` for Integrated Security - `127.0.0.1` trips the NTLM
# loopback check ("login from an untrusted domain") on many setups.
# Try a few local transport modes, then fall back to SQL auth (sa) if enabled.
function Get-AdminConnectionString {
    $candidates = @(
        ("Server=localhost,$SqlPort;Database=master;Integrated Security=true;TrustServerCertificate=true", 'WinAuth TCP'),
        ("Server=localhost\$Instance;Database=master;Integrated Security=true;TrustServerCertificate=true", 'WinAuth instance (shared mem/named pipes)'),
        ("Server=localhost,$SqlPort;Database=master;User ID=sa;Password=$SaPassword;TrustServerCertificate=true", 'SQL auth sa')
    )
    foreach ($c in $candidates) {
        if ($c[0] -like '*Password=;*' -and $c[1] -eq 'SQL auth sa') { continue }  # skip sa unless a password was given
        try { Invoke-SqlBatch -ConnectionString $c[0] -Sql "SELECT 1"; return $c[0] } catch { Write-Warn "$($c[1]) failed: $($_.Exception.Message)" }
    }
    return $null
}

if ($script:UseLocalDB) {
    $masterCs = $script:masterCs
    Write-Ok "LocalDB admin connection established"
} else {
    $masterCs = Get-AdminConnectionString
    if (-not $masterCs) {
        Write-Fail 'Could not connect to SQL Server with any local mode (Windows auth or sa).'
        Write-Host "  Fix: either ensure this account is a sysadmin on '$Instance'," -ForegroundColor $Warn
        Write-Host "  or pass -SaPassword with an existing sa password, or connect with SSMS once to add yourself:" -ForegroundColor $Warn
        Write-Host "  ALTER SERVER ROLE sysadmin ADD MEMBER [<domain>\<user>];" -ForegroundColor $Warn
        Write-Host "  ...or re-run with -UseLocalDB to use SQL Server Express LocalDB instead." -ForegroundColor $Warn
        exit 1
    }
    Write-Ok "admin connection established"
}
$dbCs = $masterCs -replace 'Database=master', "Database=$DbName"

$dbExists = $false

# Do a real existence check (result-set aware).
$conn = New-Object System.Data.SqlClient.SqlConnection $masterCs
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = "SELECT CASE WHEN DB_ID('$DbName') IS NULL THEN 0 ELSE 1 END"
$dbExists = ([int]$cmd.ExecuteScalar()) -eq 1
$conn.Close()

if ($dbExists -and $ResetDb) {
    Write-Host "  -ResetDb: DROPPING and recreating '$DbName'..." -ForegroundColor $Warn
    $confirm = Read-Host "  Type 'yes' to DROP ALL DATA in $DbName"
    if ($confirm -notin @('yes', 'y')) { Write-Warn 'Reset cancelled.'; exit 0 }
    Invoke-SqlScript -ConnectionString $masterCs -Path (Join-Path $root 'sql\schema\DB_init_table.sql') -ContinueOnError
    $dbExists = $false
}

if (-not $dbExists) {
    Write-Host "  '$DbName' does not exist — creating from sql/schema/DB_init_table.sql..."
    Invoke-SqlScript -ConnectionString $masterCs -Path (Join-Path $root 'sql\schema\DB_init_table.sql') -ContinueOnError
}

# Apply migrations 002..015. Migration 001 is a DRIFT-FIX for pre-existing DBs
# whose plannedEnd was NOT NULL — on the current schema it ALWAYS fails (the
# `active` computed column blocks the ALTER) and its work is fully superseded
# by migration 002 (guarded/idempotent), so we skip 001 entirely.
Write-Host "  Applying migrations (002..015; 001 is a drift-fix superseded by 002)..."
$migrations = Get-ChildItem (Join-Path $root 'sql\migrations') -Filter '*.sql' | Sort-Object Name | Where-Object { $_.Name -notlike '001_*' }
foreach ($m in $migrations) {
    Invoke-SqlScript -ConnectionString $dbCs -Path $m.FullName
}

# Ensure api_user's password matches what we write to .env.
if (-not $DbPassword) { $DbPassword = Get-RandomPassword }
try {
    Invoke-SqlBatch -ConnectionString $masterCs -Sql "IF SUSER_ID('$DbUser') IS NULL CREATE LOGIN [$DbUser] WITH PASSWORD = N'$DbPassword' ELSE ALTER LOGIN [$DbUser] WITH PASSWORD = N'$DbPassword'"
    Invoke-SqlBatch -ConnectionString $dbCs -Sql "IF DATABASE_PRINCIPAL_ID('$DbUser') IS NULL CREATE USER [$DbUser] FOR LOGIN [$DbUser]"
    Invoke-SqlBatch -ConnectionString $dbCs -Sql "ALTER ROLE db_datareader ADD MEMBER [$DbUser]; ALTER ROLE db_datawriter ADD MEMBER [$DbUser]"
    Write-Ok "login [$DbUser] ready (password set)"
} catch {
    Write-Warn "Could not provision [$DbUser] login: $($_.Exception.Message). The schema may have created it already."
}

# ---------------------------------------------------------------------------
# Stage 4 — .env (never overwrite)
# ---------------------------------------------------------------------------
Write-Step "Stage 4/9  .env"
$envPath = Join-Path $root '.env'
if (-not (Test-Path $envPath)) {
    if (-not $DbPassword) { $DbPassword = Get-RandomPassword }
    $jwt = Get-RandomHex 48
    if ($script:UseLocalDB) {
        # LocalDB mode: config/db.js + fileserver/db.js use mssql/msnodesqlv8
        # over ODBC Driver 18 with Windows auth (DB_USER/DB_PASSWORD unused).
        $content = @"
# Generated by scripts/bootstrap-fresh-machine.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
PORT=$AppPort
HTTPS_PORT=$HttpsPort
SERVER_HOST=$ListenHost
LOCAL_SERVER_HOST=$ListenHost
REMOTE_SERVER_HOST=0.0.0.0
DB_DRIVER=msnodesqlv8
DB_SERVER=(localdb)\$($script:LocalDbInstance)
DB_INSTANCE=$($script:LocalDbInstance)
DB_PORT=1433
DB_DATABASE=$DbName
DB_USER=$DbUser
DB_PASSWORD=$DbPassword
JWT_SECRET=$jwt
NODE_ENV=production
"@
    } else {
        $content = @"
# Generated by scripts/bootstrap-fresh-machine.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
PORT=$AppPort
HTTPS_PORT=$HttpsPort
SERVER_HOST=$ListenHost
LOCAL_SERVER_HOST=$ListenHost
REMOTE_SERVER_HOST=0.0.0.0
DB_SERVER=localhost
DB_INSTANCE=$($inst.Instance)
DB_PORT=$SqlPort
DB_DATABASE=$DbName
DB_USER=$DbUser
DB_PASSWORD=$DbPassword
JWT_SECRET=$jwt
NODE_ENV=production
"@
    }
    Set-Content -Path $envPath -Value $content -Encoding Ascii
    Write-Ok "wrote .env (strong random DB password + JWT secret generated)"
} else {
    Write-Ok ".env already exists — leaving it untouched (DB_PASSWORD must match the login)"
}

# ---------------------------------------------------------------------------
# Stage 5 — runtime dirs + fileserver config.json
# ---------------------------------------------------------------------------
Write-Step "Stage 5/9  Runtime dirs + fileserver config"

# gitignored dirs a fresh clone won't have, but uploads / fileserver / thumbs need on disk
foreach ($d in @(
    (Join-Path $root 'public\resources'),
    (Join-Path $root 'public\resources\career'),
    (Join-Path $root 'temp'),
    (Join-Path $root 'temp\fs-thumbs'),
    (Join-Path $root 'temp\fs-mirror')
)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
Write-Ok "runtime dirs ready (public/resources, public/resources/career, temp/fs-*)"

# fileserver/config.json is committed with the OLD machine's absolute paths and
# dashboard IP. Regenerate it for this machine unless it already points here.
$cfgPath    = Join-Path $root 'fileserver\config.json'
$webHost    = if ($ListenHost -eq '0.0.0.0') { 'localhost' } else { $ListenHost }
$resPath    = (Join-Path $root 'public\resources')
$mirrorPath = (Join-Path $root 'temp\fs-mirror')
$thumbsPath = (Join-Path $root 'temp\fs-thumbs')
$needsRewrite = $true
if ((Test-Path $cfgPath) -and -not $ResetConfig) {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    $existingRoot = if (@($cfg.roots).Count) { [string]$cfg.roots[0].path } else { '' }
    $existingRootOk = $false
    if ($existingRoot -and (Test-Path $existingRoot)) {
        $existingRootOk = ((Resolve-Path $existingRoot).Path -ieq $resPath)
    }
    if ($existingRootOk) { $needsRewrite = $false }
}
if ($needsRewrite) {
    $newCfg = [ordered]@{
        port          = 8090
        host          = '0.0.0.0'
        dashboardBase = "http://$webHost`:$AppPort"
        tls           = [ordered]@{ enabled = $true; host = $webHost; healthPort = 8091 }
        mode          = 'fileserver'
        allowSignup   = $true
        mirror        = [ordered]@{ sourceRootId = 'resources'; mirrorPath = $mirrorPath; readOnly = $true }
        sync          = [ordered]@{ source = $resPath; destination = $mirrorPath; deleteExtraneous = $true; intervalMinutes = 0 }
        roots         = @([ordered]@{ id = 'resources'; name = 'Resources'; path = $resPath })
        search        = [ordered]@{ maxDepth = 6; maxResults = 200 }
        thumbnails    = [ordered]@{ size = 256; cacheDir = $thumbsPath }
        textEdit      = [ordered]@{ maxBytes = 5242880 }
    }
    $newCfg | ConvertTo-Json -Depth 8 | Set-Content -Path $cfgPath -Encoding Ascii
    Write-Ok "regenerated fileserver/config.json (dashboardBase=http://$webHost`:$AppPort)"
} else {
    Write-Ok "fileserver/config.json already valid for this machine — untouched"
}

# ---------------------------------------------------------------------------
# Stage 6 — npm dependencies
# ---------------------------------------------------------------------------
Write-Step "Stage 6/9  npm dependencies"
if (-not (Confirm-Present 'npm')) { Update-Path }
Write-Host "  Installing root dependencies..."
npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Write-Fail "root npm install failed ($LASTEXITCODE)"; exit $LASTEXITCODE }
if (Test-Path (Join-Path $root 'fileserver\package.json')) {
    Write-Host "  Installing fileserver dependencies..."
    Push-Location (Join-Path $root 'fileserver')
    npm install --no-fund --no-audit
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Write-Fail "fileserver npm install failed ($code)"; exit $code }
}
Write-Ok "dependencies installed"

# ---------------------------------------------------------------------------
# Stage 7 — self-signed cert + trust (best-effort)
# ---------------------------------------------------------------------------
Write-Step "Stage 7/9  HTTPS certificate"
try {
    $certDir = Join-Path $root 'fileserver\certs'
    New-Item -ItemType Directory -Path $certDir -Force | Out-Null
    $certHost = if ($ListenHost -eq '0.0.0.0') { 'localhost' } else { $ListenHost }
    node -e "require('dotenv').config(); const {loadOrCreateCert}=require('./shared/tls'); loadOrCreateCert({certDir:process.argv[1],host:process.argv[2]}).then(()=>console.log('cert ok')).catch(e=>{console.error(e);process.exit(1)})" "$certDir" "$certHost"
    if (Test-Path (Join-Path $certDir 'cert.pem')) {
        certutil -addstore -user Root (Join-Path $certDir 'cert.pem') | Out-Null
        Write-Ok "self-signed cert generated and added to the current user's Root store"
    } else {
        Write-Warn "cert generation did not produce cert.pem — the server will still boot (cert auto-generates), but browsers will warn."
    }
} catch {
    Write-Warn "cert step skipped: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# Stage 8 — Windows Firewall (remote access)
# ---------------------------------------------------------------------------
Write-Step "Stage 8/9  Windows Firewall (remote access)"
if ($SkipFirewallRules) {
    Write-Ok "firewall rules skipped (-SkipFirewallRules)"
} else {
    # App ports only — SQL Server (1433) is deliberately NOT exposed (opsec).
    foreach ($p in @($AppPort, $HttpsPort, 8090, 8091)) {
        $name = "Oswald Inbound TCP $p"
        if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
            Write-Ok "inbound TCP $p already allowed"
        } else {
            New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -Profile Private, Domain | Out-Null
            Write-Ok "allowed inbound TCP $p (Private/Domain)"
        }
    }
}

# ---------------------------------------------------------------------------
# Stage 9 — start + verify (+ optional auto-start)
# ---------------------------------------------------------------------------
if (-not $SkipServerStart) {
    Write-Step "Stage 9/9  Starting servers"
    & (Join-Path $root 'start-detached.ps1')
    & (Join-Path $root 'start-fileserver.ps1')

    Start-Sleep -Seconds 4
    $alive = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            # PS 5.1 has no -SkipHttpErrorCheck; it throws on non-2xx, so a returned
            # response means the server is up.
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$AppPort/api/health" -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) { $alive = $true; break }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if ($alive) {
        Write-Ok "dashboard healthy on http://127.0.0.1:$AppPort  (https://127.0.0.1:$HttpsPort)"
    } else {
        Write-Warn "dashboard did not answer /api/health yet. Check server.log / server.err.log."
    }

    if (-not $SkipSmokeTest) {
        Write-Host "  Running regression suite..."
        node scripts/smoke-test.js
        if ($LASTEXITCODE -eq 0) { Write-Ok "smoke test passed" } else { Write-Warn "smoke test exit code $LASTEXITCODE (expected on some TLS environments; see output above)" }
    }
} else {
    Write-Ok "servers not started (-SkipServerStart). Run .\start-detached.ps1 and .\start-fileserver.ps1"
}

if ($RegisterAutoStart) {
    Write-Host "  Registering logon auto-start tasks..."
    $act1 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root 'start-detached.ps1')`""
    $act2 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root 'start-fileserver.ps1')`""
    $trig = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $sets = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName 'Oswald Dashboard' -Action $act1 -Trigger $trig -Settings $sets -Force | Out-Null
    Register-ScheduledTask -TaskName 'Oswald Fileserver' -Action $act2 -Trigger $trig -Settings $sets -Force | Out-Null
    Write-Ok "auto-start tasks registered (Oswald Dashboard + Fileserver, start at logon)"
}

Write-Host ""
Write-Host "==============================================================" -ForegroundColor $Ok
Write-Host "  Bootstrap complete."
Write-Host "  Dashboard : http://$ListenHost`:$AppPort   (HTTPS :$HttpsPort)" -ForegroundColor $Info
Write-Host "  Fileserver: https://$ListenHost`:8090" -ForegroundColor $Info
Write-Host "  First login: oswald_admin / admin  (change it immediately!)" -ForegroundColor $Info
if ($script:UseLocalDB) {
    Write-Host "  Database  : LocalDB '$($script:LocalDbServer)' (Windows auth, no SQL service)" -ForegroundColor $Info
    Write-Host "  Auth      : Windows auth — DB_USER/DB_PASSWORD in .env are unused" -ForegroundColor $Info
} else {
    Write-Host "  Credentials for the api_user SQL login live in .env" -ForegroundColor $Info
}
Write-Host "==============================================================" -ForegroundColor $Ok
Write-Host ""
