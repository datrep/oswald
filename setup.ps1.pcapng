# the setup will destroy any and all logged infomation when it runs. please delete this when out of production
# or if you want to keep it, make sure to backup the database before running this script. 
# it will delete all data in the database and reinitialize it with the provided SQL script. use with caution.


#setup for starting project
# This script sets up the environment for the API MVC DB project
Write-Host " ensure node.js has been installed"

#Ensure you're in the root folder of the project
Write-Host " Moving to project directory..."
Set-Location -Path "$PSScriptRoot"

Write-Host " Initializing the SQL database..."
sqlcmd -S localhost -E -i "sql\DB_init_table.sql"

# Install required npm packages
Write-Host " Installing required npm packages..."
npm install express dotenv mssql multer joi # check with package.json for any additional dependencies


# Run the SQL setup script using sqlcmd
# Make sure sqlcmd utility is installed and in your PATH
Write-Host " Running SQL script to initialize database..."

$server = "localhost"
$dbUser = "imagesapi_user"  # change if different user
$dbPassword = "imagesapi_user"  # change accordingly
$sqlScriptPath = Join-Path $PSScriptRoot "sql\DB_init_table.sql"

$sqlcmdArgs = @(
  "-S", $server
  "-U", $dbUser
  "-P", $dbPassword
  "-i", $sqlScriptPath
)

Write-Host " Starting the server..."
# Start the server
node .\server.js