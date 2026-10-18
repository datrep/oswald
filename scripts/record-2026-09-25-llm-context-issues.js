// scripts/record-2026-09-25-llm-context-issues.js — raise the deliberation/gate issues for the next session.
//
//   node scripts/record-2026-09-25-llm-context-issues.js         # dry run
//   node scripts/record-2026-09-25-llm-context-issues.js --yes   # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const edict52 = 52;

const ROWS = [
  {
    mark: '##2026-09-25 chair-context##',
    name: 'TRD-LLM-2: LLM context — the chair is asked to size a trade it has never been told the equity for',
    info: `
##2026-09-25 chair-context##
★ ASKED BY THE OWNER, ANSWERED FROM THE BUNDLE: does the LLM know the risk/position-sizing parameters, the
current equity and the available funds? **NO — none of them.** The bundle's entire account line is:

    Account: DEMO (paper).

Never printed anywhere in the bundle: **equity (4,117.85)**, available funds / free margin (rendered nowhere at
all), risk per trade (2%), max position % equity (80%), exposure cap (100%), new trades/day (20), max open (10),
re-entry cooldown (off), adverse cap (0.3%), cost-share ceiling (0.65), TP offset (5%).

WHAT THE CHAIR DOES GET: a size in **units** plus the risk engine's notes —
\`RISK ENGINE (deterministic): proposed size 10.346 units (…notes…)\` — which is why chair-2 could quote "stop capped
at 0.3% … 58% of R". So it reads the CONSEQUENCES but not the PARAMETERS, and it cannot compute "this position
is 40% of equity" because it has never been told the equity.

★ THE FIX IS ONE LINE IN \`promptBuilder.buildBundle\`, at the \`Account: DEMO (paper).\` line: print equity, free
margin, and the active risk parameters. Levels come from code and the gate is deterministic, so this changes
what the chair can REASON about, not what it can DO.
⚠ AND THE UI SAYS THE DIAL IS INERT — "'risk per trade' (2%) has no effect while the cap binds" — which the chair
is also not told. Print that too, or the seat will reason about a size rule that is not in force.
`,
  },
  {
    mark: '##2026-09-25 panel-visibility##',
    name: 'TRD-LLM-3: LLM context — the quant panel\'s votes are computed and never shown to the seats',
    info: `
##2026-09-25 panel-visibility##
★ ASKED: "does the LLM use the other Quants?" **NO.** The chair text is built as
    \`cv = await chairVotes(userId, focusText + sizeNote, settings, chairs)\`
where \`focusText\` is the wake bundle plus \`"VOTE ON THIS PROPOSAL ONLY: …"\`. \`quantVotes\` is computed one line
EARLIER (\`const qv = quantVotes(...)\`) and **never added to the text**. So the panel's votes and \`quantScore\` are
hidden from the seats.

They DO see the raw indicators per symbol (price/ATR/ADX/Donchian) — which is why chair-1 could cite "Donchian20
floor 93.20, ADX 23.0" — but it reconstructs that view itself and never learns the panel's verdict.

★ THE ASK: either show the panel votes (and the score) in the chair text, or state explicitly in the bundle that
the panel is not shown. Today a seat is asked to vote on a proposal whose only in-scope confirmation is
invisible to it, and the READER of the decision record sees both while the seat saw one.
⚠ Decide the direction deliberately: showing a numeric score invites the seat to defer to it (the
promptBuilder header records a past defect where "the panel always outvoted it, because the panel had scored the
live number"). Stating the votes as FACTS with their own basis may be safer than stating a number.
`,
  },
  {
    mark: '##2026-09-25 panel-weights##',
    name: 'TRD-PAN-1: Quant panel — the weight-1 voter is the proposal echoed back, and the panel can never dissent',
    info: `
##2026-09-25 panel-weights##
★ MEASURED over 343 recorded decisions:
    quantScore: mean 0.672   min **0**   max 1   NEGATIVE: **0**    (196 of 343 scored exactly 1.0 = 57%)
    turtle (weight 1.0):  277 yes / 66 no        <- \`vote = proposal ? 1 : 0\`, nothing else, ever
    adx    (weight 0.5):  196 yes / 88 no / **59 NEGATIVE**   <- the ONLY voter that can dissent
★ SO: the weight-1 voter is a RESTATEMENT of "a proposal exists" — it carries information only if a proposal
might not exist — while the only informative voter sits at HALF its weight. **The weighting is backwards.**
★ AND THE PANEL CANNOT VETO: because the minimum is 0 and \`total = 0.5*quant + 0.5*chair\`, the panel can only
ever ADD. A negative chairScore alone can decline; the panel can never be the reason a trade is refused.
★ CANDIDATES: (a) drop \`turtle\` from the panel or re-scope it to something that can be negative (e.g. "the
proposal agrees with the structure direction"), (b) move weight to \`adx\`, (c) add a voter that CAN be negative,
(d) leave it and record the limitation. ⚠ Whatever is chosen must be scored the same way the gate predicates
were: does the vote carry information about the OUTCOME, and does it bind between ~10% and ~90%?
`,
  },
  {
    mark: '##2026-09-25 persona-display##',
    name: 'TRD-DEL-1: Deliberation panel — the resolved chair persona is hidden behind "seat default", so the weights are tuned blind',
    info: `
##2026-09-25 persona-display##
★ THE OWNER'S SCREENSHOT shows all three seats as **persona = "seat default"**, model blank, temp blank — with
weights 0.5 / 1 / 1.5. But the RECORDED VOTES carry personas \`trend\` / \`risk\` / \`macro\` per seat, and the per-seat
tallies differ sharply:
    chair-1  persona trend  weight 0.5 (was 1 at some point)   124 yes / 190 no   meanConf 0.690
    chair-2  persona risk   weight 1                           80 yes / 236 no    meanConf 0.724
    chair-3  persona macro  weight 1.5                         100 yes / 215 no   meanConf 0.684
So "seat default" RESOLVES to a per-seat persona the operator cannot see. **The operator is tuning weights for
personas the panel does not display** — the same "substance hidden behind a label" class as the UI audit's
F8/F14, where a field whose job is to say what something is says the same thing everywhere.
★ THE ASK: render the RESOLVED persona (and the resolved model) in the Chairs table, so a weight is changed
knowingly. Also worth showing each seat's own yes/no tally, since all three lean no and chair-2 least of all at
the heaviest dissent — numbers the operator currently cannot see.
`,
  },
  {
    mark: '##2026-09-25 gate-draft##',
    name: 'TRD-GAT-1: Entry gate — DRAFT: refine the hard instrument gate with OHLC-derivable patterns (liquidity sweep first)',
    info: `
##2026-09-25 gate-draft##
★ OWNER ASK, 2026-09-25: "i do plan to refine the hard instrument gate to enter the position … including
pre-determining if a stock is going to go down, like specific strategies like cup and handle … no work done on
that, just a draft, put on a report first." **DRAFT AND REPORT ONLY — nothing implemented, nothing enabled.**

★ REPORT: \`trading/docs/instrument-gate-and-patterns-DRAFT.md\`. It contains the gate's FIVE layers as they are
today (scope → signal → venue → risk → committee) with the measured death-rate of each, the pattern catalogue
split by what this venue can actually support, and the acceptance criteria a pattern gate must clear.

★★ THE TWO FINDINGS THAT SHOULD SHAPE IT:
 1. **The gate refuses mostly at the COMMITTEE layer, not the risk layer.** Over 343 decisions: none 216 / entry
    93 / exit 34, with reasons \`deliberation declined 174 · approved 116 · chair VETO 34\`. So adding pattern
    vocabulary changes what is PROPOSED, not what is APPROVED — and **STEP 0 is therefore to score whether the
    chair's dissent carries information at all** (do chair-rejected proposals have worse forward outcomes than
    approved ones?). That test is cheap and it comes first.
 2. **Volume is 0 on every stored chart row**, so VWAP/RVOL/volume-profile/delta are IMPOSSIBLE from this
    source — and the source report's own top-15 list contains two of them. Liquidity sweep and order block/FVG
    are the high-value patterns that need NO volume.

★ THE DISCIPLINE THAT MUST NOT BE SKIPPED: every threshold a pattern needs (sweep window, displacement body,
equality tolerance) must be DERIVED from a binding-rate screen exactly as \`k = 4\` was, and PRE-REGISTERED so it
cannot drift. \`structure.js\` already carries **un-derived placeholders (\`d\`, \`r\`, the OTE band)** and
\`survGoldStruct\`'s sensitivity grid exists to say so — adding pattern vocabulary INCREASES that debt unless each
new value is derived the same way.

⚠ SGX-SPECIFIC WARNING: \`trading/docs/sgx-vs-us-market-structure.md\` finds the venue's chart series and tick feed
disagree by ~40 bps on SGX (0% of hours agreeing one way) and that the desk's own screens measured **nothing
positive on SGX across eight configurations** (best pf 0.81). A pattern gate is MORE dangerous there than on
Gold — false breakouts are exactly the predicted regime.
`,
  },
];

(async () => {
  const pool = await getPool();
  const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  let sortOrder = Number(maxSort.recordset[0].m) + 1;

  const newRows = [];
  for (const r of ROWS) {
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${r.mark}%'`);
    if (dup.recordset.length) { console.log(`[ALREADY RECORDED] ${r.name.split(':')[0]} -> #${dup.recordset[0].id}`); continue; }
    newRows.push(r);
    console.log(`  create "${r.name.slice(0, 66)}..."  info ${r.info.length}  sortOrder ${sortOrder}`);
    sortOrder++;
  }
  if (!newRows.length) { console.log('\nall rows already exist — no write.'); await pool.close(); return; }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  let order = Number(maxSort.recordset[0].m) + 1;
  const created = [];
  for (const r of newRows) {
    // ⚠ plannedStart is NOT NULL and must be UTC or the row renders "Inactive" for 8 hours.
    const ins = await pool.request()
      .input('name', r.name).input('info', r.info).input('plannedStart', new Date()).input('sortOrder', order++)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT inserted.id
              VALUES (@name, @info, @plannedStart, 1, 1, ${edict52}, @sortOrder, GETUTCDATE())`);
    created.push({ id: ins.recordset[0].id, mark: r.mark, name: r.name.split(':')[0] });
    console.log(`created ${r.name.split(':')[0]} as #${ins.recordset[0].id}`);
  }

  const ids = created.map((c) => Number(c.id)).join(',');
  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id IN (${ids}) ORDER BY id`);
  console.log('\nverify:');
  for (const c of chk.recordset) {
    const m = created.find((x) => Number(x.id) === Number(c.id));
    const h = await pool.request().query(`SELECT CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${m.mark}%' THEN 1 ELSE 0 END AS h FROM Tasks WHERE id = ${c.id}`);
    console.log(`  #${c.id} state=${c.state} info=${c.info_len} marker=${h.recordset[0].h}`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
