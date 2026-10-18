// scripts/record-2026-09-27-anc1-decisionid.js — TRD-ANC-1 (#1405): criterion (4) discharged.
// Dry by default:  node scripts/record-2026-09-27-anc1-decisionid.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 decisionid-parent##';
const ID = 1405;

const ADD = `

${MARK}
★★ **THE ACCEPTANCE LIST, AUDITED ONE BY ONE RATHER THAN ASSUMED:**

  **(1) Observe first, enforce later — DONE, shipped 2026-09-25.** \`exitLevels.fillDrift()\` computes the
  fill-vs-anchor drift and the REALISED R:R **from the fill**, records them, and changes no level (**read-only by
  construction**, which is what keeps the frozen candidate intact). \`reanchor_skipped\` logs the inert path.
  **(2) Make an inert re-anchor impossible to mistake for a working one — DONE.** \`executor.js\` emits a distinct
  \`reanchor_inert\` event when \`shift === 0\` while the fill diverged beyond the drift WARN band, and the
  \`entry_reanchored\` note is now **conditional**: \`shift === 0\` reads *"re-anchor ran but shifted NOTHING
  (shift=0)… this event cannot see the venue fill, so it does not confirm the ticket matches the decision"*. The
  false unconditional sentence is gone. So the headline defect of this row (**"the success path reports a no-op as
  a success"**, false on 30/30) **is fixed.**
  **(3) The enforcing change — STILL AN OWNER DECISION, correctly.** The \`anchorAge\` gate is built, tested and
  **OFF**, with the measured cost of each option and a stated revisit trigger (n>=50 per survivor). Not touched.
  **(4) Document the \`decisionId\` parent where a query-writer will meet it — NOW DONE** (this append).
  **(5) fieldContracts** — already carries the finding at its line 71 ("the LINK EXISTS and has all along, only its
  parent was mis-recorded"), so the code-side record was present; what was missing was the DDL-side one.

★★ **WHAT WAS ADDED FOR (4), and where.** The code comment is read by whoever reads the code; the defect bites
whoever writes the JOIN. So the rule now lives **on the column**: \`trading/sql/2026-09-27-decisionid-parent.sql\`
adds the extended property **\`DecisionIdParent\`** (936 chars) to **\`Trades.decisionId\`**, and a view
**\`dbo.vTradesWithDecision\`** that performs the CORRECT join so the right thing is also the easy thing — a warning
alone leaves the wrong join equally available. Same shape as the \`EpochNotice\` properties: a rule attached to the
object the reader is actually looking at. Verified: the property reads back, and the view returns **85 rows**,
one per trade carrying a \`decisionId\`, each with its \`TradingPrompts\` trigger and model.

★★★ **MEASURED, AND IT CORRECTS THIS ROW'S OWN FRAMING — THE FALSE JOIN IS *IMPOSSIBLE*, NOT *DORMANT*:**

    Trades.decisionId matches TradingPrompts.id :  85 of 85
    Trades.decisionId matches TradingEvents.id  :   0 of 85
    TradingPrompts.id range :      8 ..   5,308
    TradingEvents.id  range : 41,004 ..  97,547     <- DISJOINT, and DIVERGING
    ids present in BOTH series : 0

**\`TradingEvents.id\` now BEGINS at 41,004 while \`TradingPrompts.id\` tops out at 5,308, so TradingEvents grows AWAY
from the overlap. It cannot return by growing.** The historical collision (the row's examples: #1094 -> 5147, 1092
-> 5110, 1089 -> 5067) existed because \`TradingEvents.id\` had once reached ~5,000; those ids are gone and will
never be reissued. **The residual risk is therefore NOT growth — it is a RESTORE, a TRUNCATE, or a reseed of
\`TradingEvents\`**, any of which would put its identity back inside the TradingPrompts range.

⚠⚠ **AND MY FIRST DRAFT OF THAT PROPERTY SAID THE OPPOSITE, SO THE CORRECTION IS RECORDED RATHER THAN THE FILE
QUIETLY REWRITTEN.** It claimed the overlap was "dormant" and that \`TradingEvents.id\` "will grow back into the
TradingPrompts range". **The id ranges say that is WRONG** — the pruning that emptied the overlap did not postpone
it, it removed it, and the reason is monotonic divergence rather than bookkeeping. A warning that names the wrong
mechanism is worse than no warning: it would have sent a future reader looking for a collision that growth cannot
cause, while the collision a RESTORE could cause went unmentioned. The property was re-landed (936 chars) with the
divergence stated and the restore/truncate/reseed risk named instead.

⚠ **TOOLING, ONE LINE: \`sp_drop extendedproperty\` is not a procedure.** It parses as \`EXEC sp_drop\` with
\`extendedproperty\` as its argument and fails with *"Incorrect syntax near 'DecisionIdParent'"*. It is one word —
**\`sp_dropextendedproperty\`, called with NAMED parameters**. The first run of the file hit exactly this; the
property itself (\`sp_addextendedproperty\`) succeeded in the same run, so the file was idempotent for the ADD and
not for the DROP until fixed. It re-runs clean now.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`#${ID} not found`); process.exit(1); }
  const c = cur.recordset[0];
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#${ID} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  console.log(`✔ #${ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
