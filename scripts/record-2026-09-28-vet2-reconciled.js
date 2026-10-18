// scripts/record-2026-09-28-vet2-reconciled.js — the count reconciled, and a WRONG claim of mine corrected.
//   node scripts/record-2026-09-28-vet2-reconciled.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 count-reconciled##';
const ID = 1448;

const ADD = `

${MARK}
★★★ **THE 71-vs-57 DISCREPANCY IS RESOLVED, AND IT WAS \`Number(null) === 0\` — WHICH MEANS THE EARLIER APPEND TO
THIS ROW CONTAINS A CORRECTION OF MINE THAT IS ITSELF WRONG. Both are corrected here.**

**THE CAUSE, EXACTLY.** \`deliberateOne\`'s risk-veto path returns BEFORE the committee is built, so those decisions
carry **\`votes: null\`**. A tally written as \`Number(p.votes && p.votes.total) === 0\` therefore evaluates
\`Number(null)\`, which is **0** — so **every votes-less refusal was counted as an EXACT TIE**, and its
\`quantScore\` read as 0, which made it look like the quant half had declined something. Reproduced:

    decisions with NO \`votes\` object at all                          17   (all action=none, all "risk veto: ...")
    Number(p.votes && p.votes.total) === 0                           74
    ...of which votes-less:                                           17
    real ties (rows that HAVE votes, total === 0)                     57   <-- and === 0 and < 1e-9 agree exactly
    the coercion applied to quantScore/chairScore ("declined both")    17   <-- the same 17

**SO THE EARLIER 'CORRECTION' IN THIS ROW WAS THE ERROR, NOT THE FIRST CLAIM.** The first measurement said
*"the quant panel has never been the half that killed an entry — 0"* and I retracted it as a filter artifact. It
was right. **The corrected figure is \`quant: 0\`, and the 14 I reported as "quant-blamed" were 14 risk vetoes with
no committee at all.** I corrected a true statement into a false one using the exact coercion this codebase's own
comments warn about — *"\`Number(null) === 0\` made a null rate a FREE bucket"* — reproduced one layer up, in a
report, by me.

⚠ **THE FILTER STORY FROM THE EARLIER APPEND IS ALSO NOW MOOT.** I attributed the 146-vs-160 gap to a
\`payload LIKE\` filter dropping rows; the real account is above, and it is the coercion, not the filter. The lesson
is unchanged and sharper: **a derived count must not be produced by coercing a possibly-absent field.**

★★ **CORRECTED CENSUS — EVERY DECISION, NO COERCION (167 rows, 2026-09-21 .. 2026-09-28):**

    risk_veto   17   the gate refused it; NO committee sat (votes null) — never reached a seat
    approved    34
    chair_veto  35   a majority dissented AND the veto bound
    tie         57   exact halves: unanimous panel vs unanimous committee
    chair       23   chair half dragged the blend below zero without a binding veto
    quant        0   ★ the quant half has NEVER been the deciding side
    both         1
    ─────────────────
    of the 150 DELIBERATED decisions, the chair side decided 115 = 77%: 35 vetoes + 57 ties + 23 blend declines

**⇒ WHAT SHIPPED ON TOP OF THE ATTRIBUTION:** the risk-veto path now writes **\`attribution: 'risk_veto'\`** (and
\`tie: false\`) beside \`riskVetoCodes\`, so **\`attribution\` is a TOTAL partition** — before this, the 17 refusals
that never reached a seat carried no attribution at all, and a census grouping non-approvals by attribution would
have silently omitted every deterministic refusal, which is the one class the desk can attribute with certainty.
\`test/chair-veto.test.js\` now pins it (14 tests).

★ **AND ONE MORE THING THE RECONCILIATION UNCOVERED, RECORDED NOT FIXED:** \`riskVetoCodes\` is **null on 14 of
those 17**, present only on the 3 newest (\`["correlation"]\`) — exactly as the \`veto-codes\` epoch entry predicts
(prose only before 2026-09-27). **But it means those 14 refusals' \`reason\` field is the ONLY trace, and that field
reads \`"risk veto: stop capped at 0.3% of price (declared 0.645%), venue cost ..."\` — i.e. the refusal line LEADS
WITH A RESIZE NOTE.** \`reason\` is \`'risk veto: ' + risk.reasons.join('; ')\`, and \`reasons\` mixes the veto's own
text with the gate's notes in push order, where the stop-cap note is pushed FIRST. **So on 14 live rows the
headline of a refusal is the note that describes a ticket the gate RESIZED, not the rule that refused it** — the
same misattribution TRD-RSK-2 was written to end, still live in the prose channel because the codes arrived after
it. The 3 newest prove it: their codes say \`correlation\`, their prose leads with the cap.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`#${ID} not found`); process.exit(1); }
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  const c = cur.recordset[0];
  console.log(`#${ID} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('DRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  console.log(`✔ #${ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
