// scripts/record-2026-09-29-purchasing-power-rev2.js
//
// Records the EXTERNAL REVIEW of the purchasing-power report on TRD-RSK-10 (#1467) as an addendum, and corrects the
// two numbers the review's item 7 exposed in that row's own text.
//
// WHY A SEPARATE SCRIPT RATHER THAN EDITING THE INFO BY HAND: the row is the durable record the dashboard shows, and
// it currently states `SGX 1:5 at 1.497% -> 7.49%`, which is wrong twice. A stale number on a task row is the exact
// "surface that looks authoritative and isn't" defect this workstream exists to close, so the correction has to be
// re-MEASURED at write time and REFUSED if the measurement no longer supports it.
//
// DRY RUN BY DEFAULT. Pass --yes to write. Marker-guarded, so re-running is a no-op.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 rev 2';
// The wrong number this row states as fact, and the retraction keyword that must sit beside it wherever it survives.
const STALE_FIGURE = 'SGX 1:5 at 1.497%';
const YES = process.argv.includes('--yes');

// ⚠ THE ADDENDUM IS BUILT FROM \uXXXX ESCAPES ON PURPOSE. Typing the glyphs directly is how this file first got
// mojibake in it: the characters were copied out of a console that had already mangled them (the em dash came back
// as the three codepoints U+0393 U+00C7 U+00F6), so the source contained the WRONG codepoints and would have written
// them to the row. Escapes cannot be mangled by a console, and they are visibly ASCII in review.
const EM = '\u2014';      // em dash
const STAR = '\u2605';    // black star
const WARN = '\u26A0';    // warning sign
const ARROW = '\u21D2';   // rightwards double arrow
const DOT = '\u00B7';     // middle dot

const ADDENDUM = `
${MARKER} ${EM} EXTERNAL REVIEW APPLIED (14 items)##
The owner supplied a 14-item review of the report. **All 14 applied**; the document is now rev 2 and its section 9 is
the item-by-item response log. **Three items changed a NUMBER, and one of those corrected an error of MINE ${EM} in
the direction that flattered the argument.**

${STAR}${STAR} THE MATERIAL CORRECTION: rev 1 GENERALISED GOLD'S LEVERAGE TO THE WHOLE WATCHLIST.
  MEASURED at write time: \`dbo.Instruments\` leverage spans **1:1.67 (Bitcoin, 60% initial) .. 1:10 (SGX, Sands
  China, SATS, Wilmar International, Mapletree Industrial)**, with **1:5 modal at 35 of 41 rows**. rev 1 said
  "Gold is 1:5" and reasoned as though 1:5 were the venue's rate. It is the MODAL rate, which is precisely what
  made the generalisation look safe.
  ${ARROW} rev 1's headline ${EM} "5% risk per trade is a number the desk can display but cannot take" ${EM} is
    **FALSE as stated.** The ceiling is PER INSTRUMENT and spans **1.13% (Bitcoin) to 17.68% (SGX)**, a 15.6x
    spread. **5% IS expressible on SGX (needs 33% of purchasing power) and on Oil**, and is NOT on Gold / Silver /
    Coffee / Sugar / Bitcoin at their observed stops. **The dial means something different on every symbol.**
  ${ARROW} rev 1's SGX line was wrong TWICE: it read \`SGX 1:5, stop 1.497% -> 7.49%\`. The registry says **1:10**
    and the venue stop is **1.768%**, so the ceiling is **17.68%** ${EM} a **2.36x understatement, on the ONE row
    this desk has actually tried to trade.**

${STAR} OTHER MEASURED ADDITIONS THE REVIEW FORCED (all from \`temp/probe-pp-review3.js\`, read-only):
  1. **\`exposureCapPct\` HAS NEVER BOUND ${EM} 0 of the last 414 decisions.** The per-position cap and the risk cap
     each fired on 402/414; \`sizeCalc.cappedAtPct\` records only 80 (x266) and 40 (x136). **The brake stack is one
     control deep**, and that is what decides L3.a: both existing caps are KEPT and re-expressed in ONE unit (they
     are a CONCENTRATION guard, which a margin guard is not), the margin guard is expected to bind first, and **L2
     must add a \`boundBy\` field** or the new ranking ships un-inspectable.
  2. **\`maintenanceMarginPct\` IS captured, on all 41 registry rows, always exactly half the initial margin**
     (20/10, 10/5, 60/30). rev 1 never listed it. So the LEVEL at which a margin call begins is already in the
     desk's own data ${EM} only the venue's ACTION is unmeasured (below).
  3. **THE VENUE'S ACTION AT THE MARGIN LIMIT IS NOT VERIFIED** (rev 1 asserted it as fact). Refuse / reduce /
     accept-then-call are three different failure modes needing three different guards, and only the third has no
     post-hoc fix. **Measure it before L2 ships** ${EM} it is a demo account and directly observable.
  4. **The UI sliders are GLOBAL** (one \`risk-maxpos\`, one \`risk-expcap\`), so rev 1's \`L x 100\` names no number.
     Resolved: the ceiling is **\`100 x max(L)\` over the instruments in scope** (1000 while any 1:10 instrument is
     in scope, 500 for a 1:5-only book), and \`RISK_MAXPOS_DANGER_PCT = 40\` must be re-based against the SAME
     denominator or it warns on every legal value.
  5. **L3's \`default e.g. 60\` is NOT derived.** Derivation given instead: **\`u <= 1 - sum(risk_i)/equity\`**,
     because an unrealised loss consumes free margin and the margin requirement does not shrink with it ${ARROW}
     **66.8%** at 10 x 3.32%. 60 stays a PLACEHOLDER pending L5, not a value to ship.
  6. **The daily halt is un-CHOSEN, not broken.** 6.64% (2x) / 10% (3x) / flat 5% framed as postures. Plus: a halt
     that fires on the first loss also DESTROYS THE SAMPLE ${EM} at the desk's measured 42.9% win rate a loss is
     the more likely (57.1%) outcome of any entry, so the halt would end trading more days than not. And
     \`dayStartEquity\` keys on \`new Date().toISOString().slice(0,10)\` (\`risk.js:172\`) = **UTC midnight, which
     falls INSIDE a live session.**
  7. **L4's SHAPE specified**: \`sizeCalc.resolvedRiskPct\` (computed on the stop the sizing used) + \`boundBy\` +
     \`riskDialPct\`; the REALISED figure stays on the trade row rather than being duplicated (on Gold the record's
     effective stop 0.550% and the fill-anchored stop 0.664% differ by 21% within one ticket). **And the evidence
     that prose is not enough:** \`aggregator.ticketGeometryNote\` already reads \`cap.note\` / \`cap.pct\` /
     \`cap.floor\` and **none of the three is EVER stored** ${EM} across 112 \`stopCap\` objects the keys are only
     cappedBy/capPct/costPct/costShare/ceiling/ceilingFrom (\`cappedStopDistance\` drops \`floor\`; \`risk.js\` drops
     \`note\`). **Two seat-facing branches are DEAD** ${EM} the "TRUNCATED by the N% cap" suffix renders empty and
     the floor line never prints. That is the TRD-EXE-2/3/4 class found INSIDE the layer meant to fix it.
  8. **Naming:** \`maxEquityPerPositionPct\` is no longer called a "notional cap". It MEASURES equity and TRUNCATES
     notional; the collision is why 80 reads as a near-maximum when it is 16% of Gold's purchasing power.
  9. **Section 8 split in two.** "This does not create edge" stands unchanged (TRD-TP-1 #1412). But that does NOT
     make the work moot: the desk **mis-reports its risk 9.4x** (5% dial vs 0.5308% resolved ${EM} a broken metric,
     TRD-31 class), the margin gap is a **CAPITAL** event with no post-hoc fix, and an unreachable dial the owner
     believes in is the **TRD-91 defect a third time**. A report that is wrong about its own risk cannot be right
     about its own edge.

${WARN}${WARN} TWO OF MY OWN PROBE ERRORS WERE CAUGHT MID-FLIGHT, AND BOTH ARE THE DESK'S DOCUMENTED TRAPS:
  (a) the decision join used \`promptId\` alone, and **ONE WAKE WRITES ONE DECISION PER SYMBOL**, so it read an
      arbitrary symbol's geometry ${EM} it put Gold's stop at **15.218%**;
  (b) \`LIKE '%size capped at %'\` also matches \`'% risk/trade'\`, so the per-position count was a union.
  **Same failure the report describes: a number that looked authoritative and wasn't.** This is the third session
  running in which the error ran in the flattering direction.

${ARROW} THE RECORD SCRIPT NOW GATES THE CORRECTION (see section 2b of \`record-2026-09-29-purchasing-power.js\`): it
re-reads the leverage range from the registry, requires the report to carry it, and REFUSES the write if the
retracted sentence reappears without its retraction nearby. ${WARN} **That gate fired on its own first run ${EM} on
the report's legitimate QUOTATION of the sentence it retracts.** The fix was to window the check (the phrase is
allowed within 400 chars of "false", nowhere else), not to delete the gate and not to stop quoting the retraction: a
retraction that cannot quote what it retracts is worse than one that is checked.

${WARN} STILL NOT IMPLEMENTED. L1-L5 remain proposals. The owner reviews the report first; only the anchor flip
(#117071) and the document exist.

${DOT} rev 2 was written after the owner's review; ${DOT} every number above was re-measured, not copied; ${DOT} the
report's own gates were re-run and PASS (all sections, the leverage range, the retraction window).
`;

async function main() {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('\n=== 1. the report is rev 2 and carries its corrections ===');
  const doc = src(DOC);
  if (!doc.includes('rev 2')) await fail('the report is not marked rev 2');
  if (!doc.includes('FALSE as stated')) await fail('the report does not state the correction');
  for (const h of ['1.2a', 'L3.a', 'L3.b', 'L4.a', 'L4.b', '## 8. Honest limit', '## 9. Response to the external review']) {
    if (!doc.includes(h)) await fail(`the report is missing "${h}"`);
  }
  console.log(`  \u2714 ${DOC} (${doc.length} chars) is rev 2 and carries every rev-2 section`);

  // ⚠ THIS CHECK EXISTS BECAUSE THIS FILE WAS WRITTEN WRONG ON THE FIRST ATTEMPT. The addendum was composed by
  // copying glyphs out of a console that had ALREADY mangled them, so the source held U+0393-etc. mojibake and
  // would have written it straight to the row. A console cannot mangle a \uXXXX escape, so the SOURCE is ASCII and
  // the assembled OUTPUT is checked here: every non-ASCII codepoint must be one of the five deliberately intended.
  const INTENDED = new Set([...EM, ...STAR, ...WARN, ...ARROW, ...DOT].map((c) => c.codePointAt(0)));
  const strays = [...new Set([...ADDENDUM].map((c) => c.codePointAt(0)))]
    .filter((cp) => cp > 126 && !INTENDED.has(cp));
  if (strays.length) {
    await fail(`the addendum carries ${strays.length} unintended non-ASCII codepoint(s): `
      + `${strays.map((c) => 'U+' + c.toString(16).toUpperCase()).join(', ')} — the console-mojibake trap`);
  }
  const present = [[EM, 'em dash'], [STAR, 'star'], [WARN, 'warning'], [ARROW, 'arrow'], [DOT, 'middle dot']]
    .filter(([c]) => ADDENDUM.includes(c)).map(([, n]) => n);
  console.log(`  \u2714 the addendum is ${ADDENDUM.length} chars, no stray non-ASCII; glyphs used: ${present.join(', ')}`);

  console.log('\n=== 2. RE-MEASURE the leverage range the correction rests on ===');
  const lev = await q(`SELECT leverageRaw, initialMarginPct, maintenanceMarginPct, COUNT(*) AS n
    FROM dbo.Instruments WHERE userId = 1 AND venue = 'plus500' AND leverageRaw IS NOT NULL
    GROUP BY leverageRaw, initialMarginPct, maintenanceMarginPct ORDER BY COUNT(*) DESC`);
  if (lev.length < 2) await fail('the registry carries ONE leverage value — the rev-2 correction would be out of date');
  const ratios = lev.map((r) => Number(String(r.leverageRaw).split(':')[1])).filter(Number.isFinite);
  const lo = Math.min(...ratios); const hi = Math.max(...ratios);
  console.log(`  leverage spans 1:${lo} .. 1:${hi}: ${lev.map((r) => `${r.leverageRaw} x${r.n}`).join(' \u00b7 ')}`);
  console.log(`  \u2714 1:5 is ${lev[0].leverageRaw === '1:5' ? 'the modal rate, as the correction states' : 'NOT the modal rate — re-read the report'}`);
  const maint = lev.every((r) => Number(r.maintenanceMarginPct) === Number(r.initialMarginPct) / 2);
  console.log(`  \u2714 maintenance is exactly half the initial on every group: ${maint}`);
  if (!maint) await fail('maintenance is no longer half the initial — the L3 reasoning cites that');

  console.log('\n=== 3. RE-MEASURE the brake stack (0/414) ===');
  const tot = (await q(`SELECT COUNT(*) AS n FROM dbo.TradingEvents WHERE kind='decision'`))[0].n;
  const expo = (await q(`SELECT COUNT(*) AS n FROM dbo.TradingEvents WHERE kind='decision'
      AND payload LIKE '%sized down to exposure budget%'`))[0].n;
  const perpos = (await q(`SELECT COUNT(*) AS n FROM dbo.TradingEvents WHERE kind='decision'
      AND payload LIKE '% equity%'`))[0].n;
  console.log(`  decisions ${tot} \u00b7 per-position cap fired ${perpos} \u00b7 portfolio budget resized ${expo}`);
  if (expo !== 0) await fail(`exposureCapPct has now bound ${expo} times — the "dead weight / never bound" claim is out of date`);
  console.log('  \u2714 the portfolio budget has still never bound');

  console.log('\n=== 4. the row, its marker, and the IN-PLACE annotation ===');
  const row = (await q(`SELECT id, name, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const already = (row.info || '').includes(MARKER);
  console.log(`  #${row.id} "${String(row.name).slice(0, 70)}..."`);
  console.log(`  rev-2 marker: ${already ? 'PRESENT' : 'absent'}`);

  // ── 4b. ANNOTATE THE STALE NUMBER IN PLACE ────────────────────────────────────────────────────────────────────
  // The addendum retracts the SGX figure ~7,000 chars BELOW the line that states it, and this desk's own convention
  // (learned the hard way on the TRD-26 audit) is that a superseded claim must be marked WHERE IT SITS — otherwise
  // the next reader cites it again and the retraction may as well not exist. Appending is only half the correction.
  const STALE_LINE = 'Gold 1:5 at a 0.664% stop -> **3.32%**. Silver 1:5 at 0.977% -> 4.88%. SGX 1:5 at 1.497% -> 7.49%.';
  const ANNOTATED = 'Gold 1:5 at a 0.664% stop -> **3.32%**. Silver 1:5 at 0.977% -> 4.88%.'
    + `\n    ${WARN} SGX RETRACTED IN PLACE (2026-09-29 rev 2): this line read "SGX 1:5 at 1.497% -> 7.49%".`
    + ' The registry says SGX is **1:10** and its venue stop is **1.768%**, so the ceiling is **17.68%** '
    + `\u2014 a 2.36x understatement on the one symbol this desk has actually traded. Measurement below.`;
  const hasStaleLine = (row.info || '').includes(STALE_LINE);
  console.log(`  un-annotated SGX line: ${hasStaleLine ? 'PRESENT \u2014 needs the in-place marker' : 'absent (already annotated)'}`);
  if (hasStaleLine && YES) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = REPLACE(info, N'${STALE_LINE.replace(/'/g, "''")}', N'${ANNOTATED.replace(/'/g, "''")}') WHERE id = ${TASK_ID}`);
    console.log('  \u2714 annotated in place');
  } else if (hasStaleLine) {
    console.log('  would annotate it in place (dry run).');
  }
  // Now the check that matters: wherever the stale figure survives, it must survive WITH its retraction beside it.
  const after = hasStaleLine && YES
    ? (await q(`SELECT info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0].info
    : (row.info || '');
  const hits = [];
  for (let i = after.indexOf(STALE_FIGURE); i !== -1; i = after.indexOf(STALE_FIGURE, i + 1)) hits.push(i);
  const orphaned = hits.filter((i) => !/RETRACTED/i.test(after.slice(Math.max(0, i - 300), i + 120)));
  if (orphaned.length) {
    await fail(`the stale SGX figure ("${STALE_FIGURE}") survives at offset(s) ${orphaned.join(', ')} with no RETRACTED marker within 300 chars \u2014 the row would still state a wrong number as fact`);
  }
  console.log(`  \u2714 the stale SGX figure appears ${hits.length}x, each inside its retraction`);

  // ── 4c. IDEMPOTENCY, ENFORCED RATHER THAN ASSUMED ─────────────────────────────────────────────────────────────
  // ⚠ THIS SECTION EXISTS BECAUSE THE FIRST RUN OF THIS SCRIPT APPENDED THE ADDENDUM TWICE. The marker guard was
  // written as `if (already) { if (!hasStaleLine) return; }` — so when a SEPARATE pending write (the in-place
  // annotation) was still outstanding, control fell straight through to the append and duplicated 7,000 chars into
  // the row. **A marker check that guards one of two writes is not a guard.** Counting the occurrences is.
  const occurrences = after.split(MARKER).length - 1;
  console.log(`  the addendum appears ${occurrences}x in the row`);
  if (occurrences > 1) {
    if (!YES) {
      console.log(`  \u26a0 would truncate to the first copy (dry run).`);
    } else {
      await pool.request().query(`UPDATE dbo.Tasks
        SET info = RTRIM(LEFT(info, CHARINDEX(N'${MARKER}', info, CHARINDEX(N'${MARKER}', info) + 1) - 1))
        WHERE id = ${TASK_ID}`);
      console.log('  \u2714 truncated to the first copy');
    }
  }
  const infoNow = (await q(`SELECT info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0].info || '';
  const finalCount = infoNow.split(MARKER).length - 1;
  if (YES && finalCount !== 1) await fail(`the addendum appears ${finalCount}x after the repair \u2014 expected exactly 1`);
  if (YES) console.log(`  \u2714 the addendum appears exactly ${finalCount}x`);

  console.log('\n=== 5. the write ===');
  const needAppend = finalCount === 0;
  if (!needAppend) console.log('  addendum already recorded \u2014 no append.');
  if (!YES) {
    if (needAppend) console.log(`  would append ${ADDENDUM.length} chars to #${TASK_ID}.info (now ${infoNow.length} chars).`);
    console.log('  DRY RUN - not written.');
    await pool.close();
    return;
  }
  if (needAppend) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}'
      WHERE id = ${TASK_ID}`);
    console.log('  \u2714 appended');
  }
  const finalLen = (await q(`SELECT LEN(info) AS n FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0].n;
  console.log(`  #${TASK_ID}.info is now ${finalLen} chars`);
  await pool.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
