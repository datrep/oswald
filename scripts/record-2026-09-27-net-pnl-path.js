// scripts/record-2026-09-27-net-pnl-path.js — TRD-PNL-1 (#1406): the NET P/L path is now recorded.
// Dry by default:  node scripts/record-2026-09-27-net-pnl-path.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 net-pnl-path##';
const ID = 1406;

const ADD = `

${MARK}
★★★ **BUILT: THE NET P/L PATH IS NOW RECORDED as a currency min / max / terminal range, instead of one column
overwritten every ~2.4s.** The owner's instinct (*"is the maximum/minimum P/L RECORDED as a range? if not we
should record that P/L NET"*) was right, and it was cheap for the reason they implied: **the value was already
being read and written — it was just being thrown away.** \`accountPoller.js\` says so in its own header: *"so
every earlier sample of a trade's path was overwritten and discarded."*

★ **WHY THE EXISTING RANGE DID NOT ALREADY COVER THIS, since \`mfePct\`/\`maePct\` do hold a min and a max:**
they are **percentages of the ENTRY PRICE**, they are **GROSS** (no fees, funding or swap), they sit on a
**SAMPLED tick path**, and **\`maePct\` is CIRCULAR on a loss-exit row** — the close is appended to the path and
then dominates the minimum (measured 2026-09-22: **23 of the 39 rows carrying \`maePct\` had it exactly equal to
the close excursion, to 4dp**). So a NET, currency, min/max range existed **nowhere**. It does now.

**WHAT SHIPPED:**

  · **four columns on \`Trades\`**: \`netPnlMin\`, \`netPnlMax\`, \`netPnlSamples\`, \`netPnlTerminal\`
    (\`trading/sql/2026-09-27-net-pnl-path.sql\`, idempotent, with a \`NetPnlPath\` extended property explaining
    why it exists ALONGSIDE mfePct/maePct).
  · **the tracking lives INSIDE \`store.updateTrade\`**, which is the one function every writer already passes
    through — not at each write site.

★★ **THREE DESIGN DECISIONS, EACH ONE A PLACE THIS COULD HAVE BEEN BUILT WRONG:**

  1. **IT LIVES IN \`updateTrade\`, NOT AT THE WRITE SITES.** There are **FIVE** places that write
     \`floatingPnl\` (the executor reconcile, two mirror paths, the mirror upgrade, and the poller). A fix
     applied at five sites is a fix that has been applied at four, and the one that was missed would be
     invisible — its samples simply would not extend the range, which looks exactly like a quiet trade.
  2. **min/max ARE NOT SETTABLE, AND THEY ARE WIDENED IN SQL.** They are deliberately **absent from the
     \`updatable\` allowlist**: a caller that could set a maximum could also **lower** it, and a maximum that can
     go down is not a maximum. The widening is done in SQL rather than in JS because a read-modify-write across
     two writers would **race**, and this desk samples the value every ~2.4s. A test pins both halves — and
     pins the non-vacuity of the allowlist parse, so "not present" cannot pass because the parser found nothing.
  3. **\`netPnlSamples\` IS COUNTED.** Without it, \`min == max\` reads **identically** whether the trade never
     moved or was merely never sampled. A range whose coverage is unknown is the defect class this desk keeps
     closing (the same reason the LLM spend reader separates priced from unpriced calls).

★ **AND THE TERMINAL VALUE FREEZES.** \`netPnlTerminal = ISNULL(netPnlTerminal, floatingPnl)\` — it reads the
**OLD column** (the last sample actually in force when the position ended), not a value arriving in the same
statement, and \`ISNULL\` makes it **idempotent** so a re-reconcile of an already-closed row cannot move it. **A
terminal value that can change is a current value with a misleading name.**

★★ **PROVEN, NOT ASSERTED — \`temp/net-pnl-proof.sql\` runs the EXACT expressions \`updateTrade\` emits against a
scratch table through a path of 5.00 -> 12.40 -> -8.15 -> 2.00:**

    min   -8.150000   <- the trough, not the last value
    max   12.400000   <- the peak, held through the reversal
    samples 4
    terminal 2.000000 <- written TWICE on close and unchanged the second time

**Output: \`PASS: min=trough, max=peak, samples counted, terminal frozen and idempotent\`.** A scratch table is
used deliberately: proving this on a live trade row would require fabricating a position, and the claim is about
the SQL's semantics rather than about a particular trade.

★ **TESTS: \`test/net-pnl-path.test.js\` (4)** — the allowlist exclusion and its non-vacuity, the single-home
placement with its gate ordering, the ISNULL freeze, and the migration's columns. **The desk was restarted to
load the change.** The four columns are NULL on every existing row, which is correct: the tracking begins at the
first sample after this change, and a back-filled range would be invented rather than recorded.
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
