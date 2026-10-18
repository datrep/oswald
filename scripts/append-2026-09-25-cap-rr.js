// scripts/append-2026-09-25-cap-rr.js — append a MEASUREMENT to TRD-TP-1 (#1412).
//
// Not a new row: #1412 already owns this subject ("capping the stop silently moved the TARGET"), and what is
// added here is the number for the owner's actual ticket — 3.51R, not the ~2.0R the row recorded — plus the
// fact that the take-profit offset cannot repair it. Appends, never replaces. Dry by default.
//
//   node scripts/append-2026-09-25-cap-rr.js          # report what would change
//   node scripts/append-2026-09-25-cap-rr.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-25 cap-rr##'; // LIKE-safe: `[...]` would be a character class, `#` is not
const ID = 1412;

const ADD = `
${MARK}
★ MEASURED FOR THE OWNER'S ACTUAL TICKET, 2026-09-25, AND THE NUMBER IS WORSE THAN THE ONE THIS ROW RECORDED.
The owner reported a stop "top capped at 0.3% of price (declared 0.702%)". Measured with the real
\`exitLevels.entryLevels\` at a declared 2xATR stop of 0.702% on a price of 100:

    cap %    stop %    target %   effectiveRR   breakeven hit rate
    off      0.7020      1.0530        1.50           40.0%
    0.3      0.3000      1.0530        3.51           22.2%
    0.4      0.4000      1.0530        2.632          27.5%
    0.5      0.5000      1.0530        2.106          32.2%
    0.6      0.6000      1.0530        1.755          36.3%
    0.702    0.7020      1.0530        1.50           40.0%

★ THE TICKET CARRIES 3.51R, NOT THE ~2.0R THIS ROW RECORDED. That earlier figure came from Gold's ordinary
geometry (declared ~0.4377%); the owner's ticket has a much wider declared stop (0.702%), and the multiplier
\`1.5 x declared / cap\` is linear in it — so the same 0.30% cap costs 3.51R on this instrument. The cap does not
shave the reward; it MULTIPLIES the reward-to-risk, because the target is anchored to the DECLARED distance while
the stop is not.

★ WHY THIS IS THE NEAR-MISS AND NOT JUST A REJECTION. At 3.51R the trade must be right **22.2%** of the time to
break even, against **40.0%** at the 1.5R the strategy actually declared. The owner's own chart observation —
"the lines at 18:00 and 9/25 are close to the profit close, but not crossed" — is exactly what a target sitting
1.053% away while risking 0.300% produces. The two symptoms have ONE cause, and it is the cap.

⚠ THE TAKE-PROFIT OFFSET CANNOT REPAIR THIS, AND SAYING SO IS THE POINT OF THIS APPEND. With the live 5% offset
the ticket becomes target 1.0003% / RR 3.334 / breakeven 23.1% — a 5% bite out of a 3.5R target moves the
breakeven hit rate by 0.9 of a percentage point. TRD-TP-1 shipped the offset because it was the SMALLEST change
that converts a near-miss into a fill, and it still does that. But an offset calibrated to the gap between
1.053% and 0.8-1.0% of price cannot substitute for a target set 3.5x too far away, and treating a filled
1.0003% target at 3.33R as healthy would be reading the symptom as the cure.

★★ THE THREE ROUTES, and they are not equivalent:
  1. RAISE THE CAP toward the declared stop (0.702% here) — restores a true 1.5R. But it WIDENS the stop, so at a
     fixed \`riskPerTradePct\` the position SHRINKS proportionally, and it re-prices every open position. This is
     also the route bounded by TRD-RSK-2's cost floor: the cap cannot go below \`roundTrip / ceiling\` without
     excluding the instrument outright.
  2. ANCHOR THE TARGET TO THE CAPPED STOP rather than the declared one — i.e. keep \`rr\` at 1.5 against the stop
     actually placed, and let the target come IN to meet it. This changes no sizing and no admissibility, and it
     attacks the 3.51R directly. It is the route this row does not yet cover, and the one the evidence now
     points at.
  3. KEEP OFFSETTING — already shipped at 5%, and measured above to be a sub-1-point repair of a 17.8-point
     problem when the cap is this far inside the declared stop.

⚠ NOT CHANGED HERE. \`LEVEL_RR\` is 1.5 and route (2) would change what the target means for every frozen
candidate, which is a strategy decision with an annotation requirement (it edits the geometry of strategies whose
forward track is being scored). The measurement is recorded so the decision is made on the number.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`row #${ID} not found — aborting rather than writing blind`); process.exit(1); }
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
    `SELECT LEN(CAST(info AS nvarchar(max))) AS info_len, CASE WHEN info LIKE '%${MARK}%' THEN 1 ELSE 0 END AS marked
     FROM Tasks WHERE id = ${ID}`);
  const b = back.recordset[0];
  console.log(`\n✔ #${ID} read-back: info=${b.info_len} chars, marker present=${b.marked === 1}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
