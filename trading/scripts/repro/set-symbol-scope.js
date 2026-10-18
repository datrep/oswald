// trading/scripts/repro/set-symbol-scope.js — set which strategies a symbol may trade.
//
// WHY A SCRIPT AND NOT A HAND EDIT. `strategies.symbolScope` decides which strategies a symbol is even
// EVALUATED with, and `quant.scopedStrategyIds` resolves an explicit entry FIRST (explicit > DEFAULT key
// `others`/`*` > the global enabled list). So one wrong value silently changes what the desk may trade on
// an instrument - and the effect is invisible until a wake either proposes something or does not.
//
// This sends the WHOLE `symbolScope` object, not just the edited key, so a deep-merging PUT cannot leave a
// half-applied map behind, and it re-reads the settings afterwards to verify what actually landed.
//
// Scope is NOT the same as reachability. A strategy can be in scope and still never fire because its own
// gate is closed, or - for the mean-reversion family - because the DESK-GLOBAL meta regime (derived in
// `meta.js` from the FIRST watchlist symbol that has bars) says `trend`. Scope is the permission; the
// gates are the conditions.
//
// Usage (run from the repo root):
//   node trading/scripts/repro/set-symbol-scope.js "Silver" meanrev
//   node trading/scripts/repro/set-symbol-scope.js "Silver" macd meanrev
//   node trading/scripts/repro/set-symbol-scope.js "Silver"                 # clear (no strategies)
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const SYMBOL = process.argv[2];
const IDS = process.argv.slice(3).map((s) => String(s).trim()).filter(Boolean);
if (!SYMBOL) {
  console.error('usage: node trading/scripts/repro/set-symbol-scope.js "<Symbol>" [strategyId ...]');
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

  const before = JSON.parse((await call('GET', '/api/trading/settings', token)).body);
  const scope = { ...((before.strategies || {}).symbolScope || {}) };
  console.log('enabled (global):', JSON.stringify((before.strategies || {}).enabled || []));
  console.log('scope BEFORE   :', JSON.stringify(scope));
  console.log('  ' + SYMBOL + ' ->', JSON.stringify(scope[SYMBOL] ?? null));

  // The whole map is sent so every key is stated explicitly and a merge cannot half-apply it.
  scope[SYMBOL] = IDS;
  const put = await call('PUT', '/api/trading/settings', token, { strategies: { symbolScope: scope } });
  if (put.status !== 200) {
    console.error('PUT failed', put.status, put.body);
    process.exit(1);
  }

  // VERIFY what the desk now holds - a settings write that "succeeded" is not the same as applied.
  const after = JSON.parse((await call('GET', '/api/trading/settings', token)).body);
  const now = (after.strategies || {}).symbolScope || {};
  console.log('scope AFTER    :', JSON.stringify(now));
  console.log('  ' + SYMBOL + ' ->', JSON.stringify(now[SYMBOL] ?? null));
  const ok = JSON.stringify(now[SYMBOL] ?? null) === JSON.stringify(IDS);
  console.log(ok ? 'VERIFIED: the scope read back exactly as written.' : 'MISMATCH: the desk did NOT store what was sent.');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
