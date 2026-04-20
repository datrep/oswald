#Ensure you're in the root folder of the project
Write-Host " Moving to project directory..."
Set-Location -Path "$PSScriptRoot"

# no implementation to clean remote resources TODO://



# Add interactive menu before starting server
$choice = Read-Host "Start server locally (1) or remotely (2)? [1/2]"
if ($choice -eq "1") {
    Write-Host "Starting locally..."

    #clean up old resources
    Write-Host " Cleaning up old local resources..."
    npm run cleanup-resources

    Write-Host " Starting the server..."
    # Start the server
    node .\server.js

} else { # welcome to UX 
    Write-Host "Starting remotely..."
    Start-Sleep -Seconds 1
    Write-Host "contacting remote server"
    Start-Sleep -Seconds 1
    Write-Host "no action needed for remote server. redirecting..."
    Start-Sleep -Seconds 3

    start-process "http://10.244.10.3:3000/"
}


