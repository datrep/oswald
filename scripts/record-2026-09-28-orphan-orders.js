// scripts/record-2026-09-28-orphan-orders.js
//   · creates TRD-EXE-1 — submits reported as FAILED are sitting in the venue's ORDER BOOK, and nothing cancels them
//   · appends the degraded-size-vs-floor ordering defect to TRD-RSK-4 (#1453)
// Dry by default:  node scripts/record-2026-09-28-orphan-orders.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 orphan-venue-orders##';
const MARK_RSK4 = '##2026-09-28 floor-vs-degradation-order##';

const NAME = 'TRD-EXE-1: Executor - submits the desk records as FAILED are sitting in the venue ORDER BOOK, and nothing cancels or adopts them';

const INFO = `${MARK}
FOUND 2026-09-28 because the OWNER LOOKED AT THE VENUE. Registered under the rule that a novel repo-specific finding
becomes a task, not a memory note.

★★★ **THE OWNER'S OBSERVATION, WHICH THE DESK'S OWN RECORD CANNOT SEE:** *"arabica coffee placed, placed on ORDERS,
since market for that is closed right now."* The desk recorded FOUR Arabica Coffee submits today. **All four were
recorded as failures.** At least one is a live, pending order at the venue.

**THE SUBMITS, verbatim from \`order_attempt\` (2026-09-28):**

    #103464 03:35:44  Arabica Coffee buy  size 3.4676   45.6s  ambiguous  "position row did not appear after submit (order may have failed)"
    #103590 03:40:34  Sugar          buy  size 9.5697   43.6s  ambiguous  "position row did not appear after submit (order may have failed)"
    #103945 04:02:20  Arabica Coffee buy  size 1.7338   43.5s  ambiguous  "position row did not appear after submit (order may have failed)"
    #104696 04:52:30  Arabica Coffee buy  size 1.7340   51.2s  other      "order ticket did not open"
    #104725 04:53:34  Sugar          buy  size 10.3066  64.3s  dom_state  "set-limits field did not enable: #close-at-loss-rate"
    #105043 05:11:28  Arabica Coffee buy  size 1.7341   43.3s  ambiguous  "position row did not appear after submit (order may have failed)"
    #105060 05:12:25  Sugar          buy  size 11.0976  43.7s  ambiguous  "position row did not appear after submit (order may have failed)"

    TODAY BY SYMBOL:  Arabica Coffee 4 submits, requested size totalling 8.6695
                      Sugar          3 submits, requested size totalling 30.9739

★ **THE MECHANISM — A FALSE NEGATIVE, NOT A FAILURE.** The executor decides a submit succeeded by looking for a
**POSITION ROW**. With Arabica's and Sugar's markets **CLOSED**, the venue accepts the order into its **ORDER BOOK**
and no position appears until the market opens. So the check cannot see a success, the code reports
\`ambiguous\` / *"order may have failed"*, and — because its own wording says *may* — **the desk treats it as unknown
and tries again later.** Four times for Arabica, three for Sugar, across 100 minutes.
★ Note the error string was ALREADY HONEST ("may have failed") and nothing acted on the uncertainty. That is the
same shape as every prose-vs-field defect in this register: the record says *unknown* and the pipeline says *retry*.

⚠⚠⚠ **THE EXPOSURE, STATED PLAINLY.** If those orders stand, Arabica opens with ~**8.67 units** of buy against a
~1.73-unit intent, and Sugar with ~**30.97 units**. Only ONE desk row exists per symbol, at \`unconfirmed\`:
**#1104 Arabica Coffee size 1.7341** and **#1105 Sugar size 11.0976**, both \`"executor open (unconfirmed — outcome
unknown)"\`. The other rows were marked \`failed\` (#1098/#1100/#1101) or \`rejected\` (#1102/#1103). ⇒ **the desk's
ledger and the venue's book disagree by a factor of about 5 on Arabica and 3 on Sugar, and the desk does not know
it.** The desk's total overnight risk is therefore not a number it can report.

★★ **AND NOTHING CANCELS OR ADOPTS THEM — MEASURED.** Event kinds written today: \`order_rejected\` 2,
\`phantom_fill\` 1, \`reconciliation\` 1, \`trade_closed\` 1 — **and the last four are all from 00:59Z, before these
submits.** The unconfirmed path's own text is \`"unconfirmed expired after 30m with no matching venue position"\` —
it **expires its own row and abandons the venue order.** There is no cancel call and no adoption call anywhere in
the path. ⇒ **an unconfirmed submit is a permanently unmanaged liability at the venue.**

★ **AND THE RETRY ITSELF IS THE AMPLIFIER.** Nothing blocks a second submit for a symbol that already has an
\`unconfirmed\` row, so each wake that still likes the signal adds another venue order. 4 Arabica + 3 Sugar is what
100 minutes produced. **The rate is bounded only by the wake cadence.**

ACCEPTANCE
  1. **IMMEDIATE, MANUAL: the owner should open the venue's Orders page and CANCEL the surplus Arabica and Sugar
     orders, keeping at most one of each at the intended size.** Neither market is open, so they are pending and
     cancellable. This row cannot do that for him.
  2. the submit check must distinguish **"no position because the market is CLOSED"** from "no position because the
     order failed" — the session state is already known at submit time (\`sessions.js\`), so this is a decision the
     executor can make, not a guess;
  3. an unconfirmed submit must be **CANCELLED or ADOPTED** within a bounded window, never expired-and-abandoned;
  4. **a symbol with an \`unconfirmed\` row must not accept another submit** until the first is resolved — the retry
     loop is what turned one stale order into seven;
  5. the ledger must not be able to carry an \`unconfirmed\` row for a symbol whose venue book could hold more than
     one live order.
NON-GOALS: do not simply widen the position-row timeout (that is the same false negative, waited out); do not
suppress the error detail — it was right.
`;

const RSK4_NOTE = `

${MARK_RSK4}
⚠ **DEFECT IN THE ACCEPTANCE I IMPLEMENTED — FOUND THE SAME DAY, ON THE FIRST LIVE TICKET.** The clamp IS reaching
production and it IS disclosing: decision **#105106, 2026-09-28T05:13:57Z**, verbatim —

    "venue floor ACCEPTED (owner setting): the venue's minimum 20 Shares exceeds the computed size, so the size was
     RAISED to the floor — this ticket carries 0.1640% of equity instead of 0.0700% (2.34x the intended risk)"

★★ **BUT THE TICKET'S OWN \`size\` FIELD READS \`10\`, AND THE DECISION SAYS WHY: \`"chair unavailable (budget cap) —
degraded entry at 50% size, quant-only"\`.** ⇒ **the chair-offline degradation halves the size AFTER
\`risk.evaluate\` has raised it to the floor, putting it back UNDER the venue minimum.** SGX was decided and
**never submitted** (no \`order_attempt\` for SGX today), which is consistent with the venue refusing 10 Shares.
**The clamp is therefore correct and useless while the chair is soft-stopped.**

**THE ORDERING IS THE BUG: the venue floor must be applied LAST — after every size reduction — or any later
reduction silently voids it.** Same class as the stop-cap/consistency work this desk has already paid for
(TRD-102: one distance, two places, and they disagreed). The fix belongs where the degraded factor is applied,
not in \`risk.evaluate\`, because \`risk.evaluate\` cannot see a reduction that happens downstream of it.
⚠ AND NOTE THE INTERACTION: the chair being soft-stopped is precisely when the desk CANNOT afford to be wrong about
size, so this is not a corner case — it is the current steady state (chair at 100.6% of cap).
`;

(async () => {
  const pool = await getPool();

  const meta = (await pool.request().query(`
    SELECT c.max_length, t.name AS typ FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.Tasks') AND c.name = 'name'`)).recordset[0];
  const LIMIT = meta.typ === 'nvarchar' ? meta.max_length / 2 : meta.max_length;
  console.log(`Tasks.name limit ${LIMIT}; candidate ${NAME.length} ${NAME.length <= LIMIT ? 'OK' : '*** TOO LONG ***'}; info ${INFO.length}`);
  if (NAME.length > LIMIT) { console.error('refusing to write'); await pool.close(); process.exit(1); }
  if ([...NAME].some((c) => c.charCodeAt(0) > 126)) { console.error('name is not pure ASCII'); await pool.close(); process.exit(1); }

  console.log('\n=== TRD-EXE label occupancy ===');
  for (const r of (await pool.request().query(`SELECT id, state, LEFT(name,70) AS name FROM Tasks WHERE name LIKE 'TRD-EXE%'`)).recordset)
    console.log(`  #${r.id} state=${r.state}  ${r.name}`);

  console.log('\n=== create TRD-EXE-1 ===');
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR name LIKE 'TRD-EXE-1:%'`)).recordset;
  if (dup.length) console.log(`  already recorded as #${dup[0].id} — nothing to do.`);
  else if (!YES) console.log('  DRY RUN — not written.');
  else {
    const mx = (await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks')).recordset;
    const anchor = (await pool.request().query('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1448')).recordset[0];
    const ins = await pool.request()
      .input('name', NAME).input('info', INFO).input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx[0].m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    const id = ins.recordset[0].id;
    const back = (await pool.request().query(`SELECT state, active, sortOrder FROM Tasks WHERE id=${id}`)).recordset[0];
    console.log(`  ✔ created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder}`);
  }

  console.log('\n=== append the ordering defect to #1453 (TRD-RSK-4) ===');
  const cur = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1453`)).recordset[0];
  const d2 = (await pool.request().query(`SELECT id FROM Tasks WHERE id = 1453 AND info LIKE '%${MARK_RSK4}%'`)).recordset;
  console.log(`  #1453 state=${cur.state} info=${cur.len}${d2.length ? '  [marker present]' : ` -> ${Number(cur.len) + RSK4_NOTE.length}`}`);
  if (d2.length) console.log('  marker present — nothing to do.');
  else if (!YES) console.log('  DRY RUN — not written.');
  else {
    await pool.request().input('t', RSK4_NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1453`);
    const b = (await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1453`)).recordset[0];
    console.log(`  ✔ #1453 appended -> ${b.len} chars`);
  }
  const s = (await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state')).recordset;
  console.log('\nedict 52 by state: ' + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
