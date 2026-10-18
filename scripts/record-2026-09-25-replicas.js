// scripts/record-2026-09-25-replicas.js — append the owner's ruling and the replica rebuild to TRD-COV-1.
//
//   node scripts/record-2026-09-25-replicas.js         # dry run
//   node scripts/record-2026-09-25-replicas.js --yes   # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const TASK = 1410; // TRD-COV-1
// ⚠ LIKE-safe marker: `[...]` is a CHARACTER CLASS in T-SQL LIKE and matched 192 rows in an earlier script here.
const MARK = '##2026-09-25 replicas##';

const INFO = `
${MARK}
★★ OWNER RULING, AND IT INVALIDATED THE BASIS THIS ROW WAS BUILT ON: "dont trust previous data. they are before
the new policies are implemented, and the only one that works are gold and oil, those two strategies that are
working. are you able to reproduce them for the four instruments?"

The ruling is right and the rule is worth keeping: the 4-cell grid above was measured on a ONE-YEAR WINDOW OF
STORED BARS — a basis that predates the current policy set — so it was never a qualification, and using it to
CHOOSE between cells gave a decision the data could not support. The two screens in this row are therefore
PRESERVED AS A RECORD AND READ BY NOTHING. They were not used to filter the scope, and they are not deleted,
because the reading should not be silently lost.

★ WHAT REPLACED IT. The four cross-product wrappers (\`survsilver\`, \`survsugar\`, \`survbitcoin\`, \`survsgx\`) were
DELETED, along with their test and the script that scoped them. \`trading/agent/strategies/survReplicas.js\` now
reproduces the ONLY two strategies with a live forward record — \`survgold\` (survivor A: turtle dc20, ADX gate
OFF) and \`survoil\` (survivor C: dc5, gate 20) — on each of the four instruments. Eight modules:
    survasilver survcsilver | survasugar survcsugar | survabitcoin survcbitcoin | survasgx survcsgx
Every instrument gets BOTH sets, so the transfer of each proven set is a separate experiment.

★★ THE FROZEN SET IS IMPORTED BY REFERENCE, NOT COPIED, AND THAT IS THE DESIGN.
    const SET_A = require('./survGold').DEFAULTS;   // by reference
    const SET_C = require('./survOil').DEFAULTS;
A replica that restated \`{donchianPeriod: 20, adxGate: 0, ...}\` as a literal would become a DIFFERENT strategy
the moment its survivor was re-frozen while still claiming to be that survivor's set, and nothing would notice.
Importing makes drift IMPOSSIBLE BY CONSTRUCTION rather than caught later; the \`{ ...src.set }\` at the module
boundary keeps a COPY, so a replica can never mutate a live survivor. \`test/coverage-replicas.test.js\` asserts
equal BY VALUE and distinct BY OBJECT, plus a NON-VACUITY check that the two proven sets actually differ (0x20 vs
5x20) — without which both letters could carry the same set and every other assertion would still pass.

★ TRACK-BOUND, as the survivors are (\`symbols: [one instrument]\`), proven through the REAL resolver
(\`scopeResolution.applicableOn\`), not by reading the array: without it all eight would be applicable to every
scope-listed instrument and Gold's window would be applied to Sugar by a scope typo (the 2026-09-11 leak).
★ \`reviewAuthority\` deliberately NOT set: the trend survivors are \`decider\` by TRD-89's ruling, \`decider\` is the
default, and staying silent means a future change to the default reaches the replicas too.

★ SCOPE, via \`scripts/wire-2026-09-25-replica-scope.js\` (read back FROM THE STORE, not from the object built):
  CAN ENTER: Gold, Oil, Silver, Sugar, Bitcoin, SGX  — SIX, up from TWO.
  \`unreachableEnabled\` -> none (universe 12).
  ★ The superseded ids were REMOVED from \`enabled\` AND from the scope in the same write, and the script verifies
  none survive: a scope entry naming a deleted strategy resolves to NOTHING, so the symbol would LOOK configured
  while being unable to enter — the invisible-guard shape this desk keeps finding.

★ ADDING A STRATEGY FORCED A GATE DECISION — the design working, again. \`test/flat-scope.test.js\` went red until
all eight were listed under BOTH \`quant.GATE_OWNERS.donchian\` and \`.adx\`. Omitting them would have STRIPPED the
Donchian and ADX reasons from the four instruments the replicas exist to open, while the text about untouched
instruments stayed tidy.

⚠ WHAT A REPLICA IS NOT, stated because the temptation is to read the table as a result: it is NOT a claim that
these sets work on these instruments. A 20-bar window that suits Gold is a statement about GOLD; the transfer IS
the experiment, which is why the replica is track-bound. It does NOT touch \`survgold\`/\`survoil\` — those keep the
forward track that made them survivors, and widening THEIR binding would have voided it (rule-L). It is NOT a Lab
qualification: no \`LabCandidates\` row, no dev-window hunt.
⚠ IF SGX OR SUGAR IS LATER OBSERVED TO BLEED, the set-aside screen is where to look first — it reported nothing
positive for SGX on that basis — and the honest next step is a frozen-dev-window HUNT, not a re-read of the same
window.

Verification: suite 1455/1454/0 fail; eslint clean; deployed pid 37412 healthz ok. Report addendum:
\`trading/docs/symbol-coverage-four-strategies-2026-09-25.md\` §ADDENDUM.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id = ${TASK}`);
  if (!cur.recordset.length) { console.error(`row #${TASK} not found — aborting`); process.exit(1); }
  const row = cur.recordset[0];
  console.log(`#${row.id} state=${row.state} info=${row.info_len} chars -> ${Number(row.info_len) + INFO.length}`);

  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  if (dup.recordset.length) {
    console.log(`[ALREADY RECORDED] marker present on #${dup.recordset.map((r) => r.id).join(', #')}`);
    await pool.close();
    return;
  }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  const r = await pool.request().input('info', INFO).input('id', TASK)
    .query(`UPDATE Tasks SET info = ISNULL(CAST(info AS nvarchar(max)), '') + @info WHERE id = @id`);
  console.log(`appended #${TASK}: rowsAffected=${r.rowsAffected[0]}`);

  // Verify by READING BACK, not by trusting the update count.
  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len,
            CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${MARK}%' THEN 1 ELSE 0 END AS has_mark
       FROM Tasks WHERE id = ${TASK}`);
  const c = chk.recordset[0];
  console.log(`verify: #${c.id} state=${c.state} info=${c.info_len} marker=${c.has_mark}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
