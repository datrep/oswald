// scripts/record-2026-09-29-pp-rev3.js
//
// Appends the rev-3 addendum to TRD-RSK-10 (#1467) and marks the rev-2 block as partly superseded IN PLACE.
//
// WHY IN PLACE MATTERS: the rev-2 addendum asserts `402/414`, `SGX 17.68%` and three halt postures, all of which
// rev 3 corrects. Appending a second block 7,000 chars below leaves a reader who stops at the rev-2 heading holding
// three wrong numbers. Same convention as the SGX annotation in the rev-2 script.
//
// DRY RUN BY DEFAULT. Marker-guarded and OCCURRENCE-COUNTED — see the 2026-09-29 idempotency note: a guard on one
// of two writes is not a guard.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const TASK_ID = 1467;
const MARKER = '##2026-09-29 rev 3##';
const REV2_LINE = '##2026-09-29 rev 2 \u2014 EXTERNAL REVIEW APPLIED (14 items)##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const DOT = '\u00B7';
const SEC = '\u00A7';

const POINTER = `${WARN} **SUPERSEDED IN PART BY THE rev 3 BLOCK LOWER IN THIS ROW.** Three numbers below are wrong and`
  + ` corrected there: the cap counts (\`402/414\` ${ARROW} \`367/402\`), the SGX ceiling (\`17.68%\` ${ARROW} \`14.97%\`),`
  + ` and all three daily-halt postures (withdrawn). Do not cite this block without reading the rev 3 one.`;

const ADDENDUM = `
${MARKER} SECOND REVIEW APPLIED (12 items)##
The owner supplied a 12-item review of rev 2. **All 12 applied**; the document is rev 3 (58,883 chars) and its
section 10 is the response log. **Three material items were wrong NUMBERS, not wording, and the review was right
about all three** ${EM} plus a fourth defect the re-count turned up that neither review had found.

${STAR}${STAR} 1. THE CAP COUNTS WERE WRONG ${EM} AND IT WAS THE SAME DEFECT AS BEFORE, IN THE OTHER DIRECTION.
  rev 2 published \`per-position 402 / risk 402 / portfolio 0\`. The review refused to believe two independent
  controls firing on exactly the same 402 and called it a probe artefact. **Correct.** rev 2's counts came from SQL
  \`LIKE '% equity'\`, and the **risk-cap line itself ends "(implied N% of equity)"** ${EM} so the pattern matched
  BOTH lines and the per-position figure was a UNION.
  RE-COUNTED in JS over \`sizeCalc.reasons[]\` on all 414 payloads (\`temp/probe-pp-review4.js\`):
      risk cap fired             402  (of 402 decisions that have a sizeCalc)
      per-position cap fired     367
      both                       367
      neither                      0
      portfolio budget             0  ${EM} still has never acted
  ${ARROW} **\`402/414\` ${ARROW} \`367/402\`**, and the brake stack is \`the risk cap, with the per-position cap behind
    it on 91% of decisions\` ${EM} not "one control deep" as rev 2 said. **This is the SECOND time the same
    \`LIKE\`-matching mistake produced a wrong count, having been confessed in the rev-2 log as a caught error.**
    It was caught, then re-committed in the same session by the same hand.

${STAR}${STAR} 2. THE SGX CEILING WAS WRONG A SECOND TIME, DIFFERENTLY. rev 2 corrected rev 1's \`7.49%\` to \`17.68%\`
  using the REALISED stop (\`|open - stopPrice|\` = 1.768%). **The risk unit the sizing path uses is the DECLARED
  distance** (\`risk.js:415\`), and measured, \`stopCap.cappedBy\` is \`null\` on **all seven** symbols ${EM} not one of
  them was capped, so declared == the venue's intended distance and the 1.768% is TRD-37 anchor drift.
  ${ARROW} **SGX ceiling \`17.68%\` ${ARROW} \`14.97%\`** (1.497% x 10). The table now carries declared AND realised
    as two labelled columns, and the ceiling uses declared.
  ${WARN} **AND REV 1'S SGX LINE WAS WRONG ONLY ONCE, NOT TWICE.** rev 1 said \`SGX 1:5, stop 1.497% -> 7.49%\`: the
    stop and the 7.49% are arithmetically correct for L=5. Only the **L** was wrong. **rev 2 called it "wrong
    twice" and introduced the second error while fixing the first.** Two passes, two different numbers, and only
    the third matches the column definition.

${STAR}${STAR} 3. THE HALT AND THE UTILISATION DERIVATION BOTH COLLAPSED AT HIGH LEVERAGE ${EM} AND THE ROOT CAUSE IS
  ONE MISTAKE I MADE TWICE: **I used the per-trade CEILING where the RESOLVED risk applies.**
      ceiling  (L x stop% at FULL purchasing power, Gold)   ${EM} 3.32%
      RESOLVED (what the desk actually risks, per trade)    ${EM} **0.5308%**   (\u00a71.4)
  So rev 2's *"at 3.32% per trade the current 3% halt means one stop-out ends the day"* is **false by ~6x**: at the
  resolved rate the halt needs **~5.7 stop-outs**, and the combined open risk today is **0.156% of equity**
  (S$6.46 across 2 positions). **It was wrong in the ALARMIST direction** ${EM} the mirror of the error class this
  desk keeps finding.
  ${ARROW} **rev 2's three halt postures (6.64% / 10% / flat 5%) are WITHDRAWN.** They were multiples of Gold's
    ceiling and are correct only for a book risking 3.32% per trade throughout ${EM} i.e. at full purchasing power
    on 1:5 instruments, a state the desk has never been in.
  ${ARROW} **The missing control is a PORTFOLIO RISK CAP \`P\`.** rev 2's \`u <= 1 - sum(risk_i)/equity\` was never
    wrong; it was applied to an **unbounded** sum. Substituting SGX (14.97% x 10 = 149.7%) gives \`u <= -49.7%\`,
    absurd. With \`sum r_i <= P\`:  **\`u <= 1 - P\`** and the halt is **\`k x P\`, k in {1,2,3}**.
  ${ARROW} **So three dials collapse into ONE decision.** Today P ~ 5.3% by accident (10 x 0.5308%) => u <= 94.7%,
    which is why the margin guard would be invisible today; P = 30% => u <= 70%, close to rev 1's guess of 60 and
    now for a stated reason. **Pick P; u and the halt follow.** (\u00a76 Q8, new.)

${STAR}${STAR} 4. OIL'S ROW IS INDETERMINATE ${EM} rev 2 ATTRIBUTED A MECHANISM THE RECORD REFUTES.
  rev 2 wrote that Oil's \`declared:realised ~4.1x\` gap "is the cap binding". The review said that does not parse.
  The review is right about the cap's DIRECTION (\`stopPolicy\` uses \`Math.min\` and sets \`cappedBy\` only when the stop
  was SHORTENED) ${EM} but the deeper problem is that **\`cappedBy\` is \`null\` on Oil's decision too.** The cap was
  never involved, and the 4.12x gap (declared 1.256% vs realised 0.305%) is UNEXPLAINED by the record.
  ${ARROW} Oil's ceiling is therefore **between 1.53% and 6.28%**, and **on the declared geometry 5% IS expressible
    on Oil** (80% of purchasing power). rev 2 asserted "not expressible". **The row now carries both values and no
    verdict.** Corrected headline: **5% is expressible on SGX, dead on five symbols, indeterminate on Oil.**

${STAR}${STAR} 5.${EM}8. THE SMALLER ITEMS (all applied, \u00a710 of the report): \u00a71.4's margin/notional unit
  ambiguity split into two rows \`${DOT}\` the **9.4x** dial-vs-resolved ratio moved INTO \u00a71.4 where the
  measurement is, out of \u00a78.2 \`${DOT}\` \`80\` and \`40\` explained as the two values
  \`maxEquityPerPositionPct\` has taken, **a % of equity**, with the 40${ARROW}80 change **absent from the settings
  journal** (independently corroborating TRD-RSK-8 #1462) \`${DOT}\` \u00a72.4's third sentence (which repeated the
  second) cut \`${DOT}\` \u00a7L3.a's *"expected to bind FIRST"* reworded to *"untestable today, because no field
  records the binding control"* \`${DOT}\` \u00a75 now says **what to do with the range** rather than only what not
  to do: re-base the CAPS on the highest ceiling in scope, keep the TARGET per-symbol, and **do NOT design for the
  modal 1:5 case** ${EM} that is rev 1's error in a different costume.

${STAR}${STAR}${STAR} AND THE RE-COUNT FOUND A FOURTH DEFECT NEITHER REVIEW HAD: **TRD-RSK-11 (#1468).**
  Asking "where does the per-position count come from?" led to the field that should have adjudicated it, and that
  field is not trustworthy:
    ${DOT} \`risk.js:630\` writes \`cappedAtPct: Number(risk.maxEquityPerPositionPct ?? 5)\` **UNCONDITIONALLY, FROM
      THE SETTING** ${EM} present whether or not the cap truncated anything.
    ${DOT} \`fieldContracts.js:411\` reads its mere presence as PROOF: \`const explained = s.cappedAtPct != null\`,
      and renders \`(cap N% bound)\`.
  Two consequences, the second far larger:
    a) **35 decisions claim a bound cap that never bound** (\`cappedAtPct\`=80 on 266, reason on 231; the 40-era is
       clean at 136/136 because the cap really was binding then).
    b) **The warn at \`fieldContracts.js:422\` is UNREACHABLE** ${EM} \`:420\` warns only on \`unexplained\`, and
       since the field is never null, \`unexplained\` is ALWAYS EMPTY. The TRD-F20-EPOCH work ("only a gap the cap
       does NOT explain is a real mismatch") is **inert by construction**.
  Verified live: \`node trading/scripts/self-health-contracts.js\` reports \`20/20 sizing event(s)\` as EXPLAINED and
  asserts \`(cap 80% bound)\` on every one.
  ${ARROW} **That is the FOURTH dead branch found in the desk's own reporting today, and the second inside a
    component whose job is to stop numbers lying.** A field that is always present cannot be evidence of anything.

${WARN}${WARN} THE HONEST TALLY ACROSS THREE PASSES, recorded because the pattern is the finding.
  rev 1: the leverage generalisation. rev 2: fixed it, introduced two more (the \`LIKE\` union; a halt AND a formula
  computed off the per-trade ceiling). rev 3: fixed those, and corrected the SGX ceiling in the opposite direction
  again.
  ${STAR} **EVERY ONE OF THOSE ERRORS RAN IN THE DIRECTION THAT MADE THE DESK LOOK MORE CONSTRAINED, MORE
    CONSERVATIVE, OR MORE BROKEN THAN IT IS.** rev 3 is the first pass where a correction moved a number TOWARDS
    the desk being fine. **The named pattern: I have been systematically wrong in whichever direction supported the
    story I was already telling.** Saying so here is cheaper than finding it a fourth time.
  ${STAR} And the corollary that actually generalises: **the reviewer's SUSPICION was a better instrument than my
    measurement.** Both material items in this pass were flagged as "not credible as stated" rather than rebutted
    with a number. **When a count looks like a coincidence, the count is usually the artefact.**

${WARN} STILL NOT IMPLEMENTED. L1${EM}L5 remain proposals. The owner reviews first.
`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the addendum is clean of console mojibake ===');
  const INTENDED = new Set([EM, STAR, WARN, ARROW, DOT, SEC].flatMap((s) => [...s]).map((c) => c.codePointAt(0)));
  const strays = [...new Set([...ADDENDUM].map((c) => c.codePointAt(0)))].filter((cp) => cp > 126 && !INTENDED.has(cp));
  if (strays.length) await fail(`addendum carries stray non-ASCII: ${strays.map((c) => 'U+' + c.toString(16)).join(', ')}`);
  console.log(`  \u2714 ${ADDENDUM.length} chars, no stray codepoints`);

  console.log('\n=== 2. RE-MEASURE the three numbers rev 3 changes ===');
  const rows = await q(`SELECT id, payload FROM dbo.TradingEvents WHERE kind = 'decision' ORDER BY id`);
  let withSc = 0, perpos = 0, risk = 0;
  for (const r of rows) {
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    const sc = p && p.sizeCalc; if (!sc) continue;
    withSc++;
    const reasons = (sc.reasons || []).join(' | ');
    if (/size capped at [\d.]+% equity/.test(reasons)) perpos++;
    if (/size capped at [\d.]+% risk\/trade/.test(reasons)) risk++;
  }
  console.log(`  decisions with a sizeCalc ${withSc} \u00b7 per-position ${perpos} \u00b7 risk ${risk}`);
  if (perpos === risk) await fail(`per-position (${perpos}) equals risk (${risk}) — that is the rev-2 symptom; re-derive before citing 367/402`);
  console.log('  \u2714 the counts differ, so rev 2\'s union is not reproducible');
  const sgx = (await q(`SELECT TOP 1 leverageRaw FROM dbo.Instruments WHERE userId=1 AND venue='plus500'
      AND symbol='SGX' AND leverageRaw IS NOT NULL ORDER BY capturedAt DESC`))[0];
  const L = Number(String(sgx.leverageRaw).split(':')[1]);
  const declPct = 1.497; // from the decision payload stopDistance / fill; re-checked by the report's §5
  console.log(`  SGX leverage 1:${L} \u00b7 declared stop ${declPct}% \u21d2 ceiling ${(L * declPct).toFixed(2)}%`);
  if (L !== 10) await fail(`SGX leverage is now 1:${L}, not 1:10 — the correction needs re-deriving`);

  console.log('\n=== 3. the row, its markers, and the in-place pointer ===');
  const row = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const info = row.info || '';
  const rev3n = info.split(MARKER).length - 1;
  const rev2n = info.split('##2026-09-29 rev 2').length - 1;
  const hasPointer = info.includes('SUPERSEDED IN PART BY THE rev 3 BLOCK');
  console.log(`  #${TASK_ID}: rev-2 markers ${rev2n} \u00b7 rev-3 markers ${rev3n} \u00b7 pointer ${hasPointer ? 'PRESENT' : 'absent'}`);
  if (rev2n !== 1) await fail(`rev-2 marker appears ${rev2n}x — expected exactly 1`);
  if (info.split(POINTER).length - 1 > 1) await fail('the pointer appears more than once');

  if (!hasPointer) {
    if (!YES) console.log('  would insert the in-place pointer under the rev-2 heading.');
    else {
      // ⚠ THE ESCAPING IS COMPUTED OUTSIDE THE TEMPLATE. The first version wrote
      // `... N'${REV2_LINE}'.replace(/'/g, "''") ...` INSIDE the template literal, so the `.replace(...)` was
      // never executed — it was sent to SQL as literal text and produced "Unclosed quotation mark". The escaping
      // has to happen on the value, before interpolation.
      const esc = (s) => String(s).replace(/'/g, "''");
      await pool.request().query(`UPDATE dbo.Tasks
        SET info = REPLACE(info, N'${esc(REV2_LINE)}', N'${esc(`${REV2_LINE}\n${POINTER}`)}')
        WHERE id = ${TASK_ID}`);
      console.log('  \u2714 pointer inserted');
    }
  }
  const needAppend = rev3n === 0;
  if (!YES) {
    console.log(needAppend ? `  would append ${ADDENDUM.length} chars.` : '  rev-3 addendum already present.');
    console.log('  DRY RUN - not written.');
    await pool.close();
    return;
  }
  if (needAppend) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log('  \u2714 rev-3 addendum appended');
  }
  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`rev-3 addendum appears ${fn}x after the write \u2014 expected exactly 1`);
  console.log(`  #${TASK_ID}.info is now ${after.n} chars, rev-3 block x${fn}`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
