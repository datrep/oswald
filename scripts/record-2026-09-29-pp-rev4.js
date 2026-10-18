// scripts/record-2026-09-29-pp-rev4.js
//
// Records the THIRD review (8 items) on TRD-RSK-10 (#1467) and gates the two things this review was really about:
//   1. the report must agree WITH ITSELF (§1.1's table vs §1.1b's recount), and
//   2. the two suspicions it raised must be ANSWERED BY MEASUREMENT, not by prose.
//
// THE ANSWER WENT BOTH WAYS, which is the point of recording it:
//   - the risk cap's 402/402 IS a fire count (0 of 402 rows have implied <= cap), and
//   - rev 3's withdrawal of rev 2's Oil attribution was ITSELF the error — 112 of 414 decisions DID record a bound
//     stop cap, on four symbols. Rev 3 generalised from the seven trade-linked decisions, which are mostly from the
//     uncapped era. **Rev 3 manufactured a defect while looking for one.**
//
// DRY RUN BY DEFAULT. Marker-guarded and occurrence-counted.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 rev 4##';
// ⚠ THE ANCHOR MUST BE THE EXACT STORED LINE. The first version had an em dash between the marker and the title
// (`...rev 3## — SECOND REVIEW...`) and the stored line has none, so REPLACE matched ZERO rows — and the script
// printed “✔ pointer inserted” anyway, because it did not check. That is the same class as everything in this
// thread: A WRITE THAT REPORTS SUCCESS WITHOUT VERIFYING THE WRITE. Fixed both: exact anchor, and a read-back.
const REV3_LINE = '##2026-09-29 rev 3## SECOND REVIEW APPLIED (12 items)##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const DOT = '\u00B7';
const SEC = '\u00A7';

const POINTER = `${WARN} **PARTLY SUPERSEDED BY THE rev 4 BLOCK LOWER IN THIS ROW.** Two claims below are wrong and`
  + ` corrected there: the *"${'`'}cappedBy${'`'} is null on all seven symbols"* generalisation (112 of 414 decisions`
  + ` DID record a bound stop cap, on four symbols) and rev 3's halt conclusion (*"not the binding brake at all"* ${EM}`
  + ` a 3% halt is 57% of the 10-slot concurrent bound). Read rev 4 before citing this block.`;

const ADDENDUM = `
${MARKER} THIRD REVIEW APPLIED (8 items)##
The owner supplied an 8-item review of rev 3. **All 8 applied**; the document is rev 4 and its ${SEC}11 is the
response log. This review differed in kind from the first two: **it supplied no new facts, it tested rev 3 against
rev 3**, and it found four places where the document disagreed with itself.

${STAR}${STAR} ITEMS 2 AND 4 POINT IN OPPOSITE DIRECTIONS, AND BOTH ARE ABOUT THE SAME DEFECT CLASS.
  Both asked *"is this number the same defect as ${'`'}cappedAtPct${'`'}?"* ${EM} a field whose mere presence is read
  as proof that a control acted.

  **ITEM 2 ${EM} REFUTED, and the test is arithmetic rather than argument.** The risk cap's ${'`'}402/402${'`'} looked
  like the ${'`'}cappedAtPct${'`'} defect, and ${SEC}7 appears to show it CANNOT fire on Gold because the per-position
  cap has already truncated the size below the risk cap's own ceiling. The reason string carries the implied value, so
  a fire is checkable:
      "size capped at 0.07% risk/trade (implied 0.765% of equity)"    -- a fire requires implied > cap
      push sites in risk.js                       1, INSIDE \`if (impliedRiskPct > maxRiskPct + 1e-9)\`
      rows carrying the reason                    402
      rows with implied <= cap (cap did not bind)  **0**
      implied / cap range across all 402           **1.714x .. 17.086x**
  ${ARROW} **${'`'}402/402${'`'} is a genuine FIRE count.**
  ${STAR} AND THE REASON IT FIRES ON EVERYTHING IS WORTH KEEPING: **${'`'}maxRiskPerTradePct${'`'} has been 0.07% for
  the ENTIRE decision history** (every one of the 402 fires used 0.07; none used any other value) against sizes
  implying 0.12%-1.2%. The current setting is **5%** and there are **ZERO decisions recorded since it changed** ${EM}
  so the review's Gold arithmetic describes a state the desk has never recorded. That is a PREDICTION about the next
  decisions, not a description of the last 402, and it is now ${SEC}6 Q10.

  **ITEM 4 ${EM} CONFIRMED, AND IT EXPOSES A BIGGER ERROR IN rev 3.** The review noticed that ${SEC}5's Oil row said
  "YES" while ${SEC}2.2 said the row "cannot be given a number at all". Chasing that mismatch showed **rev 3's own
  correction was the defect.** rev 3 argued *"MEASURED, ${'`'}stopCap.cappedBy${'`'} is null on ALL SEVEN symbols, so
  the cap was never the mechanism"* ${EM} and the withdrawal of rev 2's attribution was wrong:
      measurement was of the seven decisions LINKED TO THE FILLED TRADES, most of which predate the cap era
      newest decision per symbol that CARRIES a disposition:
        Gold #105340 declared 22.1092 effective 12.5651 capPct 0.3
        Silver #105341 declared 0.6024 effective 0.1852 capPct 0.3
        Arabica Coffee #106044 declared 1.201 effective 0.8345 capPct 0.3
        Oil #94533 declared 1.1246 effective 0.2782 capPct 0.3
      **112 of 414 decisions recorded a bound stop cap, on FOUR symbols, every one at capPct 0.3.**
  ${ARROW} rev 2's mechanism call was RIGHT; **rev 3 manufactured a defect while looking for one** ${EM} and it
    generalised from a sample that was unrepresentative **for exactly the reason the report exists to describe.**
  ${ARROW} Oil now carries BOTH ceilings: **6.28%** at today's non-binding 1.5% cap, **1.46%** under the 0.3% cap.

${STAR}${STAR}${STAR} AND THE FINDING NEITHER REVIEW ASKED FOR: **THE STOP CAP IS ITSELF A RISK DIAL.**
  The ceiling is ${'`'}L x (the stop the venue ENFORCES)${'`'}, so **tightening ${'`'}maxAdversePct${'`'} LOWERS the
  ceiling** ${EM} Gold **2.75%** uncapped versus **1.52%** at the 0.3% cap that was live in September.
  ${ARROW} That is the **OPPOSITE** of the intuition that a tighter stop buys room for a bigger position, and it means
    **the stop cap and the risk target are two dials on one quantity: the expressible risk cannot be raised while the
    stop is being tightened.** ${SEC}5's table is now conditional on ${'`'}maxAdversePct${'`'} in its column heading.

${STAR} THE SELF-CONSISTENCY ITEMS (1, 3, 5, 6, 7, 8), all applied:
  ${DOT} **${SEC}1.1's table showed ${'`'}402${'`'} while ${SEC}1.1b ${EM} 500 words below ${EM} spent itself correcting
    that number. The document's most visible claim contradicted its most careful analysis.** Now ${'`'}367 / 402${'`'},
    with the denominator stated (402 decisions carry a ${'`'}sizeCalc${'`'}; 12 do not).
  ${DOT} **${SEC}L5's "5.7 stop-outs" was single-trade arithmetic applied to a DAY AGGREGATE** ${EM} the same category
    error rev 3 was correcting, one level down. A 3% halt is **57% of the concurrent bound** (10 x 0.5308% = 5.31%)
    and 28% of the sequential bound (20 x 0.5308% = 10.62%). **rev 3's "not the binding brake at all" is WITHDRAWN.**
  ${DOT} **${'`'}P${'`'} split into ${'`'}P_cap = 5.31%${'`'} and ${'`'}P_now = 1.06%${'`'}** (2 open positions). rev 3
    wrote "today the desk runs at P ~ 5.3%", **overstating the live book 5x in the sentence doing the correcting.**
  ${DOT} ${SEC}1.4's "~95% idle" mixed the MARGIN denominator with the NOTIONAL one; both are now labelled.
  ${DOT} ${'`'}7.49%${'`'} labelled as *"the correct ceiling for the wrong leverage"*.
  ${DOT} rev 3's tally claim qualified.

${WARN} THE TALLY HAS NOW CHANGED SHAPE, AND THAT IS THE MOST USEFUL THING IN THIS PASS.
  rev 1: leverage generalisation. rev 2: fixed it, introduced two more. rev 3: fixed those, and **two of its own
  corrections (the Oil withdrawal and the halt conclusion) moved in the ALARMIST direction** ${EM} the same direction as
  every error in the lineage before it.
  ${STAR} So the honest form is **not** "I am always wrong in the direction that damns the desk". It is: **I have been
    wrong in whichever direction supported the story I was already telling, and rev 3's story was "the desk is worse
    than the record shows".** rev 4 is the first pass where the corrections move the other way, and it only happened
    because a reviewer insisted on testing a number instead of accepting a narrative.
  ${STAR} And the operational lesson, which is cheap to apply: **a claim of the form "this number is probably the same
    defect as that one" must be TESTED rather than either accepted or dismissed.** Here the same suspicion was right
    about the class, wrong about the instance, and turned up a real defect in the process of being wrong.

${WARN} STILL NOT IMPLEMENTED. L1${EM}L5 remain proposals. The owner reviews first.
`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('\n=== 1. the report agrees WITH ITSELF (review item 1) ===');
  const doc = src(DOC);
  if (!doc.includes('rev 4')) await fail('the report is not marked rev 4');
  // The exact stale row that contradicted its own section.
  if (/truncates `size × price` \| \*\*402\*\*/.test(doc)) await fail('§1.1\'s table still shows the stale per-position count 402');
  // ⚠ THE TWO SECTIONS LEGITIMATELY USE DIFFERENT FORMATS — §1.1's table carries the denominator ("367 / 402") and
  // §1.1b's carries the bare figure with the denominator in prose ("**367**"). The first version of this gate
  // demanded "367 / 402" twice and failed on a report that was correct. Pin BOTH forms, not one form twice.
  if (!doc.includes('**367 / 402**')) await fail('§1.1\'s table does not carry "367 / 402"');
  if (!/\| per-position cap \(`maxEquityPerPositionPct`\) \| \*\*367\*\* \|/.test(doc)) {
    await fail('§1.1b\'s table does not carry the corrected per-position count 367');
  }
  console.log('  \u2714 no stale 402 in §1.1\'s table; 367 present in BOTH §1.1 (with denominator) and §1.1b');
  for (const h of ['#### 1.1c', '## 11. Response to the THIRD external review', 'P_cap', 'P_now']) {
    if (!doc.includes(h)) await fail(`the report is missing "${h}"`);
  }
  console.log('  \u2714 \u00a71.1c and \u00a711 present, and P is split into P_cap / P_now');

  console.log('\n=== 2. RE-MEASURE: is the risk cap a FIRE or a NOTE? (item 2) ===');
  const risk = src('trading/agent/risk.js');
  const sites = [...risk.matchAll(/reasons\.push\(`size capped at \$\{maxRiskPct\}% risk\/trade/g)].length;
  if (sites !== 1) await fail(`expected 1 push site for the risk-cap reason, found ${sites}`);
  console.log('  \u2714 exactly 1 push site for the risk-cap reason');
  const rows = await q(`SELECT id, payload FROM dbo.TradingEvents WHERE kind = 'decision' ORDER BY id`);
  const RE = /size capped at ([\d.]+)% risk\/trade \(implied ([\d.]+)% of equity\)/;
  let withReason = 0, viol = 0, lo = Infinity, hi = 0; const capVals = {};
  for (const r of rows) {
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    const sc = p && p.sizeCalc; if (!sc) continue;
    const m = RE.exec((sc.reasons || []).join(' | '));
    if (!m) continue;
    withReason++;
    capVals[m[1]] = (capVals[m[1]] || 0) + 1;
    const ratio = Number(m[2]) / Number(m[1]);
    if (ratio < lo) lo = ratio;
    if (ratio > hi) hi = ratio;
    if (!(Number(m[2]) > Number(m[1]))) viol++;
  }
  console.log(`  rows with the risk-cap reason ${withReason} \u00b7 implied<=cap ${viol} \u00b7 ratio ${lo.toFixed(3)}x..${hi.toFixed(3)}x`);
  console.log(`  distinct cap values that ever fired: ${JSON.stringify(capVals)}`);
  if (viol) await fail(`${viol} row(s) have implied <= cap \u2014 the reason IS a note and the count is a note count`);
  if (withReason === 0) await fail('no rows carry the risk-cap reason \u2014 the 5% era may have started; re-derive');
  console.log('  \u2714 every row has implied > cap: 402/402 is a FIRE count, as the report now states');

  console.log('\n=== 3. RE-MEASURE: the stop cap DID bind (item 4) ===');
  const capped = await q(`SELECT COUNT(*) AS n FROM dbo.TradingEvents WHERE kind='decision'
    AND JSON_VALUE(payload,'$.stopCap.cappedBy') IS NOT NULL`);
  const total = (await q(`SELECT COUNT(*) AS n FROM dbo.TradingEvents WHERE kind='decision'`))[0].n;
  const syms = await q(`SELECT DISTINCT JSON_VALUE(payload,'$.symbol') AS s, JSON_VALUE(payload,'$.stopCap.capPct') AS c
    FROM dbo.TradingEvents WHERE kind='decision' AND JSON_VALUE(payload,'$.stopCap.cappedBy') IS NOT NULL`);
  console.log(`  decisions with a bound stop cap: ${capped[0].n} of ${total}`);
  console.log(`  symbols: ${syms.map((s) => `${s.s}@${s.c}%`).join(' ')}`);
  if (capped[0].n === 0) await fail('no decision records a bound stop cap \u2014 rev 4\'s Oil correction would be out of date');
  if (!/cappedBy` is `null` on all seven/i.test(doc) && !doc.includes('rev 3 WITHDREW')) {
    await fail('the report no longer documents that rev 3\'s Oil withdrawal was wrong');
  }
  console.log('  \u2714 the cap bound on multiple symbols and the report records the withdrawal of the withdrawal');

  console.log('\n=== 4. the row and its markers ===');
  const row = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const info = row.info || '';
  const rev4n = info.split(MARKER).length - 1;
  const hasPointer = info.includes('PARTLY SUPERSEDED BY THE rev 4 BLOCK');
  console.log(`  #${TASK_ID}: rev-4 markers ${rev4n} \u00b7 pointer ${hasPointer ? 'PRESENT' : 'absent'}`);
  if (!hasPointer) {
    if (!YES) console.log('  would insert the in-place pointer under the rev-3 heading.');
    else {
      const esc = (s) => String(s).replace(/'/g, "''");
      if (!info.includes(REV3_LINE)) await fail('the rev-3 heading was not found in the row \u2014 the pointer anchor is wrong and REPLACE would silently match nothing');
      await pool.request().query(`UPDATE dbo.Tasks
        SET info = REPLACE(info, N'${esc(REV3_LINE)}', N'${esc(`${REV3_LINE}\n${POINTER}`)}')
        WHERE id = ${TASK_ID}`);
      // ⚠ READ IT BACK. The previous version did not, and it announced a successful insert that had not happened.
      const chk = (await q(`SELECT info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0].info || '';
      if (!chk.includes('PARTLY SUPERSEDED BY THE rev 4 BLOCK')) {
        await fail('the pointer REPLACE ran but the pointer is NOT in the row \u2014 the anchor did not match');
      }
      console.log('  \u2714 pointer inserted and read back');
    }
  }
  if (!YES) {
    console.log(rev4n === 0 ? `  would append ${ADDENDUM.length} chars. DRY RUN - not written.`
      : `  rev-4 addendum already present (${ADDENDUM.length} chars would be skipped). DRY RUN - not written.`);
    await pool.close();
    return;
  }
  if (rev4n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log('  \u2714 rev-4 addendum appended');
  } else console.log('  rev-4 addendum already present.');
  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`rev-4 addendum appears ${fn}x \u2014 expected exactly 1 (idempotency)`);
  console.log(`  #${TASK_ID}.info is now ${after.n} chars, rev-4 block x${fn}`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
