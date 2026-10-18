// scripts/append-2026-09-25-gate-census.js — record the wake census against the gate draft.
//
//   1. APPENDS to TRD-GAT-1 (#1417) — its §1 claim is measured on the 20% of wakes that reach the committee
//   2. CREATES TRD-WAK-1 — 25% of wakes record an EMPTY reason, which no aggregate can audit
//
// Appends, never replaces. Dry by default.
//
//   node scripts/append-2026-09-25-gate-census.js          # report what would change
//   node scripts/append-2026-09-25-gate-census.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-25 gate-census##';   // LIKE-safe
const MARK2 = '##2026-09-25 empty-wake-reason##';
const GAT1 = 1417;

const GAT_ADD = `
${MARK}
★★ ITS CENTRAL CLAIM IS MEASURED ON A SUBSET, STATED AS A CLAIM ABOUT THE DESK. Corrected with a fresh census.

§1 says: "layer 5 is where entries actually die, and layer 4 (the risk gate) vetoes rarely", from 343 recorded
decisions. The owner's standing ruling is that earlier data predates the current policy set, so the census was
re-run over the **last 14 days, deduplicated by WAKE** (each wake writes TWO identical wake events, so a naive
COUNT doubles every row and inflates whichever layer dominates). **1,849 distinct wakes:**

    positions open, no proposal — committee not convened   833   45.1%   NO layer reached (no signal)
    (reason recorded as EMPTY)                            455   24.6%   NO layer reached (nothing recorded)
    deliberation declined                                 168    9.1%   layer 5
    deliberation approved                                 132    7.1%   layer 5 (approved)
    UI Fallback Pause (selector health)                    86    4.7%   bridge paused
    chair VETO — weighted chair score …                    45    2.4%   layer 5
    no_signal (flat, no proposal — chairs skipped)         66    3.6%   NO layer reached (no signal)
    chair unavailable (budget cap) — degraded entry         18    1.0%   layer 5 (degraded)
    kill switch tier soft                                   13    0.7%   none
    SESSION_LOCK (calendar / FOMC / window)                  19    1.0%   none
    risk veto: …                                          ≈10    0.5%   layer 4
    ────────────────────────────────────────────────────────────────────
    convening a committee at all:                          367   19.8%

★ THREE CORRECTIONS.

 1. THE CLAIM DESCRIBES 20% OF THE DESK. Only 367 wakes convened a committee. WITHIN that subset §1 is right —
    declines 168 + vetoes 45 are 58% of convened wakes, so the committee really is where PROPOSALS die. But the
    desk's dominant reason for not trading is that **there is no proposal to consider** (833 + 66 = 49%), which the
    five-layer table cannot express because **no layer is ever reached**. Read alone, §1 leads an engineer to
    conclude that refining layers 1-4 is pointless. It is the opposite: layers 1-4 are UPSTREAM of everything.

 2. "LAYER 4 VETOES RARELY" WAS TRUE WHEN LAYER 4 WAS RARELY REACHED. On 2026-09-25 the risk gate refused 4 of the
    day's wakes, every one with \`llmCalled: false\`, and 6 of the last 8 wakes at the time of writing — 0.5% over
    14 days, and the binding constraint within hours. The cause is a change of REGIME, not of code: proposals began
    to exist (scope fixed, replicas added) and the next deterministic layer immediately became the binding one. The
    honest generalisation is not "layer 4 vetoes rarely" but **"a layer is 'where entries die' only for the window
    it was measured on; the moment an upstream layer stops being the blocker, the next one is"** — which is exactly
    the failure mode the owner's ruling about stale data was aimed at.

 3. ⚠ 25% OF WAKES RECORD NO REASON AT ALL — 455 of 1,849. Recorded separately as **TRD-WAK-1**, because it means
    **this census is only trustworthy for the 75% that say something**, and any future layer attribution inherits
    that hole.

★ WHAT SURVIVES UNCHANGED. §4's Step 0 stands and is now BETTER specified: **58% of convened wakes are refused by
the committee, and nothing has ever tested whether those refusals predict anything.** That is still the cheapest
next measurement and still a strict prerequisite to adding pattern vocabulary to layers 1-4, because those layers
change what is PROPOSED and the proposal is not what refuses.

★ AND ONE CONSTRAINT THE CENSUS ADDS, which a pattern gate must respect. The risk veto that fired on 2026-09-25 was
the **correlation guard** — Silver against an open Gold, |r| = 0.7761 >= 0.7 — so the desk is not declining Silver,
it is FORBIDDEN from taking it while Gold is held. **A pattern gate for Silver measured without accounting for that
would be measuring the correlation guard instead**, and would report the patterns as worthless. Any evaluation of a
new gate has to run where the downstream layers are not already deciding the outcome.

★ THE REPORT IS AMENDED IN PLACE: \`trading/docs/instrument-gate-and-patterns-DRAFT.md\` gains §7 (this census, the
three corrections and what they do not change) and a stale-claim marker on §1 itself, rather than a silent rewrite.
`;

const WAK1_NAME = 'TRD-WAK-1: Wake telemetry — 25% of wakes record an EMPTY reason (455 of 1,849), so a quarter of '
  + 'the desk\'s outcomes cannot be audited or attributed to any layer';

const WAK1_INFO = `
${MARK2}
★ MEASURED 2026-09-25 over the last 14 days, deduplicated by wake: **455 of 1,849 distinct wakes (24.6%) stored an
empty \`reason\`.** Every other outcome in the census names itself; this quarter says nothing.

★ WHY IT MATTERS MORE THAN A TIDY-UP. The reason field is the only thing that makes a wake self-describing. An
empty reason:
  · cannot be categorised, so it silently joins whatever bucket a classifier's fallback happens to be;
  · is INDISTINGUISHABLE FROM A CRASH in any aggregate view — "the desk did nothing and said nothing" and "the
    desk failed before it could say anything" produce the same row;
  · and it is the reason **the layer census in TRD-GAT-1 can only be trusted for 75% of wakes**, which is a hole
    inherited by every conclusion drawn from it.

★ HOW IT WAS FOUND, which is the part worth keeping: the census needed to attribute each wake to a gate layer, the
largest non-trivial bucket after the explained ones was 455 unexplained rows, and the honest next step was to NAME
them rather than leave them as "other". They turned out to have no name to find.

⚠ NOT YET DIAGNOSED: which code path writes a wake event with no reason. It is NOT established whether a single
emitter is responsible or several, and the two-events-per-wake behaviour (also visible in this census) means any
fix must be checked against BOTH emitters — the same trap TRD-GAT-1's census had to deduplicate for.

★ THE NEXT CONCRETE STEP: find the emitter(s) that can store an empty reason and make the field unconditionally
self-describing, then re-run the layer census and see whether the distribution moves. Until then, treat any
layer attribution as conditional on the 75%.
`;

(async () => {
  const pool = await getPool();

  const cur = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id = ${GAT1}`);
  if (!cur.recordset.length) { console.error(`row #${GAT1} not found — aborting`); process.exit(1); }
  const r = cur.recordset[0];
  console.log(`#${r.id} state=${r.state} info=${r.info_len} chars  (TRD-GAT-1)`);

  const dup1 = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  const dup2 = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK2}%' OR (edictId = 52 AND name LIKE 'TRD-WAK-1:%')`);
  console.log(`marker gate-census present on: ${dup1.recordset.map((x) => x.id).join(', ') || 'none'}`);
  console.log(`TRD-WAK-1 already present on:  ${dup2.recordset.map((x) => x.id).join(', ') || 'none'}`);

  if (!dup1.recordset.length) console.log(`  append #${GAT1}: ${r.info_len} -> ${Number(r.info_len) + GAT_ADD.length} chars`);
  if (!dup2.recordset.length) console.log(`  create TRD-WAK-1  info ${WAK1_INFO.length} chars`);

  if (dup1.recordset.length && dup2.recordset.length) { console.log('\nnothing to do.'); await pool.close(); return; }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  if (!dup1.recordset.length) {
    await pool.request().input('info', GAT_ADD).query(
      `UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @info WHERE id = ${GAT1}`);
    console.log(`✔ #${GAT1} appended`);
  }
  if (!dup2.recordset.length) {
    const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
    const sortOrder = Number(maxSort.recordset[0].m) + 1;
    // ⚠ plannedStart NOT NULL and must be UTC; ⚠ state 1 = Draft = the OPEN band on edict 52 (state 3 is the done pile).
    const ins = await pool.request()
      .input('name', WAK1_NAME).input('info', WAK1_INFO).input('plannedStart', new Date()).input('sortOrder', sortOrder)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id
              VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    console.log(`✔ created TRD-WAK-1 as #${ins.recordset[0].id}`);
  }

  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE id = ${GAT1} OR (edictId = 52 AND name LIKE 'TRD-WAK-1:%')`);
  console.log('\nread-back:');
  for (const x of chk.recordset) console.log(`  #${x.id} state=${x.state} info=${x.info_len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
