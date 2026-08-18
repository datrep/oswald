# ============================================================================
# diag-sql.ps1 — elevated SQL Server diagnostics for the SQLEXPRESS crash.
#
# Self-elevates (one UAC consent), then writes EVERYTHING to temp\sql-diag.log
# so the results can be reviewed non-interactively afterward.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\diag-sql.ps1
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'sql-diag.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on the UAC prompt)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation was declined.' -ForegroundColor Red; exit 1 }
    Write-Host "Elevated run finished. Log: $logFile"
    exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) {
    Write-Host $s
    Add-Content -Path $logFile -Value $s -Encoding UTF8
}

function Run([string]$title, [scriptblock]$body) {
    Log ""
    Log "========== $title =========="
    try { $r = (& $body 2>&1 | Out-String); if ($r) { Log $r.TrimEnd() } } catch { Log "  ERROR: $($_.Exception.Message)" }
}

function Dump-Reg([string]$path) {
    if (-not (Test-Path $path)) { Log "  [missing] $path"; return }
    $item = Get-Item $path
    $vals = Get-ItemProperty $path -ErrorAction SilentlyContinue
    $names = @()
    foreach ($prop in $vals.PSObject.Properties) {
        if ($prop.Name -notmatch '^PS') {
            try { $names += "    {0} ({1}) = {2}" -f $prop.Name, $item.GetValueKind($prop.Name), $prop.Value }
            catch { $names += "    $($prop.Name) = $($prop.Value)" }
        }
    }
    Log "  $path"
    if ($names.Count) { Log ($names -join "`n") }
    Get-ChildItem $path -ErrorAction SilentlyContinue | ForEach-Object { Dump-Reg $_.PSPath }
}

$SQLROOT = 'C:\Program Files\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQL'

Log "==== SQL DIAG $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME"
Log "IsAdmin: $isAdmin"

# ---- filesystem -------------------------------------------------------------
Run "Log dir listing"        { Get-ChildItem "$SQLROOT\Log" -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize | Out-String }
Run "ERRORLOG (tail 80)"     { Get-Content "$SQLROOT\Log\ERRORLOG" -Tail 80 -ErrorAction SilentlyContinue }
foreach ($n in 1..3) {
    $p = "$SQLROOT\Log\ERRORLOG.$n"
    if (Test-Path $p) { Run "ERRORLOG.$n (tail 50)" { Get-Content $p -Tail 50 -ErrorAction SilentlyContinue } }
}
Run "DATA dir listing"       { Get-ChildItem "$SQLROOT\DATA" -ErrorAction SilentlyContinue | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize | Out-String }
Run "master.mdf exists?"     { Test-Path "$SQLROOT\DATA\master.mdf" }
Run "mastlog.ldf exists?"    { Test-Path "$SQLROOT\DATA\mastlog.ldf" }
Run "sqlservr.exe info"      { Get-Item "$SQLROOT\Binn\sqlservr.exe" | Select-Object FullName,Length,@{n='Ver';e={$_.VersionInfo.FileVersion}} | Format-List | Out-String }
Run "Binn dir top-level"     { Get-ChildItem "$SQLROOT\Binn" -ErrorAction SilentlyContinue | Select-Object -First 25 Name | Format-Table -AutoSize | Out-String }

# ---- registry ---------------------------------------------------------------
Log ""
Log "========== REGISTRY =========="
Run "Instance Names\SQL"                { Dump-Reg 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL' }
Run "Instance root MSSQL17.SQLEXPRESS"  { Dump-Reg 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS' }
Run "Legacy SQLEXPRESS key"             { Dump-Reg 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\SQLEXPRESS' }
Run "WOW6432Node Instance Names"        { Dump-Reg 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server\Instance Names\SQL' }
Run "Top-level InstalledInstances"      { (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server').InstalledInstances -join ', ' }

# ---- ACLs -------------------------------------------------------------------
Run "ACL instance key"       { (Get-Acl 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS').Access | ForEach-Object { "    $($_.IdentityReference) : $($_.RegistryRights) ($($_.AccessControlType))" } }
Run "ACL MSSQLServer key"    { (Get-Acl 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQLServer').Access | ForEach-Object { "    $($_.IdentityReference) : $($_.RegistryRights) ($($_.AccessControlType))" } }
Run "ACL DATA dir"           { (Get-Acl "$SQLROOT\DATA").Access | ForEach-Object { "    $($_.IdentityReference) : $($_.FileSystemRights) ($($_.AccessControlType))" } }
Run "ACL Log dir"            { (Get-Acl "$SQLROOT\Log").Access | ForEach-Object { "    $($_.IdentityReference) : $($_.FileSystemRights) ($($_.AccessControlType))" } }

# ---- manual foreground run (discriminates instance-resolve vs service-context) ---
Log ""
Log "========== MANUAL sqlservr -sSQLEXPRESS (foreground, 10s) =========="
$sout = Join-Path $logDir 'fsrv_out.txt'; $serr = Join-Path $logDir 'fsrv_err.txt'
Remove-Item $sout,$serr -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath "$SQLROOT\Binn\sqlservr.exe" -ArgumentList '-sSQLEXPRESS' -PassThru -NoNewWindow -RedirectStandardOutput $sout -RedirectStandardError $serr
Start-Sleep -Seconds 10
if ($proc.HasExited) {
    Log "  sqlservr exited with code: $($proc.ExitCode)"
} else {
    Log "  sqlservr is STILL RUNNING (pid $($proc.Id)) — manual start WORKS; killing it."
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Log "  --- stdout ---";  if (Test-Path $sout) { Get-Content $sout | ForEach-Object { Log "  $_" } } else { Log "  (none)" }
Log "  --- stderr ---";  if (Test-Path $serr) { Get-Content $serr | ForEach-Object { Log "  $_" } } else { Log "  (none)" }

# ---- service start attempt ---------------------------------------------------
Log ""
Log "========== SERVICE START ATTEMPT =========="
$svc = Get-Service -Name 'MSSQL$SQLEXPRESS'
Log "  before: $($svc.Status)"
try { Start-Service -Name 'MSSQL$SQLEXPRESS' -ErrorAction Stop; Log "  Start-Service: OK" } catch { Log "  Start-Service failed: $($_.Exception.Message)" }
Start-Sleep -Seconds 8
$svc = Get-Service -Name 'MSSQL$SQLEXPRESS'
Log "  after:  $($svc.Status)"
(sc.exe queryex 'MSSQL$SQLEXPRESS' 2>&1 | Out-String) -split "`n" | ForEach-Object { Log $_ }
Run "ERRORLOG after service attempt (tail 60)" { Get-Content "$SQLROOT\Log\ERRORLOG" -Tail 60 -ErrorAction SilentlyContinue }

# ---- event log ---------------------------------------------------------------
Run "Recent Application SQL events" {
    Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-15)} -MaxEvents 60 -ErrorAction SilentlyContinue |
        Where-Object { $_.ProviderName -match 'MSSQL|SQLSERVER|SQLBrowser|Application Error|Windows Error Reporting' -or $_.Message -match 'SQLEXPRESS' } |
        Select-Object -First 14 |
        ForEach-Object { "[$($_.TimeCreated.ToString('HH:mm:ss'))] $($_.ProviderName) #$($_.Id)`n$($_.Message)" }
}

Log ""
Log "==== DIAG COMPLETE ===="
Write-Host "`nDiagnostics written to: $logFile"
