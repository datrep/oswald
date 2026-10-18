# ============================================================================
# check-sql-health.ps1 - verify the SQL Server / Oswald setup is intact.
# Run this any time (e.g. after a reboot) to confirm everything is still good,
# and to catch the known SQLEXPRESS registry-degradation early.
#
# Checks:
#   1. SQL services MSSQL$SQLEXPRESS + MSSQLSERVER are Running
#   2. TCP ports 1433 (MSSQLSERVER) + 1435 (SQLEXPRESS) are listening
#   3. Critical registry keys exist (the ones that broke before):
#        MSSQL16.SQLEXPRESS\MSSQLServer\CurrentVersion
#        MSSQL16.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Np\PipeName
#   4. DB_Oswald reachable on SQLEXPRESS (table + user counts, api_user SQL-auth)
#   5. Oswald dashboard /api/health -> db:true, fileserver /healthz -> ok
#
# No elevation needed. Exit code 0 = all good, 1 = something failed.
# ============================================================================

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sqlcmd = 'C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE'
$fail = 0

function Chk([string]$Label, [bool]$Ok, [string]$Detail = '') {
    if ($Ok) { Write-Host ("  [OK ] {0}  {1}" -f $Label, $Detail) }
    else { Write-Host ("  [FAIL] {0}  {1}" -f $Label, $Detail) -ForegroundColor Red; $script:fail = 1 }
}

Write-Host '=== SQL / Oswald health check ==='
Write-Host ''

# 1. services
Write-Host '--- 1. SQL services ---'
foreach ($svc in 'MSSQL$SQLEXPRESS', 'MSSQLSERVER') {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    Chk "service $svc" ($s -and $s.Status -eq 'Running') "($($s.Status))"
}

# 2. ports
Write-Host '--- 2. TCP ports ---'
foreach ($port in 1433, 1435) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); Chk "TCP $port" $true 'listening'; $c.Close() }
    catch { Chk "TCP $port" $false 'not listening' }
}

# 3. critical registry keys (the ones that broke before)
Write-Host '--- 3. critical registry keys ---'
$keys = @(
    @{ P = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQLServer\CurrentVersion'; N = 'SQLEXPRESS CurrentVersion'; V = '' },
    @{ P = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Np'; N = 'SQLEXPRESS Np\PipeName'; V = 'PipeName' },
    @{ P = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQLServer\SuperSocketNetLib\Tcp\IPAll'; N = 'SQLEXPRESS Tcp\IPAll'; V = 'TcpPort' }
)
foreach ($k in $keys) {
    if ($k.V) {
        $val = if (Test-Path $k.P) { (Get-ItemProperty $k.P -ErrorAction SilentlyContinue).$($k.V) } else { $null }
        Chk $k.N ($null -ne $val -and $val -ne '') "$($k.V)='$val'"
    } else {
        Chk $k.N (Test-Path $k.P) $k.P
    }
}

# 4. DB_Oswald on SQLEXPRESS
Write-Host '--- 4. DB_Oswald on SQLEXPRESS (localhost,1435) ---'
try {
    $r = & $sqlcmd -S 'localhost,1435' -d DB_Oswald -E -h -1 -W -Q "SET NOCOUNT ON; SELECT 'tables=' + CAST(COUNT(*) AS VARCHAR) FROM sys.tables; SELECT 'users=' + CAST(COUNT(*) AS VARCHAR) FROM dbo.Users;" 2>&1 | Out-String
    $ok = ($LASTEXITCODE -eq 0 -and $r -match 'tables=' -and $r -match 'users=')
    Chk 'DB_Oswald reachable' $ok ($r.Trim() -replace "`n", ' ')
} catch { Chk 'DB_Oswald reachable' $false $_.Exception.Message }

# api_user SQL-auth (password from .env)
Write-Host '--- 5. api_user SQL auth ---'
$envFile = Join-Path $root '.env'
$pw = ''
if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^DB_PASSWORD=' } | Select-Object -First 1
    if ($line) { $pw = ($line -split '=', 2)[1].Trim() }
}
if ($pw) {
    $r = & $sqlcmd -S 'localhost,1435' -d DB_Oswald -U api_user -P $pw -h -1 -W -Q "SELECT 1" 2>&1 | Out-String
    Chk 'api_user login' ($LASTEXITCODE -eq 0) ($r.Trim() -replace "`n", ' ')
} else { Chk 'api_user login' $false '.env DB_PASSWORD not found' }

# 6. Oswald endpoints
Write-Host '--- 6. Oswald endpoints ---'
try {
    $h = Invoke-WebRequest 'http://127.0.0.1:8080/api/health' -UseBasicParsing -TimeoutSec 10
    $db = ($h.Content -match '"db":true')
    Chk 'dashboard /api/health' ($h.StatusCode -eq 200 -and $db) "HTTP $($h.StatusCode), db:$db"
} catch { Chk 'dashboard /api/health' $false $_.Exception.Message }
try {
    $f = Invoke-WebRequest 'http://127.0.0.1:8091/healthz' -UseBasicParsing -TimeoutSec 10
    Chk 'fileserver /healthz' ($f.StatusCode -eq 200) "HTTP $($f.StatusCode)"
} catch { Chk 'fileserver /healthz' $false $_.Exception.Message }

Write-Host ''
if ($script:fail -eq 0) {
    Write-Host 'RESULT: ALL CHECKS PASSED - setup is intact.' -ForegroundColor Green
    exit 0
} else {
    Write-Host 'RESULT: SOME CHECKS FAILED - see above. If SQLEXPRESS is down, run scripts\fix-sqlexpress-netlib.ps1.' -ForegroundColor Red
    exit 1
}
