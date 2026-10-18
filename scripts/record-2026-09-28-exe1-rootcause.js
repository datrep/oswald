// scripts/record-2026-09-28-exe1-rootcause.js — the precise mechanism for TRD-EXE-1 (#1454).
// Dry by default:  node scripts/record-2026-09-28-exe1-rootcause.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 exe1-root-cause##';
const ID = 1454;

const NOTE = `

${MARK}
★ **OWNER ACTION TAKEN: the surplus orders were CANCELLED MANUALLY on 2026-09-28.** So the venue book is clean.
**The desk's rows are NOT clean** — \`#1104\` Arabica and \`#1105\` Sugar are still \`unconfirmed\` and will expire to
\`failed\` in ~30 min, which will record a cancellation as a failure. Neither row knows a human resolved it.

★★ **ROOT CAUSE, MEASURED — AND IT IS TWO INDEPENDENT GAPS. EITHER ONE ALONE PRODUCES THIS.**

**(1) THE CLOSED-SESSION GUARD IS CORRECT AND ITS INPUT WAS WRONG.**
\`executor.openTrade\` (line ~73) refuses a closed instrument before submitting — TRD-52's fix, added precisely
because \`Trades 1033\` was queued into a closed session and later met as a stranger:
    \`const shut = sessionClosed(await getConnector(settings).getSession(symbol));\`
    \`if (shut.closed) { logEvent('order_blocked', {reason:'market_closed', ...}); return {placed:false, reason:'market_closed'}; }\`
★ **MEASURED: \`order_blocked\` has ZERO events today.** The guard never fired for any of the seven submits. It also
writes to \`order_blocked\` rather than \`order_rejected\` deliberately (the TRD-43 asymmetry) — so its silence is
unambiguous: **\`sessionClosed()\` returned NOT CLOSED for Arabica and Sugar while the venue's markets were shut.**
⇒ the guard is not missing; **the desk's session reading for these two instruments disagreed with the venue.** The
fix is therefore not another guard, it is to make the venue the authority on its own session — which is already the
stated design in \`sessions.js\`.

**(2) THE SUBMIT CHECK CANNOT SEE A QUEUED ORDER — A ONE-WORD SELECTOR GAP.**
\`plus500/webtrader.js:1229\` decides success by:
    \`document.querySelectorAll('.positions-orders [data-testid^="PositionRow."]')\`
and the file's own comment at :1026 says *"new position appears as [data-testid^="PositionRow."] in
.positions-orders"*. ★ **THE CONTAINER IS NAMED \`positions-orders\` — IT HOLDS BOTH.** So a queued ORDER appears in
that container and **the selector, anchored on \`PositionRow.\`, cannot match it.** The order is submitted, accepted,
queued, and the desk reports \`"position row did not appear after submit (order may have failed)"\`.
⇒ **the check must collect EVERY new row in \`.positions-orders\` and CLASSIFY it** — a position row means filled, an
order row means QUEUED (a success with a deferred outcome), anything else is unknown. That is the fix, and it must
land WITH (1): a queued order the desk can SEE is still an order it must record rather than retry.

★★ **AND THE RETRY IS THE AMPLIFIER, STILL ARMED.** Nothing refuses a second submit for a symbol carrying an
\`unconfirmed\` row, so every wake that still likes the signal adds another venue order — 7 submits in 100 minutes,
4 Arabica and 3 Sugar. **The owner has now cleaned the book; without acceptance item 4 the desk will refill it.**
⚠ **This is the highest-value remaining fix in the register, and it is not a design question — both gaps are
identified and both fixes are contained.**

⚠ **ONE MORE THING THE RECORD SHOULD CARRY:** the cancel was done by hand, so the desk learned nothing from it. There
is no event kind for "a human cancelled this at the venue". Accepting or cancelling an unconfirmed row is a state
transition the desk needs to be able to perform AND to record, or the next occurrence costs another manual session.
`;

(async () => {
  const pool = await getPool();
  const cur = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`)).recordset[0];
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`)).recordset;
  console.log(`#${ID} state=${cur.state} info=${cur.len}${dup.length ? '  [marker present]' : ` -> ${Number(cur.len) + NOTE.length}`}`);
  if (dup.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  if (!YES) { console.log('DRY RUN — not written.'); await pool.close(); return; }
  await pool.request().input('t', NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`)).recordset[0];
  console.log(`✔ #${ID} appended -> ${b.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
