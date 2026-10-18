// scripts/record-2026-09-25-tp-value.js — append the measured offset VALUE and the live verification.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const TASK = 1412; // TRD-TP-1
const MARK = '##2026-09-25 tp-value##'; // LIKE-safe marker

const INFO = `
${MARK}
★★ THE VALUE, MEASURED FROM THE OWNER'S OWN EVIDENCE: \`risk.takeProfitOffsetPct = 5\`  (SET AND LIVE).

The owner supplied the two near-misses as BAR DATA, which is what made this answerable without guessing:
    9/24 18:30   low 4,245.11     9/24 23:00   low 4,245.36     target 4,244.24
i.e. 0.87 and 1.12 points short of a **28.05-point** target — **3.1% and 4.0% of the target's own distance**.

★ THE MODEL REPRODUCES THE CHART'S OWN LEVELS, so this is a calibration and not an illustration. Feeding
\`entryLevels\` \`{direction:'sell', price:4,272.29, atr14:9.35, stopDistance:18.7, maxAdversePct:0.30}\` returns
target **4,244.24** and stop **4,285.1069** — the two lines drawn on the chart, to the cent. That is why the
offset could be SET rather than guessed. (\`test/tp-offset.test.js\` is the acceptance criterion and begins with
this calibration.)

★ THE RESULT, computed against the LIVE settings:
    offset 0    (was)  target 4,244.2400   R:R 2.189   both lows MISS
    offset 5%   (now)  target 4,245.6425   R:R 2.079   both lows FILL
    offset 0.2%        target 4,244.2961   R:R 2.184   both lows still MISS
⚠ \`0.0020\` WAS TESTED RATHER THAN ACCEPTED, and it is ~20x too small: as a share of the target's own distance it
moves the target 0.056 points, recovering 0.06 of the 1.12-point miss. The owner's cost intuition was right
("cents on a $10 profit") — at 5% the give-up IS ~50 cents on a $10 target — but the FRACTION was off by ~25x.

★★ WHY THE UNIT IS THE SHARE OF THE TARGET DISTANCE, AND IT MATTERS. Because the offset is a share of the
target's own distance, 5% is SCALE-FREE: the same value applies to Gold, Silver, Bitcoin, SGX, Sugar and Arabica
Coffee, and to all ten replicas, without re-deriving per instrument or per volatility regime. A price-based
threshold (or a fixed number of points) would need re-deriving for every instrument — which is the class of
per-symbol error this desk has already paid for (declared:capped being Oil 4.7x and Gold 1.9x).

★ THE CHAIR SEES IT, VERIFIED END-TO-END AND NOT BY READING THE CODE. A real \`risk.evaluate\` call on the live
settings returns the note in \`reasons\` — the list \`aggregator\` builds the chair's \`sizeNote\` from:
    "take-profit pulled in 5% of its own distance (owner setting): the target sits closer to the entry so a
     near-miss books a win, and the effective R:R falls by the same proportion"
beside the pre-existing geometry note ("stop capped at 0.3% of price (declared 0.438%), venue cost 0.1194% = 40%
of R"), so a chair now sees BOTH halves of the asymmetry — the cap that pushed the target out and the offset that
pulls it back.

⚠ WHAT 5% IS: a value derived from TWO observations (n=2) on ONE instrument. It is a defensible opening value and
it is ANNOTATED — the offset travels on the level result and the settings write is dated — so the survivors'
forward track can be SPLIT AT 2026-09-25 rather than quietly redefined (TRD-29: any retuning voids the
candidate). Re-derive it from the full MFE study across closed trades when that exists; this row does not claim
5% is optimal, only that it catches the two misses that prompted the change.

Verification: suite 1460/1459/0 fail; eslint 0; deployed pid 37368 healthz ok.
`;

(async () => {
  const pool = await getPool();
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  if (dup.recordset.length) { console.log(`[ALREADY RECORDED] on #${dup.recordset.map((r) => r.id).join(', #')}`); await pool.close(); return; }
  const cur = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id = ${TASK}`);
  if (!cur.recordset.length) { console.error(`row #${TASK} not found`); process.exit(1); }
  console.log(`#${TASK} info ${cur.recordset[0].info_len} -> ${Number(cur.recordset[0].info_len) + INFO.length} chars`);
  if (!YES) { console.log('DRY RUN — pass --yes to write.'); await pool.close(); return; }

  const r = await pool.request().input('info', INFO).input('id', TASK)
    .query(`UPDATE Tasks SET info = ISNULL(CAST(info AS nvarchar(max)), '') + @info WHERE id = @id`);
  console.log(`appended #${TASK}: rowsAffected=${r.rowsAffected[0]}`);
  const chk = await pool.request().query(
    `SELECT id, LEN(CAST(info AS nvarchar(max))) AS info_len,
            CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${MARK}%' THEN 1 ELSE 0 END AS has_mark
       FROM Tasks WHERE id = ${TASK}`);
  console.log(`verify: #${chk.recordset[0].id} info=${chk.recordset[0].info_len} marker=${chk.recordset[0].has_mark}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
