// Oswald fileserver — FS-1 local web UI + FS-2 network share service.
// Separate Express app, own port, shares the dashboard JWT secret + SQL Server DB.
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const multer = require('multer');
const archiver = require('archiver');

// Shared TLS util (#70) — same load-or-generate cert logic as the dashboard.
const { loadOrCreateCert } = require('../shared/tls');

const { authenticateToken } = require('./auth');
const access = require('./access');
const meta = require('./fsMeta');
const syncEngine = require('./sync');
const core = require('./fsCore');
const { HttpError, getConfig, getRoots, getRoot, assertInside, listDir, search, streamThumbnail, getMime, isDangerous } = core;

// Internal API request log (#58): fileserver traffic is written to the same
// ApiLogs table as the dashboard, tagged [fileserver:<operation>] so the two
// services are distinguishable in the shared log.
const { apiLogger, archivePreviousSession } = require('../utils/apiLogger');
const { createApiLog } = require('../models/apiLogModel');

// Label a request by its fileserver operation, e.g. [fileserver:list],
// [fileserver:upload], [fileserver:rename] — matches the CRUD_* style tag.
function fsLabel(req) {
  const url = (req.originalUrl || req.url).split('?')[0];
  const m = /^\/api\/fs\/([^/]+)/.exec(url);
  return `fileserver:${m ? m[1] : 'other'}`;
}

// Dashboard upstream bases, in order: the configured base first (VPN/LAN),
// then localhost so login/register keep working when the VPN is down.
function dashboardBases() {
  const bases = [];
  const configured = String(getConfig().dashboardBase || '').replace(/\/+$/, '');
  if (configured) bases.push(configured);
  for (const local of ['http://localhost:8080', 'http://127.0.0.1:8080']) {
    if (!bases.includes(local)) bases.push(local);
  }
  return bases;
}

// POST JSON to a dashboard endpoint (login/register), falling back to the next
// base when one is unreachable (e.g. the VPN/LAN address is down). Returns the
// first response that arrives; throws only if every base failed at network level.
async function dashboardPost(path, body) {
  let lastErr;
  for (const base of dashboardBases()) {
    try {
      return await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      });
    } catch (e) {
      lastErr = e;
      console.warn(`[fileserver] dashboard ${base} unreachable (${e.message || e}); trying next base`);
    }
  }
  throw lastErr;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.text({ type: 'text/plain', limit: '6mb' }));

// --- static UI ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// --- internal API logging (#58) ----------------------------------------------
app.use(
  apiLogger({
    source: 'fileserver',
    labelFor: fsLabel,
    writeLog: createApiLog,
  })
);

// --- helpers -----------------------------------------------------------------

const uploadsTemp = path.join(__dirname, 'temp-uploads');
fs.mkdirSync(uploadsTemp, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsTemp),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname.replace(/[\\/]/g, '_')}`),
});
const upload = multer({ storage }); // fully unrestricted: any type, no size cap

function ok(res, data) {
  return res.json(data);
}

function parseRel(req) {
  return String(req.query.path || '');
}

async function cleanupTemp(files) {
  for (const f of files || []) {
    try {
      await fsp.unlink(f.path);
    } catch { /* ignore */ }
  }
}

function streamFile(res, abs, rel, forceDownload) {
  const name = path.basename(abs);
  const dl = forceDownload || isDangerous(name) || !!parseInt(process.env.DL, 10);
  if (dl) {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.type(getMime(name));
  fs.createReadStream(abs).pipe(res);
}

function streamFolderZip(res, abs, rel, name) {
  const archive = archiver('zip', { zlib: { level: 6 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name || 'folder.zip')}`);
  archive.on('error', (err) => { console.error('[fs] zip error', err); res.status(500).end(); });
  res.on('close', () => archive.abort());
  archive.pipe(res);
  archive.directory(abs, false);
  archive.finalize();
}

// --- auth --------------------------------------------------------------------

// Public bootstrap: whether self-registration is enabled + the runtime mode.
app.get('/api/fs/config', (req, res, next) => {
  try {
    const c = getConfig();
    ok(res, { allowSignup: !!c.allowSignup, mode: c.mode });
  } catch (e) { next(e); }
});

// Admin: switch the runtime MODE live — 'fileserver' (drop/upload server) vs
// 'mirror' (read-only replica). config.json is re-read on every request, so the
// flip takes effect immediately, no restart (ARCH task 50).
app.put('/api/fs/config', authenticateToken, access.requireAdmin, (req, res, next) => {
  try {
    const mode = req.body?.mode;
    if (mode !== 'fileserver' && mode !== 'mirror') {
      return res.status(400).json({ error: "mode must be 'fileserver' or 'mirror'" });
    }
    const cfgPath = path.join(__dirname, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.mode = mode;
    // Mirror mode serves a read-only copy of what the one-way Sync populates.
    // If no explicit mirror path is set, derive it from the sync destination so
    // the mode switch and the Sync button always stay in sync.
    if (mode === 'mirror' && (!cfg.mirror || !cfg.mirror.mirrorPath)) {
      cfg.mirror = { ...(cfg.mirror || {}), mirrorPath: cfg.sync && cfg.sync.destination };
    }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const c = getConfig();
    ok(res, { mode: c.mode, roots: getRoots() });
  } catch (e) { next(e); }
});

// Admin: read the full runtime config for the Settings UI (read-only-ish view of
// everything that's safe to surface; ports/TLS/mode are shown for reference).
app.get('/api/fs/settings', authenticateToken, access.requireAdmin, (req, res, next) => {
  try {
    const c = getConfig();
    ok(res, {
      allowSignup: !!c.allowSignup,
      roots: c.roots || [],
      sync: c.sync || {},
      mirror: c.mirror || {},
      search: c.search || {},
      thumbnails: c.thumbnails || {},
      textEdit: c.textEdit || {},
      mode: c.mode,
      host: c.host,
      port: c.port,
      dashboardBase: c.dashboardBase,
      tls: c.tls || {},
    });
  } catch (e) { next(e); }
});

// Admin: persist editable settings into config.json. config.json is re-read on
// every request, so changes take effect immediately (roots/sync/mirror/etc.).
app.put('/api/fs/settings', authenticateToken, access.requireAdmin, (req, res, next) => {
  try {
    const cfgPath = path.join(__dirname, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const b = req.body || {};

    if (typeof b.allowSignup === 'boolean') cfg.allowSignup = b.allowSignup;

    if (Array.isArray(b.roots)) {
      cfg.roots = b.roots
        .filter((r) => r && typeof r.path === 'string' && r.path.trim())
        .map((r) => ({
          id: String(r.id || 'root').trim() || 'root',
          name: String(r.name || r.id || 'Root').trim() || 'Root',
          path: r.path.trim(),
        }));
    }

    if (b.sync && typeof b.sync === 'object') {
      cfg.sync = {
        source: typeof b.sync.source === 'string' ? b.sync.source.trim() : cfg.sync?.source,
        destination: typeof b.sync.destination === 'string' ? b.sync.destination.trim() : cfg.sync?.destination,
        deleteExtraneous: typeof b.sync.deleteExtraneous === 'boolean' ? b.sync.deleteExtraneous : (cfg.sync?.deleteExtraneous ?? true),
        intervalMinutes: Number.isFinite(Number(b.sync.intervalMinutes)) ? Math.max(0, Math.floor(Number(b.sync.intervalMinutes))) : (cfg.sync?.intervalMinutes ?? 0),
      };
    }

    if (b.mirror && typeof b.mirror === 'object') {
      cfg.mirror = { ...(cfg.mirror || {}), ...b.mirror };
      if (typeof b.mirror.mirrorPath === 'string') {
        const mp = b.mirror.mirrorPath.trim();
        cfg.mirror.mirrorPath = mp || undefined;
      }
      if (typeof b.mirror.readOnly === 'boolean') cfg.mirror.readOnly = b.mirror.readOnly;
    }

    if (b.search && typeof b.search === 'object') {
      cfg.search = {
        maxDepth: Number.isFinite(Number(b.search.maxDepth)) ? Math.max(1, Math.floor(Number(b.search.maxDepth))) : (cfg.search?.maxDepth ?? 6),
        maxResults: Number.isFinite(Number(b.search.maxResults)) ? Math.max(1, Math.floor(Number(b.search.maxResults))) : (cfg.search?.maxResults ?? 200),
      };
    }

    if (b.thumbnails && typeof b.thumbnails === 'object') {
      cfg.thumbnails = {
        size: Number.isFinite(Number(b.thumbnails.size)) ? Math.max(16, Math.floor(Number(b.thumbnails.size))) : (cfg.thumbnails?.size ?? 256),
        cacheDir: typeof b.thumbnails.cacheDir === 'string' ? b.thumbnails.cacheDir.trim() : cfg.thumbnails?.cacheDir,
      };
    }

    if (b.textEdit && typeof b.textEdit === 'object') {
      cfg.textEdit = {
        maxBytes: Number.isFinite(Number(b.textEdit.maxBytes)) ? Math.max(1024, Math.floor(Number(b.textEdit.maxBytes))) : (cfg.textEdit?.maxBytes ?? 5242880),
      };
    }

    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const c = getConfig();
    ok(res, { saved: true, mode: c.mode, roots: getRoots() });
  } catch (e) { next(e); }
});

// Self-service account creation (fileserver login page -> Sign up).
// Creates a read-only 'user' role account via the dashboard's register endpoint.
app.post('/api/fs/register', async (req, res, next) => {
  try {
    if (!getConfig().allowSignup) {
      return res.status(403).json({ error: 'Self-registration is disabled' });
    }
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const upstream = await dashboardPost('/api/users/register', { username, password });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 500).json({ error: body.error || 'Registration failed' });
    }
    return ok(res, { message: 'Account created', ...body });
  } catch (e) { next(e); }
});

// FS-2: server-side login proxy. The UI is HTTPS (TLS), so the browser can't
// call the HTTP dashboard directly (mixed content) — the fileserver does it.
// On success we set the same-site session cookie (covers <img>/<video>/<a>)
// and hand the token back for the Authorization header.
app.post('/api/fs/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const upstream = await dashboardPost('/api/users/login', { username, password });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status === 401 ? 401 : 500).json({ error: body.error || 'Login failed' });
    }
    const tlsOn = !!getConfig().tls?.enabled;
    res.cookie('oswald_fs_token', body.token, {
      httpOnly: false,
      sameSite: 'lax',
      secure: tlsOn,
      maxAge: 60 * 60 * 1000,
    });
    return ok(res, { token: body.token, roles: body.roles, permissions: body.permissions });
  } catch (e) {
    next(e);
  }
});

// --- FS routes (access-controlled) -------------------------------------------
// Read routes -> requireRead (files.read / ACL), write routes -> requireWrite.

app.get('/api/fs/roots', authenticateToken, access.requireRead, (req, res, next) => {
  try { ok(res, { roots: getRoots() }); } catch (e) { next(e); }
});

app.get('/api/fs/list', authenticateToken, access.requireRead, async (req, res, next) => {
  try {
    const data = listDir(req.query.root, parseRel(req));
    const acc = await access.effectiveAccess(req.user, req.query.root, parseRel(req));
    ok(res, { ...data, access: { read: acc.read, write: acc.write, admin: acc.admin } });
  } catch (e) { next(e); }
});

// SYNC-2: recursive manifest for sync clients — flat {rel, size, mtime} file
// + directory list under a folder (requireRead, so ACL-granted testers can read
// their root). dirs[] lets the client create only the missing folders.
app.get('/api/fs/manifest', authenticateToken, access.requireRead, (req, res, next) => {
  try {
    const root = req.query.root;
    const rel = parseRel(req);
    const files = [];
    const dirs = [];
    // rels are RELATIVE TO the requested path (so sync clients can map them
    // 1:1 onto a local folder); listDir gets the root-relative path to walk.
    const walk = (r) => {
      const data = listDir(root, rel ? `${rel}/${r}` : r);
      for (const e of data.entries) {
        const child = r ? `${r}/${e.name}` : e.name;
        if (e.isDir) {
          dirs.push(child);
          walk(child);
        } else {
          files.push({ rel: child, size: e.size, mtime: e.mtime });
        }
      }
    };
    walk('');
    ok(res, { root, path: rel, files, dirs });
  } catch (e) { next(e); }
});

app.get('/api/fs/search', authenticateToken, access.requireRead, (req, res, next) => {
  try { ok(res, { results: search(req.query.root, req.query.q, parseRel(req)) }); } catch (e) { next(e); }
});

app.get('/api/fs/download', authenticateToken, access.requireRead, (req, res, next) => {
  try {
    const { abs } = assertInside(req.query.root, parseRel(req));
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      streamFolderZip(res, abs, parseRel(req), path.basename(abs) + '.zip');
    } else {
      streamFile(res, abs, parseRel(req), req.query.dl === '1');
    }
  } catch (e) { next(e); }
});

app.get('/api/fs/thumb', authenticateToken, access.requireRead, async (req, res, next) => {
  try { await streamThumbnail(req.query.root, parseRel(req), req.query.size, res); } catch (e) { next(e); }
});

// Text content: GET (read) + PUT (save).
app.get('/api/fs/content', authenticateToken, access.requireRead, (req, res, next) => {
  try {
    const { abs } = assertInside(req.query.root, parseRel(req));
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new HttpError(400, 'Not a file');
    const maxBytes = getConfig().textEdit?.maxBytes ?? 5242880;
    if (st.size > maxBytes) throw new HttpError(413, `File too large to edit in browser (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
    res.type('text/plain; charset=utf-8');
    fs.createReadStream(abs).pipe(res);
  } catch (e) { next(e); }
});

app.put('/api/fs/content', authenticateToken, access.requireWrite, (req, res, next) => {
  try {
    const { abs } = assertInside(req.query.root, parseRel(req));
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new HttpError(400, 'Not a file');
    const maxBytes = getConfig().textEdit?.maxBytes ?? 5242880;
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, 'Content too large');
    fs.writeFileSync(abs, text, 'utf8');
    ok(res, { message: 'Saved', size: Buffer.byteLength(text) });
  } catch (e) { next(e); }
});

// Upload: ZIPs are stored AS-IS (no auto-extract) and are size-unlimited; every
// other file type must be under 1 GB per file (checked after streaming).
const MAX_NON_ZIP_BYTES = 1024 * 1024 * 1024; // 1 GB

app.post('/api/fs/upload', authenticateToken, access.requireWrite, upload.array('files'), async (req, res, next) => {
  const root = req.query.root;
  const rel = parseRel(req);
  const files = req.files || [];
  try {
    const { abs } = assertInside(root, rel);
    if (!fs.statSync(abs).isDirectory()) throw new HttpError(400, 'Not a directory');
    const added = [];
    for (const f of files) {
      const low = f.originalname.toLowerCase();
      const dest = path.join(abs, f.originalname.replace(/[\\/]/g, '_'));
      if (low.endsWith('.zip')) {
        // ZIP: unlimited size, stored as-is.
        fs.copyFileSync(f.path, dest);
        added.push({ name: f.originalname, kind: 'archive' });
      } else {
        if (f.size > MAX_NON_ZIP_BYTES) {
          throw new HttpError(413, `${f.originalname} is too large (non-archive files are limited to 1 GB)`);
        }
        fs.copyFileSync(f.path, dest);
        added.push({ name: f.originalname, kind: 'file' });
      }
    }
    ok(res, { added });
  } catch (e) { next(e); } finally {
    await cleanupTemp(files);
  }
});

app.post('/api/fs/dir', authenticateToken, access.requireWrite, (req, res, next) => {
  try {
    const { abs } = assertInside(req.body.root, req.body.path || '');
    const name = String(req.body.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
      throw new HttpError(400, 'Invalid folder name');
    }
    const target = path.join(abs, name);
    if (fs.existsSync(target)) throw new HttpError(409, 'Already exists');
    fs.mkdirSync(target);
    ok(res, { message: 'Folder created', name });
  } catch (e) { next(e); }
});

// Create a new EMPTY file (type-selectable on creation). The "type" is chosen
// client-side as the extension — the server just validates + creates the file.
app.post('/api/fs/file', authenticateToken, access.requireWrite, (req, res, next) => {
  try {
    const { abs } = assertInside(req.body.root, req.body.path || '');
    const name = String(req.body.name || '').trim();
    if (!name || name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
      throw new HttpError(400, 'Invalid file name');
    }
    if (!path.extname(name)) throw new HttpError(400, 'File name must include an extension');
    const target = path.join(abs, name);
    if (fs.existsSync(target)) throw new HttpError(409, 'Already exists');
    fs.writeFileSync(target, '');
    ok(res, { message: 'File created', name });
  } catch (e) { next(e); }
});

app.post('/api/fs/rename', authenticateToken, access.requireWrite, (req, res, next) => {
  try {
    const { abs } = assertInside(req.body.root, req.body.path || '');
    const newName = String(req.body.newName || '').trim();
    if (!newName || newName.includes('/') || newName.includes('\\') || newName === '..' || newName === '.') {
      throw new HttpError(400, 'Invalid name');
    }
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const dest = path.join(path.dirname(abs), newName);
    if (fs.existsSync(dest)) throw new HttpError(409, 'Destination already exists');
    fs.renameSync(abs, dest);
    ok(res, { message: 'Renamed', name: newName });
  } catch (e) { next(e); }
});

app.post('/api/fs/move', authenticateToken, access.requireWrite, (req, res, next) => {
  try {
    const { rootObj, abs } = assertInside(req.body.root, req.body.path || '');
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const toRoot = req.body.toRoot || req.body.root;
    const { abs: toAbs } = assertInside(toRoot, req.body.toPath || '');
    const dest = path.join(toAbs, path.basename(abs));
    if (fs.existsSync(dest)) throw new HttpError(409, 'Destination already exists');
    if (rootObj.path === getRoot(toRoot).path) {
      fs.renameSync(abs, dest); // same volume → cheap
    } else {
      fs.cpSync(abs, dest, { recursive: true }); // cross-root → copy + delete
      fs.rmSync(abs, { recursive: true, force: true });
    }
    ok(res, { message: 'Moved' });
  } catch (e) { next(e); }
});

app.delete('/api/fs', authenticateToken, access.requireWrite, (req, res, next) => {
  try {
    const { abs } = assertInside(req.query.root, parseRel(req));
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    fs.rmSync(abs, { recursive: true, force: true });
    ok(res, { message: 'Deleted' });
  } catch (e) { next(e); }
});

// --- Favorites (per-user; requires read access to the target) ----------------

app.get('/api/fs/favorites', authenticateToken, access.requireRead, async (req, res, next) => {
  try { ok(res, { favorites: await meta.getFavorites(req.user.userID) }); } catch (e) { next(e); }
});

app.put('/api/fs/favorites', authenticateToken, access.requireRead, async (req, res, next) => {
  try {
    await meta.addFavorite(req.user.userID, req.body.root, String(req.body.path || ''));
    ok(res, { message: 'Favorited' });
  } catch (e) { next(e); }
});

app.delete('/api/fs/favorites', authenticateToken, access.requireRead, async (req, res, next) => {
  try {
    await meta.removeFavorite(req.user.userID, req.query.root, String(req.query.path || ''));
    ok(res, { message: 'Favorite removed' });
  } catch (e) { next(e); }
});

// --- Tags (shared metadata; read = requireRead, write = requireWrite) --------

app.get('/api/fs/tags/all', authenticateToken, access.requireRead, async (req, res, next) => {
  try { ok(res, { tags: await meta.getTagsAll() }); } catch (e) { next(e); }
});

app.get('/api/fs/tags', authenticateToken, access.requireRead, async (req, res, next) => {
  try { ok(res, { tags: await meta.getTags(req.query.root, String(req.query.path || '')) }); } catch (e) { next(e); }
});

app.post('/api/fs/tags', authenticateToken, access.requireWrite, async (req, res, next) => {
  try {
    const tag = String(req.body.tag || '').trim().slice(0, 64);
    if (!tag) return res.status(400).json({ error: 'tag is required' });
    await meta.addTag(req.body.root, String(req.body.path || ''), tag, req.user.userID);
    ok(res, { message: 'Tag added' });
  } catch (e) { next(e); }
});

app.delete('/api/fs/tags', authenticateToken, access.requireWrite, async (req, res, next) => {
  try {
    await meta.removeTag(req.query.root, String(req.query.path || ''), String(req.query.tag || ''));
    ok(res, { message: 'Tag removed' });
  } catch (e) { next(e); }
});

// --- Per-folder ACLs + user list (files.admin only) ---------------------------

app.get('/api/fs/acl', authenticateToken, access.requireAdmin, async (req, res, next) => {
  try { ok(res, { acls: await meta.getAcls(req.query.root) }); } catch (e) { next(e); }
});

app.post('/api/fs/acl', authenticateToken, access.requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.body.userId);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'userId required' });
    await meta.upsertAcl(userId, req.body.rootId, String(req.body.folderPath || ''), !!req.body.canRead, !!req.body.canWrite, req.user.userID);
    ok(res, { message: 'ACL saved' });
  } catch (e) { next(e); }
});

app.delete('/api/fs/acl', authenticateToken, access.requireAdmin, async (req, res, next) => {
  try {
    await meta.removeAcl(Number(req.query.userId), req.query.rootId, String(req.query.folderPath || ''));
    ok(res, { message: 'ACL removed' });
  } catch (e) { next(e); }
});

app.get('/api/fs/users', authenticateToken, access.requireAdmin, async (req, res, next) => {
  try { ok(res, { users: await meta.getUsers() }); } catch (e) { next(e); }
});

// --- FS-3: one-way mirror sync (files.admin) --------------------------------
app.get('/api/fs/sync/status', authenticateToken, access.requireAdmin, (req, res, next) => {
  try { ok(res, syncEngine.getStatus()); } catch (e) { next(e); }
});

app.post('/api/fs/sync', authenticateToken, access.requireAdmin, (req, res, next) => {
  try {
    const direction = req.body?.direction === 'collect' ? 'collect' : 'push';
    syncEngine
      .runSync(direction)
      .then((r) => {
        if (!r.skippedDueToRunning) {
          console.log(`[fs] manual sync (${direction}): +${r.added} ~${r.updated} -${r.deleted}${r.error ? ' error:' + r.error : ''}`);
        }
      })
      .catch((e) => console.error('[fs] sync error', e));
    ok(res, { running: true, direction, startedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

// --- errors + start -----------------------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.name === 'MulterError') return res.status(400).json({ error: err.message });
  console.error('[fileserver]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

const port = getConfig().port || 8090;
const host = getConfig().host || '0.0.0.0';

// Internal logging (#58): archive the previous session's active log file (dated)
// and start a fresh one for this run. Best-effort, non-blocking.
archivePreviousSession('fileserver');

// Optional scheduled sync (FS-3): intervalMinutes > 0.
const syncMins = getConfig().sync?.intervalMinutes || 0;
if (syncMins > 0) {
  setInterval(() => {
    syncEngine
      .runSync()
      .then((r) => {
        if (!r.skippedDueToRunning) {
          console.log(`[fs] scheduled sync: +${r.added} ~${r.updated} -${r.deleted}${r.error ? ' error:' + r.error : ''}`);
        }
      })
      .catch((e) => console.error('[fs] scheduled sync failed', e));
  }, syncMins * 60 * 1000);
  console.log(`[fileserver] scheduled sync every ${syncMins} min`);
}

if (getConfig().tls?.enabled) {
  // Public HTTPS interface — shared cert load-or-generate util (#70).
  loadOrCreateCert({ certDir: path.join(__dirname, 'certs'), host: getConfig().tls?.host || '172.22.160.3' })
    .then((creds) => {
      https.createServer(creds, app).listen(port, host, () => {
        console.log(`[fileserver] Oswald Fileserver (FS-1/FS-2) listening on https://${host}:${port}`);
        console.log(`[fileserver] roots: ${getRoots().map((r) => `${r.name} (${r.path})`).join(', ')}`);
      });
      // Localhost-only HTTP health endpoint (for the container healthcheck / ops).
      const healthPort = getConfig().tls?.healthPort || 8091;
      require('http')
        .createServer((req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        })
        .listen(healthPort, '127.0.0.1', () => {
          console.log(`[fileserver] health endpoint on http://127.0.0.1:${healthPort}/healthz`);
        });
    })
    .catch((e) => {
      console.error('[fileserver] cert generation failed', e);
      process.exit(1);
    });
} else {
  app.listen(port, host, () => {
    console.log(`[fileserver] Oswald Fileserver (FS-1/FS-2) listening on http://${host}:${port}`);
    console.log(`[fileserver] roots: ${getRoots().map((r) => `${r.name} (${r.path})`).join(', ')}`);
  });
}
