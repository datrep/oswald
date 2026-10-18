// scripts/record-2026-09-29-purchasing-power.js
//
// Registers the purchasing-power report and the takeProfitAnchor flip, and RE-VERIFIES the code facts the report
// asserts — so the row cannot outlive its premises.
//
// Dry by default:  node scripts/record-2026-09-29-purchasing-power.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool, sql } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const EDICT = 52;
const MARK = '##2026-09-29 purchasing-power##';
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };

const NAME = 'TRD-RSK-10: Risk - the desk sizes as if notional were cash; the venue leverage is captured but unused, the caps cannot express purchasing power, and no margin guard exists';

const INFO = `

${MARK}
★ REGISTERED 2026-09-29 from the owner's observation, which is CORRECT AND WAS VERIFIED IN CODE:
"this was operating as if the assumption of the underlying trading instrument was 1 to 1 money, not a CFD.
therefore, my 4k demo had 20k trading power."

**THE REPORT: \`${DOC}\`** — mechanics, the four quantities and how they relate, a five-layer proposal, what must not
change, and the open questions. This row tracks it; the document holds the reasoning.

★★★ THE CENTRAL FACTS, all re-verified by this script rather than asserted:
  1. **THE LEVERAGE IS ALREADY CAPTURED AND USED BY NOTHING IN SIZING.** \`dbo.Instruments.leverageRaw\` ('1:5') and
     \`initialMarginPct\` (20.0) are read at \`agent/instruments.js:422-423\` and rendered at \`:455\` as the prose
     \`leverage 1:5 (initial margin 20%)\` — a sentence the CHAIR reads. \`agent/risk.js\` mentions neither field, so
     the desk tells the model the leverage and then sizes as if it were 1:1.
  2. **EVERY SIZING CAP IS DENOMINATED IN EQUITY**, and \`size x price\` is NOTIONAL: \`risk.js:490-494\`
     (\`maxValue = equity x maxEquityPerPositionPct/100\`), \`:508-518\` (the risk cap), \`fitExposureBudget\`
     \`:231-241\` (\`wantedPct = size x price / equity x 100\`). For a spot purchase those are the same thing; for a
     CFD the cash consumed is \`notional / leverage\`.
  3. **THE UI CANNOT EXPRESS PURCHASING POWER AT ALL.** \`public/index.html:765-767\` hard-caps the sliders at
     \`risk-maxpos max=80\` and \`risk-expcap max=100\` — exactly 1x equity — with \`RISK_MAXPOS_DANGER_PCT = 40\`
     (\`app.js:1418\`) warning above 40%. A purchasing-power-aware ceiling would need to reach \`leverage x 100\` = 500
     for a 1:5 instrument, and the panel has no vocabulary above 100%.
  4. **NO MARGIN TERM EXISTS ANYWHERE.** The venue's real limit is \`sum(margin_i) <= free equity\`; nothing sums
     \`notional_i / L_i\`. It does not matter with one position and becomes THE binding constraint the moment the
     notional caps are raised.

★★★ AND THE LINE THAT SHOULD BE WRITTEN DOWN ONCE, because it is in no source file:
    **max risk per trade (single instrument) = leverage x stop%**   — independent of equity.
    Gold 1:5 at a 0.664% stop -> **3.32%**. Silver 1:5 at 0.977% -> 4.88%. SGX 1:5 at 1.497% -> 7.49%.
⇒ the owner's dial of 5% is **UNREACHABLE on Gold at any leverage the venue offers** (it would need 1:7.53), and
reaching 3.32% needs BOTH the notional caps raised above 500% AND full margin committed. **This is why the honest
form of the question is "how much of the venue's purchasing power may the desk use", not "what risk % should it
target".**

★ THE FIVE LAYERS, in the order they must land (L3 BEFORE L2):
  L1 the venue's leverage becomes a first-class input on the resolution (read only — no behaviour change)
  L2 the caps re-expressed in purchasing-power terms, and the UI slider ceilings raised to \`L x 100\`
  L3 **a MARGIN GUARD**: \`sum(notional_i / L_i) <= equity x maxMarginUtilisationPct\`, failing CLOSED and journalled
  L4 the chair told the truth: equity, free margin, purchasing power, per-instrument leverage, the MARGIN the
     ticket posts, and **the RESOLVED risk rather than the dial** (the same defect as TRD-RSK-6 #1457)
  L5 the brakes reconciled: with a per-trade risk of 3.32%, \`dailyLossHaltPct: 3\` is BREACHED by a single stop-out
     and the desk would take one trade then stop.

⚠ WHAT MUST NOT CHANGE: the venue \`minUnits\` floor (#1455/#1463, confirmed by the venue's own fills) · risk stays
\`notional x stop%\`, so leverage governs CAPACITY and the stop governs RISK · no cap widened silently (every write
journalled, #1462) · the engine must not claim a sizing outcome it did not achieve.

★ THE FLIP THAT DID LAND TODAY: \`risk.takeProfitAnchor\` **'declared' -> 'placed'** (settings journal **#117071**,
exactly one key changed). This is the (a)/(b) structure from TRD-TP-1 #1412 — under 'declared' the payoff ratio is
1.425 x declared/capped, an OUTPUT of where the cap lands; under 'placed' it is the chosen multiple. ⚠ **It is a
no-op today** (0 of 96 decisions since 2026-09-28T06:51Z recorded a cap, so declared == placed) and becomes
LOAD-BEARING the moment \`maxAdversePct\` is lowered — which is exactly why setting it before the cap is used is
cheaper than discovering the coupling afterwards.

⚠⚠ THE HONEST LIMIT, stated so this row is not read as a promise: **risk sizing SCALES an expectancy; it cannot
create one.** TRD-TP-1 (#1412) found no identifiable edge on 35 trades — every interval spanned zero, no cell won a
majority of resamples. Raising purchasing power raises return and drawdown together, and if expectancy is zero the
only thing that increases is variance. L4 is the layer that would say whether it worked.

⚠ NOT IMPLEMENTED: L1-L5 are proposals. Only the anchor flip and this report exist.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('\n=== 1. the report exists and carries its sections ===');
  const docPath = path.join(ROOT, DOC);
  if (!fs.existsSync(docPath)) await fail(`${DOC} does not exist`);
  const doc = fs.readFileSync(docPath, 'utf8');
  for (const h of ['## 2. The mechanics', '### L1', '### L3', '### L5', '## 4. What must NOT change', '## 5. The ceiling']) {
    if (!doc.includes(h)) await fail(`the report is missing "${h}"`);
  }
  console.log(`  \u2714 ${DOC} (${doc.length} chars) carries every section the row cites`);

  console.log('\n=== 2. RE-VERIFY the report\'s central code claims ===');
  const risk = src('trading/agent/risk.js');
  for (const field of ['leverageRaw', 'initialMarginPct', 'purchasingPower']) {
    if (risk.includes(field)) await fail(`risk.js now mentions ${field} — the "unused in sizing" claim is out of date`);
  }
  console.log('  \u2714 risk.js references neither leverageRaw nor initialMarginPct (the claim holds)');
  if (!/const maxValue = equity \* \(Number\(risk\.maxEquityPerPositionPct/.test(risk))
    await fail('risk.js no longer computes maxValue from maxEquityPerPositionPct — the quoted line moved');
  console.log('  \u2714 the notional cap is still `maxValue = equity x maxEquityPerPositionPct/100`');
  const inst = src('trading/agent/instruments.js');
  if (!/initialMarginPct: row\.initialMarginPct/.test(inst)) await fail('instruments.js no longer surfaces initialMarginPct');
  if (!/leverage \$\{f\.leverageRaw\}/.test(inst)) await fail('the leverage prose line moved — the "shown to the chair as prose" claim is unfounded');
  console.log('  \u2714 the leverage is surfaced as PROSE only');
  const html = src('trading/public/index.html');
  if (!/id="risk-maxpos" min="1" max="80"/.test(html)) await fail('the risk-maxpos slider ceiling is not 80 — the UI claim is out of date');
  if (!/id="risk-expcap" min="1" max="100"/.test(html)) await fail('the risk-expcap slider ceiling is not 100 — the UI claim is out of date');
  console.log('  \u2714 the UI sliders still stop at 80 / 100, i.e. at 1x equity');

  // ★ rev 2 (2026-09-29 evening): THE REPORT'S OWN MOST MATERIAL ERROR WAS A GENERALISATION, SO THE FIX GETS A GATE.
  // rev 1 said "Gold is 1:5" and reasoned as though 1:5 were the venue's rate. It is the MODAL rate. If the registry
  // ever converges to a single leverage the report's headline becomes true again and this gate should be revisited —
  // which is exactly the kind of thing that must not be discovered by re-reading prose.
  console.log('\n=== 2b. the rev-2 correction: the leverage is NOT uniform ===');
  const lev = await q(`SELECT leverageRaw, COUNT(*) AS n FROM dbo.Instruments
      WHERE userId = 1 AND venue = 'plus500' AND leverageRaw IS NOT NULL
      GROUP BY leverageRaw ORDER BY COUNT(*) DESC`);
  if (lev.length < 2) await fail(`the registry now carries only one leverage value (${lev.map((r) => r.leverageRaw).join(', ')}) — the rev-2 "1:1.67 to 1:10" correction is out of date`);
  const ratios = lev.map((r) => Number(String(r.leverageRaw).split(':')[1])).filter(Number.isFinite);
  const lo = Math.min(...ratios); const hi = Math.max(...ratios);
  if (!(hi > lo)) await fail('unreadable leverage ratios — cannot confirm the range');
  console.log(`  \u2714 leverage spans 1:${lo} .. 1:${hi} across ${lev.reduce((a, r) => a + Number(r.n), 0)} rows: ${lev.map((r) => `${r.leverageRaw} x${r.n}`).join(' · ')}`);
  if (!doc.includes('1:1.67') || !doc.includes('1:10')) await fail('the report no longer states the measured leverage range — §1.2a and §5 must carry it');
  console.log('  \u2714 the report carries the range in \u00a71.2a and \u00a75');
  // The ceiling is L x stop% and L varies, so a report that states ONE ceiling for the book is wrong by construction.
  //
  // ⚠ THIS GATE FIRED ON ITS FIRST RUN — on the report's own RETRACTION of that sentence, which quotes it verbatim.
  // The fix is NOT to delete the gate and NOT to stop quoting the retraction: a retraction that cannot quote what it
  // retracts is worse. The gate is now WINDOWED — the phrase is allowed, but only within 400 chars of the word
  // `FALSE`, i.e. only where it is being refuted. Anywhere else it is the live rev-1 error and the write is refused.
  const banned = 'cannot take';
  const hits = [];
  for (let i = doc.indexOf(banned); i !== -1; i = doc.indexOf(banned, i + 1)) hits.push(i);
  // EVERY occurrence must sit near its retraction, not just the first: the phrase appears twice legitimately (the
  // rev-2 banner and §2.2), and a gate that only checked indexOf() would go green on the banner while §2.2 quietly
  // reverted to the live claim. Case-insensitive because the banner says "false as stated" and §2.2 says "FALSE".
  const unrebutted = hits.filter((i) => !/false/i.test(doc.slice(Math.max(0, i - 400), i + 400)));
  if (unrebutted.length) {
    await fail(`the retracted rev-1 generalisation ("...${banned}") appears at offset(s) ${unrebutted.join(', ')} with no "false" within 400 chars — either it is back as a live claim, or a retraction was edited away`);
  }
  console.log(hits.length
    ? `  \u2714 the retracted rev-1 generalisation appears ${hits.length}x, each inside its retraction`
    : '  \u2714 the retracted rev-1 generalisation is absent entirely');
  if (!doc.includes('FALSE as stated')) await fail('the rev-2 retraction sentence ("FALSE as stated") is missing — §2.2 must state the correction, not merely avoid the old wording');
  console.log('  \u2714 \u00a72.2 states the correction explicitly ("FALSE as stated")');

  console.log('\n=== 3. the anchor flip is on the journal ===');
  const j = await q(`SELECT TOP 1 id, createdAt, payload FROM TradingEvents WHERE kind='settings_write'
      AND CAST(payload AS nvarchar(max)) LIKE '%takeProfitAnchor%' ORDER BY id DESC`);
  if (!j.length) await fail('no journalled takeProfitAnchor write — the flip claim is unfounded');
  const ch = (J(j[0].payload).changes || [])[0] || {};
  console.log(`  journal #${j[0].id} ${j[0].createdAt.toISOString()}  ${ch.key}: ${JSON.stringify(ch.before)} -> ${JSON.stringify(ch.after)}`);
  if (ch.after !== 'placed') await fail(`the journal says the anchor is ${JSON.stringify(ch.after)}, not 'placed'`);
  const live = J((await q(`SELECT settings FROM TradingSettings WHERE userId = 1`))[0].settings);
  if ((live.risk || {}).takeProfitAnchor !== 'placed') await fail('the stored anchor is not placed');
  console.log('  \u2714 stored and journalled');

  console.log('\n=== 4. the flip really is a no-op today ===');
  const capped = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision'
      AND createdAt >= '2026-09-28T06:51:16.553Z' AND JSON_VALUE(payload,'$.stopCap.cappedBy') IS NOT NULL`))[0].n;
  console.log(`  decisions recording a cap since the cap moved to 1.5%: ${capped}`);
  if (capped !== 0) await fail(`${capped} decisions DID record a cap — the flip is not a no-op and needs its own evidence`);
  console.log('  \u2714 inert today, load-bearing only once the cap is lowered');

  console.log('\n=== 5. the record ===');
  const dup = await q(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  if (dup.length) { console.log(`  marker already present on #${dup[0].id} - nothing to do.`); await pool.close(); return; }
  const next = (await q(`SELECT ISNULL(MAX(sortOrder), 0) + 1 AS n FROM Tasks WHERE edictId = ${EDICT}`))[0].n;
  console.log(`  would create 1 row in edict ${EDICT}, sortOrder ${next}: "${NAME.slice(0, 74)}..."`);
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }
  const req = await pool.request()
    .input('name', sql.NVarChar(sql.MAX), NAME)
    .input('info', sql.NVarChar(sql.MAX), INFO)
    .input('sortOrder', sql.Int, next)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id VALUES (@name, @info, GETUTCDATE(), 1, 1, ${EDICT}, @sortOrder, SYSUTCDATETIME())`);
  console.log(`  \u2714 created as #${req.recordset[0].id}`);
  for (const [label, s] of [['open', 1], ['published', 2], ['done', 3]]) {
    const n = (await q(`SELECT COUNT(*) AS n FROM Tasks WHERE edictId = ${EDICT} AND state = ${s}`))[0].n;
    console.log(`    ${label.padEnd(10)} ${n}`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
