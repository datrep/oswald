# ============================================================================
# fix-sqlexpress-netlib.ps1 - SQLEXPRESS's registry is missing the network
# library config (Named Pipes PipeName, Shared Memory, AdminConnection, per-IP
# TCP), which the ETW trace + events showed sqlservr failing on. This mirrors
# the ENTIRE working MSSQLSERVER\MSSQLServer subtree onto SQLEXPRESS, then
# fixes instance-specific values (pipe name, port 1435).
#
# Self-elevates (one UAC click). Logs to temp\fix-sqlexpress-netlib.log
# ============================================================================

$root   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logDir = Join-Path $root 'temp'
$logFile = Join-Path $logDir 'fix-sqlexpress-netlib.log'
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

$src = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQLServer'
$dst = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQLServer'

Log "==== FIX SQLEXPRESS NETLIB $(Get-Date) ===="

function Copy-RegTree {
    param([string]$From, [string]$To)
    if (-not (Test-Path $To)) { New-Item -Path $To -Force | Out-Null }
    $item = Get-Item $From
    (Get-ItemProperty $From -ErrorAction SilentlyContinue).PSObject.Properties |
        Where-Object { $_.Name -notmatch '^PS' } |
        ForEach-Object {
            try {
                $kind = $item.GetValueKind($_.Name)
                New-ItemProperty -Path $To -Name $_.Name -Value $_.Value -PropertyType $kind -Force | Out-Null
            } catch { }
        }
    Get-ChildItem -Path $From -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.PSChildName -eq 'Parameters') { return }   # keep SQLEXPRESS's own data paths
        Copy-RegTree -From (Join-Path $From $_.PSChildName) -To (Join-Path $To $_.PSChildName)
    }
}

Log "copying MSSQLServer subtree from MSSQLSERVER -> SQLEXPRESS (skipping Parameters)..."
Copy-RegTree -From $src -To $dst
Log '  copy done'

Log '--- applying instance-specific values ---'
$np = "$dst\SuperSocketNetLib\Np"
if (Test-Path $np) {
    New-ItemProperty -Path $np -Name 'PipeName' -Value '\\.\pipe\MSSQL$SQLEXPRESS\sql\query' -PropertyType String -Force | Out-Null
    Log "  Np\PipeName = \\.\pipe\MSSQL`$SQLEXPRESS\sql\query"
}
$ipall = "$dst\SuperSocketNetLib\Tcp\IPAll"
if (Test-Path $ipall) {
    Set-ItemProperty -Path $ipall -Name 'TcpPort' -Value '1435' -Type String
    Set-ItemProperty -Path $ipall -Name 'TcpDynamicPorts' -Value '' -Type String
    Log "  Tcp\IPAll TcpPort = 1435"
}
1..6 | ForEach-Object {
    $ip = "$dst\SuperSocketNetLib\Tcp\IP$_"
    if (Test-Path $ip) { Set-ItemProperty -Path $ip -Name 'TcpPort' -Value '1435' -Type String }
}
$via = "$dst\SuperSocketNetLib\Via"
if (Test-Path $via) {
    Set-ItemProperty -Path $via -Name 'DefaultServerPort' -Value '0:1435' -Type String
    Set-ItemProperty -Path $via -Name 'ListenInfo' -Value '0:1435' -Type String
    Log '  Via ports -> 1435'
}

Log ''
Log '--- starting MSSQL$SQLEXPRESS ---'
$svc = Get-Service 'MSSQL$SQLEXPRESS' -ErrorAction SilentlyContinue
if ($svc.Status -ne 'Stopped') { Stop-Service 'MSSQL$SQLEXPRESS' -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
Get-CimInstance Win32_Process -Filter "Name='sqlservr.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-sSQLEXPRESS' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
try {
    Start-Service 'MSSQL$SQLEXPRESS' -ErrorAction Stop
    Start-Sleep -Seconds 15
    Log "  MSSQL`$SQLEXPRESS -> $((Get-Service 'MSSQL$SQLEXPRESS').Status)"
} catch {
    Log "  START FAILED: $($_.Exception.Message)"
    Log "  status: $((Get-Service 'MSSQL$SQLEXPRESS').Status)"
}

Log ''
Log '--- verify ---'
foreach ($port in 1433,1435) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); Log "  TCP $port : LISTENING"; $c.Close() } catch { Log "  TCP $port : not listening" }
}
Log '==== COMPLETE ===='
