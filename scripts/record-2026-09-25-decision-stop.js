// scripts/record-2026-09-25-decision-stop.js — record the decision-card stop defect.
//
// Creates TRD-RSK-1 and, if TRD-114's own row can be found, appends the correction to ITS claim — that row's
// work is what added `costShareOfR` beside the WRONG stop and wrote "the pair cannot be re-derived wrongly
// later", which the measurement shows was false until now.
//
//   node scripts/record-2026-09-25-decision-stop.js         # dry run
//   node scripts/record-2026-09-25-decision-stop.js --yes   # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
// ⚠ LIKE-safe. `[...]` is a CHARACTER CLASS in T-SQL LIKE and matched 192 rows in this repo's earlier script.
const MARK = '##2026-09-25 decision-stop##';

const NAME = 'TRD-RSK-1: Risk reporting — the decision card publishes the DECLARED stop beside a cost share '
  + 'computed on the CAPPED one (4.86x apart), so the record can support the opposite conclusion';

const INFO = `
${MARK}
★ FOUND ON A LIVE DECISION CARD (Oil, 2026-09-25, chair-vetoed). The card published, side by side:

    stopDistance : 1.3538            (= 1.4586% of 92.815 — the DECLARED 2xATR)
    costShareOfR : 0.576   costShareCeiling : 0.65

and those two cannot both describe that position. Oil's round trip is 17.28 bps, so, computed with the desk's
OWN \`stopPolicy.costShareOf\`:

    costShareOf(0.1728, 1.4586) = 0.1185      <- what the PUBLISHED stop implies
    costShareOf(0.1728, 0.3000) = 0.5760      <- what the card actually reported (the CAPPED distance)

Verified against the real settings (maxAdversePct 0.3, ceiling 0.65 from maxCostShareOfR):
\`cappedStopDistance\` returns stopDist 0.278445, cappedBy max_adverse_pct, costPct 0.1728, costShare 0.576 —
exactly the card's number. So a reader who took the published stop and recomputed the share got 11.9% where
the desk meant 57.6%: a 4.86x error, and in the direction that turns a marginal trade into a comfortable one.

★★ AND THE CHAIR ONLY GOT IT RIGHT FROM PROSE. chair-2's veto (weight 1.0, confidence 0.75) quoted the risk
note's SENTENCE — "cap the Oil short stop at 0.3% of price versus the declared 1.459% ... venue cost 0.1728%
consumes 58% of R" — while the structured field beside it said 1.459%. A seat reasoning from the FIELD would
have seen a 1.46% stop with an 11.9% cost share, i.e. a trade with room, and voted yes. The veto itself was
correct; what is not defensible is that the correctness depended on a sentence rather than the data.

⚠ WHY IT HAPPENED, AND IT IS NOT A TYPO. \`risk.js\` carries BOTH distances and says so in its own words — "The
risk unit the venue will actually enforce, and the cap's disposition — recorded, never inferred" — but
\`aggregator.js\` published only \`stopDistance\`. \`effectiveStopDistance\` and \`stopCap\` appeared in NO other
file in \`trading/**\`: computed for the record, then dropped at the aggregation boundary. That is the same
"computed and read by nothing" shape TRD-114 recorded for \`costShareOfR\` itself, recurring ONE LAYER ABOVE
the place it was fixed — and it is the TRD-96/98/101/102/114 class, "a number that does not mean what it
says", which this desk has now hit six times.

★ THE FIX (2026-09-25). \`aggregator.js\` now carries \`effectiveStopDistance\` and \`stopCap\` — and the declared
\`stopDistance\` — on BOTH return paths. The REFUSAL path is why that matters: it is "the case that most needs
auditing" by TRD-114's own reasoning, and it carried no stop distance of any kind, so its \`costShareOfR\` was
unreconcilable by construction. Three notes in the code now state the measured case so the next reader meets
the numbers rather than the claim.

★ PINNED, WITH THE INVARIANT RATHER THAN A SHAPE: \`test/decision-stop-reconciliation.test.js\` asserts, using the
real \`stopPolicy\` functions and no database, that the reported share equals the EFFECTIVE-stop share and NOT
the declared-stop share (0.576 vs 0.1185), that the two are 4.8x+ apart so a misreading is DETECTABLE, and
that BOTH of those readings sit under the 0.65 ceiling — i.e. the cost gate passes either way, so the record
is the only place the distinction can survive. Structural half counts the fields on both return paths.

⚠ RESIDUALS, recorded not implied.
  · \`sizeCalc\` in the same record has the same disease in miniature and is NOT fixed here: \`baseSize\` is built
    on the DECLARED distance (equity x 1% / 1.3538 = 30.399, and 30.399 x 2xATR = 41.154 = equity's 1%) while
    the risk cap that produced \`finalSize\` is built on the EFFECTIVE one (10.346 x 0.2784 = 0.0700% of equity).
    Both are arithmetically correct and neither field names its distance; only the prose tells them apart.
  · The two repro studies that read \`d.stopDistance\` (\`byp1-veto-value.js\`, \`chair-override-value.js\`) still
    attribute risk to the declared distance. They predate this finding and were not re-run.
  · Whether the desk SHOULD veto an entry whose stop the risk engine's own cap has driven inside noise
    (0.2784 vs ATR 0.6769 = 0.41x ATR) is a strategy question this row does not decide. The cap is the
    measured-best lever (-28.89 net vs -72.15 uncapped), and it is also what the chair then objects to, so the
    risk lever and the committee can be systematically opposed on the same ticket. Recorded for the owner.
`;

(async () => {
  const pool = await getPool();
  const dup = await pool.request().query(
    `SELECT id FROM Tasks WHERE (edictId = 52 AND name LIKE 'TRD-RSK-1:%') OR info LIKE '%${MARK}%'`);
  console.log(`rows already carrying the marker or a TRD-RSK-1 row: ${dup.recordset.length}`);
  if (dup.recordset.length) {
    console.log(dup.recordset.map((r) => `  #${r.id}`).join('\n'));
    if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
    console.log('\nALREADY RECORDED — no write.'); await pool.close(); return;
  }

  // TRD-114's row, if it can be found by name, gets the correction to its own claim.
  const t114 = await pool.request().query(
    `SELECT id, name, LEN(CAST(info AS nvarchar(max))) AS info_len FROM Tasks WHERE name LIKE '%TRD-114%'`);
  const t114row = t114.recordset[0] || null;

  const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  const sortOrder = Number(maxSort.recordset[0].m) + 1;

  console.log(`\n  create "${NAME.slice(0, 62)}..." info ${INFO.length} chars, sortOrder ${sortOrder}`);
  console.log(t114row
    ? `  append #${t114row.id} (${String(t114row.name).slice(0, 60)}) info ${t114row.info_len} chars`
    : '  TRD-114 row not found by name — its correction goes in this row only');

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  // ⚠ plannedStart is NOT NULL and must be UTC or the row renders "Inactive" for 8 hours.
  const ins = await pool.request()
    .input('name', NAME).input('info', INFO).input('plannedStart', new Date()).input('sortOrder', sortOrder)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT inserted.id
            VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, GETUTCDATE())`);
  const newId = ins.recordset[0].id;
  console.log(`\ncreated TRD-RSK-1 as #${newId}`);

  const T114_ADD = `
${MARK}
⚠ CORRECTION TO THIS ROW'S OWN CLAIM, measured 2026-09-25 — see TRD-RSK-1. This work recorded \`costShareOfR\` "beside
the size and the stop distance ... so the pair cannot be re-derived wrongly later". The distance it landed beside
was the DECLARED one, which \`costShareOfR\` is NOT computed on (\`risk.js\` builds it on \`riskStopDist\`, the capped
distance the venue enforces), so the pair COULD be, and was, re-derived wrongly: the Oil card of 2026-09-25 showed
\`stopDistance 1.3538\` beside \`costShareOfR 0.576\`, which implies 0.1185 against the published stop and 0.5760
against the effective one — 4.86x apart, and only the prose told a reader which. \`aggregator.js\` now carries
\`effectiveStopDistance\` and \`stopCap\` on both paths, which is what makes that sentence true rather than
aspirational. The ceiling level and the refuse-never-widen design are unchanged and were not at fault.
`;
  if (t114row) {
    const r = await pool.request().input('info', T114_ADD).input('id', t114row.id)
      .query(`UPDATE Tasks SET info = ISNULL(CAST(info AS nvarchar(max)), '') + @info WHERE id = @id`);
    console.log(`appended #${t114row.id}: rowsAffected=${r.rowsAffected[0]}`);
  }

  // Verify by reading back rather than trusting the counts above.
  const ids = [Number(newId)].concat(t114row ? [t114row.id] : []);
  const check = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len,
            CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${MARK}%' THEN 1 ELSE 0 END AS has_mark
       FROM Tasks WHERE id IN (${ids.join(',')}) ORDER BY id`);
  console.log('\nverify:');
  for (const c of check.recordset) console.log(`  #${c.id} state=${c.state} info=${c.info_len} marker=${c.has_mark}`);
  const missing = check.recordset.filter((c) => !c.has_mark);
  console.log(missing.length ? `⚠ ${missing.length} row(s) LACK the marker` : 'all rows carry the marker');
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
