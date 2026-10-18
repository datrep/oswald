# ============================================================================
# sql-decisive-test.ps1 — ONE elevated run that settles "SQL install broken?"
# vs "Windows To Go / OS service layer broken?"
#
#   PART 1  Run sqlservr.exe -sSQLEXPRESS manually (as admin, foreground).
#           If the ENGINE stays up  -> registry + engine + data are 100% fine;
#           the failure is ONLY in the SCM service-start path (OS-level).
#           If it exits with error 2 -> the SQL install/registry is the problem
#           (fixable via SQL repair/reinstall, NO OS reinstall needed).
#   PART 2  Repair concrete defects:
#           - recreate missing MSSQL16.MSSQLSERVER\...\Parameters (-d/-e/-l)
#           - grant the SQL service accounts Read on the SQL registry hive
#   PART 3  Try Start-Service on both instances and report.
#
# Self-elevates (one UAC click). Logs to temp\sql-decisive.log
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\sql-decisive-test.ps1
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-decisive.log'
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

$SQLEXPR = 'C:\Program Files\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQL'
$DEFINST = 'C:\Program Files\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQL'

Log "==== SQL DECISIVE TEST $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (admin: $isAdmin)"
Log ""

# ---------------------------------------------------------------------------
# PART 1 — MANUAL ENGINE TEST (the discriminator)
# ---------------------------------------------------------------------------
function Test-ManualStart {
    param([string]$Name, [string]$SqlRoot, [string]$InstanceArg)
    Log "########## PART 1a: manual sqlservr $InstanceArg ($Name) ##########"
    # make sure the service isn't holding the engine
    $svcName = if ($Name -eq 'default') { 'MSSQLSERVER' } else { "MSSQL`$$Name" }
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Stopped') { Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }

    $sout = Join-Path $logDir 'dec_out.txt'; $serr = Join-Path $logDir 'dec_err.txt'
    Remove-Item $sout,$serr -ErrorAction SilentlyContinue
    $exe = "$SqlRoot\Binn\sqlservr.exe"
    if (-not (Test-Path $exe)) { Log "  ENGINE MISSING: $exe"; return }
    Log "  launching: $exe $InstanceArg"
    $proc = Start-Process -FilePath $exe -ArgumentList $InstanceArg -PassThru -NoNewWindow -RedirectStandardOutput $sout -RedirectStandardError $serr
    Start-Sleep -Seconds 12
    if ($proc.HasExited) {
        Log "  RESULT: ENGINE EXITED, code=$($proc.ExitCode)  <-- SQL install/registry problem"
        Log "  --- stderr ---"
        if (Test-Path $serr) { Get-Content $serr | ForEach-Object { Log "    $_" } } else { Log '    (none)' }
    } else {
        Log "  RESULT: ENGINE STILL RUNNING (pid $($proc.Id))  <-- engine/registry/data are FINE"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        Log '  (engine was force-killed after test)'
    }
    # show how far the engine got in its own log
    $errLog = "$SqlRoot\Log\ERRORLOG"
    if (Test-Path $errLog) {
        Log "  --- ERRORLOG tail (last 8) ---"
        Get-Content $errLog -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Log "    $_" }
    }
    Log ""
}

Test-ManualStart -Name 'SQLEXPRESS' -SqlRoot $SQLEXPR -InstanceArg '-sSQLEXPRESS'
Test-ManualStart -Name 'default'    -SqlRoot $DEFINST -InstanceArg '-sMSSQLSERVER'

# ---------------------------------------------------------------------------
# PART 2 — REPAIR concrete defects
# ---------------------------------------------------------------------------
Log "########## PART 2: repairs ##########"
function Ensure-Parameters {
    param([string]$InstanceID, [string]$SqlRoot)
    $key = "HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\$InstanceID\MSSQLServer\Parameters"
    if (-not (Test-Path $key)) {
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name 0 -Value "-d$SqlRoot\DATA\master.mdf" -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $key -Name 1 -Value "-e$SqlRoot\Log\ERRORLOG"      -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $key -Name 2 -Value "-l$SqlRoot\DATA\mastlog.ldf"  -PropertyType String -Force | Out-Null
        Log "  [repaired] $InstanceID Parameters recreated (-d/-e/-l)"
    } else {
        Log "  [ok] $InstanceID Parameters present"
    }
}
Ensure-Parameters -InstanceID 'MSSQL16.SQLEXPRESS'  -SqlRoot $SQLEXPR
Ensure-Parameters -InstanceID 'MSSQL16.MSSQLSERVER' -SqlRoot $DEFINST

# grant the SQL service accounts Read on the SQL registry hive (setup normally does this)
Log '  granting SQL service accounts ReadKey on the SQL registry hive...'
$regRoot = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server'
foreach ($sa in @('NT SERVICE\MSSQL$SQLEXPRESS', 'NT SERVICE\MSSQLSERVER', 'NT SERVICE\SQLAgent$SQLEXPRESS')) {
    try {
        $rule = New-Object System.Security.AccessControl.RegistryAccessRule($sa, 'ReadKey', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl = Get-Acl $regRoot
        $acl.AddAccessRule($rule)
        Set-Acl -Path $regRoot -AclObject $acl
        Log "  [granted] $sa ReadKey on $regRoot"
    } catch { Log "  [warn] could not grant $sa : $($_.Exception.Message)" }
}

# ---------------------------------------------------------------------------
# PART 3 — try starting the services
# ---------------------------------------------------------------------------
Log ""
Log "########## PART 3: service start attempts ##########"
foreach ($sn in @('MSSQL$SQLEXPRESS', 'MSSQLSERVER')) {
    $s = Get-Service -Name $sn -ErrorAction SilentlyContinue
    if (-not $s) { Log "  $sn : not installed"; continue }
    try {
        Start-Service -Name $sn -ErrorAction Stop
        Start-Sleep -Seconds 8
        $s = Get-Service -Name $sn
        Log "  $sn -> $($s.Status)"
    } catch {
        Log "  $sn -> START FAILED: $($_.Exception.Message)"
        $s = Get-Service -Name $sn
        Log "  $sn -> status $($s.Status)"
    }
}
$tcp = New-Object System.Net.Sockets.TcpClient
try { $tcp.Connect('127.0.0.1', 1433); Log "  TCP 1433: LISTENING"; $tcp.Close() } catch { Log "  TCP 1433: not listening" }

Log ""
Log "==== DECISIVE TEST COMPLETE ===="
Log "  Full log: $logFile"
