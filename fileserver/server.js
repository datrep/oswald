// Oswald fileserver — FS-1 local web UI + FS-2 network share service.
// Separate Express app, own port, shares the dashboard JWT secret + SQL Server DB.
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const selfsigned = require('selfsigned');

const { authenticateToken } = require('./auth');
const access = require('./access');
const meta = require('./fsMeta');
const core = require('./fsCore');
const { HttpError, getConfig, getRoots, getRoot, assertInside, listDir, search, streamThumbnail, getMime, isDangerous } = core;

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

// Extract a zip into dirAbs with zip-slip protection.
function extractZip(zipPath, dirAbs) {
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const rel = entry.entryName.split('\\').join('/');
    const target = core.safeJoin(dirAbs, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
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
    const upstream = await fetch(`${getConfig().dashboardBase}/api/users/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
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

// Upload: any type/size; .zip uploads are extracted into the target folder.
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
      if (low.endsWith('.zip')) {
        try {
          extractZip(f.path, abs);
          added.push({ name: f.originalname, kind: 'archive-extracted' });
        } catch (e) {
          throw new HttpError(400, `Failed to extract ${f.originalname}: ${e.message}`);
        }
      } else {
        const dest = path.join(abs, f.originalname.replace(/[\\/]/g, '_'));
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

// --- errors + start -----------------------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.name === 'MulterError') return res.status(400).json({ error: err.message });
  console.error('[fileserver]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

async function getOrCreateCert() {
  const certDir = path.join(__dirname, 'certs');
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  fs.mkdirSync(certDir, { recursive: true });
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const host = getConfig().tls?.host || '172.22.160.3';
  // selfsigned 5.x is async — returns a promise. Include DNS + IP SANs so
  // browsers accept the cert for both hostname and IP access (Chrome requires
  // an IP SAN, not just a DNS SAN, when connecting to an IP).
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: host }, { name: 'organizationName', value: 'Oswald Fileserver' }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: host },
          { type: 2, value: 'localhost' },
          { type: 7, value: host },
          { type: 7, value: '127.0.0.1' },
        ],
      }],
    }
  );
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

const port = getConfig().port || 8090;
const host = getConfig().host || '0.0.0.0';
if (getConfig().tls?.enabled) {
  getOrCreateCert()
    .then((creds) => {
      https.createServer(creds, app).listen(port, host, () => {
        console.log(`[fileserver] Oswald Fileserver (FS-1/FS-2) listening on https://${host}:${port}`);
        console.log(`[fileserver] roots: ${getRoots().map((r) => `${r.name} (${r.path})`).join(', ')}`);
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
