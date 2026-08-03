# setup.ps1
# One-time project setup: installs dependencies and (re)initializes the SQL database.
#
# !! DANGER !! The database init step DROPS and recreates the database, destroying
# ALL existing data. This script always asks for explicit confirmation ("yes")
# before running that step, so an accidental run won't nuke your data.

Write-Host ""
Write-Host "=============================================================="
Write-Host "  Oswald - project setup"
Write-Host "=============================================================="
Write-Host ""

# Ensure we're in the project root
Set-Location -Path "$PSScriptRoot"

# Load environment variables from .env so sqlcmd uses the same creds as the app
$envFile = ".\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^=]+)=(.*)$') {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
} else {
    Write-Host "WARNING: .env not found. DB credentials may be missing." -ForegroundColor Yellow
}

# 1) Install dependencies (from package.json)
Write-Host " Installing npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host " npm install failed (exit code $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}

# 2) Database initialization (DESTRUCTIVE - gated)
Write-Host ""
Write-Host "!! WARNING !!"
Write-Host " The next step runs 'sql\schema\DB_init_table.sql'."
Write-Host " It will DROP the database '$env:DB_DATABASE' and recreate it from scratch."
Write-Host " ALL existing data (edicts, tasks, users, resources, audit logs) will be LOST."
Write-Host ""

$confirm = Read-Host "Type 'yes' to continue, anything else to cancel"
if ($confirm -ne "yes" -and $confirm -ne "y") {
    Write-Host " Setup cancelled. The database was NOT touched." -ForegroundColor Yellow
    exit 0
}

Write-Host " Initializing the SQL database..."

# Connect to server,port directly (the SQLEXPRESS instance listens on the static
# port DB_PORT; instance-name resolution requires the SQL Browser service).
$sqlServer = $env:DB_SERVER
if ($env:DB_PORT) {
    $sqlServer = "$sqlServer,$($env:DB_PORT)"
}

$sqlScriptPath = Join-Path $PSScriptRoot "sql\schema\DB_init_table.sql"

if ($env:DB_USER -and $env:DB_PASSWORD) {
    sqlcmd -S $sqlServer -U $env:DB_USER -P $env:DB_PASSWORD -i $sqlScriptPath
} else {
    sqlcmd -S $sqlServer -E -i $sqlScriptPath
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host " Database initialization FAILED (exit code $LASTEXITCODE)." -ForegroundColor Red
    Write-Host " Check that 'sqlcmd' is installed / on PATH and the server is reachable."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host " Setup complete." -ForegroundColor Green

# 3) Optionally start the server (keeps the old setup -> server flow)
$startNow = Read-Host "Start the server now? (y/n)"
if ($startNow -eq "y" -or $startNow -eq "yes") {
    node .\server.js
} else {
    Write-Host " Run '.\start.ps1' or 'node .\server.js' when ready." -ForegroundColor Cyan
}
