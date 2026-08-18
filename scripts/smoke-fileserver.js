'use strict';
// Fileserver integration suite — boots the fileserver alone (HTTP, TLS off) on a
// free port, mints an admin JWT (shared JWT_SECRET + DB tokenVersion), and checks
// the /api/fs read surface + auth gating.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const sql = require('mssql');
const { getPool } = require('../config/db');

const ROOT = path.join(__dirname, '..');

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

function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

const ADMIN_PERMS = [
  'files.admin', 'files.read', 'files.write', 'mcp.manage', 'monitoring.manage',
  'policies.manage', 'resources.manage', 'services.manage', 'tasks.manage', 'users.manage',
];

function mint(perms, v) {
  return jwt.sign({ userID: 1, roles: ['admin'], permissions: perms, v }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function currentTokenVersion() {
  const pool = await getPool();
  try {
    const r = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
    return r.recordset[0]?.tokenVersion ?? 0;
  } finally {
    await sql.close();
  }
}

let BASE;
let child;

async function req(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => null);
  return { status: res.status, data };
}

async function waitReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/fs/config`);
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const FS_PORT = await findFreePort();
  BASE = `http://127.0.0.1:${FS_PORT}`;

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oswald-fs-smoke-'));
  fs.writeFileSync(path.join(testRoot, 'hello.txt'), 'hello world');

  child = spawn(process.execPath, [path.join(ROOT, 'fileserver', 'server.js')], {
    env: {
      ...process.env,
      FILESERVER_PORT: String(FS_PORT),
      FILESERVER_HOST: '127.0.0.1',
      FILESERVER_TLS: '0',
      FILESERVER_ROOT_PATH: testRoot,
      FILESERVER_ROOT_ID: 'resources',
      FILESERVER_ROOT_NAME: 'Resources',
    },
    stdio: 'ignore',
  });

  if (!(await waitReady())) {
    console.error('FATAL: fileserver did not become ready on', BASE);
    process.exitCode = 1;
    child.kill();
    return;
  }

  try {
    const v = await currentTokenVersion();
    const ADMIN = mint(ADMIN_PERMS, v);
    const section = (title) => console.log(`\n== ${title} ==`);

    section('Public config');
    await check('GET /api/fs/config -> 200', async () => {
      const r = await req('GET', '/api/fs/config');
      ok('config -> 200 + allowSignup', r.status === 200 && typeof r.data?.allowSignup === 'boolean', `status ${r.status} ${JSON.stringify(r.data)}`);
    });

    section('Auth gating');
    await check('GET /api/fs/roots without token -> 401', async () => {
      const r = await req('GET', '/api/fs/roots');
      ok('roots no token -> 401', r.status === 401, `status ${r.status}`);
    });

    section('Filesystem read');
    await check('GET /api/fs/roots -> 200', async () => {
      const r = await req('GET', '/api/fs/roots', { token: ADMIN });
      ok('roots -> 200 + array', r.status === 200 && Array.isArray(r.data?.roots), `status ${r.status} ${JSON.stringify(r.data)}`);
    });
    await check('GET /api/fs/list -> 200', async () => {
      const r = await req('GET', '/api/fs/list?root=resources', { token: ADMIN });
      ok('list -> 200', r.status === 200 && typeof r.data === 'object', `status ${r.status}`);
    });
    await check('GET /api/fs/download -> 200 + content', async () => {
      const r = await req('GET', '/api/fs/download?root=resources&path=hello.txt', { token: ADMIN });
      ok('download -> 200 + hello', r.status === 200 && String(r.data).includes('hello'), `status ${r.status} ${JSON.stringify(r.data)}`);
    });
    await check('GET /api/fs/search -> 200', async () => {
      const r = await req('GET', '/api/fs/search?root=resources&q=hello', { token: ADMIN });
      ok('search -> 200', r.status === 200 && typeof r.data === 'object', `status ${r.status}`);
    });

    section('Metadata + admin');
    await check('GET /api/fs/favorites -> 200', async () => {
      const r = await req('GET', '/api/fs/favorites', { token: ADMIN });
      ok('favorites -> 200 + array', r.status === 200 && Array.isArray(r.data?.favorites), `status ${r.status}`);
    });
    await check('GET /api/fs/users -> 200 (admin)', async () => {
      const r = await req('GET', '/api/fs/users', { token: ADMIN });
      ok('users -> 200 + array', r.status === 200 && Array.isArray(r.data?.users), `status ${r.status} ${JSON.stringify(r.data)}`);
    });
    await check('POST /api/fs/tags without tag -> 400', async () => {
      const r = await req('POST', '/api/fs/tags', { token: ADMIN, body: {} });
      ok('tags missing -> 400', r.status === 400, `status ${r.status}`);
    });
  } catch (err) {
    console.error('Test run failed:', err.message);
    process.exitCode = 1;
  } finally {
    child.kill();
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('');
  console.log(`Fileserver suite: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed) failures.forEach((f) => console.log('  -', f));
  process.exitCode = failed ? 1 : 0;
})();
