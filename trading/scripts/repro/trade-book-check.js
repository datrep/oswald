// trading/scripts/repro/trade-book-check.js
//
// READ-ONLY. "Is the book flat?" — the question to answer BEFORE touching the running service (restart,
// config change, anything that interrupts the wake loop).
//
// ★ WHY THIS IS A SCRIPT AND NOT A ONE-LINER. The desk has already been misled once on exactly this question.
// The pre-open runbook records it: *"⚠ While checking this I used `closeAt IS NULL` as 'open' and got 11 rows —
// they are all `status = 'rejected'` (never filled, so a NULL close time). `status` is the source of truth;
// `closeAt` is not."* A rejected row and an open row look identical to any test based on timestamps, and only
// one of them means "money is at risk".
//
// So this prints the STATUS BREAKDOWN first, so a reader can see that "0 open" is a fact about the book rather
// than an artefact of which column the filter used.
//
// Usage (from the repo root): node trading/scripts/repro/trade-book-check.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');

const USER_ID = Number(process.argv[2]) || 1;
const pad = (s, n) => String(s ?? '').padEnd(n);

async function main() {
  const pool = await getPool();
  const req = () => pool.request().input('userId', sql.Int, USER_ID);

  const cols = await pool.request().query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Trades'");
  const has = new Set(cols.recordset.map((c) => c.COLUMN_NAME));

  console.log('\n=== status breakdown (userId ' + USER_ID + ') ===');
  const byStatus = await req().query(
    'SELECT status, COUNT(1) AS c FROM Trades WHERE userId = @userId GROUP BY status ORDER BY COUNT(1) DESC');
  for (const r of byStatus.recordset) console.log('  ' + pad(r.status, 14) + r.c);

  console.log('\n=== status = \'open\' — THE ONLY ROW THAT MEANS MONEY IS AT RISK ===');
  // ★ THE COLUMN LIST IS RESOLVED FROM THE CATALOGUE, NOT WRITTEN BY HAND. Two attempts at this script died on
  // invented column names (`openedAt`, then `entryPrice`) — a small, cheap version of the same error the runbook
  // warns about: assuming a schema instead of asking for it. Only columns that exist are selected.
  const wanted = ['id', 'symbol', 'direction', 'strategyId', 'stopPrice', 'takeProfitPrice'].filter((c) => has.has(c));
  const open = await req().query(
    `SELECT ${wanted.join(', ')} FROM Trades WHERE userId = @userId AND status = 'open' ORDER BY id`);
  if (!open.recordset.length) {
    console.log('  NONE — the book is FLAT.');
  } else {
    for (const t of open.recordset) {
      console.log(`  #${t.id} ${pad(t.symbol, 12)} ${pad(t.direction, 5)} ${pad(t.strategyId, 10)}`
        + ` entry ${t.entryPrice} stop ${t.stopPrice == null ? 'NONE' : t.stopPrice}`
        + ` tp ${t.takeProfitPrice == null ? 'NONE' : t.takeProfitPrice}`);
    }
  }

  // The two traps, printed so neither can be mistaken for an open position again.
  const rejected = await req().query(
    "SELECT COUNT(1) AS c FROM Trades WHERE userId = @userId AND status = 'rejected'");
  const nullClose = await req().query(
    'SELECT COUNT(1) AS c FROM Trades WHERE userId = @userId AND closeAt IS NULL');
  console.log('\n=== why `closeAt IS NULL` is NOT "open" ===');
  console.log(`  rejected rows:      ${rejected.recordset[0].c}  (never filled, so also NULL closeAt)`);
  console.log(`  rows with NULL closeAt: ${nullClose.recordset[0].c}  <- the number that MISLED the runbook`);
  console.log(`  ACTUALLY OPEN:            ${open.recordset.length}  <- gate any restart on THIS one`);
  console.log(`\n  Trades columns available: ${cols.recordset.length}\n`);

  await pool.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
