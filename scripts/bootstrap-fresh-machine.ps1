# ============================================================================
# bootstrap-fresh-machine.ps1 — one-click setup of Oswald from a brand-new
# Windows machine (no Node, no SQL Server, nothing pre-configured).
#
# What this script does, in order:
#   1. Elevates itself to Administrator (one UAC consent).
#   2. Installs Node.js LTS via winget if `node` is missing.
#   3. Installs SQL Server 2022 Express via winget if no instance is found.
#   4. Fixes the four classic "SQL Server isn't reachable" problems:
#        - service stopped          -> Start-Service + Automatic startup
#        - TCP/IP disabled          -> registry Enabled=1 + static port
#        - Named Pipes disabled     -> registry Enabled=1
#        - Windows-auth only        -> LoginMode=2 (mixed: SQL + Windows)
#   5. Bootstraps the database over Windows auth (Integrated Security) with
#      System.Data.SqlClient (no sqlcmd dependency):
#        - runs sql/schema/DB_init_table.sql  (fresh DB only, or -ResetDb)
#        - applies sql/migrations/001..014    (idempotent, always)
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

# SqlClient doesn't understand `GO`, so split a .sql file into batches.
function Invoke-SqlScript {
    param([string]$ConnectionString, [string]$Path, [switch]$ContinueOnError)
    if (-not (Test-Path $Path)) { throw "Script not found: $Path" }
    $content = (Get-Content $Path -Raw) -replace "`r`n", "`n"
    $batches = $content -split "(?m)^\s*GO\s*$"
    $n = 0
    foreach ($b in $batches) {
        $b = $b.Trim()
        if (-not $b) { continue }
        $n++
        try {
            Invoke-SqlBatch -ConnectionString $ConnectionString -Sql $b
        } catch {
            if ($ContinueOnError) {
                Write-Warn "batch $n failed (continuing): $($_.Exception.Message)"
            } else {
                throw
            }
        }
    }
    Write-Ok "$n batch(es) executed from $(Split-Path $Path -Leaf)"
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
$instances = Get-SqlInstances
$inst = $instances | Where-Object { $_.Instance -eq $Instance } | Select-Object -First 1

if (-not $inst) {
    if ($NoInstallSqlServer) {
        Write-Fail "SQL instance '$Instance' not found and -NoInstallSqlServer was set."
        exit 1
    }
    if (-not (Confirm-Present 'winget')) {
        Write-Fail 'winget not available; install SQL Server 2022 Express manually, then re-run.'
        exit 1
    }
    Write-Host "  No SQL instance found — installing SQL Server 2022 Express (this takes several minutes)..."
    winget install --id Microsoft.SQLServer.2022.Express -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 0x8A150011) {
        Write-Fail "SQL Express install failed (exit $LASTEXITCODE). See Windows Event Log / setup logs."
        exit 1
    }
    # Re-detect (install creates the instance; service may take a moment to appear)
    $instances = Get-SqlInstances
    $inst = $instances | Where-Object { $_.Instance -eq $Instance } | Select-Object -First 1
}

if (-not $inst) {
    Write-Fail "Instance '$Instance' still not detected after install. Restart the machine and re-run."
    exit 1
}
Write-Ok "found instance '$($inst.Instance)' (InstanceID '$($inst.InstanceID)')"

$serviceName = if ($Instance -eq 'MSSQLSERVER') { 'MSSQLSERVER' } else { "MSSQL`$$Instance" }
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Fail "Service '$serviceName' not found. Check the instance name."
    exit 1
}

# (a) service on + automatic start
Write-Host "  Setting '$serviceName' to Automatic and starting it..."
Set-Service -Name $serviceName -StartupType Automatic
if ($svc.Status -ne 'Running') { Start-Service -Name $serviceName }
$svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(90))

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
Write-Host "  Restarting '$serviceName' to apply protocol changes..."
Restart-Service -Name $serviceName -Force
$svc = Get-Service -Name $serviceName
$svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(90))

if (-not (Wait-TcpPort -Port $SqlPort)) {
    Write-Fail "SQL Server is not accepting TCP connections on port $SqlPort yet. Restart the machine and re-run."
    exit 1
}
Write-Ok "SQL Server listening on TCP $SqlPort"

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

$masterCs = Get-AdminConnectionString
if (-not $masterCs) {
    Write-Fail 'Could not connect to SQL Server with any local mode (Windows auth or sa).'
    Write-Host "  Fix: either ensure this account is a sysadmin on '$Instance'," -ForegroundColor $Warn
    Write-Host "  or pass -SaPassword with an existing sa password, or connect with SSMS once to add yourself:" -ForegroundColor $Warn
    Write-Host "  ALTER SERVER ROLE sysadmin ADD MEMBER [<domain>\<user>];" -ForegroundColor $Warn
    exit 1
}
Write-Ok "admin connection established"
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

# Apply migrations 001..014 (idempotent — safe on both fresh and existing DBs)
Write-Host "  Applying migrations..."
$migrations = Get-ChildItem (Join-Path $root 'sql\migrations') -Filter '*.sql' | Sort-Object Name
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
    $content = @"
# Generated by scripts/bootstrap-fresh-machine.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
PORT=$AppPort
HTTPS_PORT=$HttpsPort
SERVER_HOST=$ListenHost
LOCAL_SERVER_HOST=$ListenHost
REMOTE_SERVER_HOST=0.0.0.0
DB_SERVER=localhost
DB_INSTANCE=$Instance
DB_PORT=$SqlPort
DB_DATABASE=$DbName
DB_USER=$DbUser
DB_PASSWORD=$DbPassword
JWT_SECRET=$jwt
NODE_ENV=production
"@
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
Write-Host "  Credentials for the api_user SQL login live in .env" -ForegroundColor $Info
Write-Host "==============================================================" -ForegroundColor $Ok
Write-Host ""
