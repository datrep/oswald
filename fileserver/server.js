// Oswald fileserver — FS-1 local web UI service.
// Separate Express app, own port, shares the dashboard JWT secret.
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const multer = require('multer');
const archiver = require('archiver');
const AdmZip = require('adm-zip');

const { authenticateToken } = require('./auth');
const core = require('./fsCore');
const { HttpError, config, getRoots, getRoot, assertInside, listDir, search, streamThumbnail, getMime, isDangerous, getExt, statEntry } = core;

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

// --- routes ------------------------------------------------------------------
// Every route requires a valid oswald_token (same JWT secret as the dashboard).

app.get('/api/fs/roots', authenticateToken, (req, res, next) => {
  try {
    ok(res, { roots: getRoots() });
  } catch (e) { next(e); }
});

app.get('/api/fs/list', authenticateToken, (req, res, next) => {
  try {
    ok(res, listDir(req.query.root, parseRel(req)));
  } catch (e) { next(e); }
});

app.get('/api/fs/search', authenticateToken, (req, res, next) => {
  try {
    ok(res, { results: search(req.query.root, req.query.q, parseRel(req)) });
  } catch (e) { next(e); }
});

app.get('/api/fs/download', authenticateToken, (req, res, next) => {
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

app.get('/api/fs/thumb', authenticateToken, async (req, res, next) => {
  try {
    await streamThumbnail(req.query.root, parseRel(req), req.query.size, res);
  } catch (e) { next(e); }
});

// Text content: GET (size-limited) + PUT (save).
app.get('/api/fs/content', authenticateToken, (req, res, next) => {
  try {
    const { abs } = assertInside(req.query.root, parseRel(req));
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new HttpError(400, 'Not a file');
    const maxBytes = config.textEdit?.maxBytes ?? 5242880;
    if (st.size > maxBytes) throw new HttpError(413, `File too large to edit in browser (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
    res.type('text/plain; charset=utf-8');
    fs.createReadStream(abs).pipe(res);
  } catch (e) { next(e); }
});

app.put('/api/fs/content', authenticateToken, (req, res, next) => {
  try {
    const { abs } = assertInside(req.query.root, parseRel(req));
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new HttpError(400, 'Not a file');
    const maxBytes = config.textEdit?.maxBytes ?? 5242880;
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
    if (Buffer.byteLength(text) > maxBytes) throw new HttpError(413, 'Content too large');
    fs.writeFileSync(abs, text, 'utf8');
    ok(res, { message: 'Saved', size: Buffer.byteLength(text) });
  } catch (e) { next(e); }
});

// Upload: any type/size; .zip uploads are extracted into the target folder.
app.post('/api/fs/upload', authenticateToken, upload.array('files'), async (req, res, next) => {
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

app.post('/api/fs/dir', authenticateToken, (req, res, next) => {
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

app.post('/api/fs/rename', authenticateToken, (req, res, next) => {
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

app.post('/api/fs/move', authenticateToken, (req, res, next) => {
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

app.delete('/api/fs', authenticateToken, (req, res, next) => {
  try {
    const { abs } = assertInside(req.query.root, parseRel(req));
    if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
    fs.rmSync(abs, { recursive: true, force: true });
    ok(res, { message: 'Deleted' });
  } catch (e) { next(e); }
});

// --- errors + start -----------------------------------------------------------

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.name === 'MulterError') return res.status(400).json({ error: err.message });
  console.error('[fileserver]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

const port = config.port || 8090;
const host = config.host || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`[fileserver] Oswald Fileserver (FS-1) listening on http://${host}:${port}`);
  console.log(`[fileserver] roots: ${getRoots().map((r) => `${r.name} (${r.path})`).join(', ')}`);
});
