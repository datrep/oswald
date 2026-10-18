// scripts/record-2026-09-28-vet2-tie-attribution.js
//   · creates TRD-VET-2: the chair half decides most non-approvals, and 71 exact ties are declined UNATTRIBUTED
//   · appends a short pointer to the TRD-VET-1 row, which owns the veto rule itself
// Dry by default:  node scripts/record-2026-09-28-vet2-tie-attribution.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 tie-attribution##';
const MARK_V1 = '##2026-09-28 vet2-pointer##';

const NAME = 'TRD-VET-2: Committee — the chair half decides most non-approvals, and 71 exact ties are declined without an attribution';
const INFO = `${MARK}
★★★ **MEASURED ON ALL 160 RECORDED DECISIONS (2026-09-21 .. 2026-09-27, \`kind='decision'\`), AND THE VETO COUNTER
UNDERSTATES THE CHAIR'S ROLE BY 3.2x.**

    approved                        33   (30 entries, 3 exits — all 3 exits were approved)
    chair VETO (\`chairVeto: true\`)   35
    declined, NO veto               92   └ of which: chair half blamed 78 · quant half blamed 14
    ────────────────────────────────────
    the CHAIR HALF is the declining side in 78 of 113 non-approvals (69%), the QUANT half in 14

⚠ **FIRST, A CORRECTION OF MY OWN FIRST MEASUREMENT, ON THE RECORD.** A tally run an hour earlier over
\`payload LIKE '%"chairScore"%'\` reported \`declinedQuantOnly: 0\` — "the quant panel has never been the half that
killed an entry". **That was WRONG, and the artifact is worth naming: the LIKE filter admitted only 146 of the 160
decision events, and the 14 it dropped were exactly the quant-blamed ones**, so the filter removed the entire
population that would have falsified the claim. Same class as the GRD-5 source-selection error: a population
chosen by a convenient string is not the population the sentence is about. The corrected split is above.

★★★ **THE FINDING: 71 DECISIONS ARE EXACT TIES, AND A TIE IS DECLINED WHILE BEING EXPLICITLY *NOT* A VETO.**

    total = 0.5 x quantScore + 0.5 x chairScore
    approved = base && !vetoApplies      where base = total > 0
    vetoApplies = base && ... && majorityDissents      <-- GATED ON \`base\`

With the halves equally weighted, a UNANIMOUS panel against a UNANIMOUS committee gives \`total\` of EXACTLY 0, and
that is the desk's single most common decision shape:

    #53509 2026-09-21T23:37:59Z Gold entry qs=1 cs=-1 veto=false seats=3
    #53927 2026-09-22T00:22:33Z Oil  entry qs=1 cs=-1 veto=false seats=3
    … 71 rows, essentially all \`qs=1, cs=-1, veto=false, reason="deliberation declined"\`

**Every one of them says the same two things at once: the quant panel was UNANIMOUS FOR, all three seats were
UNANIMOUS AGAINST — and the record calls it "deliberation declined" with \`chairVeto: false\`.** So:

  * \`committeeVerdict\`'s own comment rules that *"A TIE IS NOT A VETO … and therefore not dissent."* True of the
    **label** — but \`approved = total > 0\` fails at exactly 0, so **the tie kills the entry anyway**. The comment's
    refinement (weighted score, tie ≠ dissent) is therefore inert at the boundary: you get the veto's CONSEQUENCE
    without the veto's RECORD.
  * **A report counting vetoes sees 35 where the chair half actually decided 113.** The veto counter is not merely
    a label; it is the desk's only machine-readable attribution of "why did nothing enter", and it misses 69% of
    the cases.

**WHAT I AM *NOT* PROPOSING, AND WHY.** "A tie approves" would admit **71 more entries against the 30 on record —
45% more than the desk has ever approved** — and the only outcome measurement of overruling the chairs points the
other way: TRD-VET-1 measured 13 decisions where a chair majority dissented and all 13 were approved, and the 11
that filled came to **−37.27 gross on 4W/7L**. That set also contained the period's biggest WINNER (+28.86), which
is the honest shape of the lever — it removes the tail in both directions. **On the evidence available the chairs
winning the tie is the better-supported default, so the outcome should not move yet.**

⚠ **AND THE TIE OUTCOME CANNOT BE SETTLED FROM THE DESK'S OWN RECORD, which is the part that needs saying: a
DECLINED decision places no trade, so it records no \`mfePct\` and no path — there is nothing to look up.** The
population is real (71 cases over six days, well past the 20-case evidence threshold) but answering "were the
chairs right?" needs a COUNTERFACTUAL on stored bars, which is exactly the method TRD-TP-1 (#1412) used for target
distances: take each tie's decision price, direction and levels, and measure on \`PriceBars\` whether the stop or the
1.5R target was reached first.

**TWO STEPS, AND ONLY THE FIRST IS SAFE TO DO WITHOUT A MEASUREMENT:**

  1. **ATTRIBUTE THE TIE (reporting only — changes nothing that trades).** Give the tie its own outcome on the
     decision record (\`tie\`, distinct from \`veto\` and from a decline), carrying \`quantScore\`, \`chairScore\` and the
     seat split. Then "why is the desk not trading" can be answered as a number, and the veto accounting stops
     understating the chair by 3.2x. This is the same remedy TRD-RSK-2 applied to the risk gate: name the cause in
     a field, stop making a report read prose.
  2. **THEN MEASURE THE 71 TIES against stored bars before touching the rule.** If the ties would have paid, that
     is the evidence to change \`base\`; if they would not, the current default is CONFIRMED rather than assumed,
     and the desk will have the number to say so.

⚠ **OPEN OWNER DECISION:** whether a tie should decline, approve, or be broken by a stated rule (e.g. the chairs
win on ENTRIES, which is what happens today, but with the attribution of step 1). NOT CHANGED HERE — the rule was
an explicit owner decision on 2026-09-20 and is measured in TRD-VET-1, so it is not a thing to patch in passing.
`;

const V1_ADD = `
${MARK_V1}
★ **SEE TRD-VET-2 (2026-09-28).** The rule below is measured on the whole record and it is doing MORE than this
row's text claims. Over all 160 decisions: 33 approved, 35 chair vetoes, and **92 declined WITHOUT a veto — 78 of
them on the chair half.** Because \`vetoApplies\` is gated on \`base = total > 0\`, a UNANIMOUS panel against a
UNANIMOUS committee yields \`total\` of exactly 0, so **71 of those declines are exact ties that this row's own
comment rules are "not a veto" — and they die anyway, with \`chairVeto: false\` and no attribution.** The veto
counter therefore reports 35 where the chair half actually decided 113. Attribution (not the outcome) is the fix;
see TRD-VET-2 for the measurement that has to precede any change to \`base\`.
`;

async function appendTo(pool, id, text, mark, label) {
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`);
  if (!cur.recordset.length) { console.log(`  [${label}] #${id} NOT FOUND — skipped`); return; }
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${mark}%'`);
  const c = cur.recordset[0];
  console.log(`  [${label}] #${id} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + text.length}`}`);
  if (dup.recordset.length) { console.log('    marker present — nothing to do.'); return; }
  if (!YES) { console.log('    DRY RUN — not written.'); return; }
  await pool.request().input('t', text).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${id}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`);
  console.log(`    ✔ appended -> ${back.recordset[0].len} chars`);
}

(async () => {
  const pool = await getPool();

  // ⚠ `Tasks.name` is nvarchar(510) = 255 CHARACTERS (max_length is reported in BYTES) — read the limit and check.
  const meta = await pool.request().query(`
    SELECT c.max_length, t.name AS typ FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.Tasks') AND c.name = 'name'`);
  const LIMIT = meta.recordset[0].typ === 'nvarchar' ? meta.recordset[0].max_length / 2 : meta.recordset[0].max_length;
  console.log(`Tasks.name limit ${LIMIT} chars; candidate ${NAME.length} ${NAME.length <= LIMIT ? 'OK' : '*** TOO LONG ***'}`);
  if (NAME.length > LIMIT) { console.error('refusing to write'); await pool.close(); process.exit(1); }

  console.log('\n=== the row that owns the veto rule ===');
  const v1 = await pool.request().query(`SELECT id, state, LEFT(name, 110) AS name FROM Tasks WHERE name LIKE 'TRD-VET-1:%'`);
  if (!v1.recordset.length) console.log('  (TRD-VET-1 not found by name)');
  for (const r of v1.recordset) console.log(`  #${r.id} state=${r.state}  ${r.name}`);

  console.log('\n=== TRD-VET-2 ===');
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR name LIKE 'TRD-VET-2:%'`);
  console.log(`  name ${NAME.length} chars · info ${INFO.length} chars`);
  console.log(`  ${NAME}`);
  if (dup.recordset.length) console.log(`  already recorded as #${dup.recordset[0].id} — nothing to do.`);
  else if (!YES) console.log('  DRY RUN — not written.');
  else {
    const mx = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
    const ins = await pool.request()
      .input('name', NAME).input('info', INFO).input('plannedStart', new Date()).input('sortOrder', Number(mx.recordset[0].m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id
              VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    console.log(`  ✔ created as #${ins.recordset[0].id}`);
  }

  if (v1.recordset.length) {
    console.log('\n=== pointer on the TRD-VET-1 row ===');
    await appendTo(pool, v1.recordset[0].id, V1_ADD, MARK_V1, 'TRD-VET-1');
  }

  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('\nedict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
