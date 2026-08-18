# install-mssqlserver.ps1 — install the DEFAULT instance (MSSQLSERVER) from the
# full Express media at C:\SQL2025\Express_ENU, then restart-survival test.
# Self-elevates; logs to temp\sql-mssqlserver.log.
$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-mssqlserver.log'
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

$setup = 'C:\SQL2025\Express_ENU\setup.exe'
$saPwd = (-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 22 | ForEach-Object { [char]$_ })) + 'a1!'

Log "==== MSSQLSERVER DEFAULT INSTALL $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (IsAdmin: $isAdmin)"
if (-not (Test-Path $setup)) { Log "FATAL: $setup not found"; exit 1 }
Log "setup: $setup"

$args = @(
    '/ACTION=Install',
    '/FEATURES=SQLENGINE',
    '/INSTANCENAME=MSSQLSERVER',
    '/SQLSYSADMINACCOUNTS=BUILTIN\Administrators',
    '/TCPENABLED=1',
    '/NPENABLED=1',
    '/SECURITYMODE=SQL',
    ('/SAPWD=' + $saPwd),
    '/SQLCOLLATION=SQL_Latin1_General_CP1_CI_AS',
    '/Q',
    '/IACCEPTSQLSERVERLICENSETERMS',
    '/SUPPRESSPRIVACYSTATEMENTNOTICE'
)
Log "running: $setup $($args -join ' ')"
$proc = $null
try { $proc = Start-Process -FilePath $setup -ArgumentList $args -PassThru -Wait -ErrorAction Stop; $code = $proc.ExitCode } catch { Log "ERROR launching: $($_.Exception.Message)"; $code = -2 }
if ($null -eq $code) { $code = -2 }
Log "install exit: $code  (0 or 3010 = success)"

Start-Sleep -Seconds 8
Log ""
Log "--- verification ---"
Log "MSSQLSERVER service: $(SvcStatus 'MSSQLSERVER')"
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL') {
    (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { Log "  registered: $($_.Name) = $($_.Value)" }
}
Log "TCP 1433 listening: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"

if ((SvcStatus 'MSSQLSERVER') -ne 'Running') { Start-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 10 }
Log "after ensure-start: $(SvcStatus 'MSSQLSERVER')"

if ((SvcStatus 'MSSQLSERVER') -eq 'Running') {
    Log ""
    Log "--- CRITICAL: plain stop + start (survival) ---"
    Stop-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    Log "after stop: $(SvcStatus 'MSSQLSERVER')"
    Start-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 10
    Log "after start: $(SvcStatus 'MSSQLSERVER')"
    Log "TCP 1433 after restart: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"
    if ((SvcStatus 'MSSQLSERVER') -eq 'Running') { Log "RESULT: DEFAULT INSTANCE SURVIVES RESTART - SUCCESS" } else { Log "RESULT: DEFAULT INSTANCE ALSO FAILS ON RESTART" }
} else {
    Log "MSSQLSERVER did not start - cannot test survival."
    sc.exe queryex MSSQLSERVER 2>&1 | ForEach-Object { Log $_ }
    $logs = Get-ChildItem 'C:\Program Files\Microsoft SQL Server\170\Setup Bootstrap\Log' -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($logs) { $sf = Get-ChildItem $logs.FullName -Filter 'Summary*.txt' | Select-Object -First 1; if ($sf) { Get-Content $sf.FullName | Select-Object -First 35 | ForEach-Object { Log $_ } } }
}
Log ""
Log "sa password: $saPwd"
Log "==== COMPLETE $(Get-Date) ===="
