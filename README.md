# Oswald — Policy & Task Management

A Node.js + Express API (backed by Microsoft SQL Server) for managing policies ("edicts"), tasks, file resources, users, services, and audit logs — with a static frontend in `public/`.

> 📖 Full architecture and conventions: [NEWCOMER_GUIDE.md](NEWCOMER_GUIDE.md)

## Setup (first time)

From the project root:

```powershell
.\setup.ps1
```

This installs npm dependencies and (re)initializes the SQL database from `sql\schema\DB_init_table.sql`.

> ⚠️ The DB init **drops and recreates** the database, destroying all data.
> `setup.ps1` will always ask for explicit confirmation (`yes`) before doing this.

## Run

```powershell
.\start.ps1            # interactive launcher (local / remote)
# or directly:
node .\server.js       # http://localhost:3000
```

## Maintenance

- `npm run cleanup-resources` — remove orphaned files under `public/resources/` that are no longer referenced by the `EdictResources` table.
