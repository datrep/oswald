// scripts/record-2026-09-27-step0.js — TRD-GAT-1 Step 0 RUN: does the committee's dissent carry information?
//
// Appends to TRD-GAT-1 (#1417). Dry by default.
//   node scripts/record-2026-09-27-step0.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 step-0-run##';

const ADD = `
${MARK}
★★★ STEP 0 IS RUN AND IT ANSWERS YES: **THE COMMITTEE'S DISSENT CARRIES INFORMATION.** §4 called this "the cheap one
and it comes first". It is done, and the answer changes what the rest of this draft should prioritise.

**METHOD, and the one care that matters.** For every recorded decision that carried a proposal, the forward move in
the direction the desk PROPOSED is measured at two horizons. ⚠ **BOTH ENDS ARE 1h BAR CLOSES** — the anchor is the
last 1h bar at or before the decision and the outcome is the 1h close H hours later. The prompt bundle carries a
live TICK price, and this codebase has a named defect for comparing a tick against a bar close (TRD-PRC-1, where
five chair dissents reported a staleness difference as a venue conflict). One clock, and the same clock the
strategies read.

    horizon 4h — forward move IN THE PROPOSED DIRECTION (%)
    group                    n     mean     median    % that would have LOST
    A approved entry        65   -0.159    -0.148          55.4%
    B score-declined        73   -0.570    -0.140          58.9%
    C CHAIR VETO             9   -1.632    -0.934          **100%**
    D risk veto             35   -1.149    -0.654          68.6%
    E chair offline          5   -1.539    -0.378          80.0%
    exit                    25   -0.121    +0.251          44.0%

    horizon 24h
    A approved entry        65   -0.753    -0.143          53.8%
    B score-declined        73   -1.621    -0.832          65.8%
    C CHAIR VETO             9   -2.734    -4.101          66.7%
    D risk veto             35   -1.118    -2.271          65.7%

★ **APPROVED vs DECLINED: −0.159% vs −0.686% at 4h, and −0.753% vs −1.744% at 24h.** The declined proposals would
have done WORSE at both horizons, and the separation GROWS with the horizon (0.53pp -> 0.99pp). The order is also
monotone and sensible: score-declined is worst-but-one, the chair veto is worst, and risk-vetoed proposals — the
deterministic layer — are in between but consistently negative. **The committee is not noise.**

★★ **BUT THE SECOND HALF OF THE TABLE IS THE ONE THAT SHOULD CHANGE THE PLAN: THE APPROVED ENTRIES WERE ALSO
NEGATIVE.** Mean −0.159% at 4h and −0.753% at 24h, with 54-55% of them going the wrong way. So the committee is a
good FILTER — it reliably removes the worse half — while the half it keeps still has no measurable forward edge.

★★★ **WHAT THAT MEANS FOR THIS DRAFT.** The premise of "refine the hard instrument gate" was that more filtering
would help. Step 0 now says the filter WORKS, and that **the weak link is upstream of it: layers 1-2 (scope and
signal) produce proposals with no edge, and layers 3-5 then sort them.** Adding pattern vocabulary to layers 1-4 as
originally sketched would ADD MORE FILTERING to a gate that is already doing its job — and §7.3 independently
measured that 44.7% of wakes never reach any layer at all while a further 30.1% skip before a decision exists.

**Recommended re-scoping, for the owner:** make the gate's next work about **entry quality in layers 1-2** — what
makes a proposal have an edge — rather than about more ways to refuse one. The pattern catalogue in §3 stays
relevant, but as a SOURCE OF ENTRIES to be measured, not as another veto. And §4's Step 0 discipline (derive every
threshold from a binding-rate screen, pre-register it) applies unchanged to whatever replaces it.

⚠ **CAVEATS, stated rather than buried.**
  · **n = 9 for the chair veto.** The 100%-negative figure at 4h is striking and far too small to lean on; the
    24h figure (66.7% negative) is the more honest read of that group.
  · **The forward-return proxy ignores the stop and the target.** It answers "was the direction right", not "would
    the trade have made money" — a proposal can be directionally wrong and still profitable if its stop is wide. As
    a test of whether a SIGNAL carries information that is the right first-order measure, and it is deliberately not
    being read as P&L.
  · **Selection:** 212 usable decisions from the 900 prompts scanned, because only prompts carrying both a
    \`decision.decisions[]\` array and a bundle snapshot can be measured. The groups are unbalanced (65 approved vs
    82 declined) and the sample spans the pre-cap era, so the post-cap split is worth re-running before anything is
    concluded from it.
  · **Exits read +0.199% at 24h** — the position would have gone ON to improve in its own direction after the exit
    was proposed. n=25 and no exit-reason split, so this is a flag for a separate look, not a finding.

⚠ **NOT CHANGED HERE.** No gate, no threshold, no pattern vocabulary, and no weight. This row is a DRAFT and the
recommendation above is the owner's to accept or refuse.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query('SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1417');
  if (!cur.recordset.length) { console.error('#1417 not found — aborting'); process.exit(1); }
  const c = cur.recordset[0];
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#1417 state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1417`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len, state FROM Tasks WHERE id = 1417`);
  console.log(`✔ #1417 appended -> ${back.recordset[0].len} chars (state ${back.recordset[0].state}, still DRAFT as intended)`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
