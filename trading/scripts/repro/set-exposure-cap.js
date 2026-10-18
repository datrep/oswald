// trading/scripts/repro/set-exposure-cap.js
//
// Sets `risk.exposureCapPct` ONLY, and PREDICTS the consequence before applying it.
//
// Why this is its own script rather than an argument to set-risk-sizing.js: that tool's positional args make it easy
// to move a risk value nobody asked about, and this change is one key.
//
// ⚠ THE CONSEQUENCE THIS SCRIPT EXISTS TO MEASURE. `fitExposureBudget` RESIZES when there is room and **HARD-VETOES
// when there is not** (`remainingPct <= 0` -> `full` -> `veto('exposure_budget', ...)`). It does not resize to
// nothing. So if the book's CURRENT open exposure already exceeds the new cap, EVERY new entry is vetoed until an
// open position closes — a hard stop, not a squeeze. That is the control working as designed (the book is over
// budget, so no new risk may be added), but it is not obvious from the setting's name, so it is predicted here and
// then measured again afterwards.
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const NEW_CAP = Number(process.argv[2] || 50);
const YES = process.argv.includes('--yes');
const WARN = '\u26A0';
const CHECK = '\u2714';
const EM = '\u2014';

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
  const uv = await q(`SELECT tokenVersion FROM Users WHERE id = 1`);
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  const get = async () => JSON.parse((await call('GET', '/api/trading/settings', token)).body);
  const before = (await get()).risk || {};

  console.log('=== set exposureCapPct ===\n');
  if (!Number.isFinite(NEW_CAP) || NEW_CAP <= 0) fail(`cap ${process.argv[2]} is not a positive number`);
  if (Number(before.exposureCapPct) === NEW_CAP) { console.log(`already ${NEW_CAP}. Nothing to do.`); await pool.close(); return; }

  console.log(`1. the change: exposureCapPct ${before.exposureCapPct} -> ${NEW_CAP}`);
  console.log(`   (maxEquityPerPositionPct stays ${before.maxEquityPerPositionPct}; riskPerTradePct ${before.riskPerTradePct}; guard ${before.maxMarginUtilisationPct})`);
  if (Number(before.maxEquityPerPositionPct) > NEW_CAP) {
    console.log(`   ${WARN} NOTE: the per-position cap (${before.maxEquityPerPositionPct}%) now EXCEEDS the portfolio cap (${NEW_CAP}%) — the budget binds first, so the per-position setting is unreachable.`);
  }

  // The book, computed EXACTLY as risk.js:426 does: sum(size x openPrice) / equity x 100.
  const open = await q(`SELECT id, symbol, size, openPrice, status FROM Trades WHERE status = 'open' ORDER BY id`);
  const equityRow = await q(`SELECT TOP 1 equity FROM TradingAccounts ORDER BY id DESC`).catch(() => []);
  const equity = Number(before.initialEquity);
  let notional = 0;
  console.log(`\n2. the open book (sum of size x openPrice / equity x 100, as risk.js:426 computes it)`);
  for (const t of open) {
    const n = (Number(t.size) || 0) * (Number(t.openPrice) || 0);
    notional += n;
    console.log(`   #${t.id} ${String(t.symbol).padEnd(14)} size=${t.size} open=${t.openPrice} notional=${n.toFixed(2)}`);
  }
  const exposurePct = notional / (equity || 1) * 100;
  console.log(`   total notional ${notional.toFixed(2)} on equity ${equity} => exposurePct = ${exposurePct.toFixed(2)}%`);
  console.log(`   ${equityRow.length ? `(live equity from TradingAccounts: ${equityRow[0].equity})` : '(no TradingAccounts row in this schema)'}`);

  const remaining = NEW_CAP - exposurePct;
  console.log(`\n3. PREDICTION (fitExposureBudget: remaining = cap - open)`);
  console.log(`   remaining = ${NEW_CAP} - ${exposurePct.toFixed(2)} = ${remaining.toFixed(2)}`);
  if (remaining <= 0) {
    console.log(`   ${WARN}${WARN} remaining <= 0 => 'full' => VETO 'exposure_budget' on EVERY new entry until an open position closes.`);
    console.log(`   The budget will NOT resize to nothing; it stops the desk entering.`);
  } else {
    console.log(`   ${CHECK} remaining > 0 => a new entry is RESIZED to ${remaining.toFixed(2)}% notional rather than vetoed.`);
  }

  const LIVE = { 'Arabica Coffee': { ceil: 2.3101, L: 5 }, Sugar: { ceil: 2.751, L: 5 }, SGX: { ceil: 14.9866, L: 10 } };
  console.log(`\n4. risk if the budget is what binds (risk = cap x stop%, stop = ceiling/L)`);
  for (const [sym, m] of Object.entries(LIVE)) {
    const stop = m.ceil / m.L;
    console.log(`   ${sym.padEnd(16)} ${NEW_CAP}% x ${stop.toFixed(5)}% = ${(NEW_CAP * stop / 100).toFixed(4)}%   (pre-L2 80% would have been ${(80 * stop / 100).toFixed(4)}%)`);
  }

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written. Pass --yes to apply.`); await pool.close(); return; }

  console.log(`\n5. applying`);
  const r = await call('PUT', '/api/trading/settings', token, { risk: { exposureCapPct: NEW_CAP } });
  if (r.status !== 200) fail(`PUT returned HTTP ${r.status}: ${String(r.body).slice(0, 300)}`);
  const after = (await get()).risk || {};
  if (Number(after.exposureCapPct) !== NEW_CAP) fail(`re-read says exposureCapPct = ${after.exposureCapPct}, wanted ${NEW_CAP}`);
  for (const k of ['maxEquityPerPositionPct', 'riskPerTradePct', 'dailyLossHaltPct', 'maxMarginUtilisationPct']) {
    if (String(after[k]) !== String(before[k])) fail(`${k} MOVED: ${before[k]} -> ${after[k]}`);
  }
  console.log(`  ${CHECK} exposureCapPct = ${after.exposureCapPct}; every other risk key held`);
  await pool.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
