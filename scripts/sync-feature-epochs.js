// scripts/sync-feature-epochs.js — materialise the feature timeline into `FeatureEpochs` so RAW SQL can join it.
//
// ⚠ ONE ROW PER DISTINCT LANDING DATE, NOT ONE ROW PER FEATURE. Five features landed on 2026-09-25, and a table with
// five rows sharing a `landedAt` produces five OVERLAPPING intervals — so a single row of `Trades` would match five
// epochs and a `JOIN` would multiply the result. Grouping by date keeps the intervals contiguous and disjoint, which
// is what makes `createdAt >= landedAt AND createdAt < nextLandedAt` correct.
//
//   node scripts/sync-feature-epochs.js            # report what would change
//   node scripts/sync-feature-epochs.js --yes      # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');
const { FEATURES, EPOCH, ranges: buildRanges } = require('../trading/agent/epoch');

const YES = process.argv.includes('--yes');
// ⚠ An OPEN-ENDED sentinel, so the newest epoch matches everything after it. `datetime2(0)` max is 9999-12-31
// 23:59:59, and using it means the newest range needs no special case in the join.
const OPEN_END = '9999-12-31T23:59:59';

// ⚠ THE RANGES COME FROM `agent/epoch.ranges()`, NOT FROM A SECOND GROUPING HERE. The first version of this file
// re-derived them, and the module named a regime after a feature while this table named it after the date — the same
// day, two names. One implementation is the only way the API answer and the joinable row cannot disagree.

(async () => {
  const pool = await getPool();
  const rows = buildRanges();
  console.log(`FEATURES ${FEATURES.length} -> ${rows.length} contiguous date ranges (epoch ${EPOCH})\n`);
  for (const r of rows) {
    const span = `${r.landedAt} .. ${r.nextLandedAt === OPEN_END ? 'open' : r.nextLandedAt}`;
    console.log(`  ${r.id.padEnd(26)} ${span.padEnd(30)} row#${String(r.rowId ?? '-').padEnd(5)} ${r.features.join(', ')}`);
  }
  // Contiguity is the property the join depends on, so it is CHECKED rather than assumed.
  let gap = null;
  for (let i = 0; i + 1 < rows.length; i++) if (rows[i].nextLandedAt !== rows[i + 1].landedAt) gap = `${rows[i].id} -> ${rows[i + 1].id}`;
  console.log(gap ? `\n⚠ GAP between ${gap} — the join would leave rows unmatched` : '\n✔ ranges are contiguous and disjoint');

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  // MERGE rather than delete-and-insert: a reader mid-query must not see an empty table.
  for (const r of rows) {
    await pool.request()
      .input('id', r.id).input('landedAt', new Date(r.landedAt)).input('nextLandedAt', new Date(r.nextLandedAt))
      .input('rowId', r.rowId).input('title', r.title.slice(0, 400)).input('invalidates', r.invalidates.slice(0, 1200))
      .query(`MERGE FeatureEpochs AS t USING (SELECT @id AS id) AS s ON t.id = s.id
              WHEN MATCHED THEN UPDATE SET landedAt = @landedAt, nextLandedAt = @nextLandedAt, rowId = @rowId,
                title = @title, invalidates = @invalidates, syncedAt = SYSUTCDATETIME()
              WHEN NOT MATCHED THEN INSERT (id, landedAt, nextLandedAt, rowId, title, invalidates)
                VALUES (@id, @landedAt, @nextLandedAt, @rowId, @title, @invalidates);`);
  }
  // Ranges that no longer exist in FEATURES must go, or a stale interval shadows a current one.
  const ids = rows.map((r) => `'${r.id}'`).join(',');
  const del = await pool.request().query(`DELETE FROM FeatureEpochs WHERE id NOT IN (${ids})`);
  console.log(`\n✔ upserted ${rows.length} ranges${del.rowsAffected?.[0] ? `, removed ${del.rowsAffected[0]} stale` : ''}`);

  const back = await pool.request().query('SELECT id, landedAt, nextLandedAt, rowId FROM FeatureEpochs ORDER BY landedAt');
  for (const r of back.recordset) console.log(`  ${String(r.id).padEnd(26)} ${new Date(r.landedAt).toISOString().slice(0, 10)} .. ${new Date(r.nextLandedAt).toISOString().slice(0, 10)}`);

  // ★ PROVE THE JOIN WORKS, because a join that matches nothing looks identical to a table with no rows.
  const check = await pool.request().query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN epochId IS NULL THEN 1 ELSE 0 END) AS unmatched
     FROM (SELECT TOP 5000 t.createdAt, e.id AS epochId FROM TradingEvents t
             LEFT JOIN FeatureEpochs e ON t.createdAt >= e.landedAt AND t.createdAt < e.nextLandedAt
             ORDER BY t.id DESC) x`);
  console.log(`\njoin check over the newest 5000 TradingEvents: ${check.recordset[0].total} rows, ${check.recordset[0].unmatched} unmatched`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
