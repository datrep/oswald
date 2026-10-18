// trading/scripts/order-book-probe.js
//
// TRD-EXE-1 (#1454): MEASURE the venue's order book, so item 4's classification half and item 2's
// cancel/adopt have a real `data-testid` to be written against instead of a guess.
//
// WHY A THIN HTTP CLIENT RATHER THAN DOING THE READ HERE. `pageLock` is IN-PROCESS mutual exclusion
// ("every desk flow lives in the service process"). A script that grabbed the shared tab itself could
// not coordinate with a ticket and would navigate it out from under one — the race that killed order
// 6289 mid set-limits (order_rejected 6289: the mirror's cycle navigated to /open-positions while the
// venue SL/TP cards were expanding, so #close-at-loss-rate never enabled). So the read lives in the
// service and this is only the caller, exactly as instrument-probe.js is for /instruments/probe.
//
// READ-ONLY end to end: the route navigates, waits, reads, and parks the tab back on /open-positions.
// No path here can cancel or modify an order.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const https = require('https');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { getPool } = require(path.join(__dirname, '..', '..', 'shared', 'db'));

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const BASE = process.env.TRADING_BASE_URL || 'https://172.22.160.3:8114';
const OUT = path.join(__dirname, '..', '..', 'temp', 'order-book-shape.json');

const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const u = new URL(BASE + p);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 180000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

(async () => {
  const pool = await getPool();
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0] ? uv.recordset[0].tokenVersion : 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );
  await pool.close();

  const r = await call('POST', '/api/trading/orders/book-probe' + (force ? '?force=1' : ''), token, { waitMs: 240000 });
  if (r.status !== 200) { console.error('HTTP ' + r.status + ': ' + String(r.body).slice(0, 400)); process.exit(1); }
  const o = JSON.parse(r.body);
  if (o.skipped) {
    console.error('REFUSED: ' + o.skipped + (o.hint ? ' — ' + o.hint : ''));
    console.error('The bridge is shared with the live desk; rerun when the wake finishes (--force to override).');
    process.exit(2);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(o, null, 2), 'utf8');

  console.log('=== VENUE ORDER BOOK, MEASURED ===');
  console.log('  url now        : ' + o.url);
  console.log('  url before     : ' + o.urlBefore);
  console.log('  content state  : ' + o.contentState);
  console.log('  app mounted    : ' + o.mounted + '   (content, not chrome — see readOrderBookShape)');
  console.log('  body innerText : ' + o.bodyLen + ' chars');
  console.log('  html length    : ' + o.htmlLen);
  console.log('  shadow-root txt: ' + o.shadowLen + ' chars');
  console.log('  testids on page: ' + o.testidCount);
  console.log('  overlay testids: ' + JSON.stringify(o.overlayTestids));
  console.log('  dialog text    : ' + JSON.stringify(o.dialogText));
  console.log('\n  --- testid prefixes (count) ---');
  const hist = Object.entries(o.histogram || {}).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of hist) console.log('    ' + String(k).padEnd(34) + String(v).padStart(5));
  console.log('\n  --- ROW-LIKE candidates (<Prefix>.<id>) ---');
  console.log('    ' + JSON.stringify(o.rowLike, null, 0));
  console.log('\n  --- ORDER-ish testids ---');
  console.log('    ' + JSON.stringify(o.orderish, null, 0));
  console.log('\n  --- body signals ---');
  console.log('    ' + JSON.stringify(o.bodySignals));
  console.log('\n  --- body text (first 1200) ---');
  console.log('    ' + String(o.bodyText || '').replace(/\n/g, ' | '));
  console.log('\n  raw written to ' + OUT);
  process.exit(0);
})().catch((e) => { console.error('FAILED: ' + String((e && e.message) || e)); process.exit(1); });
