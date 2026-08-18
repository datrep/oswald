# test-localdb-tcp.ps1 — test whether LocalDB can serve TCP + SQL-auth connections.
# Self-elevates (needs HKLM write), logs to temp\localdb-tcp-test.log.
$root    = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir  = Join-Path $root 'temp'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'localdb-tcp-test.log'
Remove-Item $logFile -ErrorAction SilentlyContinue

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Requesting Administrator privileges (click Yes on UAC)..." -ForegroundColor Cyan
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -PassThru -Wait
    if (-not $p) { Write-Host 'Elevation declined.'; exit 1 }
    Write-Host "Test finished. Log: $logFile"; exit 0
}

$ErrorActionPreference = 'Continue'
function Log([string]$s) { Write-Host $s; Add-Content -Path $logFile -Value $s -Encoding UTF8 }

$SqlLocalDB = 'C:\Program Files\Microsoft SQL Server\170\Tools\Binn\SqlLocalDB.exe'
$tcpBase = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL17E.LOCALDB\MSSQLServer\SuperSocketNetLib'

Log "==== LOCALDB TCP TEST $(Get-Date) ===="
Log "whoami: $env:USERDOMAIN\$env:USERNAME (IsAdmin: $isAdmin)"

# 1. stop LocalDB
Log "--- stop LocalDB ---"
& $SqlLocalDB stop MSSQLLocalDB 2>&1 | ForEach-Object { Log "  $_" }
Start-Sleep -Seconds 2

# 2. enable TCP on LocalDB via registry
Log "--- enable TCP (port 1433) in LocalDB registry ---"
$tcp = Join-Path $tcpBase 'Tcp' -ErrorAction SilentlyContinue
New-Item -Path "$tcpBase\Tcp\IPAll" -Force | Out-Null
Set-ItemProperty -Path "$tcpBase\Tcp" -Name 'Enabled' -Value 1 -Type DWord
Set-ItemProperty -Path "$tcpBase\Tcp\IPAll" -Name 'TcpPort' -Value '1433' -Type String
Set-ItemProperty -Path "$tcpBase\Tcp\IPAll" -Name 'TcpDynamicPorts' -Value '' -Type String
Log "  wrote: $tcpBase\Tcp\Enabled=1, IPAll\TcpPort=1433"
(Get-ItemProperty "$tcpBase\Tcp\IPAll") | Select-Object TcpPort, TcpDynamicPorts | Format-List | Out-String | ForEach-Object { Log $_ }

# 3. start LocalDB
Log "--- start LocalDB ---"
& $SqlLocalDB start MSSQLLocalDB 2>&1 | ForEach-Object { Log "  $_" }
Start-Sleep -Seconds 5
& $SqlLocalDB info MSSQLLocalDB 2>&1 | ForEach-Object { Log "  $_" }
Log "  TCP 1433 listening: $([bool](Get-NetTCPConnection -LocalPort 1433 -State Listen -ErrorAction SilentlyContinue))"

# 4. create a SQL login via Windows-auth pipe connection
Log "--- create SQL login lb_test ---"
Add-Type -AssemblyName System.Data
try {
    $wcs = 'Server=(localdb)\MSSQLLocalDB;Integrated Security=true;TrustServerCertificate=true;Connect Timeout=10'
    $conn = New-Object System.Data.SqlClient.SqlConnection $wcs
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "IF SUSER_ID('lb_test') IS NULL CREATE LOGIN lb_test WITH PASSWORD=N'Passw0rd!123', CHECK_POLICY=OFF"
    $cmd.ExecuteNonQuery() | Out-Null
    Log "  login created OK"
    $conn.Close()
} catch { Log "  create login FAILED: $($_.Exception.Message)" }

# 5. test TCP + SQL auth
Log "--- test TCP + SQL auth (localhost:1433 / lb_test) ---"
try {
    $tcs = 'Server=localhost,1433;User ID=lb_test;Password=Passw0rd!123;TrustServerCertificate=true;Connect Timeout=10'
    $c2 = New-Object System.Data.SqlClient.SqlConnection $tcs
    $c2.Open()
    Log "  TCP SQL-auth connection: SUCCESS. ServerVersion=$($c2.ServerVersion)"
    $c2.Close()
    Log "RESULT: LOCALDB NETWORKING WORKS (TCP 1433 + SQL auth)."
} catch {
    Log "  TCP SQL-auth connection FAILED: $($_.Exception.Message)"
    Log "RESULT: LOCALDB NETWORKING FAILED."
}
Log "==== TEST COMPLETE ===="
