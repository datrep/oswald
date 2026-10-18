// scripts/append-2026-09-25-live-veto.js — append the LIVE veto diagnosis to TRD-RSK-2 (#1418).
//
// The row was written from an inferred mechanism. This appends the measurement: the rejection the owner reported
// is live on 6 of the last wakes, the rule that fires is identified from the code path that sets the flag, and
// llmCalled is false — which is the structural reason it is silent.
//
// Appends, never replaces. Dry by default.
//
//   node scripts/append-2026-09-25-live-veto.js          # report what would change
//   node scripts/append-2026-09-25-live-veto.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-25 live-veto##'; // LIKE-safe
const ID = 1418;

const ADD = `
${MARK}
★★ MEASURED LIVE, 2026-09-25 04:36-06:03 UTC — THE REJECTION THE OWNER REPORTED, IDENTIFIED EXACTLY.

The owner wrote: "top capped at 0.3% of price (declared 0.702%) positions getting capped beaucse LLM likely doesnt
know what cap it is, so it gets rejected (not like they LLm knows if it got rejected or not, its silent)."
Every part of that is confirmed, and the CAUSE is not the cap:

    #94869  06:03:20Z  action=none  llmCalled=FALSE
      risk veto: stop capped at 0.3% of price (declared 0.652%), venue cost 0.1936% = 65% of R;
                 take-profit pulled in 5% of its own distance (owner setting): ... ;
                 run-in factor 0.5 (this strategy is not parity-validated); size capped at 80% equity;
                 size capped at 0.07% risk/trade (implied 0.240% of equity)
    #94157  05:01:52Z  action=none  llmCalled=FALSE
      risk veto: stop capped at 0.3% of price (declared 0.702%), venue cost 0.1936% = 65% of R;
                 run-in factor 0.5 (this strategy is not parity-validated); size capped at 40% equity;
                 size capped at 0.07% risk/trade (implied 0.120% of equity);
                 CORRELATION 0.7761 (30d log-returns) with open position Gold >= 0.7

★ THE REASON STRING LISTS NOTES, NOT CAUSES — SO THE CAUSE HAS TO BE READ OFF THE CODE. \`risk.reasons\` accumulates
every note the gate pushes, and only SOME of them set \`v.veto\`. Cross-reading the two live strings against the
sites that actually set the flag in \`trading/agent/risk.js\`:

  · \`correlation <c> ... >= <threshold>\` (risk.js:421) — SETS \`v.veto = true\`. **THIS IS THE VETO.**
  · \`cost ceiling: ...\` (risk.js:343) — SETS \`v.veto\`, and is ABSENT from both strings, so the cost ceiling did
    NOT fire. Confirmed by the structured record on #94867: \`costShareOfR = 0.6453\` against
    \`costShareCeiling = 0.65\` — 0.0047 UNDER, not over.
  · \`stop capped at ...\`, \`take-profit pulled in ...\`, \`run-in factor 0.5 ...\`, \`size capped at ...\` — NOTES.
    Clamps and context, no veto.

A WRONG READING, CORRECTED ON THE RECORD. The first pass through these strings named the cost ceiling, because
"venue cost 0.1936% = 65% of R" reads like a breach of the 0.65 ceiling and 65% is EXACTLY the ceiling as a
percentage. It is not a breach: 0.1936/0.3000 = 0.6453, i.e. 64.53% and rendered as "65%" by rounding. The
ceiling has 0.0047 of headroom and the veto came from somewhere else entirely. The structured field is what
settles it; the prose is what nearly did not.

★★ WHAT IS ACTUALLY BLOCKING THE DESK: SILVER CANNOT BE HELD ALONGSIDE GOLD.
The veto is \`|correlation(Silver, Gold)| = 0.7761 >= 0.7\` on 30-day log-returns of 1h closes, against a 3-slot
book. The open position is a Gold short, and it stays open, so **every Silver entry is refused for as long as
Gold is held**. That is not a bug — the concentration guard is deliberate and the threshold is documented (0.7
for a 3-slot book). It IS a structural consequence nobody can currently see: the desk is not "finding no
opportunity" on Silver, it is FORBIDDEN from taking one, and the difference is invisible from every existing
surface.

★ AND \`llmCalled: false\` IS THE MECHANISM OF THE SILENCE, EXACTLY AS THE OWNER SUSPECTED. The risk gate runs
BEFORE the committee, so on these wakes no chair is consulted at all: no model is asked, no reason is generated,
and the model therefore cannot know a cap it was never shown. The owner's phrasing — "not like they LLM knows if
it got rejected or not, its silent" — is precisely right, and the reason is structural rather than a reporting
omission.

⚠ THE CAP IS STILL REAL, IT IS JUST NOT THIS. On the very same ticket the cap truncates a declared 0.652% stop to
0.300%, which carries 1.5 x 0.652 / 0.300 = **3.26R** instead of 1.5R (see the appended measurement on TRD-TP-1
for the owner's 0.702% case, which is 3.51R). So both of the owner's observations are true and they are DIFFERENT
defects with different fixes:
  · the near-miss / hit-rate problem is the CAP (and the target anchored to the declared distance);
  · the rejection is the CORRELATION GATE.
Raising the cap would not unblock a single one of these wakes.

⚠ WHAT THIS ROW DID NOT DO: the correlation threshold was NOT changed, and neither was the cap. Both are owner
decisions, and the measured consequence of raising the cap (wider stop, smaller size, R:R back to 1.5) is set out
above so the decision is made on numbers rather than on the word "rejected".

★ THE ONE THING THIS APPEND ARGUES FOR, and it is a reporting change rather than a trading one: a refusal that
happens before the committee should be VISIBLE as a refusal. Today the cause is only recoverable by reading wake
event prose against the source that produced it — which is what this append had to do, and it is not a process
that should be required to answer "why is the desk not trading".
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`row #${ID} not found — aborting`); process.exit(1); }
  const r = cur.recordset[0];
  console.log(`#${r.id} state=${r.state} info=${r.info_len} chars`);

  const already = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  if (already.recordset.length) {
    console.log(`\n⚠ marker already present on #${already.recordset.map((x) => x.id).join(', ')} — nothing to do.`);
    await pool.close();
    return;
  }
  console.log(`  append #${ID}: ${r.info_len} -> ${Number(r.info_len) + ADD.length} chars`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  await pool.request().input('info', ADD).query(
    `UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @info WHERE id = ${ID}`);
  const back = await pool.request().query(
    `SELECT LEN(CAST(info AS nvarchar(max))) AS info_len, CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${MARK}%' THEN 1 ELSE 0 END AS marked FROM Tasks WHERE id = ${ID}`);
  console.log(`\n✔ #${ID} read-back: info=${back.recordset[0].info_len} chars, marker=${back.recordset[0].marked}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
