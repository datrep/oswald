// trading/scripts/repro/set-parity-gate.js — flip learning.parityValidated, which
// is the switch that releases FULL size on the live desk (and live-desk tuning).
//
// WHY THIS MATTERS (report S4): while the notional cap binds, realized risk per
// trade = maxEquityPerPositionPct x stopDistance% and `riskPerTradePct` is inert.
// `runInFactor` is the OTHER half of that product:
//
//     parityValidated true  -> runInFactor 1   -> size x1
//     parityValidated false -> runInFactor 0.5 -> size x0.5  (and the tuner
//                                                 refuses to touch the live desk)
//
// So this is a one-setting, no-code-change, instantly-reversible step-down of live
// exposure: with maxEquityPerPositionPct 40, setting this false makes the EFFECTIVE
// cap 20%. Nothing else about the desk changes.
//
// It is a mitigation for S4, not a fix: the flag is a manual assertion (nothing in
// the codebase writes it), and the automated evidence that should support it
// (`analytics.parityCheck`) has never evaluated a named strategy — its only subject
// has been the 'unknown' bucket, which its retirement loop is hard-coded to skip.
//
// Usage (run from the repo root):
//   node trading/scripts/repro/set-parity-gate.js false   # half size + no live tuning
//   node trading/scripts/repro/set-parity-gate.js true    # full size (needs evidence)
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const WANT = String(process.argv[2] || '').toLowerCase();
if (WANT !== 'true' && WANT !== 'false') {
  console.error('usage: node trading/scripts/repro/set-parity-gate.js <true|false>');
  process.exit(2);
}
const VALUE = WANT === 'true';

const call = (method, path, token, body) => new Promise((resolve, reject) => {
  const u = new URL('https://172.22.160.3:8114' + path);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 60000,
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

  const before = JSON.parse((await call('GET', '/api/trading/settings', token)).body);
  console.log('before: parityValidated =', before.learning && before.learning.parityValidated);

  const r = await call('PUT', '/api/trading/settings', token, { learning: { parityValidated: VALUE } });
  if (r.status !== 200) { console.error('HTTP', r.status, r.body.slice(0, 300)); process.exit(1); }

  const after = JSON.parse(r.body);
  const risk = after.risk || {};
  const factor = VALUE ? 1 : 0.5;
  console.log('after:  parityValidated =', after.learning && after.learning.parityValidated);
  console.log(`  runInFactor ${factor} -> effective per-position cap ${(Number(risk.maxEquityPerPositionPct) * factor).toFixed(1)}% of equity`);
  console.log(`  live-desk tuning: ${VALUE ? 'ALLOWED' : 'BLOCKED (tuner requires parityValidated on a live desk)'}`);
  console.log(`  total exposure cap ${(Number(risk.exposureCapPct) * factor).toFixed(1)}% (from ${risk.exposureCapPct}%)`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
