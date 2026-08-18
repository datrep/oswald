// scripts/smoke-test.js
// Regression suite (#72) — boots server.js on an isolated port and runs ~100
// checks against the real HTTP surface: public endpoints, auth (401/403),
// permission gating, and full CRUD round-trips (created rows are cleaned up).
//
//   npm test   -> node scripts/smoke-test.js
//
// FUTURE SCOPE: if this project grows, extend this suite with more per-module
// cases (fileserver API, MCP lifecycle, notifications), parallel workers, and a
// CI report (JUnit/JSON). Keep every new endpoint covered here.

const { spawn } = require('child_process');
const https = require('https');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const sql = require('mssql');
const { getPool } = require('../config/db');

// Windows reserves dynamic TCP ranges (Hyper-V/WinNAT) that shift on reboot —
// e.g. 7986-8085 (incl. 8080) and 4435-4534 were reserved at the time of
// writing. A hardcoded port can land inside one and fail with EACCES, so we
// probe for free ports before booting the test server (falling back to the
// legacy fixed ports if the probe itself fails).
function findFreePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

let HTTP_PORT = 4099;
let HTTPS_PORT = 4499;
let BASE = `http://127.0.0.1:${HTTP_PORT}`;
let child = null;

const ADMIN_PERMS = [
  'files.admin', 'files.read', 'files.write', 'mcp.manage', 'monitoring.manage',
  'policies.manage', 'resources.manage', 'services.manage', 'tasks.manage', 'users.manage',
];

// ---- tiny harness -----------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.error(`  ✗ ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    ok(name, false, err.message);
  }
}

function mint(perms, v) {
  return jwt.sign({ userID: 1, roles: ['admin'], permissions: perms, v }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// UAC session control: a self-minted token must carry the user's current `v`
// (tokenVersion) or the auth middleware revokes it immediately. Look it up at
// run time rather than hardcoding 0.
async function currentTokenVersion() {
  const pool = await getPool();
  try {
    const r = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
    return r.recordset[0]?.tokenVersion ?? 0;
  } finally {
    await sql.close();
  }
}

let ADMIN;
let READ_ONLY;

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const hasBody = !['GET', 'HEAD'].includes(method) && body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => null);
  return { status: res.status, data };
}

// HTTPS probe (self-signed cert — accepted for the local regression test).
function httpsGet(path) {
  return new Promise((resolve) => {
    const r = https.get(
      { host: '127.0.0.1', port: HTTPS_PORT, path, rejectUnauthorized: false, timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    r.on('error', () => resolve(0));
    r.on('timeout', () => { r.destroy(); resolve(0); });
  });
}

// ---- boot -------------------------------------------------------------------
// Resolve two free ports first (bind 0 probes skip Windows-reserved ranges),
// then boot the isolated server on them.
async function boot() {
  try {
    const [p1, p2] = await Promise.all([findFreePort(), findFreePort()]);
    if (p1 && p2 && p1 !== p2) {
      HTTP_PORT = p1;
      HTTPS_PORT = p2;
      BASE = `http://127.0.0.1:${HTTP_PORT}`;
    }
  } catch { /* keep legacy fixed ports */ }
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(HTTP_PORT), HTTPS_PORT: String(HTTPS_PORT), SERVER_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
}

async function waitReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/settings`);
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  return false;
}

// State for CRUD cleanup.
const created = { edicts: [], tasks: [] };

async function cleanup() {
  for (const id of created.tasks) {
    await fetch(`${BASE}/api/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } }).catch(() => {});
  }
  for (const id of created.edicts) {
    await fetch(`${BASE}/api/edicts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } }).catch(() => {});
  }
}

// ---- tests ------------------------------------------------------------------
async function run() {
  // 1) Public / static -------------------------------------------------------
  await check('GET / serves the dashboard HTML', async () => {
    const r = await req('GET', '/');
    ok('GET / serves the dashboard HTML', r.status === 200 && /html/i.test(String(r.data || '')), `status ${r.status}`);
  });
  await check('GET /css/main.css is 200', async () => {
    const r = await req('GET', '/css/main.css');
    ok('GET /css/main.css is 200', r.status === 200);
  });
  await check('GET /js/main.js is 200', async () => {
    const r = await req('GET', '/js/main.js');
    ok('GET /js/main.js is 200', r.status === 200);
  });
  await check('GET /pages/index.html is 200', async () => {
    const r = await req('GET', '/pages/index.html');
    ok('GET /pages/index.html is 200', r.status === 200);
  });

  // 2) Public API ------------------------------------------------------------
  await check('GET /api/settings -> 200 + resourcesDir', async () => {
    const r = await req('GET', '/api/settings');
    ok('GET /api/settings -> 200', r.status === 200, `status ${r.status}`);
    ok('settings contains resourcesDir', !!r.data && typeof r.data.resourcesDir === 'string', JSON.stringify(r.data));
  });
  await check('GET /api/health -> 200 + ok', async () => {
    const r = await req('GET', '/api/health');
    ok('GET /api/health -> 200', r.status === 200, `status ${r.status}`);
    ok('health.status === ok', r.data && r.data.status === 'ok', JSON.stringify(r.data));
    ok('health has uptime + checkedAt', r.data && typeof r.data.uptime === 'number' && !!r.data.checkedAt);
  });
  await check('GET /api/edicts -> array', async () => {
    const r = await req('GET', '/api/edicts');
    ok('GET /api/edicts -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('GET /api/edicts/unfinished -> array', async () => {
    const r = await req('GET', '/api/edicts/unfinished');
    ok('GET /api/edicts/unfinished -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('GET /api/edicts/trends -> 200', async () => {
    const r = await req('GET', '/api/edicts/trends');
    ok('GET /api/edicts/trends -> 200', r.status === 200);
  });
  await check('GET /api/edicts/999999 -> 404', async () => {
    const r = await req('GET', '/api/edicts/999999');
    ok('GET /api/edicts/999999 -> 404', r.status === 404, `status ${r.status}`);
  });
  await check('GET /api/tasks -> array', async () => {
    const r = await req('GET', '/api/tasks');
    ok('GET /api/tasks -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('GET /api/tasks/edict/18 -> array', async () => {
    const r = await req('GET', '/api/tasks/edict/18');
    ok('GET /api/tasks/edict/18 -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('GET /api/resources -> array', async () => {
    const r = await req('GET', '/api/resources');
    ok('GET /api/resources -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('GET /api/resources/edict/18 -> array', async () => {
    const r = await req('GET', '/api/resources/edict/18');
    ok('GET /api/resources/edict/18 -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('GET /api/audit-logs -> array', async () => {
    const r = await req('GET', '/api/audit-logs');
    ok('GET /api/audit-logs -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('GET /api/services -> array (public)', async () => {
    const r = await req('GET', '/api/services');
    ok('GET /api/services -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('POST /api/users/register empty -> 400', async () => {
    const r = await req('POST', '/api/users/register', { body: {} });
    ok('POST /api/users/register empty -> 400', r.status === 400, `status ${r.status}`);
  });
  await check('GET /api/does-not-exist -> 404', async () => {
    const r = await req('GET', '/api/does-not-exist');
    ok('GET /api/does-not-exist -> 404', r.status === 404, `status ${r.status}`);
  });
  await check('PUT /api/health (wrong method) -> 404', async () => {
    const r = await req('PUT', '/api/health', { body: {} });
    ok('PUT /api/health -> 404', r.status === 404, `status ${r.status}`);
  });

  // 3) HTTPS listener ----------------------------------------------------------
  await check('HTTPS GET /api/settings -> 200', async () => {
    const code = await httpsGet('/api/settings');
    ok('HTTPS GET /api/settings -> 200', code === 200, `status ${code}`);
  });

  // 4) Auth-negative: 401 without a token --------------------------------------
  const protectedEndpoints = [
    ['POST', '/api/edicts'], ['PUT', '/api/edicts/1'], ['DELETE', '/api/edicts/1'],
    ['POST', '/api/tasks'], ['PUT', '/api/tasks/1'], ['PUT', '/api/tasks/reorder'], ['DELETE', '/api/tasks/1'],
    ['POST', '/api/resources'], ['POST', '/api/resources/attach'], ['PUT', '/api/resources/1'], ['PUT', '/api/resources/reorder'], ['DELETE', '/api/resources/1'],
    ['GET', '/api/ips/check'], ['GET', '/api/ips/hosts'], ['POST', '/api/ips/hosts'], ['PUT', '/api/ips/hosts/1'], ['DELETE', '/api/ips/hosts/1'],
    ['POST', '/api/services'], ['PUT', '/api/services/1'], ['DELETE', '/api/services/1'],
    ['PUT', '/api/users/1'], ['DELETE', '/api/users/1'], ['GET', '/api/users/me'], ['GET', '/api/users'], ['GET', '/api/users/roles'], ['PUT', '/api/users/1/role'],
    ['GET', '/api/mcp/status'], ['POST', '/api/mcp/start'], ['POST', '/api/mcp/stop'],
    ['GET', '/api/servers'], ['GET', '/api/servers/mcp'], ['POST', '/api/servers/mcp/start'],
    ['PUT', '/api/settings'], ['GET', '/api/logs'],
  ];
  for (const [m, p] of protectedEndpoints) {
    await check(`${m} ${p} without token -> 401`, async () => {
      const r = await req(m, p, { body: {} });
      ok(`${m} ${p} without token -> 401`, r.status === 401, `status ${r.status}`);
    });
  }

  // 5) Permission-negative: 403 for non-admin -----------------------------------
  await check('PUT /api/settings with read-only token -> 403', async () => {
    const r = await req('PUT', '/api/settings', { token: READ_ONLY, body: { resourcesDir: 'public/resources' } });
    ok('PUT /api/settings read-only -> 403', r.status === 403, `status ${r.status}`);
  });
  await check('GET /api/users with read-only token -> 403', async () => {
    const r = await req('GET', '/api/users', { token: READ_ONLY });
    ok('GET /api/users read-only -> 403', r.status === 403, `status ${r.status}`);
  });
  await check('POST /api/edicts with read-only token -> 403', async () => {
    const r = await req('POST', '/api/edicts', { token: READ_ONLY, body: { name: 'x' } });
    ok('POST /api/edicts read-only -> 403', r.status === 403, `status ${r.status}`);
  });

  // 6) Edicts CRUD round-trip ----------------------------------------------------
  const edictName = `SMOKE-EDICT-${Date.now()}`;
  let edictId = null;
  await check('Edicts: create', async () => {
    const r = await req('POST', '/api/edicts', {
      token: ADMIN,
      body: { name: edictName, plannedStart: new Date().toISOString(), plannedEnd: null, priority: 2, state: 1, info: 'smoke' },
    });
    ok('Edicts: create -> 200 + id', r.status === 200 && Number.isInteger(r.data?.id), `status ${r.status} ${JSON.stringify(r.data)}`);
    edictId = r.data?.id ?? null;
    if (edictId) created.edicts.push(edictId);
  });
  await check('Edicts: create without name -> 400', async () => {
    const r = await req('POST', '/api/edicts', { token: ADMIN, body: { plannedStart: new Date().toISOString() } });
    ok('Edicts: create without name -> 400', r.status === 400, `status ${r.status}`);
  });
  await check('Edicts: create with bad date -> 400', async () => {
    const r = await req('POST', '/api/edicts', { token: ADMIN, body: { name: 'bad', plannedStart: 'not-a-date' } });
    ok('Edicts: create with bad date -> 400', r.status === 400, `status ${r.status}`);
  });
  await check('Edicts: get created -> 200 + name match', async () => {
    if (!edictId) return ok('Edicts: get created -> 200 + name match', false, 'no id');
    const r = await req('GET', `/api/edicts/${edictId}`);
    ok('Edicts: get created -> 200', r.status === 200, `status ${r.status}`);
    ok('Edicts: created name matches', r.data && r.data.name === edictName, JSON.stringify(r.data));
  });
  await check('Edicts: update created -> 200', async () => {
    if (!edictId) return ok('Edicts: update created -> 200', false, 'no id');
    const r = await req('PUT', `/api/edicts/${edictId}`, {
      token: ADMIN,
      body: { name: edictName + '-UPD', plannedStart: new Date().toISOString(), plannedEnd: null, priority: 1, state: 1, info: 'updated' },
    });
    ok('Edicts: update created -> 200', r.status === 200, `status ${r.status}`);
  });
  await check('Edicts: list contains created', async () => {
    if (!edictId) return ok('Edicts: list contains created', false, 'no id');
    const r = await req('GET', '/api/edicts');
    ok('Edicts: list contains created', r.status === 200 && r.data.some((e) => e.id === edictId), `status ${r.status}`);
  });

  // 7) Tasks CRUD round-trip (runs BEFORE the temp edict is deleted below) --------
  let taskId = null;
  await check('Tasks: create on temp edict', async () => {
    if (!edictId) return ok('Tasks: create on temp edict', false, 'edict deleted already');
    const r = await req('POST', '/api/tasks', {
      token: ADMIN,
      body: { name: 'SMOKE-TASK', edictId, plannedStart: new Date().toISOString(), plannedEnd: null, priority: 1, state: 1, info: 'smoke' },
    });
    ok('Tasks: create -> 200', r.status === 200, `status ${r.status}`);
    const list = await req('GET', `/api/tasks/edict/${edictId}`);
    const found = (list.data || []).find((t) => t.name === 'SMOKE-TASK');
    ok('Tasks: create appears in edict list', !!found, JSON.stringify(list.data));
    taskId = found?.id ?? null;
    if (taskId) created.tasks.push(taskId);
  });
  await check('Tasks: get created -> 200', async () => {
    if (!taskId) return ok('Tasks: get created -> 200', false, 'no id');
    const r = await req('GET', `/api/tasks/${taskId}`);
    ok('Tasks: get created -> 200', r.status === 200 && r.data?.name === 'SMOKE-TASK', `status ${r.status}`);
  });
  await check('Tasks: update created -> 200', async () => {
    if (!taskId) return ok('Tasks: update created -> 200', false, 'no id');
    const r = await req('PUT', `/api/tasks/${taskId}`, {
      token: ADMIN,
      body: { name: 'SMOKE-TASK-UPD', edictId, plannedStart: new Date().toISOString(), plannedEnd: null, priority: 1, state: 1, info: 'upd' },
    });
    ok('Tasks: update created -> 200', r.status === 200, `status ${r.status}`);
  });
  await check('Tasks: delete created -> 200', async () => {
    if (!taskId) return ok('Tasks: delete created -> 200', false, 'no id');
    const r = await req('DELETE', `/api/tasks/${taskId}`, { token: ADMIN });
    ok('Tasks: delete created -> 200', r.status === 200, `status ${r.status}`);
    created.tasks = created.tasks.filter((id) => id !== taskId);
  });
  await check('Tasks: get deleted -> 404', async () => {
    if (!taskId) return ok('Tasks: get deleted -> 404', false, 'no id');
    const r = await req('GET', `/api/tasks/${taskId}`);
    ok('Tasks: get deleted -> 404', r.status === 404, `status ${r.status}`);
  });

  // 8) Edicts: delete the temp edict (now that its tasks are gone) ----------------
  await check('Edicts: delete created -> 200', async () => {
    if (!edictId) return ok('Edicts: delete created -> 200', false, 'no id');
    const r = await req('DELETE', `/api/edicts/${edictId}`, { token: ADMIN });
    ok('Edicts: delete created -> 200', r.status === 200, `status ${r.status}`);
    created.edicts = created.edicts.filter((id) => id !== edictId);
  });
  await check('Edicts: get deleted -> 404', async () => {
    if (!edictId) return ok('Edicts: get deleted -> 404', false, 'no id');
    const r = await req('GET', `/api/edicts/${edictId}`);
    ok('Edicts: get deleted -> 404', r.status === 404, `status ${r.status}`);
  });
  await check('Edicts: delete missing -> 200 (idempotent)', async () => {
    const r = await req('DELETE', '/api/edicts/999999', { token: ADMIN });
    ok('Edicts: delete missing -> 200 (idempotent)', r.status === 200, `status ${r.status}`);
  });

  // 9) Resources ---------------------------------------------------------------
  await check('Resources: POST without file -> 400', async () => {
    const r = await req('POST', '/api/resources', { token: ADMIN, body: { edictId: 18, description: 'x' } });
    ok('Resources: POST without file -> 400', r.status === 400, `status ${r.status}`);
  });
  await check('Resources: GET /api/resources -> array (admin)', async () => {
    const r = await req('GET', '/api/resources', { token: ADMIN });
    ok('Resources: GET -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });

  // 9) Users ---------------------------------------------------------------------
  await check('Users: GET /api/users/me -> 200 (admin)', async () => {
    const r = await req('GET', '/api/users/me', { token: ADMIN });
    ok('Users: /me -> 200', r.status === 200, `status ${r.status}`);
    ok('Users: /me has userID 1', r.data && (r.data.userID === 1 || r.data.id === 1), JSON.stringify(r.data));
  });
  await check('Users: GET /api/users -> 200 + array (admin)', async () => {
    const r = await req('GET', '/api/users', { token: ADMIN });
    ok('Users: list -> 200 + array', r.status === 200 && Array.isArray(r.data?.users), `status ${r.status} ${JSON.stringify(r.data)}`);
  });
  await check('Users: GET /api/users/roles -> 200 (admin)', async () => {
    const r = await req('GET', '/api/users/roles', { token: ADMIN });
    ok('Users: roles -> 200', r.status === 200, `status ${r.status}`);
  });
  await check('Users: PUT self with empty body -> 400 (validation)', async () => {
    const me = await req('GET', '/api/users/me', { token: ADMIN });
    const id = me.data?.userID ?? me.data?.id ?? 1;
    const r = await req('PUT', `/api/users/${id}`, { token: ADMIN, body: {} });
    ok('Users: PUT self empty body -> 400', r.status === 400, `status ${r.status}`);
  });

  // 10) Logs (#58) ----------------------------------------------------------------
  await check('Logs: GET /api/logs -> 200 + array (admin)', async () => {
    const r = await req('GET', '/api/logs', { token: ADMIN });
    ok('Logs: GET -> 200 + array', r.status === 200 && Array.isArray(r.data), `status ${r.status}`);
  });
  await check('Logs: rows carry source + label', async () => {
    const r = await req('GET', '/api/logs?limit=20', { token: ADMIN });
    const rows = r.data || [];
    ok('Logs: rows carry source + label', rows.every((x) => x.source && x.method && x.path), JSON.stringify(rows[0]));
  });
  await check('Logs: filter source=dashboard', async () => {
    const r = await req('GET', '/api/logs?source=dashboard&limit=50', { token: ADMIN });
    ok('Logs: source=dashboard -> array', Array.isArray(r.data), `status ${r.status}`);
    ok('Logs: all rows source === dashboard', (r.data || []).every((x) => x.source === 'dashboard'));
  });
  await check('Logs: filter source=fileserver', async () => {
    const r = await req('GET', '/api/logs?source=fileserver&limit=50', { token: ADMIN });
    ok('Logs: source=fileserver -> array', Array.isArray(r.data), `status ${r.status}`);
    ok('Logs: all rows source === fileserver', (r.data || []).every((x) => x.source === 'fileserver'));
  });

  // 11) Settings PUT round-trip -----------------------------------------------------
  await check('Settings: PUT resourcesDir round-trip', async () => {
    const before = await req('GET', '/api/settings');
    const dir = before.data?.resourcesDir || 'public/resources';
    const r = await req('PUT', '/api/settings', { token: ADMIN, body: { resourcesDir: dir } });
    ok('Settings: PUT -> 200', r.status === 200, `status ${r.status}`);
    ok('Settings: PUT preserved resourcesDir', r.data?.resourcesDir === dir, JSON.stringify(r.data));
  });

  // 12) MCP + Servers (admin) ---------------------------------------------------------
  await check('MCP: GET /api/mcp/status -> 200 (admin)', async () => {
    const r = await req('GET', '/api/mcp/status', { token: ADMIN });
    ok('MCP: status -> 200', r.status === 200, `status ${r.status}`);
  });
  await check('Servers: GET /api/servers -> 200 + array (admin)', async () => {
    const r = await req('GET', '/api/servers', { token: ADMIN });
    ok('Servers: list -> 200 + array', r.status === 200 && Array.isArray(r.data?.servers), `status ${r.status} ${JSON.stringify(r.data)}`);
  });

  // 13) File-based session log (#58) ---------------------------------------------------
  await check('Session log active file exists on disk', async () => {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(__dirname, '..', 'logs', `active-api.dashboard.${HTTP_PORT}.log`);
    ok('Session log active file exists on disk', fs.existsSync(f), f);
  });

  console.log('');
  console.log(`Regression suite: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  -', f));
  }
  process.exitCode = failed ? 1 : 0;
}

(async () => {
  await boot();
  let ready = false;
  try {
    ready = await waitReady();
  } catch { /* ignore */ }
  if (!ready) {
    console.error('FATAL: test server did not become ready on', BASE);
    process.exitCode = 1;
    if (child) child.kill();
    return;
  }
  try {
    const v = await currentTokenVersion();
    ADMIN = mint(ADMIN_PERMS, v);
    READ_ONLY = mint(['files.read'], v);
    await run();
  } catch (err) {
    console.error('Test run failed:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    if (child) child.kill();
  }
})();
