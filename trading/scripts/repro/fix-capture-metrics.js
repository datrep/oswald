// trading/scripts/repro/fix-capture-metrics.js — force a recompute of MFE/MAE/
// holding/slippage for every closed trade (report S2).
//
// Needed once because of three defects in autopsy.computeMetrics, all fixed
// 2026-09-12: MFE/MAE were SWAPPED for every short (a short's best price is the
// LOW), the tick window ran past the close (so a trade that never went our way
// looked like it "had 0.45% available"), and the sampled peak under-read the
// achieved move. Recomputing with `force` repairs rows written by the old code.
//
// Usage (run from the repo root):
//   node trading/scripts/repro/fix-capture-metrics.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const post = (path, token, body) => new Promise((resolve, reject) => {
  const u = new URL('https://172.22.160.3:8114' + path);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
    rejectUnauthorized: false, timeout: 240000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

(async () => {
  const pool = await getPool();
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  const r = await post('/api/trading/autopsy/backfill', token, { limit: 200, force: true });
  console.log('HTTP', r.status, r.body.slice(0, 400));
  process.exit(r.status === 200 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
