// scripts/record-2026-09-28-floor-live.js — append the LIVE verification to TRD-RSK-4 (#1453).
// Dry by default:  node scripts/record-2026-09-28-floor-live.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 floor-live##';
const ID = 1453;
const SINCE = '2026-09-28T03:30:17Z';

const NOTE = `

${MARK}
★ **LIVE-VERIFIED 2026-09-28T03:31:04.763Z — the first wake after the 03:30:17Z restart, 47 seconds later.** The
disclosure is no longer "code on disk": it is in the recorded bundle the seat was given.

**PROMPT #5360 (micro, text 17,308 chars), verbatim, the proposal lines — every one now carries its OWN floor:**

    PROPOSED ACTION by quant: entry sell Bitcoin size=risk-sized · venue minimum 0.001 Contracts (basis: donchian20 breakout down, ADX 14.1786).
    entry sell Bitcoin (basis: donchian20 breakout down, ADX 14.1786) · venue minimum 0.001 Contracts
    entry buy Arabica Coffee (basis: donchian5 breakout up, ADX 24.9245) · venue minimum 0.5 Contracts
    entry sell Silver (basis: donchian20 breakout down, ADX 28.0825) · venue minimum 2.5 Troy Ounces
    entry buy Sugar (basis: donchian5 breakout up, ADX 40.6219) · venue minimum 15 Contracts
    entry buy SGX (basis: donchian20 breakout up, ADX 32.2537) · venue minimum 20 Shares

⇒ **floor ON the proposal line: TRUE**, and the cost section still renders all 7 rows (\`min size\` lines: 7), so the
two placements coexist rather than one replacing the other. Check: \`temp/verify-floor-live.js\` (read-only).
★ **AND SGX IS STILL BEING PROPOSED** — on the same wake that this row is about, with its floor printed on the line
for the first time. That is exactly the acceptance item this row carries: the disclosure is now correct and the
structural problem is untouched by it, so the desk continues to table a ticket the venue cannot accept.
⇒ the owner's three options in ACCEPTANCE item 1 stand, and item 2 (the TRD-RSK-2 declared-stop-widening candidate)
is what decides whether SGX ever becomes tradeable again.
`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);

  console.log('\n=== venue_minimum refusals, the authoritative count ===');
  for (const r of await q(`SELECT JSON_VALUE(payload,'$.symbol') AS sym, COUNT(*) n, MIN(createdAt) mn, MAX(createdAt) mx
      FROM TradingEvents WHERE kind='decision' AND CAST(payload AS nvarchar(max)) LIKE '%"venue_minimum"%'
      GROUP BY JSON_VALUE(payload,'$.symbol') ORDER BY n DESC`))
    console.log(`  ${r.sym}  ${r.n}   ${r.mn.toISOString()} .. ${r.mx.toISOString()}`);

  console.log('\n=== decisions from the 03:30+ restart window ===');
  for (const r of await q(`SELECT id, createdAt, JSON_VALUE(payload,'$.symbol') AS sym, JSON_VALUE(payload,'$.attribution') AS att,
      JSON_VALUE(payload,'$.riskVetoCodes') AS codes, LEFT(JSON_VALUE(payload,'$.reason'), 120) AS reason
      FROM TradingEvents WHERE kind='decision' AND createdAt >= '${SINCE}' ORDER BY id`))
    console.log(`  #${r.id} ${r.createdAt.toISOString()} ${String(r.sym).padEnd(15)} att=${r.att} codes=${r.codes}\n     ${r.reason}`);

  const cur = (await q(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  const dup = await q(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`);
  console.log(`\n#${ID} state=${cur.state} info=${cur.len}${dup.length ? '  [marker present]' : ` -> ${Number(cur.len) + NOTE.length}`}`);
  if (dup.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  if (!YES) { console.log('DRY RUN — not written.'); await pool.close(); return; }
  await pool.request().input('t', NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const back = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`✔ #${ID} appended -> ${back.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
