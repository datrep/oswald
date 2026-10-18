// Filesystem core for the Oswald fileserver.
// All public functions take a *relative* path (posix-style, '/'-separated) that
// is validated to stay inside the configured root — no path traversal.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig, getRoots, getRoot } = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'log', 'csv', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'env', 'sh', 'bat', 'ps1', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'sql', 'css', 'scss', 'html', 'htm', 'xml', 'svg', 'toml', 'lock', 'gitignore', 'dockerfile', 'editorconfig', 'prettierrc', 'eslintrc', 'xml']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'avi', 'mkv']);
const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json',
  csv: 'text/csv', log: 'text/plain', yml: 'text/plain', yaml: 'text/plain',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  m4v: 'video/x-m4v', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar', gz: 'application/gzip', bz2: 'application/x-bzip2', xz: 'application/x-xz', tgz: 'application/gzip',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
};

// Types that could execute in a browser origin — always served as a download
// (attachment + nosniff), never inline.
const DANGEROUS = new Set(['html', 'htm', 'svg', 'js', 'mjs', 'cjs', 'wasm', 'hta', 'xhtml']);

function getExt(name) {
  const base = String(name || '').split('?')[0];
  const idx = base.lastIndexOf('.');
  if (idx === -1) return '';
  return base.slice(idx + 1).toLowerCase();
}

function getFileKind(name) {
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return 'office';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  return 'other';
}

function getMime(name) {
  return MIME[getExt(name)] || 'application/octet-stream';
}

function isDangerous(name) {
  return DANGEROUS.has(getExt(name));
}

// ---- Config / roots -------------------------------------------------------
// getRoots()/getRoot() come from ./config — mode-aware ('fileserver' vs
// 'mirror') and read live from config.json + env on each call.

// ---- Safe path resolution -------------------------------------------------

function safeJoin(rootPath, rel) {
  const base = path.resolve(rootPath);
  const parts = String(rel || '')
    .split('/')
    .filter((p) => p && p !== '.');

  for (const p of parts) {
    if (p === '..') throw new HttpError(400, 'Invalid path (no .. allowed)');
    if (p.includes('\\') || p.includes('\0') || /^[a-zA-Z]:/.test(p)) {
      throw new HttpError(400, 'Invalid path component');
    }
  }

  const abs = path.resolve(base, ...parts);
  const relCheck = path.relative(base, abs);
  // relCheck === '' means abs IS the root (empty rel path).
  if (relCheck === '' || (!relCheck.startsWith('..') && !path.isAbsolute(relCheck))) {
    return abs;
  }
  throw new HttpError(400, 'Path escapes root');
}

function assertInside(root, rel) {
  const rootObj = getRoot(root);
  if (!rootObj) throw new HttpError(404, 'Unknown root');
  const abs = safeJoin(rootObj.path, rel);
  return { rootObj, abs };
}

// ---- Listing --------------------------------------------------------------

function statEntry(abs, name) {
  const st = fs.statSync(abs);
  return {
    name,
    isDir: st.isDirectory(),
    size: st.isDirectory() ? null : st.size,
    mtime: st.mtime.toISOString(),
    ext: st.isDirectory() ? '' : getExt(name),
    kind: st.isDirectory() ? 'dir' : getFileKind(name),
  };
}

function listDir(root, rel) {
  const { rootObj, abs } = assertInside(root, rel);
  if (!fs.existsSync(abs)) throw new HttpError(404, 'Path not found');
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new HttpError(400, 'Not a directory');

  const entries = fs
    .readdirSync(abs, { withFileTypes: true })
    .map((d) => statEntry(path.join(abs, d.name), d.name));

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return {
    root: { id: root, name: rootObj.name, path: rootObj.path },
    rel: String(rel || ''),
    abs: abs,
    entries,
  };
}

// ---- Search ---------------------------------------------------------------

function search(root, query, startRel) {
  const { rootObj, abs } = assertInside(root, startRel);
  if (!query) return [];
  const q = query.toLowerCase();
  const maxDepth = getConfig().search?.maxDepth ?? 6;
  const maxResults = getConfig().search?.maxResults ?? 200;
  const out = [];

  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxResults) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) {
      if (out.length >= maxResults) return;
      const full = path.join(dir, d.name);
      const rel = path.relative(rootObj.path, full).split(path.sep).join('/');
      if (d.name.toLowerCase().includes(q)) {
        out.push({ rel, name: d.name, isDir: d.isDirectory(), size: d.isDirectory() ? null : fs.statSync(full).size, kind: d.isDirectory() ? 'dir' : getFileKind(d.name) });
      }
      if (d.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  };

  walk(abs, 0);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out.slice(0, maxResults);
}

// ---- Thumbnails -----------------------------------------------------------

// On-the-fly image thumbnail via sharp, cached on disk by (root+rel+mtime+size).
// Falls back to the original image if sharp is unavailable or fails.
async function streamThumbnail(root, rel, size, res) {
  const { abs } = assertInside(root, rel);
  if (!fs.existsSync(abs)) throw new HttpError(404, 'Not found');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new HttpError(400, 'Not a file');

  const want = Math.max(32, Math.min(1024, parseInt(size, 10) || 256));
  const key = crypto
    .createHash('md5')
    .update(`${root}|${rel}|${st.mtimeMs}|${want}`)
    .digest('hex');
  const cacheDir = getConfig().thumbnails?.cacheDir || path.join(__dirname, '..', 'temp', 'fs-thumbs');
  const cacheFile = path.join(cacheDir, `${key}.webp`);

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    if (fs.existsSync(cacheFile)) {
      return res.type('image/webp').sendFile(cacheFile);
    }
    const sharp = require('sharp');
    const buf = await sharp(abs).rotate().resize({ width: want, height: want, fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    fs.writeFileSync(cacheFile, buf);
    res.type('image/webp').send(buf);
  } catch {
    // No sharp / not an image / resize failed → serve the original.
    res.type(getMime(rel));
    fs.createReadStream(abs).pipe(res);
  }
}

module.exports = {
  HttpError,
  getConfig,
  getRoots,
  getRoot,
  assertInside,
  listDir,
  search,
  streamThumbnail,
  getFileKind,
  getMime,
  isDangerous,
  getExt,
  safeJoin,
  statEntry,
};
