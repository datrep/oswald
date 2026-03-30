
# BED-2025-EOT-Project-Back_end

Back_end deveplopment end-of-term Project



## Setup

go to the terminal inside the root folder and run setup.ps1

```cmd
.\setup.ps1
```
installs all dependencies inside the project
npm install express mssql joi dotenv bcryptjs jsonwebtoken multer


## 

alternatively, 

```cmd
Write-Host " Moving to project directory..."
Set-Location -Path "$PSScriptRoot"

Write-Host " Initializing the SQL database..."
sqlcmd -S localhost -E -i "sql\BEDinittable.sql"

npm install express dotenv mssql multer joi bcryptjs jsonwebtoken

```



and run node .\app.js

## Maintenance

Run `npm run cleanup-resources` after deleting database entries or on a schedule to remove orphaned files under `public/resources/` that no longer appear in `EdictResources`.
