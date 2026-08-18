#!/usr/bin/env node
// fileserver/sync-client.js — SYNC-2: bidirectional remote sync client (MEGA-like).
//
// Keeps a local folder in two-way sync with a fileserver root over HTTPS
// (ZeroTier). Server stays dumb (storage + perms); THIS client does the diff:
//   - manifest-diff  (recursive /api/fs/manifest vs a local walk)
//   - last-write-wins, with `<name>.conflict-<ts><ext>` copies when BOTH sides
//     changed since the last sync
//   - safe-delete    (a deletion only propagates if the far side is unchanged
//     since the last sync — never clobbers a remotely-modified file)
//   - optional --watch (poll every --interval seconds)
//
// Usage:
//   node fileserver/sync-client.js --folder "C:\MyOswaldCopy" [options]
// Options:
//   --server <url>    Fileserver base (default https://172.22.160.3:8090)
//   --root <rootId>   Server root to sync (default 'sync')
//   --path <rel>      Sub-path within the root (default '')
//   --username <u> --password <p>   Login via the fileserver /api/fs/login proxy
//   --token <jwt>     Use a pre-issued token instead of logging in
//   --insecure        Allow self-signed TLS (dev only; prefer trusting the cert)
//   --dry-run         Show what would change without applying anything
//   --watch           Keep running, re-syncing every --interval seconds
//   --interval <sec>  Poll interval for --watch (default 30)
//   --state <path>    Sync-state file (default <folder>/.oswald-sync.json)
//
// The state file tracks the server + local manifests as of the last sync so
// "changed since last sync" (and therefore conflicts + safe deletes) are
// correct across runs. It is never itself synced.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- args ----------
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(name);
const FOLDER = path.resolve(arg('--folder', ''));
const SERVER = (arg('--server', 'https://172.22.160.3:8090') || '').replace(/\/+$/, '');
const ROOT = arg('--root', 'sync');
const SUBPATH = arg('--path', '');
const USERNAME = arg('--username', '');
const PASSWORD = arg('--password', '');
const TOKEN = arg('--token', '');
const INSECURE = has('--insecure');
const DRY_RUN = has('--dry-run');
const WATCH = has('--watch');
const INTERVAL = Math.max(2, Number(arg('--interval', '30')) || 30);
const STATE_FILE = path.resolve(arg('--state', '') || path.join(FOLDER, '.oswald-sync.json'));

const TOLERANCE_MS = 1000; // mtime equality tolerance (matches fileserver/sync.js)
const STATE_NAME = path.basename(STATE_FILE);

if (!FOLDER) {
  console.error('Usage: node fileserver/sync-client.js --folder <dir> [--server url] [--root id] [--path rel] [--username u --password p | --token jwt] [--insecure] [--dry-run] [--watch] [--interval N]');
  process.exit(2);
}
if (!fs.existsSync(FOLDER)) fs.mkdirSync(FOLDER, { recursive: true });

// ---------- HTTP helpers (node:https so self-signed certs can be allowed) ----------
function httpReq(method, urlPath, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(SERVER + urlPath);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: !INSECURE,
        headers: { ...headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, body: json !== null ? json : text, buf });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpDownload(urlPath, token, destAbs) {
  return new Promise((resolve, reject) => {
    const u = new URL(SERVER + urlPath);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        rejectUnauthorized: !INSECURE,
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download ${res.statusCode} for ${u.pathname}`));
        }
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        const ws = fs.createWriteStream(destAbs);
        res.pipe(ws);
        ws.on('finish', () => resolve(destAbs));
        ws.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function multipart(field, filename, buf, contentType) {
  const boundary = '----oswaldsync' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${String(filename).replace(/"/g, '')}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const foot = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { body: Buffer.concat([head, buf, foot]), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------- auth ----------
async function getToken() {
  if (TOKEN) return TOKEN;
  if (!USERNAME || !PASSWORD) {
    console.error('Provide --token OR --username/--password.');
    process.exit(2);
  }
  const r = await httpReq('POST', '/api/fs/login', {
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({ username: USERNAME, password: PASSWORD })),
  });
  if (r.status !== 200) throw new Error(`login failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  if (!r.body.token) throw new Error('login response had no token');
  return r.body.token;
}

// ---------- local + server manifests ----------
function localWalk(dir, rel, out) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    if (it.name === STATE_NAME) continue;
    const full = path.join(dir, it.name);
    const r = rel ? `${rel}/${it.name}` : it.name;
    if (it.isSymbolicLink()) continue;
    if (it.isDirectory()) localWalk(full, r, out);
    else {
      const st = fs.statSync(full);
      out.set(r, { size: st.size, mtimeMs: st.mtimeMs, abs: full });
    }
  }
}

async function serverManifest(token) {
  const q = `root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(SUBPATH)}`;
  const r = await httpReq('GET', `/api/fs/manifest?${q}`, { token });
  if (r.status === 404) return { files: new Map(), dirs: new Set(), serverDirs: new Set() }; // folder not on the server yet = empty
  if (r.status !== 200) throw new Error(`manifest failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  const m = new Map();
  for (const f of r.body.files || []) m.set(f.rel, { size: f.size, mtimeMs: Date.parse(f.mtime) || 0 });
  return { files: m, dirs: new Set(r.body.dirs || []), serverDirs: new Set(r.body.dirs || []) };
}

// ---------- state ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { server: {}, local: {} }; }
}
function saveState(serverFiles, localFiles) {
  const server = {};
  for (const [rel, v] of serverFiles) server[rel] = [v.size, v.mtimeMs];
  const local = {};
  for (const [rel, v] of localFiles) local[rel] = [v.size, v.mtimeMs];
  fs.writeFileSync(STATE_FILE, JSON.stringify({ server, local }, null, 2));
}

// ---------- helpers ----------
const same = (aSize, aM, bSize, bM) => aSize === bSize && Math.abs(aM - bM) <= TOLERANCE_MS;
// Manifest rels are relative to SUBPATH; the API wants root-relative paths.
function serverRel(rel) { return SUBPATH ? (rel ? `${SUBPATH}/${rel}` : SUBPATH) : rel; }
const relUrl = (rel) => `root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(serverRel(rel))}`;
function conflictName(name) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name}.conflict-${ts}`;
  return `${name.slice(0, dot)}.conflict-${ts}${name.slice(dot)}`;
}
function localAbs(rel) { return path.join(FOLDER, rel.split('/').join(path.sep)); }

// Ensure the server has every ancestor dir of `rel` (subpath-relative). The
// mkdir route takes {root, path, name}: create each segment one at a time.
async function ensureServerDirs(token, rel, serverDirs, report) {
  const parts = rel.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    const relDir = parts.slice(0, i + 1).join('/');
    if (serverDirs.has(relDir)) continue;
    const parent = serverRel(parts.slice(0, i).join('/'));
    const r = await httpReq('POST', '/api/fs/dir', {
      token,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ root: ROOT, path: parent, name: parts[i] })),
    });
    if (r.status === 200) { serverDirs.add(relDir); report.dirs++; }
  }
}

// Ensure the sync SUBPATH folder itself exists on the server (uploads need it).
async function ensureSubpathDir(token) {
  if (!SUBPATH) return;
  let cur = '';
  for (const seg of SUBPATH.split('/')) {
    const r = await httpReq('POST', '/api/fs/dir', {
      token,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ root: ROOT, path: cur, name: seg })),
    });
    if (r.status !== 200 && r.status !== 409) return; // stop on a hard error
    cur = cur ? `${cur}/${seg}` : seg;
  }
}

// ---------- sync ----------
async function syncOnce(token) {
  const report = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, unchanged: 0, errors: [], dirs: 0 };
  const local = new Map();
  localWalk(FOLDER, '', local);
  if (!DRY_RUN) await ensureSubpathDir(token);
  const { files: server, serverDirs } = await serverManifest(token);
  report.serverDirs = serverDirs; // shared so uploads can create missing folders
  // Conflict copies (`.conflict-<ts>`) are sync artifacts — never diff/propagate.
  const isConflict = (rel) => path.basename(rel).includes('.conflict-');
  for (const k of [...local.keys()]) if (isConflict(k)) local.delete(k);
  for (const k of [...server.keys()]) if (isConflict(k)) server.delete(k);
  const st = loadState();
  const lastServer = st.server || {};
  const lastLocal = st.local || {};

  // NOTE: the manifest is fetched with path=SUBPATH, so rel values are relative
  // to SUBPATH. We sync folder<->SUBPATH, so local rel == server rel directly.

  // 1) downloads + conflicts (server -> local)
  for (const [rel, sv] of server) {
    const lv = local.get(rel);
    const lastS = lastServer[rel];
    const lastL = lastLocal[rel];
    if (!lv) {
      // server-only: if it was synced before, either it was modified remotely
      // (keep) or unchanged (step 3 propagates the local deletion). Fresh ones
      // are downloaded.
      const serverChanged = lastS && (lastS[0] !== sv.size || Math.abs(lastS[1] - sv.mtimeMs) > TOLERANCE_MS);
      if (lastS && serverChanged) {
        report.errors.push(`kept server-only (modified remotely): ${rel}`);
        continue;
      }
      if (lastS && !serverChanged) continue; // unchanged -> step 3 deletes it
      if (DRY_RUN) { report.downloaded++; continue; }
      try {
        await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, localAbs(rel));
        report.downloaded++;
      } catch (e) { report.errors.push(`download ${rel}: ${e.message}`); }
      continue;
    }
    if (same(sv.size, sv.mtimeMs, lv.size, lv.mtimeMs)) { report.unchanged++; continue; }
    // both exist, differ
    const serverChanged = !lastS || lastS[0] !== sv.size || Math.abs(lastS[1] - sv.mtimeMs) > TOLERANCE_MS;
    const localChanged = !lastL || lastL[0] !== lv.size || Math.abs(lastL[1] - lv.mtimeMs) > TOLERANCE_MS;
    const serverNewer = sv.mtimeMs > lv.mtimeMs;
    if (!lastS && !lastL) {
      // first baseline: newer mtime wins, ties -> server
      if (serverNewer) { if (DRY_RUN) { report.downloaded++; continue; } try { await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, localAbs(rel)); report.downloaded++; } catch (e) { report.errors.push(`download ${rel}: ${e.message}`); } }
      else { if (DRY_RUN) { report.uploaded++; continue; } try { await uploadLocal(token, rel, lv, report); } catch (e) { report.errors.push(`upload ${rel}: ${e.message}`); } }
      continue;
    }
    if (serverChanged && localChanged) {
      // conflict — newer wins, loser kept as .conflict
      report.conflicts++;
      if (DRY_RUN) continue;
      if (serverNewer) {
        try {
          const cn = conflictName(path.basename(rel));
          const cRel = path.join(path.dirname(rel), cn).split(path.sep).join('/');
          fs.renameSync(localAbs(rel), localAbs(cRel));
          await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, localAbs(rel));
          report.errors.push(`conflict: local ${path.basename(rel)} kept as ${cn}`);
        } catch (e) { report.errors.push(`conflict ${rel}: ${e.message}`); }
      } else {
        try {
          // upload server's current content as a .conflict copy, then local wins
          const tmp = path.join(FOLDER, '.fs-conflict-tmp');
          await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, tmp);
          const cn = conflictName(path.basename(rel));
          const cRel = path.join(path.dirname(rel), cn).split(path.sep).join('/');
          await uploadLocalRaw(token, cRel, fs.readFileSync(tmp), report);
          fs.unlinkSync(tmp);
          await uploadLocal(token, rel, lv, report);
          report.errors.push(`conflict: server ${path.basename(rel)} kept as ${cn}`);
        } catch (e) { report.errors.push(`conflict ${rel}: ${e.message}`); }
      }
      continue;
    }
    if (serverChanged && !localChanged) {
      if (DRY_RUN) { report.downloaded++; continue; }
      try { await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, localAbs(rel)); report.downloaded++; } catch (e) { report.errors.push(`download ${rel}: ${e.message}`); }
      continue;
    }
    if (localChanged && !serverChanged) {
      if (DRY_RUN) { report.uploaded++; continue; }
      try { await uploadLocal(token, rel, lv, report); } catch (e) { report.errors.push(`upload ${rel}: ${e.message}`); }
      continue;
    }
    // neither "changed" but differ (same mtime, diff size) -> pick server
    report.unchanged++;
  }

  // 2) local-only (uploads + local deletions that propagate server deletions)
  for (const [rel, lv] of local) {
    if (server.has(rel)) continue;
    const lastS = lastServer[rel];
    const lastL = lastLocal[rel];
    if (lastS) {
      // server deleted it: propagate delete to local if local is unchanged,
      // otherwise local edit wins and we re-upload.
      const localChanged = !lastL || lastL[0] !== lv.size || Math.abs(lastL[1] - lv.mtimeMs) > TOLERANCE_MS;
      if (!localChanged) {
        if (DRY_RUN) { report.deleted++; continue; }
        try { fs.unlinkSync(localAbs(rel)); report.deleted++; } catch (e) { report.errors.push(`delete ${rel}: ${e.message}`); }
        continue;
      }
    }
    if (DRY_RUN) { report.uploaded++; continue; }
    try { await uploadLocal(token, rel, lv, report); } catch (e) { report.errors.push(`upload ${rel}: ${e.message}`); }
  }

  // 3) server-side deletions for files that were on the server and are now gone
  //    locally (safe-delete: only when the server copy is unchanged since last sync)
  for (const [rel, sv] of server) {
    if (local.has(rel)) continue;
    const lastS = lastServer[rel];
    if (lastS && lastS[0] === sv.size && Math.abs(lastS[1] - sv.mtimeMs) <= TOLERANCE_MS) {
      if (DRY_RUN) { report.deleted++; continue; }
      const r = await httpReq('DELETE', `/api/fs?${relUrl(rel)}`, { token });
      if (r.status === 200) report.deleted++;
      else report.errors.push(`delete ${rel}: ${r.status}`);
    }
  }

  if (!DRY_RUN) {
    // Save state from POST-sync reality (re-fetch server manifest + re-walk
    // local) so the next pass sees no phantom changes and doesn't churn.
    try {
      const fresh = await serverManifest(token);
      const freshLocal = new Map();
      localWalk(FOLDER, '', freshLocal);
      saveState(fresh.files, freshLocal);
    } catch {
      saveState(server, local);
    }
  }
  return report;
}

async function uploadLocal(token, rel, lv, report) {
  const buf = fs.readFileSync(lv.abs);
  await uploadLocalRaw(token, rel, buf, report);
}

async function uploadLocalRaw(token, rel, buf, report) {
  await ensureServerDirs(token, rel, report.serverDirs, report);
  const enc = multipart('files', path.basename(rel), buf, 'application/octet-stream');
  const dir = serverRel(rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '');
  const r = await httpReq('POST', `/api/fs/upload?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(dir)}`, {
    token,
    headers: { 'Content-Type': enc.contentType },
    body: enc.body,
  });
  if (r.status !== 200) throw new Error(`upload ${rel}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  report.uploaded++;
}

// ---------- main ----------
async function run() {
  let token;
  try { token = await getToken(); } catch (e) { console.error('AUTH ERROR: ' + e.message); process.exit(1); }
  console.log(`sync: ${FOLDER}  <->  ${SERVER} root '${ROOT}'${SUBPATH ? '/' + SUBPATH : ''}${DRY_RUN ? '  [DRY RUN]' : ''}`);
  const loop = async () => {
    const t0 = Date.now();
    try {
      const rep = await syncOnce(token);
      console.log(
        `${new Date().toISOString()}  ↓${rep.downloaded} ↑${rep.uploaded} ⊘${rep.deleted} ⚠${rep.conflicts} dirs+${rep.dirs} unchanged:${rep.unchanged}` +
        (rep.errors.length ? `  (${rep.errors.length} notes)` : '') +
        (DRY_RUN ? '  [dry-run, nothing applied]' : '')
      );
      for (const e of rep.errors.slice(0, 10)) console.log('  • ' + e);
    } catch (e) {
      console.error(`${new Date().toISOString()}  SYNC ERROR: ${e.message}`);
      if (!WATCH) process.exit(1);
    }
    if (WATCH) setTimeout(loop, INTERVAL * 1000);
  };
  await loop();
  if (!WATCH) process.exit(0);
}

run();
