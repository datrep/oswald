# install-sql2022.ps1 — clean up broken SQL 2025 instances, then install SQL 2022
# Express (SQLEXPRESS) and run the restart-survival test.
# Self-elevates; logs to temp\sql2022.log
$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql2022.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on UAC)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation declined.'; exit 1 }
    Write-Host "Run finished. Log: $logFile"; exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }
function SvcStatus([string]$n) { (Get-Service -Name $n -ErrorAction SilentlyContinue).Status }
function RegisteredInstances { if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL') { ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; ' } else { '(none)' } }

$ssei2025 = 'C:\SQL2025\Express_ENU\setup.exe'
$ssei2022 = Join-Path $env:TEMP 'SQL2022-SSEI-Expr.exe'

function Invoke-Setup([string]$exe, [string]$action, [string]$instance) {
    Log "  running: $exe /ACTION=$action /INSTANCENAME=$instance /Q /IACCEPTSQLSERVERLICENSETERMS /SUPPRESSPRIVACYSTATEMENTNOTICE"
    $args = @('/ACTION=' + $action, '/FEATURES=SQLENGINE', '/INSTANCENAME=' + $instance, '/Q', '/IACCEPTSQLSERVERLICENSETERMS', '/SUPPRESSPRIVACYSTATEMENTNOTICE')
    $proc = $null
    try { $proc = Start-Process -FilePath $exe -ArgumentList $args -PassThru -Wait -ErrorAction Stop; return $proc.ExitCode } catch { Log "  ERROR launching: $($_.Exception.Message)"; return -2 }
}

Log "==== SQL 2022 INSTALL + CLEANUP $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (IsAdmin: $isAdmin)"
Log "instances before: $(RegisteredInstances)"

# 1. kill stray installers + stop SQL services
Get-Process msiexec, setup -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'msiexec|setup' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Get-Service -Name 'MSSQL$SQLEXPRESS','MSSQLSERVER' -ErrorAction SilentlyContinue | Stop-Service -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# 2. uninstall the 2025 default instance (half-created)
if ((RegisteredInstances) -match 'MSSQLSERVER') {
    Log "--- uninstall MSSQLSERVER (2025 partial) ---"
    $c = Invoke-Setup $ssei2025 'Uninstall' 'MSSQLSERVER'
    Log "  uninstall MSSQLSERVER exit: $c"
}
# 3. uninstall the 2025 SQLEXPRESS
if ((RegisteredInstances) -match 'SQLEXPRESS') {
    Log "--- uninstall SQLEXPRESS (2025) ---"
    $c = Invoke-Setup $ssei2025 'Uninstall' 'SQLEXPRESS'
    Log "  uninstall SQLEXPRESS exit: $c"
}
Start-Sleep -Seconds 5
Log "instances after cleanup: $(RegisteredInstances)"

# 4. install SQL 2022 Express via its SSEI
Log ""
Log "--- install SQL 2022 Express (SSEI) ---"
if (-not (Test-Path $ssei2022)) { Log "FATAL: $ssei2022 not found"; exit 1 }
$proc = Start-Process -FilePath $ssei2022 -ArgumentList @('/IACCEPTSQLSERVERLICENSETERMS','/ENU','/ACTION=Install','/quiet') -PassThru -Wait
Log "  2022 SSEI exit: $($proc.ExitCode)"

Start-Sleep -Seconds 6
Log "instances after 2022 install: $(RegisteredInstances)"

# 5. verify + restart-survival test
Log ""
Log "--- verification ---"
Log "MSSQL$SQLEXPRESS service: $(SvcStatus 'MSSQL$SQLEXPRESS')"
Log "TCP 1433 listening: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
if ((SvcStatus 'MSSQL$SQLEXPRESS') -ne 'Running') { Start-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 10 }
Log "after ensure-start: $(SvcStatus 'MSSQL$SQLEXPRESS')"

if ((SvcStatus 'MSSQL$SQLEXPRESS') -eq 'Running') {
    Log ""
    Log "--- CRITICAL: plain stop + start (survival) ---"
    Stop-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    Log "after stop: $(SvcStatus 'MSSQL$SQLEXPRESS')"
    Start-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 10
    Log "after start: $(SvcStatus 'MSSQL$SQLEXPRESS')"
    Log "TCP 1433 after restart: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
    if ((SvcStatus 'MSSQL$SQLEXPRESS') -eq 'Running') { Log "RESULT: SQL 2022 SQLEXPRESS SURVIVES RESTART - SUCCESS" } else { Log "RESULT: SQL 2022 STILL FAILS ON RESTART" }
} else {
    Log "SQL 2022 did not start - cannot test survival."
    sc.exe queryex 'MSSQL$SQLEXPRESS' 2>&1 | ForEach-Object { Log $_ }
    $logs = Get-ChildItem 'C:\Program Files\Microsoft SQL Server\160\Setup Bootstrap\Log' -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($logs) { $sf = Get-ChildItem $logs.FullName -Filter 'Summary*.txt' | Select-Object -First 1; if ($sf) { Get-Content $sf.FullName | Select-Object -First 30 | ForEach-Object { Log $_ } } }
}

Log ""
Log "==== COMPLETE $(Get-Date) ===="
