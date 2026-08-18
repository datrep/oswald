// fileserver/sync-core.js — SYNC-2 bidirectional sync ENGINE (shared by the CLI
// `sync-client.js` and the local web UI `sync-ui.js`).
//
// createSync(config) -> { runSync(), getStatus() }.
//   config: { folder, server, root, subPath, username, password, token,
//             insecure, dryRun, stateFile }
//
// Semantics (unchanged from the CLI): manifest-diff, last-write-wins with
// `<name>.conflict-<ts>` copies when BOTH sides changed since the last sync,
// safe-delete (a deletion only propagates if the far side is unchanged since
// the last sync), state file tracks post-sync manifests so passes are stable.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOLERANCE_MS = 1000; // mtime equality tolerance (matches fileserver/sync.js)

function createSync(cfg) {
  const config = {
    folder: path.resolve(cfg.folder || ''),
    server: String(cfg.server || 'https://172.22.160.3:8090').replace(/\/+$/, ''),
    root: cfg.root || 'sync',
    subPath: cfg.subPath || '',
    username: cfg.username || '',
    password: cfg.password || '',
    token: cfg.token || '',
    insecure: !!cfg.insecure,
    dryRun: !!cfg.dryRun,
    stateFile: path.resolve(cfg.stateFile || path.join(cfg.folder || '', '.oswald-sync.json')),
  };
  const STATE_NAME = path.basename(config.stateFile);
  let running = false;
  let lastReport = null;

  // ---- HTTP helpers (node:https so self-signed certs can be allowed) ----
  function httpReq(method, urlPath, { token, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(config.server + urlPath);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          method,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          rejectUnauthorized: !config.insecure,
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
      const u = new URL(config.server + urlPath);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          method: 'GET',
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          rejectUnauthorized: !config.insecure,
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

  // ---- auth (throws; callers decide how to surface) ----
  async function getToken() {
    if (config.token) return config.token;
    if (!config.username || !config.password) throw new Error('Provide token OR username/password');
    const r = await httpReq('POST', '/api/fs/login', {
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ username: config.username, password: config.password })),
    });
    if (r.status !== 200) throw new Error(`login failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
    if (!r.body.token) throw new Error('login response had no token');
    return r.body.token;
  }

  // ---- manifests ----
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
    const q = `root=${encodeURIComponent(config.root)}&path=${encodeURIComponent(config.subPath)}`;
    const r = await httpReq('GET', `/api/fs/manifest?${q}`, { token });
    if (r.status === 404) return { files: new Map(), dirs: new Set(), serverDirs: new Set() }; // not on server yet = empty
    if (r.status !== 200) throw new Error(`manifest failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
    const m = new Map();
    for (const f of r.body.files || []) m.set(f.rel, { size: f.size, mtimeMs: Date.parse(f.mtime) || 0 });
    return { files: m, dirs: new Set(r.body.dirs || []), serverDirs: new Set(r.body.dirs || []) };
  }

  // ---- state ----
  function loadState() {
    try { return JSON.parse(fs.readFileSync(config.stateFile, 'utf8')); } catch { return { server: {}, local: {} }; }
  }
  function saveState(serverFiles, localFiles) {
    const server = {};
    for (const [rel, v] of serverFiles) server[rel] = [v.size, v.mtimeMs];
    const local = {};
    for (const [rel, v] of localFiles) local[rel] = [v.size, v.mtimeMs];
    fs.writeFileSync(config.stateFile, JSON.stringify({ server, local }, null, 2));
  }

  // ---- helpers ----
  const same = (aSize, aM, bSize, bM) => aSize === bSize && Math.abs(aM - bM) <= TOLERANCE_MS;
  function serverRel(rel) { return config.subPath ? (rel ? `${config.subPath}/${rel}` : config.subPath) : rel; }
  const relUrl = (rel) => `root=${encodeURIComponent(config.root)}&path=${encodeURIComponent(serverRel(rel))}`;
  function conflictName(name) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}.conflict-${ts}`;
    return `${name.slice(0, dot)}.conflict-${ts}${name.slice(dot)}`;
  }
  function localAbs(rel) { return path.join(config.folder, rel.split('/').join(path.sep)); }

  async function ensureServerDirs(token, rel, serverDirs, report) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const relDir = parts.slice(0, i + 1).join('/');
      if (serverDirs.has(relDir)) continue;
      const parent = serverRel(parts.slice(0, i).join('/'));
      const r = await httpReq('POST', '/api/fs/dir', {
        token,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ root: config.root, path: parent, name: parts[i] })),
      });
      if (r.status === 200) { serverDirs.add(relDir); report.dirs++; }
    }
  }

  async function ensureSubpathDir(token) {
    if (!config.subPath) return;
    let cur = '';
    for (const seg of config.subPath.split('/')) {
      const r = await httpReq('POST', '/api/fs/dir', {
        token,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ root: config.root, path: cur, name: seg })),
      });
      if (r.status !== 200 && r.status !== 409) return; // stop on a hard error
      cur = cur ? `${cur}/${seg}` : seg;
    }
  }

  async function uploadLocal(token, rel, lv, report) {
    const buf = fs.readFileSync(lv.abs);
    await uploadLocalRaw(token, rel, buf, report);
  }

  async function uploadLocalRaw(token, rel, buf, report) {
    await ensureServerDirs(token, rel, report.serverDirs, report);
    const enc = multipart('files', path.basename(rel), buf, 'application/octet-stream');
    const dir = serverRel(rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '');
    const r = await httpReq('POST', `/api/fs/upload?root=${encodeURIComponent(config.root)}&path=${encodeURIComponent(dir)}`, {
      token,
      headers: { 'Content-Type': enc.contentType },
      body: enc.body,
    });
    if (r.status !== 200) throw new Error(`upload ${rel}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    report.uploaded++;
  }

  // ---- one sync pass ----
  async function runSync() {
    if (running) return { ...(lastReport || {}), skippedDueToRunning: true };
    running = true;
    let report;
    try {
      const token = await getToken();
      report = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: 0, unchanged: 0, errors: [], dirs: 0, startedAt: new Date().toISOString() };
      const local = new Map();
      if (!fs.existsSync(config.folder)) fs.mkdirSync(config.folder, { recursive: true });
      localWalk(config.folder, '', local);
      if (!config.dryRun) await ensureSubpathDir(token);
      const { files: server, serverDirs } = await serverManifest(token);
      report.serverDirs = serverDirs; // shared so uploads can create missing folders
      const isConflict = (rel) => path.basename(rel).includes('.conflict-');
      for (const k of [...local.keys()]) if (isConflict(k)) local.delete(k);
      for (const k of [...server.keys()]) if (isConflict(k)) server.delete(k);
      const st = loadState();
      const lastServer = st.server || {};
      const lastLocal = st.local || {};

      for (const [rel, sv] of server) {
        const lv = local.get(rel);
        const lastS = lastServer[rel];
        const lastL = lastLocal[rel];
        if (!lv) {
          const serverChanged = lastS && (lastS[0] !== sv.size || Math.abs(lastS[1] - sv.mtimeMs) > TOLERANCE_MS);
          if (lastS && serverChanged) { report.errors.push(`kept server-only (modified remotely): ${rel}`); continue; }
          if (lastS && !serverChanged) continue;
          if (config.dryRun) { report.downloaded++; continue; }
          try { await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, localAbs(rel)); report.downloaded++; }
          catch (e) { report.errors.push(`download ${rel}: ${e.message}`); }
          continue;
        }
        if (same(sv.size, sv.mtimeMs, lv.size, lv.mtimeMs)) { report.unchanged++; continue; }
        const serverChanged = !lastS || lastS[0] !== sv.size || Math.abs(lastS[1] - sv.mtimeMs) > TOLERANCE_MS;
        const localChanged = !lastL || lastL[0] !== lv.size || Math.abs(lastL[1] - lv.mtimeMs) > TOLERANCE_MS;
        const serverNewer = sv.mtimeMs > lv.mtimeMs;
        if (!lastS && !lastL) {
          if (serverNewer) { if (config.dryRun) { report.downloaded++; continue; } try { await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, localAbs(rel)); report.downloaded++; } catch (e) { report.errors.push(`download ${rel}: ${e.message}`); } }
          else { if (config.dryRun) { report.uploaded++; continue; } try { await uploadLocal(token, rel, lv, report); } catch (e) { report.errors.push(`upload ${rel}: ${e.message}`); } }
          continue;
        }
        if (serverChanged && localChanged) {
          report.conflicts++;
          if (config.dryRun) continue;
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
              const tmp = path.join(config.folder, '.fs-conflict-tmp');
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
          if (config.dryRun) { report.downloaded++; continue; }
          try { await httpDownload(`/api/fs/download?${relUrl(rel)}`, token, localAbs(rel)); report.downloaded++; } catch (e) { report.errors.push(`download ${rel}: ${e.message}`); }
          continue;
        }
        if (localChanged && !serverChanged) {
          if (config.dryRun) { report.uploaded++; continue; }
          try { await uploadLocal(token, rel, lv, report); } catch (e) { report.errors.push(`upload ${rel}: ${e.message}`); }
          continue;
        }
        report.unchanged++;
      }

      for (const [rel, lv] of local) {
        if (server.has(rel)) continue;
        const lastS = lastServer[rel];
        const lastL = lastLocal[rel];
        if (lastS) {
          const localChanged = !lastL || lastL[0] !== lv.size || Math.abs(lastL[1] - lv.mtimeMs) > TOLERANCE_MS;
          if (!localChanged) {
            if (config.dryRun) { report.deleted++; continue; }
            try { fs.unlinkSync(localAbs(rel)); report.deleted++; } catch (e) { report.errors.push(`delete ${rel}: ${e.message}`); }
            continue;
          }
        }
        if (config.dryRun) { report.uploaded++; continue; }
        try { await uploadLocal(token, rel, lv, report); } catch (e) { report.errors.push(`upload ${rel}: ${e.message}`); }
      }

      for (const [rel, sv] of server) {
        if (local.has(rel)) continue;
        const lastS = lastServer[rel];
        if (lastS && lastS[0] === sv.size && Math.abs(lastS[1] - sv.mtimeMs) <= TOLERANCE_MS) {
          if (config.dryRun) { report.deleted++; continue; }
          const r = await httpReq('DELETE', `/api/fs?${relUrl(rel)}`, { token });
          if (r.status === 200) report.deleted++;
          else report.errors.push(`delete ${rel}: ${r.status}`);
        }
      }

      if (!config.dryRun) {
        try {
          const fresh = await serverManifest(token);
          const freshLocal = new Map();
          localWalk(config.folder, '', freshLocal);
          saveState(fresh.files, freshLocal);
        } catch { saveState(server, local); }
      }
      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - new Date(report.startedAt).getTime();
    } catch (err) {
      report = report || {};
      report.error = err.message;
    }
    lastReport = report;
    running = false;
    return report;
  }

  function getStatus() {
    return {
      running,
      lastReport,
      config: {
        folder: config.folder,
        server: config.server,
        root: config.root,
        subPath: config.subPath,
        username: config.username,
        hasPassword: !!config.password,
        hasToken: !!config.token,
        insecure: config.insecure,
        dryRun: config.dryRun,
        stateFile: config.stateFile,
      },
    };
  }

  return { runSync, getStatus };
}

module.exports = { createSync };
