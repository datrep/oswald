// trading/scripts/repro/apply-L2-risk-package.js
//
// L2 (rev 5, 2026-09-29) — THE OWNER-APPROVED PURCHASING-POWER PACKAGE. Applies the four decided changes
// together, because §6 says the ordering is not negotiable: L3's margin guard must be ARMED in the same change
// as the cap raise, or the raise permits 5 Gold positions x 400% notional = 400% of equity in margin.
//
//   maxEquityPerPositionPct   80 -> 500    (Q2)
//   exposureCapPct           100 -> 500    (Q2)
//   riskPerTradePct            5 -> 3      (Q1: the package sets r = 3.0% PER TRADE, plus a portfolio brake)
//   dailyLossHaltPct           3 -> 6.0    (Q6)
//
// ⚠ NOT CHANGED, DELIBERATELY: `maxMarginUtilisationPct` (80, already armed — the guard is what makes the raise
// survivable), `maxAdversePct` (1.5 — tightening it LOWERS every ceiling), `maxPositions` (10),
// `maxRiskPerTradePct` (5 — already ABOVE the new target 3.0%, so it cannot fire, which is §6.1's intent), and
// `dailyHaltAnchor` (utc_midnight).
//
// ⚠ WHAT THIS DOES *NOT* FIX: TRD-EXE-1 (#1454). The desk cannot reliably distinguish a venue refusal from
// "maybe submitted" (measured: 1 clean refusal vs 9 ambiguous rows vs 7 expired-unconfirmed). The margin guard
// is the mitigation — it keeps the book inside available funds so refusals should not occur in normal operation
// — but any refusal that DOES occur will be recorded ambiguously.
//
// Goes through PUT /api/trading/settings (the UI's own path) so the change is deep-merged and observable, and
// RE-READS with a GET afterwards. Settings are read per wake, so no restart is required; the change is
// reversible by running this script with the ROLLBACK values printed at the end.
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0';
const CHECK = '\u2714';
const EM = '\u2014';

// The decided package, and the exact BEFORE values this script expects to find. If the live values have moved,
// the script REFUSES rather than patching on top of a state it did not expect.
const BEFORE = { maxEquityPerPositionPct: 80, exposureCapPct: 100, riskPerTradePct: 5, dailyLossHaltPct: 3 };
const AFTER = { maxEquityPerPositionPct: 500, exposureCapPct: 500, riskPerTradePct: 3, dailyLossHaltPct: 6 };
const MUST_STAY = ['maxMarginUtilisationPct', 'maxAdversePct', 'maxPositions', 'maxRiskPerTradePct', 'dailyHaltAnchor'];

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

const fail = (msg) => { console.error(`\n${WARN} REFUSING: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  const get = async () => JSON.parse((await call('GET', '/api/trading/settings', token)).body);

  console.log('=== L2 risk package — gates ===\n');
  const before = (await get()).risk || {};

  console.log('1. the margin guard is ARMED (the non-negotiable ordering condition)');
  if (!(Number(before.maxMarginUtilisationPct) > 0)) {
    fail(`maxMarginUtilisationPct is ${before.maxMarginUtilisationPct}. The guard must be armed in the SAME change as the raise; deploying the caps without it permits 400% of equity in margin.`);
  }
  console.log(`  ${CHECK} maxMarginUtilisationPct = ${before.maxMarginUtilisationPct}% — armed, so the raise is survivable`);

  console.log('\n2. the live values are what this script expects to patch');
  for (const [k, want] of Object.entries(BEFORE)) {
    const got = Number(before[k]);
    if (got !== want) fail(`${k} is ${before[k]}, expected ${want}. Re-read §6.1 before patching on top of an unexpected state.`);
  }
  console.log(`  ${CHECK} ${JSON.stringify(BEFORE)}`);

  console.log('\n3. the keys that must NOT move');
  const stays = {};
  for (const k of MUST_STAY) stays[k] = before[k];
  console.log(`  ${JSON.stringify(stays)}`);

  console.log('\n4. the change');
  for (const k of Object.keys(AFTER)) console.log(`  ${k}: ${before[k]} -> ${AFTER[k]}`);

  // The envelope, computed per symbol from the LIVE ceilings measured in §13.10 where they exist.
  // ⚠ THE LEVERAGE IS PER SYMBOL, NOT A CONSTANT. The first version of this block divided every ceiling by 5,
  // which made SGX (1:10) report an old risk of 2.3979% when the desk actually recorded 1.1987%. Deriving the
  // stop as `ceiling / L` is only useful if L is the symbol's OWN leverage — and it is also the check that the
  // model is right: with L pinned, Coffee reproduces 0.3696% and Sugar 0.4402%, matching the recorded
  // `resolvedRiskPct` of 0.3696 and 0.4401.
  const LIVE_CEIL = { 'Arabica Coffee': { ceiling: 2.3101, L: 5 }, Sugar: { ceiling: 2.751, L: 5 }, SGX: { ceiling: 14.9866, L: 10 } };
  const u = Number(before.maxMarginUtilisationPct);
  console.log(`\n5. what the package delivers per symbol (live ceilings, u = ${u}%)`);
  for (const [sym, m] of Object.entries(LIVE_CEIL)) {
    const stopPct = m.ceiling / m.L;                 // the live stop, recovered from the ceiling
    const oldRisk = BEFORE.maxEquityPerPositionPct * stopPct / 100;   // the old cap bound, so risk = cap x stop
    const newRisk = Math.min(AFTER.riskPerTradePct, (u / 100) * m.ceiling);
    console.log(`  ${sym.padEnd(16)} L=1:${String(m.L).padEnd(2)} ceiling ${String(m.ceiling).padEnd(8)}%  old risk ~${oldRisk.toFixed(4)}%  ->  new risk ${newRisk.toFixed(4)}%  (${(newRisk / oldRisk).toFixed(1)}x)`);
  }
  console.log('  \u26A0 the other four symbols are UNMEASURED in the L4 era, so they are not modelled here.');

  if (!YES) {
    console.log(`\nDRY RUN ${EM} nothing written. Pass --yes to apply.`);
    await pool.close();
    return;
  }

  console.log('\n6. applying through PUT /api/trading/settings');
  const r = await call('PUT', '/api/trading/settings', token, { risk: AFTER });
  if (r.status !== 200) fail(`PUT returned HTTP ${r.status}: ${String(r.body).slice(0, 300)}`);
  console.log(`  ${CHECK} HTTP 200`);

  console.log('\n7. RE-READ with a fresh GET (the response is not the record)');
  const after = (await get()).risk || {};
  let bad = 0;
  for (const [k, want] of Object.entries(AFTER)) {
    if (Number(after[k]) !== want) { console.log(`  ${WARN} ${k} = ${after[k]}, WANTED ${want}`); bad++; }
  }
  for (const k of MUST_STAY) {
    if (String(after[k]) !== String(stays[k])) { console.log(`  ${WARN} ${k} MOVED: ${stays[k]} -> ${after[k]}`); bad++; }
  }
  if (bad) fail(`${bad} setting(s) did not land as intended — the package is NOT correctly applied`);
  console.log(`  ${CHECK} all four landed and every protected key held`);
  console.log(`  ${JSON.stringify({ maxEquityPerPositionPct: after.maxEquityPerPositionPct, exposureCapPct: after.exposureCapPct, riskPerTradePct: after.riskPerTradePct, dailyLossHaltPct: after.dailyLossHaltPct })}`);
  console.log(`\nROLLBACK: node trading/scripts/repro/apply-L2-risk-package.js with BEFORE swapped in ${EM} i.e. set`);
  console.log(`  maxEquityPerPositionPct=${BEFORE.maxEquityPerPositionPct} exposureCapPct=${BEFORE.exposureCapPct} riskPerTradePct=${BEFORE.riskPerTradePct} dailyLossHaltPct=${BEFORE.dailyLossHaltPct}`);
  await pool.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
