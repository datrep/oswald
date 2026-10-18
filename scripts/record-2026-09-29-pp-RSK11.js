// scripts/record-2026-09-29-pp-RSK11.js
//
// Records TRD-RSK-11 (#1468) on the task row. Closes the loop on the field that could not be evidence.
//
// The block records THREE things, and the second is the one worth the write:
//   · `cappedAtPct` is now written only where the cap truncates, so its presence is a binding claim again;
//   · the FIRST version of that fix re-classified 25 of 200 real rows as "unexplained" — 24 of them because the
//     reader knew only the notional cap's prose. Shipping it would have swapped one false verdict for another;
//   · inspecting one of those rows found a SECOND cause: the contract measured realised risk with `atr x 2` while
//     the ticket's stop was `3x spread`, 6.1x larger — so the denominator was wrong too.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
// The strongest gate here RE-RUNS the live window and the live contract and refuses to write if either disagrees.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { execFileSync } = require('child_process');
const { getPool } = require('../shared/db');
const fc = require('../trading/agent/fieldContracts');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1468;
const MARKER = '##2026-09-29 cappedAtPct FIXED##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const ADDENDUM = `
${MARKER} FIXED: 'cappedAtPct' NOW RECORDS THE BINDING, NOT THE SETTING.##

${STAR} WHAT WAS WRONG, IN THE TWO LINES THIS ROW STATES IT IN. 'risk.js' wrote
'cappedAtPct: Number(risk.maxEquityPerPositionPct ?? 5)' when building 'sizeCalc' ${EM}
**unconditionally, from the SETTING**. So the field reported what the cap IS and never whether it ACTED.
'fieldContracts.riskUnit' then read its mere PRESENCE as proof the cap had bound
('const explained = s.cappedAtPct != null'). The field was never null, so 'explained' was ALWAYS TRUE,
'unexplained' was always empty, and the F20 warn was **UNREACHABLE** ${EM} the contract printed "the dial is doing
its job" on every run while asserting "(cap 80% bound)". **A field that is always present is not evidence of
anything.**

${STAR} WHAT LANDED. 'cappedAtPct' is written ONLY in the branch that truncates, so null now means "the cap did
not act" ${EM} the shape 'boundBy' and 'stopCap.cappedBy' already use. The cap, the field and the reason string all
read ONE resolved value, so they cannot print three different numbers. And the reader no longer reads
'cappedAtPct' AT ALL: 'explained' now comes from witnesses that cannot be faked ${EM} the L4 'boundBy' enum
(post-2026-09-29, and more precise because ANY of the four controls can cause the gap), or the writer's own reason
string (every era, because it is pushed in the same branch that truncates). A WINDOW spans both eras, so a
contract that read the field would let the old rows certify themselves. Pins:
'test/risk-unit-explained.test.js' (17).

${WARN}${WARN} **AND THE FIRST VERSION OF THIS FIX WAS ITSELF THE DEFECT THIS ROW WARNED ABOUT.** Making
'cappedAtPct' honest while recognising only the NOTIONAL cap's prose re-classified **25 of the newest 200 sizing
events as "unexplained"** ${EM} and **24 of those 25 carry the RISK cap's wording**
("size capped at 0.07% risk/trade (implied 1.000% of equity)"). Shipping it would have **swapped a false
"explained" for a false "unexplained" on 12% of the window**, which is precisely the trade this row forbade when it
said the two edits are ONE change. **The count looked like a finding; the rows said it was a bug in the fix.**
That is why the re-measure inspects the offending population instead of totalling it.

${WARN} **AND INSPECTING ONE OF THOSE ROWS FOUND A SECOND, INDEPENDENT CAUSE ${EM} THE CONTRACT WAS USING THE
WRONG DENOMINATOR.** It measured realised risk as 'finalSize x (atr x 2)', but the desk's live stop is
'max(2xATR, 3x spread)' clamped by 'maxAdversePct'. On event **#105926** it used 'atr x 2 = 0.0556' while the
reason line records "stop widened to 3x spread (0.3390 > 2xATR 0.0556)" ${EM} **6.1x larger**. Recomputed with the
ticket's real stop, that ticket's realised risk is **0.0700% of equity, which is EXACTLY the 0.07% the risk cap's
own reason names.** The gap was explained all along and only the denominator was wrong. 'realised' now prefers, in
order: the writer's 'resolvedRiskPct' (L4 ${EM} the very number this check was trying to reproduce), the effective
stop recorded in the writer's own reason, then the 'atr x stopMultiple' approximation ${EM} **and the window now
REPORTS which basis each verdict rests on.**

${STAR} THE MEASURED OUTCOME, and it is the OPPOSITE of the alarming intermediate number. Over the newest 200
sizing events the window is **200 gaps, 200 explained, 0 unexplained** ${EM} the same answer the old predicate gave,
but now EARNED rather than assumed, and reported as "(stop basis: resolvedRiskPct x8, reason:widened x47,
atr x145)". **So the fix creates NO false warnings: the warn branch is reachable by construction (pinned against a
synthetic window) and does not fire, because this window's gaps really are accounted for.**

${STAR}${STAR} AND IT FOUND A SECOND LABEL THAT DID NOT DESCRIBE ITS NUMBER. With 'boundBy' supplying the
evidence, the live contract stopped saying "(cap 80% bound)" and started saying **"(portfolio budget bound)"**
${EM} on all 20 sizing events in the window. The old text named the NOTIONAL cap; the control that actually decided
the size was **'exposureCapPct'**. Same defect as TRD-RSK-1 (a number whose label does not describe what the number
is), reached from the other end ${EM} and **independent corroboration of TRD-RSK-10 ${SEC}1.1b's correction**, since
the control that supposedly never bound is the one deciding every ticket the contract can see.

${WARN} NOT IN SCOPE / STILL OPEN: the gap test still compares realised against 'riskPct' (the configured dial)
rather than the resolved 'riskDialPct' L4 added, so a row whose dial was resolved differently is compared to the
wrong baseline. Filed for TRD-RSK-6 / #1457, not fixed here. Also unchanged: the 145/200 rows that still rest on
the 'atr' approximation are now VISIBLE rather than silent, but making them exact needs the stop recorded on
'sizeCalc', which is a writer change.

${STAR} STATUS: suite **1,763 tests / 1,762 pass / 0 fail / 1 skipped** (was 1,746 / 1,745 ${EM} the 17 new pins);
eslint exit 0 on 'risk.js', 'fieldContracts.js' and the new test; the report carries ${SEC}13.9.
${ARROW} No size, cap, veto or dial was changed by this work: it changes what the desk SAYS about a size, never the
size.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const nl = (s) => s.replace(/\r\n/g, '\n');
  const code = (rel) => nl(read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'));

  console.log('=== TRD-RSK-11 — recording gates ===\n');

  console.log('1. the writer: cappedAtPct is set ONLY where the cap truncates');
  const riskSrc = code('trading/agent/risk.js');
  if (!riskSrc.includes('let cappedAtPct = null;')) await fail('cappedAtPct must start null, like boundBy');
  const from = riskSrc.indexOf('if (size * price > maxValue) {');
  if (from < 0) await fail('the truncation branch is gone');
  const branch = riskSrc.slice(from, riskSrc.indexOf('\n  }', from));
  if (!/^ {4}cappedAtPct = maxEquityPerPositionPct;$/m.test(branch)) await fail('it must be set INSIDE the branch');
  if (/cappedAtPct:\s*Number\(/.test(riskSrc)) await fail('the unconditional write is back');
  console.log(`  ${CHECK} declared null, set in the branch, no unconditional write`);

  console.log('\n2. the reader: presence is no longer proof');
  const fcSrc = code('trading/agent/fieldContracts.js');
  if (/explained\s*=\s*[^\n;]*cappedAtPct/.test(fcSrc)) await fail('the always-true predicate is back');
  if (!fcSrc.includes('riskUnitExplain(s)')) await fail('the reader must use the witness rule');
  if (!fcSrc.includes('riskUnitRealised(s, { stopMultiple })')) await fail('the denominator is still hardcoded');
  console.log(`  ${CHECK} witness-based explained; realised has a stop-basis resolver`);

  console.log('\n3. the rule, on the rows that matter');
  if (fc.riskUnitExplain({ cappedAtPct: 80, reasons: [] }).explained !== false) {
    await fail('cappedAtPct alone must NOT certify a gap');
  }
  if (fc.riskUnitExplain({ reasons: ['size capped at 0.07% risk/trade (implied 1.000% of equity)'] }).explained !== true) {
    await fail('the RISK cap prose must be recognised or the fix creates false warnings');
  }
  const ev105926 = { equity: 4134.54, atr: 0.0278, finalSize: 8.5374, riskPct: 2, reasons: ['stop widened to 3x spread (0.3390 > 2xATR 0.0556)'] };
  const got = fc.riskUnitRealised(ev105926);
  if (got.source !== 'reason:widened' || Math.abs(got.realisedPct - 0.07) > 0.005) {
    await fail(`event #105926 must measure ~0.07% via the widened stop; got ${got.realisedPct} via ${got.source}`);
  }
  console.log(`  ${CHECK} 0.07% from the widened stop, which is exactly the risk cap's own figure`);

  console.log('\n4. THE CENTRAL CLAIM, RE-MEASURED ON LIVE ROWS');
  const rows = (await q(`SELECT TOP 200 JSON_QUERY(payload,'$.sizeCalc') AS sizeCalc
      FROM TradingEvents WHERE kind = 'decision' AND JSON_QUERY(payload,'$.sizeCalc') IS NOT NULL ORDER BY id DESC`))
    .map((x) => { try { return JSON.parse(x.sizeCalc); } catch { return null; } }).filter(Boolean);
  let gaps = 0, explained = 0, still = 0;
  for (const s of rows) {
    if (s.equity == null || s.riskPct == null || !(Number(s.finalSize) > 0)) continue;
    const g = fc.riskUnitRealised(s);
    if (g.realisedPct == null || g.realisedPct >= Number(s.riskPct) * 0.9) continue;
    gaps++;
    if (fc.riskUnitExplain(s).explained) explained++; else still++;
  }
  if (!gaps) await fail('no gaps found — the window cannot support the claim');
  if (still !== 0) await fail(`the block claims 0 unexplained; measured ${still} of ${gaps} — do NOT record it`);
  console.log(`  ${CHECK} ${gaps} gaps, ${explained} explained, ${still} unexplained`);

  console.log('\n5. the live contract says so, and names the right control');
  let sh = '';
  try {
    sh = execFileSync(process.execPath, [path.join(ROOT, 'trading', 'scripts', 'self-health-contracts.js')], { encoding: 'utf8' });
  } catch (e) { sh = `${e.stdout || ''}${e.stderr || ''}`; } // exit 1 is the pre-existing standing WARN, not a failure
  if (!sh.includes('stop basis:')) await fail('the contract does not report its stop basis');
  if (sh.includes('the notional cap binds')) await fail('the verdict still names the notional cap as THE control');
  if (!sh.includes('portfolio budget bound')) await fail('the contract should now name the control that actually bound');
  console.log(`  ${CHECK} reports its stop basis, and names the portfolio budget rather than the notional cap`);

  console.log('\n6. the report');
  const doc = read(DOC);
  const i8 = doc.indexOf('### 13.8 '), i9 = doc.indexOf('### 13.9 ');
  if (i9 < 0) await fail('the report is missing 13.9');
  if (i9 < i8) await fail('13.9 must come after 13.8');
  console.log(`  ${CHECK} the report carries 13.8 then 13.9`);

  console.log('\n7. the row and its marker');
  const t = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!t) await fail(`row ${TASK_ID} does not exist`);
  const n = (t.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(t.info || '').length} chars, this marker ${n}x`);

  if (!YES) {
    console.log(n === 0
      ? `\n  would append ${ADDENDUM.length} chars. DRY RUN ${EM} not written.`
      : `\n  block already present. DRY RUN ${EM} not written.`);
    await pool.close();
    return;
  }
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log(`  ${CHECK} block appended`);
  } else console.log('  block already present.');

  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(after.info || '').includes('NOW RECORDS THE BINDING, NOT THE SETTING')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
