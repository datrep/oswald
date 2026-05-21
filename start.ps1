#Ensure you're in the root folder of the project
Write-Host "Moving to project directory..."
Set-Location -Path "$PSScriptRoot"

# Load environment variables from .env
$envFile = ".\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^=]+)=(.*)$') { # REGEX
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

Write-Host "Starting MCP Filesystem Server..."
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "C:\Users\datrep\Desktop\oswald"
Start-Sleep -Seconds 2

# Interactive menu with input validation
do {
    $choice = Read-Host "Start server locally (1) or remotely (2)? [1/2]"
    $valid = $choice -eq "1" -or $choice -eq "2"
    if (-not $valid) {
        Write-Host "Invalid choice. Please enter 1 or 2." -ForegroundColor Yellow
    }
} while (-not $valid)

if ($choice -eq "1") {
    $localHost = $env:LOCAL_SERVER_HOST
    Write-Host "Starting locally on http://$($localHost):3000" -ForegroundColor Green
    Start-Sleep -Seconds 1
    # Clean up old resources
    Write-Host "Cleaning up old local resources..."
    npm run cleanup-resources
    Start-Sleep -Seconds 1
    Write-Host "Starting the server..."
    Start-Sleep -Seconds 2
    # Set environment variable for local binding
    $env:SERVER_HOST = $localHost
  
    # Open local server in browser
    start-process "http://$($localHost):3000/"
    Start-Sleep -Seconds 2
    node .\server.js


} else {
    $remoteHost = $env:REMOTE_SERVER_HOST
    Write-Host "Starting remotely on http://$($remoteHost):3000" -ForegroundColor Green
    Start-Sleep -Seconds 1
    Write-Host "Contacting remote server..."
    Start-Sleep -Seconds 1
    Write-Host "Remote server is running. Redirecting to browser..."
    Start-Sleep -Seconds 2
    
    # Open remote server in browser
    start-process "http://$($remoteHost):3000/"
}


