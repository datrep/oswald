// scripts/record-2026-09-25-tp-offset.js — record Arabica Coffee coverage and the take-profit offset.
//
//   node scripts/record-2026-09-25-tp-offset.js         # dry run
//   node scripts/record-2026-09-25-tp-offset.js --yes   # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-25 tp-offset##'; // LIKE-safe: `[...]` is a CHARACTER CLASS in T-SQL LIKE

// The coverage addendum belongs on the coverage row; the offset is its own subject.
const COV = 1410; // TRD-COV-1
const COV_ADD = `
${MARK}
★ FIFTH INSTRUMENT (owner ask). \`Arabica Coffee\` was in the same state as the other four — a \`symbolScope\`
key holding an EXPLICIT EMPTY LIST — so it could not enter anything. It joins the replica set on the same terms,
both proven sets, track-bound: \`survaarabicacoffee\` (survivor A: dc20/gate OFF) and \`survcarabicacoffee\`
(survivor C: dc5/gate 20). \`INSTRUMENTS\` in survReplicas.js is the single source, so the two ids are GENERATED
rather than special-cased.

  CAN ENTER NOW: Gold, Oil, Silver, Sugar, Bitcoin, SGX, Arabica Coffee — SEVEN, up from TWO.
  \`unreachableEnabled\` -> none.

⚠ IT BIT FOR THE THIRD TIME AND IS WORTH NAMING: adding a strategy makes \`test/flat-scope.test.js\` fail until
it is declared in BOTH \`quant.GATE_OWNERS.donchian\` and \`.adx\`. The design is working — it forces the gate
decision instead of inheriting someone else's — but the cost is that EVERY new instrument now needs an edit to
\`quant.js\` as well, and forgetting it STRIPS the Donchian/ADX reasons from the instrument being opened. That map
is the second place to look after survReplicas.js.
`;

const TP_TASK = {
  name: 'TRD-TP-1: Exit levels — capping the stop silently moved the target from 1.5R to ~2.0R, and the venue target was never part of the strategy\'s validation',
  info: `
${MARK}
★ OWNER OBSERVATION, AND IT IS A REAL GEOMETRY DEFECT RATHER THAN BAD LUCK. On the live Gold short (Plus500 15m)
price came within a hair of \`close at profit\` (4,244.2) TWICE — around 18:00 and again near 23:00 — without
touching it, then bounced back toward the entry. A trade that nearly booked, heading for a loss. The owner's
proposal: "reduce a bit of profit for a guaranteed one … known to the chair before sending."

★★ THE GEOMETRY, MEASURED FROM THE CODE (\`exitLevels.entryLevels\`):
    target distance = LEVEL_RR x DECLARED          = 1.5 x 2xATR  = 3xATR
    stop distance   = min(DECLARED, 0.3% of price) = the CAPPED one
    effective R:R   = 1.5 x declared / stopDist    ~= 2.0 on Gold
Capping the stop did NOT just shrink the stop — it moved the TARGET from 1.5R to ~2.0R. The visible 2:1 on the
chart (13.6 points of stop against 27.3 of target) is that ratio. \`exitLevels\`' own header calls it deliberate
("leaving the TP where it is keeps the reward intact") and it does keep the reward — but a 2R target is reached
far less often than a 1.5R one, so THE NEAR-MISSES ARE A CONSEQUENCE OF THE CAP.

★★ AND THE TARGET WAS NEVER PART OF THE STRATEGY'S VALIDATION. \`turtleUltimate\` contains NO take-profit at all —
its exits are the ATR trailing stop and a reverse signal. The venue TP is an EXTRA LAYER placed by
\`wakePipeline\` -> \`entryLevels\`. So the strategy was validated WITHOUT a target, and NO BACKTEST IN THIS REPO
CAN PRICE A CHANGE TO ONE. That is why the offset ships DEFAULT 0 with no value chosen: picking one would be
inventing a number, the same error as the 4-cell grid.

★ BUILT (owner ask), four small files:
  \`agent/exitLevels.js\`  applies the offset; returns \`takeProfitOffsetPct\`, \`takeProfitDist\`,
                        \`declaredTakeProfitDist\`, and \`effectiveRR\` recomputed as \`tpDist/stopDist\` so a capped
                        stop RAISES it and an offset LOWERS it (the net number is what a chair should see).
  \`agent/wakePipeline.js\` passes the setting at the call site that places the levels.
  \`store.js\`            \`DEFAULT_SETTINGS.risk.takeProfitOffsetPct = 0\` (OFF).
  \`agent/risk.js\`        one note in \`reasons\` when non-zero.

★ THE CHAIR SEES IT BEFORE SENDING, THROUGH THE EXISTING CHANNEL. \`aggregator\` builds the chair's \`sizeNote\`
from \`risk.reasons\`, and the decision card renders the same list as \`riskReasons\` — so ONE push in risk.js makes
the policy visible to the seat that is voting AND to the record after, with no new plumbing. Pushed only when
non-zero, and the note states the R:R cost, because a chair reasoning about a 2R target that is really 1.8R is
reasoning about a trade that does not exist.

⚠ THE CONSTRAINT THAT MATTERS MOST: these levels belong to a FROZEN forward-validation candidate (TRD-29 —
\`survgold\`/\`survoil\` declare \`params: []\`, and any retuning voids the candidate). Switching the offset ON
CHANGES THE GEOMETRY OF THE TWO STRATEGIES THE DESK HAS A FORWARD RECORD FOR — the record that makes them the
two worth trusting. So the offset travels on the level result and is logged when it binds, exactly as \`cappedBy\`
is, so the forward track can be SPLIT AT THE DATE IT WAS ENABLED rather than quietly redefined.

★ "IS IT JUST A MODIFICATION OF THE BUY SCRIPT?" Nearly: four small files, and only the entry path's behaviour
changes. The one respect in which it is NOT: it edits a frozen candidate's geometry, so it needs the annotation
above or the forward track becomes uninterpretable.

★ THE TRAILING-STOP ALTERNATIVE, DISTINGUISHED — they are TWO DIFFERENT EXITS and conflating them hides that one
is already implemented:
  · THE SOFTWARE TRAILING STOP ALREADY EXISTS (\`atrStopMultiple: 2\`, i.e. 2xATR) evaluated by \`liveSignal\` at
    each wake. It is the strategy's OWN exit and the backtest models it.
  · THE VENUE TP IS THE EXTRA LAYER — an absolute level at the broker that the backtest does NOT model. The
    near-misses are against THAT level.
So an offset fixes the VENUE layer, while routing the exit entirely through the trailing stop would REMOVE the
venue TP and let the trail decide — a larger change to a frozen candidate, and one that moves the exit out of the
venue's hands into a path that only runs when a wake does.

⚠ STILL NEEDED, AND EXPLICITLY NOT GUESSED: the offset VALUE. The decisive measurement is NOT the backtest (the
target is not in it) but the desk's CLOSED TRADES — how far did price get toward the target as a share of the
target distance before reversing? That is the MFE the \`position_review\` events already record, against the offset
that would have caught each one; the same shape as \`analytics.netEdge\`'s \`MFE - |MAE| - cost\` test with the
target distance as the denominator instead of cost. SET \`risk.takeProfitOffsetPct\` TO 0 UNTIL THAT NUMBER
EXISTS; the mechanism is in place so it can be set in seconds once it does.

Verification: suite 1455/1454/0 fail; eslint 0; deployed pid 52648 healthz ok. Report:
\`trading/docs/symbol-coverage-four-strategies-2026-09-25.md\` §A7/§A8.
`,
};

(async () => {
  const pool = await getPool();
  const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  let sortOrder = Number(maxSort.recordset[0].m) + 1;

  // 1. the coverage addendum appends to the existing row
  const covHas = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' AND id = ${COV}`);
  if (covHas.recordset.length) console.log(`[ALREADY RECORDED] coverage addendum on #${COV}`);
  else console.log(`  append #${COV} (TRD-COV-1) info +${COV_ADD.length} chars`);

  // 2. the take-profit row
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE name LIKE 'TRD-TP-1:%' OR info LIKE '%${MARK}%'`);
  const existing = dup.recordset[0] || null;
  console.log(existing ? `[ALREADY RECORDED] TRD-TP-1 -> #${existing.id}` : `  create "TRD-TP-1..." info ${TP_TASK.info.length} chars, sortOrder ${sortOrder}`);

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  if (!covHas.recordset.length) {
    const r = await pool.request().input('info', COV_ADD).input('id', COV)
      .query(`UPDATE Tasks SET info = ISNULL(CAST(info AS nvarchar(max)), '') + @info WHERE id = @id`);
    console.log(`appended #${COV}: rowsAffected=${r.rowsAffected[0]}`);
  }
  if (!existing) {
    // ⚠ plannedStart is NOT NULL and must be UTC or the row renders "Inactive" for 8 hours.
    const ins = await pool.request()
      .input('name', TP_TASK.name).input('info', TP_TASK.info).input('plannedStart', new Date()).input('sortOrder', sortOrder)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT inserted.id
              VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, GETUTCDATE())`);
    console.log(`created TRD-TP-1 as #${ins.recordset[0].id}`);
  }

  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len,
            CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${MARK}%' THEN 1 ELSE 0 END AS has_mark
       FROM Tasks WHERE id = ${COV} OR name LIKE 'TRD-TP-1:%' ORDER BY id`);
  console.log('\nverify:');
  for (const c of chk.recordset) console.log(`  #${c.id} state=${c.state} info=${c.info_len} marker=${c.has_mark}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
