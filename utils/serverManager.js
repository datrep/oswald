// utils/serverManager.js
// Generic child-process manager for the side services the dashboard can
// manage from the UI (Server tray + the servers page): open (start), close
// (stop), restart, attach (adopt a detached instance already listening on the
// service's port), per-service logs + health, and an auto-start flag.
//
// Built-in definitions (mcp, fileserver) are code; user-defined services live
// in config/servers.json and can be added/edited/removed from the UI. The
// registry is "one entry per service" — no new controller/route/UI copies.
//
// Detached instances: spawned children are children of the dashboard process.
// On Windows an orphaned child survives if the dashboard dies, so something may
// still be listening on a port after a crash. `portActive` reports that, and
// `attach` adopts the external process (finds its pid on the port) so Stop can
// terminate it — letting services run independently yet still be controlled.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'servers.json');

// ---------------------------------------------------------------------------
// Definitions (built-in + user-defined)
// ---------------------------------------------------------------------------

// Built-ins are code-defined and protected (not editable/removable from the UI).
const BUILTIN = {
  mcp: {
    name: 'mcp',
    label: 'MCP Filesystem Server',
    description: 'Model Context Protocol filesystem server, scoped to the project root.',
    command: process.execPath,
    args: [path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'server-filesystem', 'dist', 'index.js'), ROOT],
    cwd: ROOT,
    port: null,
    logFile: path.join(ROOT, 'mcp.server.log'),
    healthUrl: '',
    autoStart: false,
    env: {},
  },
  fileserver: {
    name: 'fileserver',
    label: 'Oswald Fileserver',
    description: 'Separate HTTPS web UI + network share service on :8090.',
    command: process.execPath,
    args: [path.join(ROOT, 'fileserver', 'server.js')],
    cwd: ROOT,
    port: 8090,
    https: true,
    logFile: path.join(ROOT, 'fileserver.log'),
    healthUrl: 'http://127.0.0.1:8091/healthz',
    autoStart: false,
    env: {},
  },
  listings: {
    name: 'listings',
    label: 'Listing Workbench',
    description: 'Personal listing/price/profit/inventory service on :8110.',
    command: process.execPath,
    args: [path.join(ROOT, 'listings', 'server.js')],
    cwd: ROOT,
    port: 8110,
    https: true,
    logFile: path.join(ROOT, 'listings', 'server.log'),
    healthUrl: 'http://127.0.0.1:8111/healthz',
    autoStart: false,
    env: {},
  },
  expenses: {
    name: 'expenses',
    label: 'Expense Sheet',
    description: 'General expense sheet (computer / investing / school / other) on :8112.',
    command: process.execPath,
    args: [path.join(ROOT, 'expenses', 'server.js')],
    cwd: ROOT,
    port: 8112,
    https: true,
    logFile: path.join(ROOT, 'expenses', 'server.log'),
    healthUrl: 'http://127.0.0.1:8113/healthz',
    autoStart: false,
    env: {},
  },
  trading: {
    name: 'trading',
    label: 'Trading Agent',
    description: 'Plus500 demo automation + DeepSeek wake loop + quant/risk on :8114.',
    command: process.execPath,
    args: [path.join(ROOT, 'trading', 'server.js')],
    cwd: ROOT,
    port: 8114,
    https: true,
    logFile: path.join(ROOT, 'trading', 'server.log'),
    healthUrl: 'http://127.0.0.1:8115/healthz',
    autoStart: false, // opt-in via the Services page auto-start toggle
    env: {},
  },
  dswatch: {
    name: 'dswatch',
    label: 'DS-WATCH (DeepSeek cache)',
    description:
      'Prompt-cache watchdog for the DeepSeek-backed Copilot chat. Flags any request whose cache-hit rate collapsed and refuses /chat/completions while tripped (a broken prompt prefix re-bills ~half the context at 50x on every turn).',
    command: process.execPath,
    args: [path.join(ROOT, 'scripts', 'ds-watch.js'), '--proxy', '--port', '8788'],
    cwd: ROOT,
    port: 8788,
    logFile: path.join(ROOT, 'logs', 'ds-watch.out.log'),
    healthUrl: 'http://127.0.0.1:8788/status',
    detailFile: path.join(ROOT, 'temp', 'ds-watch-state.json'), // breaker state, shown in the tray
    autoStart: false, // opt-in via the Services page auto-start toggle
    env: {},
  },
};

let userDefs = {}; // name -> definition (from config/servers.json)
let builtinOverrides = {}; // name -> { autoStart } (opt-in overrides for built-ins)
function loadUserDefs() {
  try {
    const all = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    builtinOverrides = (all && all._builtinOverrides) || {};
    delete all._builtinOverrides;
    userDefs = all || {};
  } catch {
    userDefs = {};
    builtinOverrides = {};
  }
}
function saveUserDefs() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...userDefs, _builtinOverrides: builtinOverrides }, null, 2));
}

function definitions() {
  const all = { ...BUILTIN };
  for (const [name, over] of Object.entries(builtinOverrides)) {
    if (all[name]) all[name] = { ...all[name], autoStart: !!over.autoStart };
  }
  for (const [name, def] of Object.entries(userDefs)) {
    if (!all[name]) all[name] = { ...def, name };
  }
  return all;
}

// Opt-in/out of auto-start for ANY managed service (built-in or user-defined).
function setAutoStart(name, on) {
  const v = !!on;
  if (BUILTIN[name]) {
    builtinOverrides[name] = { ...(builtinOverrides[name] || {}), autoStart: v };
  } else if (userDefs[name]) {
    userDefs[name] = { ...userDefs[name], autoStart: v };
  } else {
    throw new Error(`Unknown server "${name}"`);
  }
  saveUserDefs();
  return { name, autoStart: v };
}

// Normalize/validate a user-supplied definition (from the UI).
function normalizeDef(name, raw) {
  const command = String(raw && raw.command ? raw.command : '').trim();
  if (!command) throw new Error('command is required');
  const label = String((raw && raw.label) || name).trim();
  if (!label) throw new Error('label is required');
  return {
    name,
    label,
    description: String((raw && raw.description) || ''),
    command,
    args: Array.isArray(raw && raw.args) ? raw.args.map(String) : [],
    cwd: String((raw && raw.cwd) || ROOT),
    port: raw && raw.port ? Number(raw.port) : null,
    logFile: String((raw && raw.logFile) || ''),
    healthUrl: String((raw && raw.healthUrl) || ''),
    autoStart: !!(raw && raw.autoStart),
    https: !!(raw && raw.https),
    env: raw && raw.env && typeof raw.env === 'object' ? { ...raw.env } : {},
  };
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------
const children = {}; // name -> { child, startedAt }
const attached = {}; // name -> { pid, since } (external instance adopted via attach)

function childRec(name) { return children[name]; }
function isRunning(name) {
  const rec = children[name];
  return !!rec && rec.child.exitCode === null && !rec.child.killed;
}

// ---------------------------------------------------------------------------
// Port / process discovery
// ---------------------------------------------------------------------------
function probePort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(timeoutMs, () => { sock.destroy(); resolve(false); });
  });
}

// Find the pid listening on 127.0.0.1/0.0.0.0:<port> via netstat -ano.
function findPidOnPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    execFile('netstat', ['-ano'], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve(null);
      const re = new RegExp(`TCP\\s+[^\\s]+:${port}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)`, 'g');
      let m; const pids = new Set();
      while ((m = re.exec(stdout))) pids.add(m[1]);
      resolve(pids.size ? [...pids][0] : null);
    });
  });
}

// ---------------------------------------------------------------------------
// Spawn / kill helpers
// ---------------------------------------------------------------------------
function attachLog(name, child, logFile) {
  if (!logFile) return;
  try {
    const stream = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
  } catch (err) {
    console.error(`[servers] ${name}: cannot open log ${logFile}:`, err.message);
  }
}

function forceKillPid(pid) {
  if (!pid) return;
  try { execFile('taskkill', ['/PID', String(pid), '/F', '/T']); } catch { /* best-effort */ }
}

// Graceful stop: SIGTERM, wait up to 2.5s, then taskkill /F.
function killChild(name) {
  const rec = children[name];
  if (!rec) return Promise.resolve();
  const c = rec.child;
  return new Promise((resolve) => {
    const t = setTimeout(() => { forceKillPid(c.pid); resolve(); }, 2500);
    c.once('exit', () => { clearTimeout(t); resolve(); });
    try { c.kill(); } catch { clearTimeout(t); resolve(); }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function start(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  if (isRunning(name)) return { name, label: def.label, running: true, alreadyRunning: true, pid: children[name].child.pid };

  if (def.port && await probePort(def.port)) {
    const pid = await findPidOnPort(def.port);
    return { name, label: def.label, running: false, portActive: true, detachedPid: pid, error: 'Port already in use — attach the detached instance or stop it first.' };
  }

  const child = spawn(def.command, def.args, { cwd: def.cwd || ROOT, windowsHide: true, env: { ...process.env, ...(def.env || {}) } });
  children[name] = { child, startedAt: Date.now() };
  attachLog(name, child, def.logFile);
  child.on('error', (err) => {
    console.error(`[servers] ${name} spawn error:`, err.message);
    delete children[name];
  });
  child.on('exit', (code, signal) => {
    console.log(`[servers] ${name} exited (code=${code}, signal=${signal})`);
    delete children[name];
  });
  return { name, label: def.label, running: true, pid: child.pid };
}

async function stop(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  if (isRunning(name)) {
    await killChild(name);
    delete children[name];
    return { name, label: def.label, running: false };
  }
  // Not a managed child — maybe a detached instance we attached to.
  if (attached[name]) {
    forceKillPid(attached[name].pid);
    delete attached[name];
    return { name, label: def.label, running: false, stoppedDetached: true };
  }
  return { name, label: def.label, running: false };
}

async function restart(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  await stop(name);
  return start(name);
}

// Adopt a detached instance already listening on the service's port so the
// dashboard can track + stop it even though it didn't spawn it.
async function attach(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  if (isRunning(name)) return { name, label: def.label, running: true, pid: children[name].child.pid };
  if (!def.port) return { name, label: def.label, error: 'This service has no port to attach to.' };
  const onPort = await probePort(def.port);
  if (!onPort) return { name, label: def.label, running: false, error: 'Nothing is listening on the service port — start it instead.' };
  const pid = await findPidOnPort(def.port);
  if (!pid) return { name, label: def.label, running: false, error: 'Could not find the process on the port.' };
  attached[name] = { pid, since: Date.now() };
  return { name, label: def.label, running: false, attached: true, pid };
}

function detach(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  delete attached[name];
  return { name, label: def.label, running: false, detached: false };
}

// Synchronous status (no network probes) — safe to call from /api/health.
function status(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  const rec = children[name];
  const att = attached[name];
  return {
    name,
    label: def.label,
    description: def.description,
    port: def.port || null,
    running: isRunning(name),
    pid: rec && rec.child.pid ? rec.child.pid : null,
    startedAt: rec ? rec.startedAt : null,
    uptimeSec: rec ? Math.floor((Date.now() - rec.startedAt) / 1000) : null,
    attached: att ? att.pid : null,
    attachedSince: att ? att.since : null,
    lastExit: rec && rec.lastExit ? rec.lastExit : null,
    autoStart: !!def.autoStart,
    https: !!def.https,
    builtin: !!BUILTIN[name],
  };
}

function probeHealth(healthUrl, timeoutMs = 1800) {
  return new Promise((resolve) => {
    if (!healthUrl) return resolve(null);
    let u;
    try { u = new URL(healthUrl); } catch { return resolve(false); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, rejectUnauthorized: false },
      (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 500); }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// Optional per-service state file, surfaced to the UI (e.g. the DS-WATCH breaker:
// tripped / miss % / estimated CNY). Absent or unreadable -> null, never throws.
function readDetail(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const t = d.totals || {};
    return {
      updated: d.updated || null,
      tripped: !!d.tripped,
      advisory: !!d.advisory,
      trips: d.tripCount || 0,
      badStreak: d.badStreak || 0,
      lastTrip: d.lastTrip || null,
      requests: t.n || 0,
      budget: d.budget
        ? {
            maxCny: d.budget.maxCny == null ? null : Number(d.budget.maxCny),
            maxMissCny: d.budget.maxMissCny == null ? null : Number(d.budget.maxMissCny),
            spent: Number(d.budget.spent) || 0,
            over: !!d.budget.over,
            waived: !!d.budget.waived,
          }
        : null,
      missPct: t.missPct == null ? null : Number(t.missPct),
      cny: t.cny == null ? null : Number(Number(t.cny).toFixed(2)),
      badCny: t.badCny == null ? null : Number(Number(t.badCny).toFixed(2)),
    };
  } catch {
    return null; // not started yet, or no state written
  }
}

// Async status that also probes the port + health (used by /api/servers).
async function statusOne(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  const s = status(name);
  if (def.port) s.portActive = await probePort(def.port);
  else s.portActive = false;
  if (!s.running && !s.attached && s.portActive) s.detachedPid = await findPidOnPort(def.port);
  s.healthy = await probeHealth(def.healthUrl);
  if (def.detailFile) s.detail = readDetail(def.detailFile);
  return s;
}

async function statusAll() {
  const out = [];
  for (const name of Object.keys(definitions())) out.push(await statusOne(name));
  return out;
}

// Read the tail of a service's log file (newest last).
function readLog(name, lines = 100) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  if (!def.logFile) return { log: [], logFile: '' };
  try {
    const text = fs.readFileSync(def.logFile, 'utf8');
    const arr = text.split(/\r?\n/).filter(Boolean);
    return { log: arr.slice(-Math.max(1, Math.min(500, Number(lines) || 100))), logFile: def.logFile };
  } catch {
    return { log: [], logFile: def.logFile };
  }
}

function clearLog(name) {
  const def = definitions()[name];
  if (!def) return { error: `Unknown server "${name}"` };
  if (!def.logFile) return { error: 'This service has no log file.' };
  try { fs.writeFileSync(def.logFile, ''); return { cleared: true }; }
  catch (err) { return { error: err.message }; }
}

// --- config registry (user-defined services) ---
function listDefinitions() {
  return Object.entries(definitions()).map(([name, d]) => ({
    name,
    label: d.label,
    description: d.description,
    command: d.command,
    args: d.args,
    cwd: d.cwd,
    port: d.port || null,
    logFile: d.logFile,
    healthUrl: d.healthUrl,
    autoStart: !!d.autoStart,
    https: !!d.https,
    builtin: !!BUILTIN[name],
  }));
}

function addDefinition(raw) {
  const name = String((raw && raw.name) || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!name) throw new Error('name is required');
  if (BUILTIN[name]) throw new Error(`"${name}" is a built-in service and cannot be redefined`);
  if (userDefs[name]) throw new Error(`A service named "${name}" already exists`);
  const def = normalizeDef(name, raw);
  userDefs[name] = def;
  saveUserDefs();
  return { ok: true, definition: def };
}

function updateDefinition(name, raw) {
  if (BUILTIN[name]) throw new Error(`"${name}" is a built-in service and cannot be edited`);
  if (!userDefs[name]) throw new Error(`Unknown service "${name}"`);
  const def = normalizeDef(name, { ...userDefs[name], ...raw });
  userDefs[name] = def;
  saveUserDefs();
  return { ok: true, definition: def };
}

async function removeDefinition(name) {
  if (BUILTIN[name]) throw new Error(`"${name}" is a built-in service and cannot be removed`);
  if (!userDefs[name]) throw new Error(`Unknown service "${name}"`);
  await stop(name);
  delete attached[name];
  delete userDefs[name];
  saveUserDefs();
  return { ok: true };
}

// Start every autoStart service that isn't already running / port-held.
async function autoStart() {
  const started = [];
  const skipped = [];
  for (const [name, def] of Object.entries(definitions())) {
    if (!def.autoStart) continue;
    if (isRunning(name)) { skipped.push(name); continue; }
    if (def.port && await probePort(def.port)) { skipped.push(name); continue; }
    const r = await start(name);
    if (r.error) skipped.push(name); else started.push(name);
  }
  console.log(`[servers] autoStart: started [${started.join(', ')}], skipped [${skipped.join(', ')}]`);
  return { started, skipped };
}

loadUserDefs();

module.exports = {
  start, stop, restart, attach, detach, status, statusOne, statusAll,
  readLog, clearLog, autoStart, setAutoStart,
  listDefinitions, addDefinition, updateDefinition, removeDefinition,
  DEFINITIONS: definitions(),
};
