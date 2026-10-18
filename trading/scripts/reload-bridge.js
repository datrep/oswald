// trading/scripts/reload-bridge.js — TRD-46: reload the shared Plus500 tab.
//
//   node trading/scripts/reload-bridge.js            # dry run: report the plan + memory, touch nothing
//   node trading/scripts/reload-bridge.js --apply    # do it
//   node trading/scripts/reload-bridge.js --memory   # read-only footprint, no reload
//
// GOES THROUGH THE API ON PURPOSE. `pageLock` is in-process state, so a reload issued from THIS
// process would take no lock and could land in the middle of a venue SL/TP card being set. Posting to
// the desk means the reload is coordinated with the desk's own flows by the only lock that exists.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../shared/db');

const USER = Number(process.env.TRADING_SCRIPT_USER) || 1;
const BASE = process.env.TRADING_API_BASE || 'https://172.22.160.3:8114';
// The desk's cert is self-signed (an https.Agent is REQUIRED here — undici's fetch silently ignores
// one, which is why this file uses node:https).
const agent = new https.Agent({ rejectUnauthorized: false });

function call(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(`${BASE}${p}`, {
      method, agent,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch { /* non-JSON error body */ }
        resolve({ status: res.statusCode, body: parsed, text: d });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const mb = (m) => (m && Number.isFinite(m.privateMb) ? `${m.privateMb} MB private / ${m.workingSetMb} MB working across ${m.processes} procs (largest ${m.largestMb} MB)` : 'unavailable');

(async () => {
  const apply = process.argv.includes('--apply');
  const memoryOnly = process.argv.includes('--memory');

  const pool = await getPool();
  const r = await pool.request().query(`SELECT tokenVersion FROM Users WHERE id = ${USER}`);
  const v = Number(r.recordset[0] && r.recordset[0].tokenVersion) || 0;
  const token = jwt.sign({ userID: USER, roles: ['admin'], permissions: ['services.manage'], v }, process.env.JWT_SECRET, { expiresIn: '10m' });

  if (memoryOnly) {
    const res = await call('GET', '/api/trading/bridge/memory', token);
    console.log(res.status === 200 ? mb(res.body) : `HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    process.exit(0);
  }

  console.log(`=== bridge maintenance reload (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  const res = await call('POST', `/api/trading/bridge/maintenance-reload${apply ? '' : '?dryRun=1'}`, token, {
    reason: process.argv.includes('--reason') ? process.argv[process.argv.indexOf('--reason') + 1] : 'cli',
    waitMs: 180000,
  });
  if (res.status !== 200) {
    console.log(`HTTP ${res.status}: ${res.text.slice(0, 400)}`);
    process.exit(1);
  }
  const x = res.body || {};
  if (x.skipped) {
    console.log(`SKIPPED (${x.skipped})${x.heldBy ? ` — bridge held by ${x.heldBy}` : ''}`);
    console.log('Nothing was touched. Ask again when the desk is idle.');
    process.exit(0);
  }
  if (x.dryRun) {
    console.log(`url          : ${x.urlBefore}`);
    console.log(`memory before: ${mb(x.before)}`);
    console.log('dry run — nothing was reloaded');
    process.exit(0);
  }
  console.log(`url          : ${x.urlBefore} -> ${x.urlAfter}`);
  console.log(`memory before: ${mb(x.before)}`);
  console.log(`memory after : ${mb(x.after)}`);
  console.log(`reclaimed    : ${x.reclaimedMb == null ? 'unknown' : x.reclaimedMb + ' MB'}`);
  console.log(`reloaded in  : ${x.reloadMs} ms · settled=${x.settled} (${x.bodyChars} chars in ${x.waitedMs} ms) · loggedIn=${x.loggedIn}`);
  if (x.reloadError) console.log(`reload error : ${x.reloadError}`);
  console.log(x.ok ? 'OK — the shared tab was reloaded in place.' : 'NOT OK — see above; the tab may need a human look.');
  process.exit(x.ok ? 0 : 1);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
