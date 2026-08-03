# Newcomer Guide

## What this project is

This repository is a Node.js + Express application backed by Microsoft SQL Server. It provides REST APIs for **edicts (policies)**, **tasks**, **resources (file attachments)**, and **audit logs**, plus a static frontend in `public/` for browsing and editing policies.

## High-level architecture

The backend follows a lightweight MVC-ish shape:

- `routes/` define HTTP endpoints.
- `controllers/` parse request data and shape responses.
- `models/` run SQL queries via `mssql`.
- `config/db.js` exposes a singleton connection pool (`getPool`) used by models.
- `server.js` wires middleware, static hosting, and route mounts.

Request flow is typically:

`browser -> route -> controller -> model -> SQL Server -> controller -> JSON`

## Main runtime entry points

- `server.js`: app startup, middleware setup, static file hosting, route mounting, graceful shutdown.
- `public/pages/index.html` + `public/js/pages/index.js`: dashboard list view of all policies.
- `public/pages/policy.html` + `public/js/pages/policy.js`: policy detail/edit page with task and resource operations.

## Core domain modules

### Edicts (Policies)

- Route: `routes/edictRoutes.js`
- Controller: `controllers/edictController.js`
- Model: `models/edictModel.js`
- Table: `Edicts`

Supports CRUD and includes a helper query for tasks per edict.

### Tasks

- Route: `routes/taskRoutes.js`
- Controller: `controllers/taskController.js`
- Model: `models/taskModel.js`
- Table: `Tasks`

Supports CRUD and filtered listing by `edictId` (`/api/tasks/edict/:edictId`).

### Resources (uploaded files)

- Route: `routes/resourceRoutes.js`
- Controller: `controllers/resourceController.js`
- Model: `models/resourceModel.js`
- Table: `EdictResources`
- Upload handling: multer disk storage into `public/resources/`

Important behavior:

- File uploads use `multipart/form-data` with field name `file`.
- DB stores relative paths where possible.
- Deleting a resource attempts to remove both DB row and on-disk file.

### Audit logs

- Route: `routes/auditRoutes.js`
- Controller: `controllers/auditController.js`
- Model: `models/auditModel.js`
- Table: `AuditLogs`

Supports create and list/filter endpoints.

### DB inspection endpoints

- Route: `routes/dbRoutes.js`
- Controller: `controllers/dbController.js`
- Model: `models/dbModel.js`

Useful for debugging table contents (`/api/db/tables`, `/api/db/:tableName`).

## Database and schema

- SQL bootstrap/reset script: `sql/schema/DB_init_table.sql`
- Connection config + shared connection pool: `config/db.js`
- Shared connection pool logic: `config/db.js`

Schema includes `Edicts`, `Tasks`, `Users`, `EdictResources`, `AuditLogs` with FK relationships.

## Frontend structure

- `public/pages/*.html`: page shells.
- `public/js/pages/*.js`: page-level behavior.
- `public/js/api/api.js`: centralized `fetch` wrappers (`apiGet/apiPost/apiPut/apiDelete`).
- `public/css/*.css`: styles.

A key convention is to avoid raw `fetch` scattered everywhere and use `public/js/api/api.js` helpers (though there are still direct `fetch` calls in `policy.js`).

## Ops / maintenance scripts

- `npm run cleanup-resources` -> `scripts/cleanup-resources.js`

This script scans `public/resources/` and removes files not referenced by `EdictResources` rows.

## Important gotchas to know early

1. **Host binding in `server.js` is not specific**.
2. **`resource` static path mismatch risk**: server exposes `/resources` from `resources/`, while uploads are saved to `public/resources/`. Verify actual runtime paths before changing resource links.
3. **Auth routes are present but currently not mounted** in `server.js` (user routes are commented out).
4. **User schema mismatch risk**: user controller expects `userID` column patterns like `U123`, while SQL bootstrap defines `Users.id` as integer PK. Treat auth/user area as partially integrated.
5. **Error middleware exists but is not wired** (`middlewares/errorHandler.js` is not attached to Express app).
6. **Legacy and dump files** (`dump/`, old pages, unused upload helper) coexist with active code; confirm target paths before editing.

## Suggested learning path for a newcomer

1. **Start with the running flow**
   - Read `server.js` mounts and static configuration first.
2. **Trace one feature end-to-end**
   - Example: list policies (`GET /api/edicts`) from frontend (`index.js`) to route/controller/model and SQL query.
3. **Understand DB schema and FKs**
   - Read `sql/schema/DB_init_table.sql` to map entities and relationships.
4. **Inspect file upload lifecycle**
   - `resourceRoutes` -> `resourceController` -> `resourceModel` plus `cleanup-resources` script.
5. **Stabilize rough edges** (good first issues)
   - Mount and verify global error handlers.
   - Align users/auth schema with current DB.
   - Consolidate direct `fetch` usage in frontend onto API helper module.
   - Resolve static resource serving path consistency.

## Good “next contribution” ideas

- Add request validation (Joi) in controllers.
- Add tests for models/controllers (none currently configured).
- Add pagination/filtering on list endpoints.
- Add structured logging and environment-based logging levels.
- Document setup/run flow in README with current entrypoint (`server.js`) and required `.env` keys.
