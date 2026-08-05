# Oswald — Policy & Task Management

A Node.js + Express API (backed by Microsoft SQL Server) for managing policies ("edicts"), tasks, file resources, users, services, and audit logs — with a static frontend in `public/`. It also ships a **separate Fileserver service** (HTTPS web UI + network share) that shares the same login and user database.

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
.\start.ps1               # interactive launcher (local / remote)
.\start-detached.ps1      # detached background server (survives terminal close)
# or directly:
node .\server.js          # binds SERVER_HOST (default 0.0.0.0) on PORT (default 3000)
```

The dashboard is normally served at `http://172.22.160.3:8080` (ZeroTier IP), and also over **HTTPS at `https://172.22.160.3:8443`** (task #60 — same app, TLS on `HTTPS_PORT`, reusing the fileserver's trusted self-signed cert). The fileserver runs separately — see the Fileserver section below.

## Maintenance

- `npm run cleanup-resources` — remove orphaned files under `public/resources/` that are no longer referenced by the `EdictResources` table.
- `node scripts/reset-password.js` — interactive password reset (hidden input; `--list` prints existing usernames first).
- `node scripts/create-account.js` — create a new account (`--admin` for full access).

## Database migrations

Schema changes are applied incrementally under `sql/migrations/` (after the initial `DB_init_table.sql`):

| # | File | Change |
|---|------|--------|
| 004 | `004_user_access_control.sql` | UAC — `Users`/`Roles`/`Permissions`/`UserRoles`/`RolePermissions` tables |
| 005 | `005_fileserver_metadata.sql` | Fileserver metadata — `FileServerACLs`/`FileFavorites`/`FileTags` |
| 006 | `006_task_reorder.sql` | `Tasks.sortOrder` (drag-to-reorder) |
| 007 | `007_resource_reorder.sql` | `EdictResources.sortOrder` (drag-to-reorder) |

Apply with `sqlcmd` (see the migration files for the exact command).

## Users & permissions (UAC)

The dashboard has a users & roles admin page at `pages/users.html` — linked from the sidebar **Links → "users & permissions"** (requires `users.manage`, i.e. admin):

- Lists every user with their roles; **Make admin / Make user** promote/demote (role assignment *replaces* roles; you can't change your own role, and the last admin can't be demoted).
- Read-only **permission matrix** (role → permission).
- Create accounts via `scripts/create-account.js` (or the fileserver's self-signup).

## Task & resource ordering

Tasks and resources on the policy workspace (`pages/policy.html?id=…`) can be **drag-reordered** — grab any card (requires `tasks.manage` / `resources.manage`) and drop it where you want it. The order persists via `Tasks.sortOrder` / `EdictResources.sortOrder` (`PUT /api/tasks/reorder`, `PUT /api/resources/reorder` — both transactional and scoped to the policy). New items append to the end.

Each task card shows its **task ID** (`#<id>`), and **archived tasks (state 3) are hidden by default** — a "Show archived" toggle above the list reveals them (persisted via the settings store). The policy card counter + progress rail always reflect the full task set.

## Managed services (Server tray)

The dashboard sidebar **Server ▾** section can start/stop the side services as child processes (backed by `utils/serverManager.js` — add a new managed service by adding one entry to its `DEFINITIONS` registry):

- **MCP Filesystem Server** — Model Context Protocol filesystem server, scoped to the project root.
- **Oswald Fileserver** — the separate HTTPS share on `:8090`.

API: `GET /api/servers` (status of all — any signed-in user) · `GET /api/servers/:name` · `POST /api/servers/:name/start` · `POST /api/servers/:name/stop` (start/stop require `services.manage`). The `portActive` field reports whether something already listens on the service's port, so a **detached** fileserver is shown as "port in use" instead of letting you spawn a conflicting copy.

---

## Fileserver (FS-1 + FS-2) — separate service

A web UI + network file share (`fileserver/`), run as its **own Express service on port `8090`** — independent from the dashboard (`server.js` on `:8080`). It shares the Oswald login: sign in with the same username/password, and the same `JWT_SECRET` (from the repo-root `.env`) authenticates your requests. Served over **HTTPS** (self-signed cert, auto-generated in `fileserver/certs/`).

> URL: **`https://172.22.160.3:8090`** — the host's ZeroTier IP, so it's already reachable on the private VPN. Other ZeroTier members must accept the self-signed cert once.

### Features
- Multi-root browsing — roots are defined in `fileserver/config.json` (`roots[]`)
- Full CRUD — upload (**non-archive files ≤ 1 GB; ZIPs are stored as-is, no auto-extract**, with a live upload progress meter), download, rename, move, delete, create folders, **create empty files with a chosen type** (New file → pick Text/Markdown/JSON/CSV/HTML/CSS/JS/Python/Shell or a custom extension), folder-download as ZIP
- **View state is cached per-browser** — list/grid view, sort column and direction persist across reloads (`oswald_fs_state` in localStorage)
- Type-aware previews (images, PDF, text/JSON, audio/video, DOCX/XLSX) — the same viewer logic as the policy resource viewer
- Search by filename, sortable columns, filter by file type
- Thumbnail grid for image folders (on-the-fly via `sharp`, cached under `temp/fs-thumbs`)
- In-browser text editing for text/code files (load → edit → save)
- **FS-2: per-user access control** — `files.read` (browse/download) / `files.write` (write ops) / `files.admin` (manage shares), plus **per-folder ACLs** (the Share panel grants users read/write on specific folders)
- **FS-2: favorites** (★ star + "Favorites" filter) and **tags** (add in the viewer, filter by tag) — DB-backed (SQL Server, `FileServerACLs` / `FileFavorites` / `FileTags` tables)
- Default for new accounts: **read-only** (the `user` role gets `files.read` only); writes require `files.write` or an ACL grant

### Run

```powershell
.\start-fileserver.ps1        # detached background service -> https://172.22.160.3:8090
```

First time, trust the self-signed cert so the browser stops warning:

```powershell
certutil -addstore -user Root fileserver\certs\cert.pem
```

Stop it:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*fileserver*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Logs: `fileserver.log` / `fileserver.err.log` in the repo root.

### Accounts (who can log in)
The fileserver shares the dashboard's `Users` table — there are no separate fileserver logins. Only `oswald_admin` exists by default, so hand out accounts, not the admin password:

- **Create an account for someone** (read-only by default; `--admin` for full access):
  ```powershell
  node scripts/create-account.js          # 'user' role (fileserver: browse/download)
  node scripts/create-account.js --admin  # full admin
  ```
- **Self-service**: the fileserver login page has a **"Sign up"** link (controlled by `"allowSignup"` in `fileserver/config.json`, default `true`) — anyone who can reach the VPN address can create a read-only account.
- Grant folder-level write via the **Share** panel (needs `files.admin`).

### Config (`fileserver/config.json`)

```jsonc
{
  "port": 8090,
  "host": "0.0.0.0",
  "dashboardBase": "http://172.22.160.3:8080",   // used only by the server-side login proxy
  "tls": { "enabled": true, "host": "172.22.160.3" },
  "roots": [
    { "id": "resources", "name": "Resources", "path": "C:\\Users\\datrep\\Desktop\\oswald\\public\\resources" }
  ],
  "search":    { "maxDepth": 6,  "maxResults": 200 },
  "thumbnails":{ "size": 256,    "cacheDir": "C:\\Users\\datrep\\Desktop\\oswald\\temp\\fs-thumbs" },
  "textEdit":  { "maxBytes": 5242880 }
}
```

- Add more roots by appending to `roots[]` (restart required). Paths are arbitrary local folders; the service refuses paths that escape a root.
- **Auth**: every `/api/fs/*` call needs a valid `oswald_token` — as a `Bearer` header (fetch) or the `oswald_fs_token` same-site cookie (set by the server on login so `<img>`/`<video>`/downloads work over HTTPS). Login is a **server-side proxy** (`POST /api/fs/login` → forwards to the dashboard) so the HTTPS UI has no mixed content.
- **Access model**: `files.admin` → everything; otherwise the most-specific per-folder ACL wins; else `files.read`/`files.write` flags. Read routes are gated on read, write routes on write. The UI hides write controls (upload, new folder, rename/move/delete/edit) when the current folder is read-only.
- **Security**: HTML/SVG/JS/etc. are always served as a forced download (`attachment` + `nosniff`), never rendered inline, to avoid stored XSS on the service origin.

### API (all require a token)
`POST /api/fs/login` (no token) · `GET /api/fs/config` (no token) · `PUT /api/fs/config` (files.admin — switch mode) · `GET /api/fs/roots` · `GET /api/fs/list?root&path` (returns `access` for the folder) · `GET /api/fs/search?root&q&path` · `GET /api/fs/download?root&path[&dl=1]` (files, or folders as ZIP) · `GET /api/fs/thumb?root&path&size` · `GET/PUT /api/fs/content?root&path` (text) · `POST /api/fs/upload?root&path` · `POST /api/fs/dir` · `POST /api/fs/file` (create empty file) · `POST /api/fs/rename` · `POST /api/fs/move` · `DELETE /api/fs?root&path` · favorites: `GET/PUT /api/fs/favorites`, `DELETE /api/fs/favorites?root&path` · tags: `GET /api/fs/tags?root&path`, `GET /api/fs/tags/all`, `POST /api/fs/tags`, `DELETE /api/fs/tags?root&path&tag` · admin: `GET /api/fs/users`, `GET/POST/DELETE /api/fs/acl`

### ARCH: mode switch + containerization (tasks 49–50)

**Two modes, config-driven (not hard-coded).** Set `"mode": "fileserver"` or `"mirror"` in `fileserver/config.json` (or the `FILESERVER_MODE` env var). Config is re-read live on every request, so flipping the mode takes effect without a code change (just edit the file).
- `fileserver` — serve the configured roots (interactive file server).
- `mirror` — serve a single read-only **mirror root** (`mirror.mirrorPath`); the mirroring *engine* (copy/sync) is FS-3 (task 48, deferred). Even admins can't write to the mirror.

**GUI mode switch.** Admins get a **Mode** dropdown in the toolbar — *Server (drop)* ↔ *Mirror (sync)* — backed by `PUT /api/fs/config` (files.admin). It writes `mode` into `config.json`, the roots re-load live (no restart), and the UI reflects read-only when in mirror mode. In mirror mode the served root defaults to the sync destination (`mirror.mirrorPath` falls back to `sync.destination`), so **what the one-way Sync populates is exactly what mirror mode shows** — the two can't drift.

**Docker (reproducible alternative — native launcher stays the default).** A standalone `oswald-fileserver` image is built from `fileserver/Dockerfile` (non-root user, healthcheck, layer-cached deps) and wired up in `compose.yaml` at the repo root (uses repo-root `.env` for DB/JWT; mounts `./public/resources` as the root and reuses the trusted `fileserver/certs`; reaches the host SQL Server via `host.docker.internal`). Run it:

```powershell
docker compose build fileserver
docker compose up -d fileserver     # stop the native process first (both use :8090)
```

The fileserver is fully standalone (its own `fileserver/db.js` — no dependency on the dashboard's module tree), and exposes a localhost-only health endpoint at `http://127.0.0.1:8091/healthz` (used by the container healthcheck).

### FS-3: one-way mirror sync (task 48)
`fileserver/sync.js` mirrors a configured **source → local destination** (source wins), optionally deleting extraneous files (`deleteExtraneous`, rsync `--delete` semantics). Fast size+mtime compare, per-file **temp+rename** writes (no half-written files), mtimes preserved (re-runs report `unchanged`), per-file error collection.

- Config (`config.json` → `sync`): `source`, `destination`, `deleteExtraneous`, `intervalMinutes` (`0` = manual only; `>0` = scheduled poll). Env overrides: `FILESERVER_SYNC_SOURCE` / `_DEST` / `_DELETE` / `_INTERVAL`.
- `mirror.mirrorPath` defaults to `sync.destination`, so the read-only mirror root is the synced copy.
- Admin API: `POST /api/fs/sync` (run now, async) · `GET /api/fs/sync/status` (running + last report).
- UI: **Sync** button in the toolbar (files.admin) triggers a run and toasts the delta (`+added ~updated -deleted`).


