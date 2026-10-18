// scripts/record-2026-09-27-epoch-unmatched-note.js — addendum to TRD-DAT-1 (#1422): what "unmatched" means.
// Dry by default.
//   node scripts/record-2026-09-27-epoch-unmatched-note.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 epoch-unmatched-note##';
const TASK_ID = 1422;

const ADD = `

${MARK}
★ **WHAT "0 UNMATCHED" SHOULD MEAN, because the first version of this check asked for the wrong thing.** My own
verification printed \`Trades unmatched: 68\` and treated it as a failure against an \`expect 0\`. **The expectation was
wrong, not the join.** All **68** predate the earliest range (\`2026-09-19\`), so they have no regime *by construction*
— that is the \`pre-registry\` case, which is the mechanism **behaving as designed**: it refuses to attribute a
provenance it does not hold. The 68 are exactly the pre-epoch \`Trades\` the prune below deliberately KEPT.

  ⇒ The claim that carries information is **not** "0 unmatched rows". It is:
     **"0 unmatched rows sit INSIDE a range"** (\`createdAt >= MIN(landedAt)\`) — only those would mean the join
     predicate is broken, and a count alone cannot tell the two apart. Measured: **68 pre-registry / 0 inside.**

★ **Naming the two cases separately is the difference between a check and a coincidence.** "0 unmatched" would have
been satisfied by a registry that covered nothing, and "68 unmatched" reads as a defect when it is the feature
working. Both numbers are now on the record, and the \`pre-registry\` answer is why the second one is *not* a silent
gap: a row the registry cannot place **says so**, rather than being quietly absorbed into the nearest regime.

★ Reconciled against the biggest table too, since that is the one measurements read: **\`TradingEvents\` unmatched = 0**
— consistent with the prune, which left nothing below \`2026-09-21\` (earliest surviving event
\`2026-09-21T00:00:04.963Z\`). \`FeatureEpochs\` holds 4 rows / 4 distinct ranges with 3 contiguous joining pairs, and
the 4 views and 3 extended properties are all present.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${TASK_ID}`);
  if (!cur.recordset.length) { console.error(`#${TASK_ID} not found — aborting`); process.exit(1); }
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#${TASK_ID} info=${cur.recordset[0].len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(cur.recordset[0].len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${TASK_ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${TASK_ID}`);
  console.log(`✔ #${TASK_ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
