// trading/scripts/repro/trail-curve-probe.js — TRD-TRL-3. What does the venue's trailing-stop control ACTUALLY do?
//
// THE QUESTION. Eight approved entries were refused because a distance read back "did not hold the requested
// value", and the first live capture then showed WHY: the control COMMITS the first count it is given and ignores
// every one after it. 100000 committed -166.56%; 25000, 62 and 124 all read the same value while the PRICE kept
// moving it in the fourth decimal. So the count range where the control answers PROPORTIONALLY is unknown, and it
// is below 62.
//
// HOW IT IS MEASURED. `POST /orders/trail-curve-probe` walks a sweep of counts on a ticket that is NEVER
// SUBMITTED (nothing arms until `#trade-button`), taking a FRESH TICKET for each count so every measurement is a
// first write - the only kind this control honours. The read lives in the service because `pageLock` is in-process.
//
// HOW TO READ THE OUTPUT. `pip` = distance / count, in price units per count.
//   * pip CONSTANT across a range  -> the control is proportional there. THAT range is the only place the desk can
//     scale from, and the constant is the per-instrument pip it has never had.
//   * pip COLLAPSING as the count rises -> saturation. Anything scaled from a reading in that zone is wrong by the
//     saturation ratio, which is what missed the target AND the fail-safe on all eight refusals.
//
// ⚠ ONE SYMBOL AT A TIME, AND THE VALUE IS PER-INSTRUMENT until proven otherwise. The desk has never assumed a pip
// table and must not start now.
//
// Usage (from the repo root):
//   node trading/scripts/repro/trail-curve-probe.js [symbol] [buy|sell]
//   node trading/scripts/repro/trail-curve-probe.js [symbol] [buy|sell] methods   # which WRITE lands
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
const https = require('https');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../../shared/db');

const USER = Number(process.env.TRADING_SCRIPT_USER) || 1;
const BASE = process.env.TRADING_API_BASE || 'https://127.0.0.1:8114';
const SYMBOL = process.argv[2] || 'Oil';
const DIRECTION = process.argv[3] === 'sell' ? 'sell' : 'buy';
const METHODS = process.argv.includes('methods') ? ['type', 'fill', 'native'] : null;
const LABEL = (process.argv.find((a) => a.startsWith('label=')) || '').split('=')[1] || null;
const COUNTS = (process.argv.find((a) => a.startsWith('counts=')) || '').split('=')[1];
const STOP = Number((process.argv.find((a) => a.startsWith('stop=')) || '').split('=')[1]);
const SIZE = Number((process.argv.find((a) => a.startsWith('size=')) || '').split('=')[1]);
const OUT = path.join(__dirname, '..', '..', '..', 'temp', `trail-curve-${SYMBOL.replace(/\W+/g, '-')}${METHODS ? '-methods' : ''}${LABEL ? '-' + LABEL.replace(/\W+/g, '-') : ''}.json`);
if (STOP > 0 || SIZE > 0) console.log(`ticket state: stop=${STOP > 0 ? STOP : 'none'} size=${SIZE > 0 ? SIZE : 'none'} (reproduction inputs, never submitted)`);
const agent = new https.Agent({ rejectUnauthorized: false });

function call(method, p, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(`${BASE}${p}`, {
      method, agent,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const pool = await getPool();
  const uv = await pool.request().query(`SELECT tokenVersion FROM Users WHERE id = ${USER}`);
  const v = Number(uv.recordset[0] && uv.recordset[0].tokenVersion) || 0;
  const token = jwt.sign({ userID: USER, roles: ['admin'], permissions: ['services.manage'], v },
    process.env.JWT_SECRET, { expiresIn: '30m' });
  await pool.close();

  console.log(`probing the trailing-stop control on ${SYMBOL} ${DIRECTION} — fresh ticket per count, nothing submitted`);
  const r = await call('POST', '/api/trading/orders/trail-curve-probe', token, {
    symbol: SYMBOL, direction: DIRECTION, waitMs: 240000,
    ...(METHODS ? { counts: [10000], methods: METHODS } : {}),
    ...(COUNTS ? { counts: COUNTS.split(',').map(Number).filter((n) => n > 0) } : {}),
    ...(STOP > 0 ? { stopPrice: STOP } : {}),
    ...(SIZE > 0 ? { size: SIZE } : {}),
  });
  if (r.status !== 200) {
    console.error(`HTTP ${r.status}: ${String(r.text).slice(0, 400)}`);
    process.exit(1);
  }
  const o = JSON.parse(r.text);
  if (o.skipped) {
    console.error(`REFUSED: ${o.skipped}${o.hint ? ' — ' + o.hint : ''}`);
    console.error('The bridge is shared with the live desk; rerun when the wake finishes.');
    process.exit(2);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(o, null, 2), 'utf8');

  const f = (x, n = 4) => (x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(n));
  console.log(`\n${SYMBOL} ${DIRECTION} — the venue's own reading after ONE write of each count`);
  console.log('count'.padStart(8), 'method'.padStart(8), 'field'.padStart(8), 'money'.padStart(12),
    'percent'.padStart(11), 'distance'.padStart(11), 'pip'.padStart(14), 'moved', 'note'.padStart(10));
  let prevDistance = null;
  for (const row of o.rows) {
    let note = '';
    if (row.ok && prevDistance != null) {
      const grew = row.distance / prevDistance;
      note = `${grew.toFixed(2)}x`;
    }
    console.log(
      String(row.count).padStart(8), String(row.method).padStart(8), String(row.fieldRaw).padStart(8),
      f(row.money, 2).padStart(12), String(row.raw == null ? '—' : row.raw).padStart(11),
      f(row.distance, 5).padStart(11), f(row.pip, 8).padStart(14),
      String(row.moved === true ? 'YES' : row.moved === false ? 'no' : '?').padStart(5),
      (row.ok ? note : (row.reason || 'failed').slice(0, 10)).padStart(10),
    );
    if (row.ok) prevDistance = row.distance;
  }

  const ok = o.rows.filter((x) => x.ok);
  const def = o.rows.find((x) => x.defaultRaw) || {};
  console.log(`\nthe card's OWN default before any write: ${def.defaultRaw || 'unknown'}`);
  console.log(`${ok.length} of ${o.rows.length} counts produced a readable consequence.`);
  if (ok.length >= 2) {
    const pips = ok.map((x) => x.pip);
    const lo = Math.min(...pips);
    const hi = Math.max(...pips);
    console.log(`pip ranged ${f(lo, 8)} .. ${f(hi, 8)} — a spread of ${f(hi / lo, 1)}x across the sweep.`);
    console.log(hi / lo < 1.2
      ? 'CONSTANT across the sweep: the control is proportional here, and that value is the pip.'
      : 'NOT constant: the control saturates somewhere in this sweep. Only the flat end of it may be scaled from.');
  }
  console.log(`\nfull curve written to ${OUT}`);
  console.log('CAUTION: one symbol, one direction, one moment. The pip is per-instrument until measured otherwise,');
  console.log('and a market tick mid-sweep perturbs every row after it.');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
