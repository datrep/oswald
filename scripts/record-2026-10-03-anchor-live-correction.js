// scripts/record-2026-10-03-anchor-live-correction.js — CORRECTS the 2026-10-02 append on TRD-TP-1 (#1412).
// Found 2026-10-03 while briefing open-work §4.15: the anchor has been 'placed' IN PRODUCTION since 09-28.
// Appends, never replaces. Dry by default.
//   node scripts/record-2026-10-03-anchor-live-correction.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const M = '##2026-10-03 placed-already-live##';

const ADD = `
${M}
⚠ RECORD CORRECTION (found 2026-10-03 while briefing open-work §4.15). **The claim in the 2026-10-02 append above — "Route (2) stays built and OFF" — is WRONG.** \`risk.takeProfitAnchor\` has been **'placed' IN PRODUCTION since 2026-09-28 20:03:03Z** (settings journal id 117071: before "declared" -> after "placed"; recorded live in \`symbol-coverage-four-strategies-2026-09-25.md\` "A8-A10 shipped ... settings read 2026-10-02" and \`STRATEGY_AMENDMENT_REPORT.md\` "the TP-anchor switch is live").

WHAT CHANGES, AND WHAT DOES NOT:
- The D-2 DECISION is unchanged: no further anchor change, and **no revert** — reverting now would be a live change inside the TRD-PRU-1 era, exactly what one-change-per-era forbids.
- The null reading TIGHTENS rather than weakens: the offline family's placed-anchor arm (+0.074R, p~0.48) was (near-)status-quo, so its null is what "no change needed" looks like — it does NOT demonstrate a gain, which was D-2's point.
- Documents that said "ships OFF" (\`strategy-analysis-reply-2026-10-02.md\`, two rows) carry dated corrections (10-03). The "caps bend the target to 2.0R / 4.6-7.3R" reading in that table described the DECLARED-anchor behaviour; on the live 'placed' config the capped ticket re-anchors to the placed stop (~1.5R; ~1.41R with the 6% offset).
- Reopen criteria (unchanged): TP-side leakage telemetry showing decay beyond the offset's compensation, or a fresh pre-registered replay — and NOT during the prune window.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1412`);
  if (!cur.recordset.length) { console.error('#1412 not found — aborting'); process.exit(1); }
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${M}%'`);
  const c = cur.recordset[0];
  console.log(`#1412 TRD-TP-1 state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — skipped'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1412`);
  console.log('✔ #1412 correction appended');
  const chk = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1412`);
  console.log(`read-back: #1412 state=${chk.recordset[0].state} info=${chk.recordset[0].len}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
