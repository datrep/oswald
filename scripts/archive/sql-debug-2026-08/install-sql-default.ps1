# ============================================================================
# install-sql-default.ps1 — replace the broken SQLEXPRESS named instance with a
# DEFAULT instance (MSSQLSERVER), which runs sqlservr.exe WITHOUT -s and avoids
# the failing named-instance resolution. Self-elevates; logs to temp\sql-default.log.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\install-sql-default.ps1
# ============================================================================

$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-default.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on the UAC prompt)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host "Install run finished. Log: $logFile"
    exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

$setup   = 'C:\Program Files\Microsoft SQL Server\170\Setup Bootstrap\SQL2025\setup.exe'
$saPwd   = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 22 | ForEach-Object { [char]$_ }) + 'a1!'

function Invoke-Setup([string]$action, [string]$instance, [switch]$install) {
    Log ""
    Log "==== setup /ACTION=$action INSTANCENAME=$instance ===="
    $args = @('/ACTION=' + $action, '/FEATURES=SQLENGINE', '/INSTANCENAME=' + $instance, '/Q', '/IACCEPTSQLSERVERLICENSETERMS', '/SUPPRESSPRIVACYSTATEMENTNOTICE')
    if ($install) {
        $args += '/SQLSYSADMINACCOUNTS=BUILTIN\Administrators'
        $args += '/TCPENABLED=1'
        $args += '/NPENABLED=1'
        $args += '/SECURITYMODE=SQL'
        $args += ('/SAPWD=' + $saPwd)
        $args += '/SQLCOLLATION=SQL_Latin1_General_CP1_CI_AS'
    }
    Log "  running: $setup $($args -join ' ')"
    $proc = $null
    try { $proc = Start-Process -FilePath $setup -ArgumentList $args -PassThru -Wait -ErrorAction Stop; $code = $proc.ExitCode } catch { Log "  ERROR launching setup: $($_.Exception.Message)"; $code = -2 }
    if ($null -eq $code) { $code = -2 }
    Log "  exit code: $code  (0 or 3010 = success)"
    return $code
}

function SvcStatus([string]$n) { (Get-Service -Name $n -ErrorAction SilentlyContinue).Status }

Log "==== SQL DEFAULT-INSTANCE INSTALL $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (IsAdmin: $isAdmin)"
Log "setup: $setup"

# 1. stop any running SQL, kill stray installers
Get-Process msiexec, setup -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'msiexec|setup' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue | Stop-Service -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 2. uninstall the broken SQLEXPRESS named instance
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL') {
    $names = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | Select-Object -ExpandProperty Name
    if ($names -contains 'SQLEXPRESS') {
        Invoke-Setup 'Uninstall' 'SQLEXPRESS'
    } else {
        Log "SQLEXPRESS not registered - skipping uninstall."
    }
} else {
    Log "no SQL instances registered - skipping uninstall."
}

# 3. install the DEFAULT instance (MSSQLSERVER)
Invoke-Setup 'Install' 'MSSQLSERVER' -install

# 4. verification + CRITICAL restart-survival test
Start-Sleep -Seconds 6
Log ""
Log "--- verification ---"
Log "service MSSQLSERVER status: $(SvcStatus 'MSSQLSERVER')"
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL') {
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { Log "registered instance: $($_.Name) = $($_.Value)" }
}
Log "TCP 1433 listening: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"

# ensure it's running
if ((SvcStatus 'MSSQLSERVER') -ne 'Running') { Start-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 8 }
Log "after ensure-start: $(SvcStatus 'MSSQLSERVER')"

# CRITICAL: plain restart survival test
if ((SvcStatus 'MSSQLSERVER') -eq 'Running') {
    Log ""
    Log "--- CRITICAL TEST: plain stop + start (does default instance survive restart?) ---"
    Stop-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    Log "after stop: $(SvcStatus 'MSSQLSERVER')"
    Start-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 10
    Log "after start: $(SvcStatus 'MSSQLSERVER')"
    Log "TCP 1433 listening after restart: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
    if ((SvcStatus 'MSSQLSERVER') -eq 'Running') { Log "RESULT: DEFAULT INSTANCE SURVIVES RESTART - SUCCESS" } else { Log "RESULT: DEFAULT INSTANCE ALSO FAILS ON RESTART" }
} else {
    Log "MSSQLSERVER did not start - cannot run survival test."
    $q = sc.exe queryex MSSQLSERVER 2>&1 | Out-String; Log $q
}

Log ""
Log "sa password for MSSQLSERVER is in this log (SAPWD arg) - keep it safe."
Log "==== INSTALL COMPLETE $(Get-Date) ===="
Write-Host "`nLog written to: $logFile"
