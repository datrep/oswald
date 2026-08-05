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
node .\server.js       # http://localhost:8080
```

## Maintenance

- `npm run cleanup-resources` — remove orphaned files under `public/resources/` that are no longer referenced by the `EdictResources` table.

---

## Fileserver (FS-1 + FS-2) — separate service

A web UI + network file share (`fileserver/`), run as its **own Express service on port `8090`** — independent from the dashboard (`server.js` on `:8080`). It shares the Oswald login: sign in with the same username/password, and the same `JWT_SECRET` (from the repo-root `.env`) authenticates your requests. Served over **HTTPS** (self-signed cert, auto-generated in `fileserver/certs/`).

> URL: **`https://172.22.160.3:8090`** — the host's ZeroTier IP, so it's already reachable on the private VPN. Other ZeroTier members must accept the self-signed cert once.

### Features
- Multi-root browsing — roots are defined in `fileserver/config.json` (`roots[]`)
- Full CRUD — upload (any type/size; ZIPs are extracted), download, rename, move, delete, create folders, folder-download as ZIP
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
`POST /api/fs/login` (no token) · `GET /api/fs/roots` · `GET /api/fs/list?root&path` (returns `access` for the folder) · `GET /api/fs/search?root&q&path` · `GET /api/fs/download?root&path[&dl=1]` (files, or folders as ZIP) · `GET /api/fs/thumb?root&path&size` · `GET/PUT /api/fs/content?root&path` (text) · `POST /api/fs/upload?root&path` · `POST /api/fs/dir` · `POST /api/fs/rename` · `POST /api/fs/move` · `DELETE /api/fs?root&path` · favorites: `GET/PUT /api/fs/favorites`, `DELETE /api/fs/favorites?root&path` · tags: `GET /api/fs/tags?root&path`, `GET /api/fs/tags/all`, `POST /api/fs/tags`, `DELETE /api/fs/tags?root&path&tag` · admin: `GET /api/fs/users`, `GET/POST/DELETE /api/fs/acl`

> Note: the rest of this README predates the FS work; the Fileserver section above is current.

