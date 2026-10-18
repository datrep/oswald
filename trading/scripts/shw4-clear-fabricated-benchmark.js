// trading/scripts/shw4-clear-fabricated-benchmark.js — TRD-SHW-4 data correction, owner-approved 2026-09-23.
//
// Sets `benchmarkLongR = NULL` on rows where the value is a FABRICATED zero: the scorer read `b.open`
// (undefined on every real PriceBars row), got `null` from `benchmarkLongPct`, and `rOf(null, risk)` coerced
// that to 0 because `Number(null) === 0`. The result is a plausible 0.000000 the gate's own `isNum()` accepts
// as a real measurement of the unmirrored-long benchmark.
//
// WHY THE PREDICATE, NOT A LIST OF IDS. The ledger is live: the un-deployed process keeps BURNING rows, and
// each burned row lands with `benchmarkLongR = 0` and `realisedR = NULL`. A hard-coded id list would be stale
// before it ran. `benchmarkLongR = 0 AND realisedR IS NULL` is self-limiting and self-extinguishing: once the
// fix is deployed, new rows carry either a real number or NULL, and the predicate can never match a row that
// was measured correctly. Measured 2026-09-23: the column holds ONLY NULLs and these zeros — no legitimate
// zero exists yet, because no row carries a realisedR at all.
//
// WHAT THIS DOES NOT DO: it does not rescore anything, does not touch `scoredAt`, and does not touch
// `realisedR`. The 45+ already-scored rows stay exactly as the broken scorer left them — they are the record
// the pre-registration §1 is written from.
//
//   node trading/scripts/shw4-clear-fabricated-benchmark.js           # DRY RUN
//   node trading/scripts/shw4-clear-fabricated-benchmark.js --yes     # applies, and writes a backup
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { getPool, sql } = require('../../shared/db');

const USER = 1;
const APPLY = process.argv.includes('--yes');
// NOTE: must NOT match /^shadow-gate-\d{4}-\d{2}-\d{2}\.md$/ — shadow-gate.js counts files in this directory
// to size its `looks` argument, and a stray matching name would silently spend an alpha unit.
const REPORT_DIR = path.join(__dirname, '..', 'reports');

// ★ The predicate is stated ONCE and used for the dry run, the UPDATE and the verification, so the three
// cannot drift apart.
const PREDICATE = 'userId = @u AND benchmarkLongR = 0 AND realisedR IS NULL';

(async () => {
  const pool = await getPool();
  const req = () => pool.request().input('u', sql.Int, USER);

  const shape = (await req().query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN benchmarkLongR IS NULL THEN 1 ELSE 0 END) AS b_null,
            SUM(CASE WHEN benchmarkLongR = 0 AND realisedR IS NULL THEN 1 ELSE 0 END) AS fabricated,
            SUM(CASE WHEN benchmarkLongR = 0 AND realisedR IS NOT NULL THEN 1 ELSE 0 END) AS zero_with_real_r,
            SUM(CASE WHEN benchmarkLongR IS NOT NULL AND benchmarkLongR <> 0 THEN 1 ELSE 0 END) AS other_vals,
            SUM(CASE WHEN realisedR IS NOT NULL THEN 1 ELSE 0 END) AS with_real_r
       FROM ShadowSignals WHERE userId = @u`)).recordset[0];

  console.log(`ShadowSignals — ${shape.total} rows`);
  console.log(`  benchmarkLongR NULL                                  ${shape.b_null}`);
  console.log(`  benchmarkLongR = 0 with realisedR NULL (FABRICATED)  ${shape.fabricated}   ← target`);
  console.log(`  benchmarkLongR = 0 with a real realisedR             ${shape.zero_with_real_r}   (0 = no legitimate zero exists to protect)`);
  console.log(`  any other value                                      ${shape.other_vals}`);
  console.log(`  rows with a non-NULL realisedR                       ${shape.with_real_r}   (0 = nothing has ever been measured)`);

  const sample = (await req().query(
    `SELECT TOP 8 id, symbol, venue, direction, benchmarkLongR, realisedR, scoredAt
       FROM ShadowSignals WHERE ${PREDICATE} ORDER BY id DESC`)).recordset;
  console.log(`\nmost recent rows matching the predicate:`);
  for (const r of sample) {
    console.log(`  #${r.id} ${r.symbol}/${r.venue} ${r.direction} · benchmarkLongR ${r.benchmarkLongR} · realisedR ${r.realisedR} · scoredAt ${r.scoredAt ? new Date(r.scoredAt).toISOString() : 'NULL'}`);
  }

  if (!shape.fabricated) { console.log('\nNothing to correct — predicate matches 0 rows.'); return; }

  if (!APPLY) {
    console.log(`\nSQL that would run:\n  UPDATE ShadowSignals SET benchmarkLongR = NULL\n  WHERE ${PREDICATE};   → ${shape.fabricated} rows`);
    console.log('\nDRY RUN — pass --yes to apply. A backup of the old values is written first.');
    return;
  }

  // ★ OUTPUT makes the correction SELF-DOCUMENTING: the statement returns exactly the rows it changed, with
  // the old and new value of the one column involved, in the same statement that changes them. No read-then-
  // write race, and no possibility of the backup disagreeing with what was applied.
  const res = await req().query(
    `UPDATE ShadowSignals SET benchmarkLongR = NULL
     OUTPUT deleted.id, deleted.symbol, deleted.venue, deleted.direction, deleted.scoredAt,
            deleted.realisedR, deleted.benchmarkLongR AS old_benchmarkLongR, inserted.benchmarkLongR AS new_benchmarkLongR
     WHERE ${PREDICATE};`);
  const changed = res.recordset || [];
  console.log(`\nAPPLIED — ${changed.length} row(s) changed.`);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(REPORT_DIR, `shw4-benchmark-cleanup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({
    correction: 'benchmarkLongR 0 -> NULL where realisedR IS NULL (fabricated by rOf(null) === 0)',
    predicate: PREDICATE,
    appliedAt: new Date().toISOString(),
    rowsAffected: changed.length,
    shapeBefore: shape,
    rows: changed,
  }, null, 2));
  console.log(`backup of every changed row written to ${path.relative(path.join(__dirname, '../..'), file)}`);

  // Verification, using the same predicate.
  const after = (await req().query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN benchmarkLongR IS NULL THEN 1 ELSE 0 END) AS b_null,
            SUM(CASE WHEN benchmarkLongR = 0 AND realisedR IS NULL THEN 1 ELSE 0 END) AS fabricated,
            SUM(CASE WHEN benchmarkLongR IS NOT NULL AND benchmarkLongR <> 0 THEN 1 ELSE 0 END) AS other_vals,
            SUM(CASE WHEN realisedR IS NOT NULL THEN 1 ELSE 0 END) AS with_real_r
       FROM ShadowSignals WHERE userId = @u`)).recordset[0];
  console.log(`\nVERIFY`);
  console.log(`  fabricated zeros remaining              ${after.fabricated}   (must be 0)`);
  console.log(`  benchmarkLongR NULL                     ${after.b_null}   (was ${shape.b_null}; +${changed.length} expected)`);
  console.log(`  any other non-zero value                ${after.other_vals}   (unchanged)`);
  console.log(`  rows with a non-NULL realisedR          ${after.with_real_r}   (unchanged — this correction measured nothing)`);

  const bad = changed.filter((c) => c.new_benchmarkLongR != null || Number(c.old_benchmarkLongR) !== 0 || c.realisedR != null);
  console.log(bad.length
    ? `\n★ ${bad.length} row(s) changed something OTHER than benchmarkLongR — INSPECT: ${bad.map((b) => b.id).join(', ')}`
    : `\n  every changed row: old exactly 0, new exactly NULL, realisedR untouched. ✅`);
  console.log(`\n⚠ The predicate can match again while the un-deployed scorer keeps burning rows. Re-run this`);
  console.log(`  AFTER the fix is deployed only to confirm it matches 0; until then the ledger keeps growing zeros.`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
