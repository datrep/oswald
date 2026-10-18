// scripts/record-2026-09-29-cappedatpct-explained.js
//
// TRD-RSK-11 — `sizeCalc.cappedAtPct` reports the SETTING, not whether the cap BOUND. Consequence: the `risk_unit`
// field contract classifies EVERY dial-vs-realised gap as "explained by the cap", so its warn branch is unreachable
// and the TRD-F20-EPOCH separation of explained from unexplained gaps is inert by construction.
//
// HOW THIS WAS FOUND: asking the second review's item 1 — "where does the per-position count come from?" — led to
// the field itself. The count was wrong (a `LIKE` union), and the field that should have adjudicated it is not
// trustworthy either.
//
// DRY RUN BY DEFAULT. Pass --yes to write. Marker-guarded, occurrence-counted (see the 2026-09-29 idempotency note).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const ROOT = path.join(__dirname, '..');
const EDICT = 52;
const SORT_ORDER = 185;
const MARKER = '##2026-09-29 cappedAtPct##';
const RECORDED = '(settings_write)';
const YES = process.argv.includes('--yes');

const WARN = '\u26A0';
const STAR = '\u2605';
const ARROW = '\u21D2';
const EM = '\u2014';

const NAME = 'TRD-RSK-11: Risk - cappedAtPct records the SETTING, not the binding; the risk_unit contract can therefore never report an unexplained dial-vs-realised gap';

const INFO = `
${MARKER}
${STAR} FOUND 2026-09-29 while answering an external review's question about a DIFFERENT number. The review refused
to believe that the per-position cap and the risk cap both fired on 402 of 414 decisions, and was right: counted
properly the figures are **367 / 402** (see TRD-RSK-10 #1467 rev 3). Asking "then where does the per-position count
come from?" led to the field this row is about — and that field is the reason the question could not be settled
from the record in the first place.

${STAR}${STAR} THE DEFECT, IN TWO LINES.
  (1) \`trading/agent/risk.js:630\` writes \`cappedAtPct: Number(risk.maxEquityPerPositionPct ?? 5)\` when it builds
      \`sizeCalc\` ${EM} **UNCONDITIONALLY, FROM THE SETTING**. It is present whether or not the cap truncated
      anything. It therefore reports what the cap IS, never whether it ACTED.
  (2) \`trading/agent/fieldContracts.js:411\` reads its mere presence as PROOF that the cap bound:
      \`const explained = s.cappedAtPct != null;\` and then renders \`(cap N% bound)\` at \`:413\`.

${STAR} MEASURED CONSEQUENCE ${EM} two of them, and the second is the larger.
  a) **35 decisions carry a seat-facing claim that a cap bound when it did not.** \`cappedAtPct\` is \`80\` on **266**
     decisions, but the reason \`size capped at 80% equity\` appears on only **231**. (The 40-era is clean: 136 and
     136, because \`maxEquityPerPositionPct\` genuinely was the binding constraint then.)
  b) **The warn at \`fieldContracts.js:422\` is UNREACHABLE.** \`:420\` computes
     \`const unexplained = inert.filter((x) => !x.explained);\` and the warn fires only on \`unexplained\`. Since
     \`cappedAtPct\` is never null, **\`unexplained\` is ALWAYS EMPTY**. So the TRD-F20-EPOCH work ${EM} whose whole
     premise was *"only a gap the cap does NOT explain is a real label mismatch worth a warn"* ${EM} is **inert by
     construction**: every gap is classed "explained" and the contract prints *"the dial is doing its job"*.

${STAR} VERIFIED LIVE, not inferred. \`node trading/scripts/self-health-contracts.js\` reports:
    [WARN] riskPct = risk the trade took
           the risk dial is INERT while the notional cap binds ${EM} 2.5% declared ${ARROW} 0.07% realised
           (cap 80% bound) x3 ... BY DESIGN (the cap is a safety limit ...). 20/20 sizing event(s) in this window.
  ${ARROW} \`20/20\` as EXPLAINED, and \`(cap 80% bound)\` asserted on every one. The F20 comment at \`:405-410\` states
    its own premise in capitals: *"When \`sizeCalc\` carries \`cappedAtPct\`, the notional cap BOUND"*. That premise is
    false, and the entire branch rests on it.

${WARN} WHY THIS IS THE SAME CLASS AS THE REST OF THE THREAD. It is the **fourth dead branch** found in the desk's
own reporting in one day (the other two are \`aggregator.ticketGeometryNote\` reading \`cap.note\`/\`cap.pct\`/
\`cap.floor\`, none of which is ever stored ${EM} TRD-RSK-10 rev 3 §L4.a) and the **second inside a component whose
job is to stop numbers lying**. A field that is always present cannot be evidence of anything.

${STAR} THE FIX (not implemented; recorded for the owner):
  - \`cappedAtPct\` keeps its meaning ONLY if it is written when the cap actually truncates ${EM} i.e. set it in the
    same branch that pushes \`size capped at N% equity\`, or pair it with the reason.
  - The better shape is the one \`stopCap.cappedBy\` already uses: **null when the control did not act**, and the
    control's name when it did. L2's \`boundBy\` (TRD-RSK-10 §L3.a) should follow that shape for exactly this reason.
  - Then \`fieldContracts\`' \`explained\` becomes a real distinction again and the warn at \`:422\` can fire.
  - Do NOT simply make \`cappedAtPct\` nullable without the contract change: the two edits are one change.

${WARN} NOT VERIFIED / OUT OF SCOPE: whether any OTHER consumer reads \`cappedAtPct\` as a binding claim (only
\`fieldContracts.js:411\` and \`app.js:1417\` reference it today, the latter only as a comment about the audit trail).
` + `${RECORDED} registered as a record only; no code was changed.

${WARN} NAMING NOTE: this is a Risk/Reporting defect, and it is numbered \`TRD-RSK-11\` to sit beside TRD-RSK-1
(the decision card publishing a DECLARED stop beside a cost share computed on the capped one) ${EM} the two are the
same failure: **a number whose label does not describe what the number is.**
`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('\n=== 1. the two code lines the row quotes ===');
  const risk = src('trading/agent/risk.js');
  if (!/cappedAtPct:\s*Number\(risk\.maxEquityPerPositionPct/.test(risk))
    await fail('risk.js no longer writes cappedAtPct from the setting unconditionally — the premise of this row moved');
  console.log('  \u2714 risk.js writes cappedAtPct from the SETTING, unconditionally');
  const fc = src('trading/agent/fieldContracts.js');
  if (!/const explained = s\.cappedAtPct != null/.test(fc))
    await fail('fieldContracts.js no longer derives `explained` from cappedAtPct — re-read the file before writing');
  if (!/const unexplained = inert\.filter\(\(x\) => !x\.explained\)/.test(fc))
    await fail('fieldContracts.js no longer filters on `unexplained` — the unreachable-warn claim is out of date');
  console.log('  \u2714 fieldContracts.js treats presence as proof, and warns only on `unexplained`');

  console.log('\n=== 2. RE-MEASURE the 266 vs 231 gap (the 35 wrong claims) ===');
  const rows = await q(`SELECT id, payload FROM dbo.TradingEvents WHERE kind = 'decision' ORDER BY id`);
  let withField = 0; let withReason = 0; let withField80 = 0; let withReason80 = 0;
  for (const r of rows) {
    let p; try { p = JSON.parse(r.payload); } catch { continue; }
    const sc = p && p.sizeCalc; if (!sc) continue;
    const reasons = (sc.reasons || []).join(' | ');
    if (sc.cappedAtPct != null) { withField++; if (Number(sc.cappedAtPct) === 80) withField80++; }
    if (/size capped at [\d.]+% equity/.test(reasons)) { withReason++; if (/size capped at 80% equity/.test(reasons)) withReason80++; }
  }
  console.log(`  decisions with a sizeCalc: ${rows.length - 12} (414 total, 12 without)`);
  console.log(`  cappedAtPct present: ${withField}  \u00b7  ...value 80: ${withField80}`);
  console.log(`  "size capped at N% equity" reason present: ${withReason}  \u00b7  ...value 80: ${withReason80}`);
  const wrong = withField80 - withReason80;
  console.log(`  ${ARROW} decisions claiming a bound 80% cap with no binding reason: ${wrong}`);
  if (withField80 === 0) await fail('cappedAtPct is no longer 80 anywhere — this row was written for the 80-era; re-derive');
  if (wrong <= 0) await fail('the field and the reason now agree everywhere — the defect this row records may be fixed');
  console.log('  \u2714 the field over-reports the binding, by ' + wrong + ' decisions');

  console.log('\n=== 3. the row ===');
  const existing = (await q(`SELECT id, name, info FROM dbo.Tasks WHERE name LIKE 'TRD-RSK-11%'`))[0];
  if (existing) {
    const n = ((existing.info || '').split(MARKER).length - 1);
    console.log(`  already registered as #${existing.id} (marker x${n})`);
    if (n !== 1) await fail(`marker appears ${n}x on #${existing.id} — expected exactly 1`);
    console.log('  nothing to do.');
    await pool.close();
    return;
  }
  console.log(`  would create 1 row in edict ${EDICT}, sortOrder ${SORT_ORDER}`);
  console.log(`  name: ${NAME.slice(0, 96)}...`);
  console.log(`  info: ${INFO.length} chars`);

  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }

  const sibling = (await q(`SELECT plannedStart FROM dbo.Tasks WHERE edictId = ${EDICT} AND id = 1467`))[0];
  if (!sibling || !sibling.plannedStart) await fail('could not read the sibling plannedStart (Tasks.active is DERIVED from it)');
  await pool.request().query(`INSERT INTO dbo.Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
    VALUES (N'${NAME.replace(/'/g, "''")}', N'${INFO.replace(/'/g, "''")}', '${new Date(sibling.plannedStart).toISOString().slice(0, 19).replace('T', ' ')}', 2, 1, ${EDICT}, ${SORT_ORDER}, GETUTCDATE())`);
  const got = (await q(`SELECT id, name, DATALENGTH(info) AS bytes FROM dbo.Tasks WHERE name LIKE 'TRD-RSK-11%'`))[0];
  if (!got) await fail('insert did not land');
  const active = (await q(`SELECT active FROM dbo.Tasks WHERE id = ${got.id}`))[0];
  console.log(`  \u2714 created as #${got.id} (active=${active ? active.active : '?'})`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
