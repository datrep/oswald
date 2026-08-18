#!/usr/bin/env node
// fileserver/sync-ui.js — SYNC-2 local web UI for the sync client.
//
// Runs a tiny localhost HTTP server on 127.0.0.1 that wraps the shared engine
// (sync-core.js) with a browser page: configure folder/server/credentials,
// Sync now / Dry run, watch toggle, live status + log. No Electron dependency —
// the tester runs `node fileserver/sync-ui.js` on their machine and opens the
// printed URL.
//
// Usage: node fileserver/sync-ui.js [--port 8650] [--config <path>]
//   config file (default fileserver/sync-ui-config.json) persists the settings.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSync } = require('./sync-core');

const argVal = (name) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined; };
const PORT = Number(argVal('--port')) || 8650;
const CONFIG_FILE = path.resolve(argVal('--config') || path.join(__dirname, 'sync-ui-config.json'));
const UI_HTML = path.join(__dirname, 'sync-ui', 'index.html');

// ---- tiny log buffer ----
const logBuf = [];
function log(line) {
  const t = new Date().toISOString();
  console.log(t, line);
  logBuf.push(`${t}  ${line}`);
  if (logBuf.length > 300) logBuf.shift();
}

// ---- config ----
function defaultConfig() {
  return {
    folder: '',
    server: 'https://172.22.160.3:8090',
    root: 'sync',
    subPath: '',
    username: '',
    password: '',
    token: '',
    insecure: false,
    dryRun: false,
    watch: false,
    interval: 30,
    port: PORT,
  };
}
function loadConfig() {
  try { return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { return defaultConfig(); }
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}
function publicConfig(c) {
  const { password, token, ...rest } = c;
  return { ...rest, hasPassword: !!password, hasToken: !!token };
}

// ---- engine + watch ----
let config = loadConfig();
let sync = null;
let watchTimer = null;

function rebuildEngine() {
  try {
    sync = createSync({
      folder: config.folder,
      server: config.server,
      root: config.root,
      subPath: config.subPath,
      username: config.username,
      password: config.password,
      token: config.token,
      insecure: config.insecure,
      dryRun: config.dryRun,
    });
    return null;
  } catch (e) {
    return e.message;
  }
}

function applyWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  if (config.watch && config.folder) {
    const ms = Math.max(2, Number(config.interval) || 30) * 1000;
    watchTimer = setInterval(() => {
      if (!sync || sync.getStatus().running) return;
      sync.runSync().then((rep) => {
        log(`[watch] ↓${rep.downloaded} ↑${rep.uploaded} ⊘${rep.deleted} ⚠${rep.conflicts}${rep.error ? ' error:' + rep.error : ''}${rep.errors?.length ? ` (${rep.errors.length} notes)` : ''}`);
      }).catch((e) => log('[watch] ' + e.message));
    }, ms);
    log(`watch on — every ${ms / 1000}s`);
  } else if (watchTimer === null && !config.watch) {
    log('watch off');
  }
}

rebuildEngine();
applyWatch();

// ---- helpers ----
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}
async function startSync(dryRunOverride) {
  if (!sync) return { error: 'engine not built — save config first' };
  const st = sync.getStatus();
  if (st.running) return { error: 'already syncing' };
  const wasDry = config.dryRun;
  if (dryRunOverride !== undefined && sync.setDryRun) sync.setDryRun(dryRunOverride);
  log(`sync ${dryRunOverride ? '(dry-run) ' : ''}started`);
  sync.runSync()
    .then((rep) => log(`sync done: ↓${rep.downloaded} ↑${rep.uploaded} ⊘${rep.deleted} ⚠${rep.conflicts}${rep.error ? ' error:' + rep.error : ''}${rep.errors?.length ? ` (${rep.errors.length} notes)` : ''}`))
    .catch((e) => log('sync error: ' + e.message));
  return { started: true };
}

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // UI page
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      let html = '';
      try { html = fs.readFileSync(UI_HTML, 'utf8'); } catch { /* fallthrough */ }
      if (!html) { res.writeHead(500); return res.end('sync-ui/index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname.startsWith('/api/')) {
      // GET /api/status
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const st = sync ? sync.getStatus() : { running: false, lastReport: null, config: null };
        return json(res, 200, { running: st.running, lastReport: st.lastReport, engine: publicConfig(st.config || config), saved: publicConfig(config), watchOn: config.watch, port: PORT });
      }
      // GET /api/config
      if (req.method === 'GET' && url.pathname === '/api/config') {
        return json(res, 200, publicConfig(config));
      }
      // POST /api/config
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(req);
        const next = { ...config, ...body };
        if (typeof next.folder !== 'string' || !next.folder.trim()) return json(res, 400, { error: 'folder is required' });
        next.folder = next.folder.trim();
        next.server = String(next.server || '').trim().replace(/\/+$/, '');
        if (!next.server) return json(res, 400, { error: 'server is required' });
        next.interval = Math.max(2, Number(next.interval) || 30);
        config = next;
        saveConfig(config);
        const err = rebuildEngine();
        applyWatch();
        log(`config saved (folder=${config.folder}, server=${config.server})`);
        if (err) return json(res, 500, { error: err });
        return json(res, 200, { message: 'config saved', config: publicConfig(config) });
      }
      // POST /api/sync
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const body = await readBody(req);
        const r = await startSync(body.dryRun ? true : undefined);
        if (r.error) return json(res, 400, r);
        return json(res, 200, r);
      }
      // POST /api/watch
      if (req.method === 'POST' && url.pathname === '/api/watch') {
        const body = await readBody(req);
        config.watch = !!body.watch;
        if (body.interval) config.interval = Math.max(2, Number(body.interval) || 30);
        saveConfig(config);
        applyWatch();
        return json(res, 200, { watch: config.watch, interval: config.interval });
      }
      // GET /api/log
      if (req.method === 'GET' && url.pathname === '/api/log') {
        return json(res, 200, { log: logBuf.slice(-100) });
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Oswald Sync UI on http://127.0.0.1:${PORT}/`);
  log(`config file: ${CONFIG_FILE}`);
});
