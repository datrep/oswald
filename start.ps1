#Ensure you're in the root folder of the project
Write-Host " Moving to project directory..."
Set-Location -Path "$PSScriptRoot"

Write-Host " Starting the server..."
# Start the server
node .\server.js