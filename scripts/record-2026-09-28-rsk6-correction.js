// scripts/record-2026-09-28-rsk6-correction.js — corrects TRD-RSK-6's premise.
//
// WHY THIS EXISTS. #1457 was registered claiming "the panel cannot say which [dial binds]". That is FALSE —
// the panel says so in two places with the arithmetic. The row was written from the SHAPE of the code without
// reading the RENDERING path. A row whose TITLE carries a refuted claim is worse than no row, so the title is
// corrected and the correction is appended. The mechanism is RE-MEASURED here before anything is written, so
// this script cannot itself assert something the code does not do.
//
// Dry by default:  node scripts/record-2026-09-28-rsk6-correction.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 rsk6-premise-correction##';
const ROOT = path.join(__dirname, '..');

const NEW_NAME = 'TRD-RSK-6: Risk - one trade size has five inputs and no single line states the resolved outcome';

const CORRECTION = `

${MARK}
★★ **CORRECTION — THE PREMISE OF THIS ROW AS FIRST WRITTEN IS FALSE. WITHDRAWN AND RESTATED.**
I registered this as *"the panel cannot say which dial binds"*. **It can, and it does, in two places.** I wrote the
row from the SHAPE of the code without reading the RENDERING path — and the rendering was in the same file I was
quoting.

**WITHDRAWN — "the panel cannot say which dial binds."**
- \`renderRiskBindNote()\` (app.js; TRD-LLM-2 #1413) writes into **\`#risk-maxrisk-note\` (index.html:776)**:
  \`"risk per trade" (N%) is INERT — this cap (M%) is smaller and both divide by the SAME stop distance, so the
  realised risk per trade is M%, not N%\`. It also handles the cap-off case and the declared-binds case.
- **\`app.js:1528\` populates \`#risk-runin\` (index.html:781)** with the run-in factor AND its arithmetic:
  \`run-in: parity not yet validated -> all new-entry sizes halved (0.5x) · EFFECTIVE per-position cap 5%
  (5% x 0.5) — realised risk = that x the stop's distance in %, so "risk per trade" (1%) has no effect while the
  cap binds\`.

**WITHDRAWN — "two of those four terms are invisible on the risk panel."** The run-in factor is NOT invisible: it is
displayed with its arithmetic. **Only \`degradedFactor\` (chair budget-stopped, x0.5) has no panel element** — one
gap, not two.

★★ **THE CORRECTED DEFECT: MULTIPLICITY, NOT INVISIBILITY.**
The size of one trade is **the minimum of THREE independent caps** — \`maxRiskPerTradePct\` (risk),
\`maxEquityPerPositionPct\` (notional; the S1 finding), \`exposureCapPct\` (portfolio budget) — **times TWO
multipliers** — \`runInFactor\` (0.5/1, desk-wide) and \`degradedFactor\` (0.5, chair budget-stopped).
**Five numbers from five different places.** Two of the caps and one multiplier each carry their own prose note, so
the panel is not hiding them: **it makes the operator compose five facts into one answer, and NO single line on the
board states the resolved outcome.** ⇒ **The fix is ONE line naming the BINDING constraint and the resulting size,
NOT more disclosure. More disclosure is what produced three separate notes.**

WHAT SURVIVES UNCHANGED, and is still the reason this row is open:
1. \`riskPerTradePct\` (live **1%**) is inert while \`maxRiskPerTradePct\` (live **0.07%**) binds every ticket — the
   disclosure is TEXT, not AFFORDANCE: the dial remains draggable and is still saved to settings.
2. The epoch registry already records the cost: \`epoch.js:127\` — between 2026-09-25 and its fix the prompt told
   the chair \`equity x riskPerTradePct% / stop\` while the cap overrode it, so **"chair reasoning in that window is
   about a rule 28x larger than the one in force."**
3. \`degradedFactor\` is the one genuine invisible term.

★ **THE TRANSFERABLE LESSON, and it is the third instance of the same failure today: I asserted a defect from the
shape of the code without reading the path that CONSUMES it.** \`renderRiskBindNote\` was named in the file I was
quoting; I read its comment (about a stale-note bug it already fixes) and inferred from that comment that the note
did not exist. **Read the output, not the comment.**`;

const LRD_NOTE = `

##2026-09-28 four-docs-frozen##
★ **THE FOUR DOCUMENTS ARE IN REFINEMENT AND NOTHING FROM THEM IS DEPLOYED. Owner, 2026-09-28: "for those four
markdown files, there will be rounds of refinement. stay tuned for that, we are not deploying any of them yet."**
The four are \`news-aggregator-2026-09-28.md\`, \`news-classification-decision-2026-09-28.md\`,
\`trailing-stop-2026-09-28.md\` and \`roadmap-sequencing-2026-09-28.md\`.
⇒ **This row's ORDER is a proposed sequence, NOT a schedule, and no item from those four docs may be started on the
strength of it.** The ordering logic in \`roadmap-sequencing\` remains the reference for WHEN they land; the documents
themselves are still being refined and may change. Nothing in this row authorises work on S1/S2/S3, the trailing
rule, or any options item.
★ And the same reading applies to the danger the roadmap itself flags: the four docs must not be deployed as a
bundle, and no two of them should ride one prompt-version bump.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // ── 1. RE-MEASURE the disclosure before correcting anything ──────────────────────────────────────
  console.log('\n=== 1. is the disclosure real? (the claim being WITHDRAWN depends on it) ===');
  const app = read('trading/public/js/app.js');
  const html = read('trading/public/index.html');
  const checks = [
    ['renderRiskBindNote() exists', /function renderRiskBindNote\s*\(/.test(app)],
    ['it writes to risk-maxrisk-note', /risk-maxrisk-note/.test(app)],
    ['it says the word INERT', /is INERT/.test(app)],
    ['index.html declares #risk-maxrisk-note', /id="risk-maxrisk-note"/.test(html)],
    ['app.js populates #risk-runin', /\$\('risk-runin'\)/.test(app)],
    ['index.html declares #risk-runin', /id="risk-runin"/.test(html)],
    ['the run-in note carries the arithmetic', /EFFECTIVE per-position cap/.test(app)],
  ];
  for (const [label, ok] of checks) console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (checks.some(([, ok]) => !ok)) await fail('the disclosure is NOT as described — the correction would be wrong too');
  console.log('  \u2714 the panel DOES disclose both the inert dial and the run-in factor, with arithmetic');

  // ── 2. and the ONE term that genuinely has no panel element ──────────────────────────────────────
  console.log('\n=== 2. the one term claimed to be genuinely invisible ===');
  const degraded = [...app.matchAll(/degradedFactor/g), ...html.matchAll(/degradedFactor/g)].length;
  console.log(`  "degradedFactor" appears ${degraded} time(s) in trading/public/{js/app.js,index.html}`);
  if (degraded !== 0) console.log('  \u26a0 it IS mentioned — re-check the claim that it is invisible before publishing');
  else console.log('  \u2714 confirmed: no panel element renders the chair-budget 0.5x, so it is the ONE real gap');

  // ── 3. the rows ──────────────────────────────────────────────────────────────────────────────────
  console.log('\n=== 3. corrections ===');
  const r6 = (await q(`SELECT id, name, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE name LIKE 'TRD-RSK-6:%'`))[0];
  if (!r6) await fail('TRD-RSK-6 (#1457) not found');
  console.log(`  #${r6.id} currently: "${r6.name}"`);
  console.log(`  -> "${NEW_NAME}"`);
  if (NEW_NAME.length > 255) await fail('new name exceeds 255 chars');
  if (/[^\x20-\x7E]/.test(NEW_NAME)) await fail('new name is not pure ASCII');

  for (const [id, label] of [[r6.id, 'TRD-RSK-6'], [1458, 'TRD-RSK-7'], [1461, 'TRD-LRD-1']]) {
    const n = (await q(`SELECT id FROM Tasks WHERE id = ${id} AND info LIKE '%${MARK}%'`)).length;
    console.log(`  [${label}] #${id} ${n ? 'already carries this correction' : 'would receive it'}`);
  }
  const lrdDup = (await q(`SELECT id FROM Tasks WHERE id = 1461 AND info LIKE '%four-docs-frozen%'`)).length;
  console.log(`  [TRD-LRD-1] #1461 ${lrdDup ? 'already carries the four-docs note' : 'would receive the four-docs note'}`);

  if (!YES) { console.log('\nDRY RUN — not written.'); await pool.close(); return; }

  await pool.request().input('n', NEW_NAME).query(`UPDATE Tasks SET name = @n WHERE id = ${r6.id}`);
  const back = (await q(`SELECT name FROM Tasks WHERE id = ${r6.id}`))[0];
  console.log(`  \u2714 #${r6.id} renamed -> "${back.name}"`);

  for (const [id, label] of [[r6.id, 'TRD-RSK-6'], [1458, 'TRD-RSK-7']]) {
    const dup = (await q(`SELECT id FROM Tasks WHERE id = ${id} AND info LIKE '%${MARK}%'`)).length;
    if (dup) { console.log(`  [${label}] marker present — skipped`); continue; }
    const before = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`))[0].len;
    await pool.request().input('t', CORRECTION).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${id}`);
    const after = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`))[0].len;
    console.log(`  \u2714 [${label}] #${id} ${before} -> ${after} chars`);
  }

  if (!lrdDup) {
    const before = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1461`))[0].len;
    await pool.request().input('t', LRD_NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1461`);
    const after = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1461`))[0].len;
    console.log(`  \u2714 [TRD-LRD-1] #1461 ${before} -> ${after} chars`);
  }

  const s = await q(`SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state`);
  console.log('\nedict 52 by state: ' + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
