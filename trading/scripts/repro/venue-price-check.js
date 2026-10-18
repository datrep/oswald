// trading/scripts/repro/venue-price-check.js — TRD-EXE-18 live verification, READ-ONLY.
//
// WHAT THIS PROVES. `openInstrument` now carries the venue's live buy/sell out instead of discarding them, and
// `probeSession` prefers them over `readTicket`. The discriminator is simple and was the whole point: until today
// the venue price was NULL on every live observation (2 of 2 recorded `session_probe` events).
//
// ⚠ WHY THIS IS AN HTTP CALL AND NOT A DIRECT BRIDGE USE. `pageLock` is IN-PROCESS mutual exclusion, so a script
// that drove the shared tab itself could not coordinate with a ticket and would navigate it out from under one —
// the race that killed order 6289 mid set-limits. The navigation happens INSIDE the service; this only asks it.
//
// ⚠ AND IT PLACES NOTHING. `/watchlist/open` navigates and reads. No size, no level, no Buy/Sell.
//
// Usage: node trading/scripts/repro/venue-price-check.js [Gold Oil Sugar]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const BASE = process.env.TRADING_API_BASE || 'https://172.22.160.3:8114';
const SYMBOLS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const WANT = SYMBOLS.length ? SYMBOLS : ['Gold', 'Oil', 'Sugar'];

const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const u = new URL(BASE + p);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 120000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
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

  console.log('=== TRD-EXE-18: does the venue price actually arrive? ===\n');
  let withPrice = 0;
  for (const symbol of WANT) {
    let r = null;
    try { r = JSON.parse((await call('POST', '/api/trading/watchlist/open', token, { symbol })).body); }
    catch (e) { console.log(`${symbol.padEnd(8)} REQUEST FAILED: ${e.message}`); continue; }
    if (r.error) { console.log(`${symbol.padEnd(8)} REFUSED: ${r.error}`); continue; }

    const mid = r.buy != null && r.sell != null ? +(((r.buy + r.sell) / 2).toFixed(8)) : null;
    const t = (await pool.request()
      .query(`SELECT TOP 1 symbol, bid, ask, capturedAt FROM PriceTicks
              WHERE symbol = '${symbol.replace(/'/g, "''")}' ORDER BY id DESC`)).recordset[0] || null;
    const tickMid = t && t.bid != null && t.ask != null ? +(((Number(t.bid) + Number(t.ask)) / 2).toFixed(8)) : null;
    const ageSec = t && t.capturedAt ? Math.round((Date.now() - new Date(t.capturedAt).getTime()) / 1000) : null;
    const gapPct = mid != null && tickMid ? +(((mid - tickMid) / tickMid) * 100).toFixed(4) : null;

    if (mid != null) withPrice++;
    console.log(`${String(symbol).padEnd(8)} via=${String(r.via || '?').padEnd(9)} src=${String(r.priceSource || 'NONE').padEnd(8)}`
      + ` buy=${r.buy ?? 'null'} sell=${r.sell ?? 'null'} venueMid=${mid ?? 'null'}`);
    console.log(`${''.padEnd(8)} desk tick=${tickMid ?? 'none'} (${ageSec == null ? 'n/a' : ageSec + 's old'})`
      + `  venue-vs-desk gap=${gapPct == null ? 'n/a' : gapPct + '%'}`);
  }

  console.log(`\n★ ${withPrice} of ${WANT.length} symbols returned a venue price.`);
  console.log(withPrice
    ? '★ EXPECTED BEFORE THE FIX: 0 — every live `session_probe` recorded venueMid: null (2 of 2).'
    : '\u26A0 STILL NULL — the fix did not reach this path; the source field above says which one was tried.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
