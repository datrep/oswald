// trading/scripts/repro/set-risk-sizing.js — raise/lower the position + exposure
// caps (report S1/A3). Owner decision 2026-09-12 moved these into the 25-40% band.
//
// WHY THIS IS THE LEVER: while the notional cap binds, the risk gate computes
// size = capPct x equity / price, so `riskPerTradePct` is inert and
//
//     effective risk per trade = capPct x stopDistance%  x runInFactor
//
// On 2026-09-11 the cap was 8%: Oil (stop 1.427%) risked 0.114% of equity and
// Gold (stop 0.648%) risked 0.052% — 4-20x below the 1% the frozen strategies
// declare. A +2.145% favourable Oil move was worth S$20.17 because the position
// was 8% of equity, not because the exit missed the move (it captured 100%).
//
// Goes through PUT /api/trading/settings (the UI's own path) so the change is
// deep-merged and observable, rather than hand-editing the JSON blob.
//
// Usage (run from the repo root):
//   node trading/scripts/repro/set-risk-sizing.js [maxPct] [exposurePct] [riskPerTradePct] [marginCeilingPct]
//   defaults: 40 / 80 / (risk unit left unchanged) / (margin ceiling left unchanged)
//
// L3 (rev 5, 2026-09-29): the FOURTH argument is `maxMarginUtilisationPct`, the share of equity the whole
// book may commit as venue margin. It is left UNSET when the argument is omitted — the setting already holds
// its default of 80 and this script must not move a risk value nobody asked it to move. ⚠ Raising it weakens
// the desk's only capacity brake, and the package's ordering rule is the other way round: the guard exists so
// the CAPS can go up, not so this can.
//
// S1.5 (2026-09-13): pass the third argument to align the risk unit with the frozen
// spec. Both frozen survivors and store.js DEFAULT_SETTINGS declare
// riskPerTradePct: 1, while live settings had drifted to 5 — so the forward track
// was measuring a different bet than the frozen candidate. Note the unit is INERT
// while the notional cap binds (see the printed envelope), which is why this is a
// contract fix rather than a sizing change.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const maxPct = Number(process.argv[2] || 40);
const expPct = Number(process.argv[3] || 80);
const riskArg = process.argv[4];
const marginArg = process.argv[5];
const PATCH = { risk: { maxEquityPerPositionPct: maxPct, exposureCapPct: expPct } };
if (riskArg != null && riskArg !== '') PATCH.risk.riskPerTradePct = Number(riskArg);
if (marginArg != null && marginArg !== '') PATCH.risk.maxMarginUtilisationPct = Number(marginArg);

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

  const before = JSON.parse((await call('GET', '/api/trading/settings', token)).body).risk || {};
  console.log('before:', JSON.stringify({
    maxEquityPerPositionPct: before.maxEquityPerPositionPct,
    exposureCapPct: before.exposureCapPct,
    riskPerTradePct: before.riskPerTradePct,
    maxPositions: before.maxPositions,
    maxMarginUtilisationPct: before.maxMarginUtilisationPct,
  }));

  const r = await call('PUT', '/api/trading/settings', token, PATCH);
  if (r.status !== 200) { console.error('HTTP', r.status, r.body.slice(0, 300)); process.exit(1); }

  const after = JSON.parse(r.body).risk || {};
  console.log('after: ', JSON.stringify({
    maxEquityPerPositionPct: after.maxEquityPerPositionPct,
    exposureCapPct: after.exposureCapPct,
    riskPerTradePct: after.riskPerTradePct,
    maxPositions: after.maxPositions,
    maxMarginUtilisationPct: after.maxMarginUtilisationPct,
  }));

  // Show the resulting risk envelope rather than just the dial positions.
  const stopPct = { Oil: 1.427 / 99.9 * 100, Gold: 28.46 / 4333 * 100 };
  const eq = 4024;
  for (const [sym, sp] of Object.entries(stopPct)) {
    const pct = after.maxEquityPerPositionPct * sp / 100;
    console.log(`  ${sym}: ${after.maxEquityPerPositionPct}% notional x ${sp.toFixed(3)}% stop = ${pct.toFixed(3)}% equity risk (~S$${(eq * pct / 100).toFixed(2)})`);
  }
  console.log(`  book: max ${after.exposureCapPct}% exposure -> modelled simultaneous stop-out ~S$${(eq * after.exposureCapPct / 100 * 1.4 / 100).toFixed(2)} at a 1.4% average stop (assumes fills AT the stop; a gap is larger)`);
  // S1: the number the UI labels "risk per trade" is NOT the risk actually taken.
  const baseSizePct = (Number(after.riskPerTradePct) / 100) * eq / (2 * 0.71) * 99.9 / eq * 100;
  console.log(`  NOTE: riskPerTradePct=${after.riskPerTradePct} is INERT while the position cap binds.`);
  console.log(`        Turtle sizing would want ~${baseSizePct.toFixed(0)}% of equity in notional (cap is ${after.maxEquityPerPositionPct}%),`);
  console.log('        so realised risk = cap% x the stop distance in %, and the risk-unit dial changes nothing.');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
