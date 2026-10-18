// scripts/record-2026-09-27-trail-unreachable.js — TRD-32 (#1273): the trailing stop is unreachable.
// Dry by default:  node scripts/record-2026-09-27-trail-unreachable.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 trail-unreachable##';
const ID = 1273;

const ADD = `

${MARK}
★★★ **THE QUESTION THIS ROW SET ITSELF IS ANSWERED, AND THE ANSWER IS: THE TRAILING STOP WAS ARMED ON 0 OF 7
TRADES. It is not that it fired too late — on this geometry it CANNOT ARM AT ALL.** Measured by
\`temp/trail-armed.js\` (read-only), reproducing \`quant.openPositionContext\` and \`turtleUltimate.liveSignal\`
exactly: the anchor is the 1h-close peak (long) / trough (short) since entry, \`trail = anchor -/+ 2 x ATR\`, and
"armed" means the trail has crossed to the profitable side of the ENTRY.

    id     sym    dir   hold  MFE%     anchor     2xATR%   trail       armed?   what closed it
    1094   Oil    buy    86m   1.575    96.44      2.841    93.73       no       0.305% stop
    1088   Oil    sell  402m   0.901    91.50      1.275    92.67       no       0.338% stop
    1093   Gold   sell  703m   0.697  4252.92      1.143   4301.79       no       0.303% stop
    1092   Gold   sell  260m   0.613  4252.25      1.084   4298.56       no       0.146% stop
    1076   Gold   sell  233m   0.376  4326.95      0.823   4362.62       no       0.244% stop
    1068   Gold   sell  467m   0.357  4347.20      0.847   4384.11       no       0.353% stop
    1095   Gold   sell  281m   0.334  4262.72      0.991   4305.05       no       0.319% stop

★★★ **WHY IT CANNOT ARM, exactly.** \`trail = anchor -/+ 2 x ATR\`, so the trail crosses the entry only once the
anchor has travelled a full **2 x ATR**. Measured: **mean 2xATR = 1.286%, mean MFE achieved = 0.693%.** The trades
would have needed **~0.6% MORE** favourable movement each — and the two are not close: the trail's own width is
**1.86x the entire favourable excursion these trades make.**

★★★ **AND THE SCALE MISMATCH IS THE REAL DEFECT. The trail is 1.286% wide. The stop that actually closes these
trades is 0.30% wide — \`risk.maxAdversePct\`, and \`stop_capped\` fired ~1 per trade. A 0.30% stop fires LONG
before price can travel 1.286%, so THE TRAILING RULE IS UNREACHABLE WHILE THE CAP IS IN FORCE. It was designed
against a 2xATR stop; capping the STOP to 0.3% left the TRAIL's width at 2xATR, and nobody moved it.** The two
levels sit on scales 4.3x apart and the tighter one always wins the race.

\`atrStopMultiple: 2\` confirmed in force on BOTH layers, separately — \`symbolParams.Gold.turtle\` and
\`symbolParams.Oil.turtle\` (and \`risk.atrStopMultiple\`) — so this is the live configuration, not a default I assumed.

★★ **THE CONSEQUENCE FOR THE EXIT POLICY, stated as the gap rather than as a proposal: there is NO profit
protection between the two extremes.** The only levels that can act are (a) the venue stop at **0.30%** — pure loss,
no protection — and (b) the venue TP at **1.5 x DECLARED**, which post-cap sits beyond the instrument's typical
travel (TRD-TP-1). **Nothing exists in between.** That is the structural reason 7 of 27 trades ran to a +0.33% to
+1.58% favourable excursion and closed at a LOSS: there was no mechanism anywhere in the interval they actually
traded in.

★★ **THE FIX IS SMALL AND SPECIFIC, AND IT IS A1/A2's MISSING FORM.** The trail's width must be tied to the level
that actually governs risk — the **CAPPED** stop — not to 2xATR. A trail at \`anchor - c x cappedStopDist\` with
c ~ 1.5-2 arms at **0.45-0.60%**, which is inside the range these trades reach (mean MFE 0.693%, and 7 of 27
exceeded 0.33%). Note this is the OPPOSITE of A1 as written: A1 \`follow-through time-stop\` was found to make the
sample WORSE on every short horizon (see the A1 RE-SPEC above), and \`maxHold\` from the LONG end helped. A
cap-scaled trail is a **long-horizon-aware, level-based** rule that does not exit sooner by the clock at all —
it exits on a retrace from a stated level. **That is why it is not subject to A1's refutation.**

⚠ **NOT A COUNTERFACTUAL AND NOT A FILL.** A trail fills on a retrace, so it banks less than the MFE and can be
gapped through; the \`-8.40R\` on those 7 trades is what was LOST, not what a trail would have recovered. What is
now KNOWN rather than assumed is that the existing trail could not have been involved in any of those closes —
**it was never armed, so the give-back was not the trailing rule failing to fire; there was nothing to fire.**
The counterfactual still belongs in the Lab as a pre-registered family (rule L), with sizing held fixed in RISK
terms per the INTERACTION WARNING above, because a cap-scaled trail changes exposure as a side effect.
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
