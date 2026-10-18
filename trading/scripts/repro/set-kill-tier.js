// trading/scripts/repro/set-kill-tier.js — set the kill tier via the app's own
// endpoint (POST /api/trading/kill), so the resulting state is exactly what a
// dashboard action produces.
//
// The kill tier is NEVER auto-cleared (fail-secure by design), so this is a
// deliberate human action, never a side effect of anything else.
//
//   off  — full management restored (entries allowed, subject to every other gate)
//   soft — documented posture for maintenance windows
//   hard — freezes management entirely: wakes and position reviews stand down, and
//          open positions are protected ONLY by the venue-native SL/TP attached at
//          entry. With `autoClose` it also closes the book.
//
// Usage (from the repo root):
//   node trading/scripts/repro/set-kill-tier.js off
//   node trading/scripts/repro/set-kill-tier.js off "resume before Sunday open"
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const TIER = String(process.argv[2] || '').toLowerCase();
const REASON = process.argv[3] ? String(process.argv[3]).slice(0, 200) : 'repro script';
if (!['off', 'soft', 'hard'].includes(TIER)) {
  console.error('usage: node trading/scripts/repro/set-kill-tier.js <off|soft|hard> [reason]');
  process.exit(2);
}

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

  const r0 = await call('GET', '/api/trading/kill', token);
  console.log('before:', r0.body.slice(0, 220));

  // open positions matter: a hard tier with autoClose closes the book, so say so.
  const open = (await pool.request().query(
    `SELECT COUNT(*) AS n FROM Trades WHERE status NOT IN ('closed','rejected') OR (status='closed' AND grossPnl IS NULL)`,
  )).recordset[0].n;
  console.log(`open/unresolved positions: ${open}`);

  const r = await call('POST', '/api/trading/kill', token, { tier: TIER, reason: REASON, autoClose: TIER === 'hard', alert: TIER !== 'off' });
  if (r.status !== 200) { console.error('HTTP', r.status, r.body.slice(0, 300)); process.exit(1); }
  console.log(`after:  tier=${TIER} reason="${REASON}"`);
  console.log(r.body.slice(0, 220));
  console.log(TIER === 'off'
    ? 'kill OFF — entries allowed again, subject to every other gate (parity run-in halves size).'
    : 'kill NOT off — management is gated.');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
