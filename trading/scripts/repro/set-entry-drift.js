// trading/scripts/repro/set-entry-drift.js — switch TRD-EXE-13 ON (or OFF), predicting first.
//
// ONE KEY, and the house rule applies: predict the consequence, apply, then verify every other key held.
//
// WHAT IT DOES. `risk.entryDriftFactor` multiplies into the same `expectedLossDist` the sizing already divides by,
// alongside the exit-side `stopSlippageFactor`. Above 1 it SHRINKS sizes, because the denominator grows.
//
//   node trading/scripts/repro/set-entry-drift.js          # dry run, prints the prediction
//   node trading/scripts/repro/set-entry-drift.js --yes     # apply the measured 1.083
//   node trading/scripts/repro/set-entry-drift.js --yes --value 1   # roll back to inert
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const YES = process.argv.includes('--yes');
const vi = process.argv.indexOf('--value');
const WANT = vi >= 0 ? Number(process.argv[vi + 1]) : 1.083; // the measured mean over 73 entries
const WARN = '\u26A0';
const CHECK = '\u2714';

const call = (method, path, token, body) => new Promise((resolve, reject) => {
  const u = new URL('https://172.22.160.3:8114' + path);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 60000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});
const fail = (m) => { console.error(`\n${WARN} REFUSING: ${m}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const uv = await q('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign({ userID: 1, roles: ['admin'], permissions: ['services.manage'],
    v: uv[0]?.tokenVersion ?? 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const get = async () => JSON.parse((await call('GET', '/api/trading/settings', token)).body);

  const before = (await get()).risk || {};
  const now = Number(before.entryDriftFactor ?? 1);
  console.log('=== set risk.entryDriftFactor ===\n');
  console.log(`1. the change: entryDriftFactor ${now} -> ${WANT}`);
  if (!(WANT >= 1)) fail(`a factor below 1 asserts entries fill BETTER than the decision price, which 54 of 73 measured rows disprove (mean 1.083)`);
  if (now === WANT) { console.log('   already there. Nothing to do.'); await pool.close(); return; }

  console.log('\n2. what it means');
  console.log(`   sizes shrink by 1/${WANT} = ${((1 - 1 / WANT) * 100).toFixed(1)}% versus the dial alone, because the`);
  console.log('   sizing denominator becomes riskStopDist x stopSlippageFactor x entryDriftFactor.');
  console.log(`   Measured basis, 73 entry_reanchored events: 74% of entries fill ADVERSE to the decision`);
  console.log(`   price; realised/sized stop distance averages 1.083x (min 0.486, max 2.518).`);
  console.log(`   ⚠ It COMPOUNDS with the currency correction: the cap now binds at ${before.maxEquityPerPositionPct ?? '?'}% literally`);
  console.log('   instead of that value x fx. The stop LEVEL is untouched.');

  if (!YES) { console.log('\n3. DRY RUN — nothing written. Re-run with --yes to apply.'); await pool.close(); return; }

  console.log('\n3. applying...');
  const r = await call('PUT', '/api/trading/settings', token, { risk: { entryDriftFactor: WANT } });
  if (r.status !== 200) fail(`PUT returned ${r.status}: ${String(r.body).slice(0, 300)}`);

  const after = (await get()).risk || {};
  console.log('\n4. verification');
  if (Number(after.entryDriftFactor) !== WANT) fail(`re-read says ${after.entryDriftFactor}, wanted ${WANT}`);
  console.log(`   ${CHECK} entryDriftFactor = ${after.entryDriftFactor}`);
  const others = Object.keys(before).filter((k) => k !== 'entryDriftFactor');
  const moved = others.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (moved.length) fail(`unrelated risk keys moved: ${moved.join(', ')}`);
  console.log(`   ${CHECK} every other risk key held (${others.length} checked)`);
  await pool.close();
})();
