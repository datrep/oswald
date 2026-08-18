# ============================================================================
# sql-repair-2022.ps1 — SQL Server 2022 Setup REPAIR for both instances.
#
# Repairs re-write the SQL instance registry configuration AND re-apply the
# service-account ACLs — exactly the layer that is broken on this machine
# (missing legacy CurrentVersion key, SQLBrowser "config inaccessible/invalid",
# UpdateUptimeRegKey access denied). This is the cheap fix to TRY before an
# OS reinstall.
#
# IMPORTANT (the earlier repair bug): do NOT pass /FEATURES with /ACTION=Repair
# (that errors out with exit 0x84b40005 / -2068578299). Use the minimal switch
# set below.
#
# Self-elevates (one UAC click). Logs to temp\sql-repair-2022.log
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\sql-repair-2022.ps1
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-repair-2022.log'
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

# ---- locate the 2022 setup media ------------------------------------------
$setup = $null
foreach ($p in @(
        'C:\SQL2022\Express_ENU\setup.exe',
        'C:\SQL2022\setup.exe',
        'C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\SQL2022\setup.exe')) {
    if (Test-Path $p) { $setup = $p; break }
}
if (-not $setup) {
    Log 'ERROR: 2022 setup.exe not found (looked in C:\SQL2022\Express_ENU, C:\SQL2022, Setup Bootstrap\SQL2022).'
    Log 'Download SQL Server 2022 Express media or re-extract it, then re-run.'
    exit 1
}
Log "setup.exe: $setup ($(Get-Item $setup).Length bytes)"
Log ""

function Repair-Instance {
    param([string]$InstanceName, [int]$TimeoutMin = 20)
    Log "########## Repairing instance '$InstanceName' ##########"
    $args = @(
        '/ACTION=Repair',
        "/INSTANCENAME=$InstanceName",
        '/Q',
        '/IACCEPTSQLSERVERLICENSETERMS',
        '/SUPPRESSPRIVACYSTATEMENTNOTICE'
    )
    Log "  command: $setup $($args -join ' ')"
    # Watchdog instead of blocking -Wait: setup has hung on this machine before,
    # so poll with a timeout and log progress so we never block silently.
    $proc = Start-Process -FilePath $setup -ArgumentList $args -PassThru -NoNewWindow
    $deadline = (Get-Date).AddMinutes($TimeoutMin)
    while (-not $proc.HasExited) {
        if ((Get-Date) -gt $deadline) {
            Log "  TIMEOUT after $TimeoutMin min - setup.exe still running (PID $($proc.Id)); moving on (may finish in background)."
            return $false
        }
        Start-Sleep -Seconds 15
        Log "  ...setup still running (PID $($proc.Id)) at $(Get-Date -Format 'HH:mm:ss'), waiting (up to $TimeoutMin min)..."
    }
    $code = $proc.ExitCode
    if ($code -eq 0 -or $code -eq 3010) {
        Log "  RESULT: SUCCESS (exit $code)  [3010 = reboot recommended, still success]"
        return $true
    }
    Log "  RESULT: FAILED (exit $code)"
    Log "  Review the setup log: C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log\ (latest Summary.txt)"
    return $false
}

# stop the SQL services first so repair isn't fighting a running engine
foreach ($sn in @('MSSQL$SQLEXPRESS', 'MSSQLSERVER')) {
    $s = Get-Service -Name $sn -ErrorAction SilentlyContinue
    if ($s -and $s.Status -ne 'Stopped') {
        Log "  stopping $sn ..."
        Stop-Service -Name $sn -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }
}

$r1 = Repair-Instance -InstanceName 'SQLEXPRESS'
Log ""
$r2 = Repair-Instance -InstanceName 'MSSQLSERVER'
Log ""

# ---- try starting the services ---------------------------------------------
Log '########## Starting services ##########'
foreach ($sn in @('MSSQL$SQLEXPRESS', 'MSSQLSERVER')) {
    $s = Get-Service -Name $sn -ErrorAction SilentlyContinue
    if (-not $s) { Log "  $sn : not installed"; continue }
    try {
        Start-Service -Name $sn -ErrorAction Stop
        Start-Sleep -Seconds 10
        $s = Get-Service -Name $sn
        Log "  $sn -> $($s.Status)"
    } catch {
        Log "  $sn -> START FAILED: $($_.Exception.Message)"
    }
}
$tcp = New-Object System.Net.Sockets.TcpClient
try { $tcp.Connect('127.0.0.1', 1433); Log '  TCP 1433: LISTENING'; $tcp.Close() } catch { Log '  TCP 1433: not listening' }

Log ""
Log "  repairs: SQLEXPRESS=$r1  MSSQLSERVER=$r2"
Log "==== REPAIR ATTEMPT COMPLETE ===="
Log "  Full log: $logFile"
