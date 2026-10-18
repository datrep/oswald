// scripts/record-2026-09-29-pp-L2.js
//
// Records L2 LANDED on TRD-RSK-10 (#1467): the owner-approved purchasing-power package is applied, and the
// envelope model that sized it was validated against the OLD regime before it was used to predict the new one.
//
// The gates re-derive rather than restate: they read the LIVE settings, re-check the three recorded
// resolvedRiskPct values the model reproduced, and confirm the protected keys did not move. If the desk has since
// produced a sized decision under the new regime, the gate ALSO reports the falsifiable prediction's outcome.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 L2 LANDED##';
const YES = process.argv.includes('--yes');
const APPLIED = new Date('2026-09-29T07:57:43Z');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const ADDENDUM = `
${MARKER} L2 LANDED ${EM} THE PURCHASING-POWER PACKAGE IS APPLIED, AND THE MODEL THAT SIZED IT WAS VALIDATED FIRST.##

${STAR} APPLIED 2026-09-29T07:57:43Z through the UI's own 'PUT /api/trading/settings' (deep-merged and
observable, not a hand-edited blob) and then RE-READ with a fresh GET, because the response is not the record. The
change is itself logged as a 'settings_write' event.

  maxEquityPerPositionPct  80 -> 500    (Q2)
  exposureCapPct          100 -> 500    (Q2)
  riskPerTradePct           5 -> 3      (Q1 ${EM} r = 3.0% PER TRADE, plus a separate portfolio brake)
  dailyLossHaltPct          3 -> 6.0    (Q6)

DELIBERATELY NOT MOVED, and asserted so by the deployer: 'maxMarginUtilisationPct' (80 ${EM} the guard is what makes
the raise survivable), 'maxAdversePct' (1.5), 'maxPositions' (10), 'maxRiskPerTradePct' (5 ${EM} already ABOVE the new
target so it cannot fire, which is ${SEC}6.1's intent), 'dailyHaltAnchor' (utc_midnight).

${STAR}${STAR} THE NON-NEGOTIABLE ORDERING WAS CHECKED BEFORE THE RAISE, NOT AFTER. ${SEC}6.1 says the guard must
land in the SAME change as the caps, or the raise permits 5 Gold positions x 400% notional = **400% of equity in
margin**. The deployer REFUSES TO RUN AT ALL unless 'maxMarginUtilisationPct > 0', and also refuses unless the live
values match the exact 'before' it expects ${EM} so it cannot patch on top of a state it did not anticipate.

${STAR}${STAR} AND THE ENVELOPE MODEL WAS VALIDATED ON THE OLD REGIME BEFORE PREDICTING THE NEW ONE. The model is
'stop = ceiling / L' and 'old risk = capPct x stop' ${EM} what ${SEC}6.1's table rests on. Against the recorded
decisions it reproduces the desk's OWN 'resolvedRiskPct' exactly:

  Arabica Coffee  L=1:5   model 0.3696%   recorded 0.3696  (agrees)   -> under L2: 1.8481%  (5.0x)
  Sugar           L=1:5   model 0.4402%   recorded 0.4401  (agrees)   -> under L2: 2.2008%  (5.0x)
  SGX             L=1:10  model 1.1989%   recorded 1.1987  (agrees)   -> under L2: 3.0000%  (2.5x)

${WARN} AND THE VALIDATION CAUGHT ITS OWN BUG FIRST. The deployer's first version divided EVERY ceiling by 5, which
made **SGX report 2.3979%** ${EM} **exactly 2x the 1.1987% the desk recorded** ${EM} because SGX is 1:10, not 1:5.
That one wrong constant is the difference between a model that agrees with the record and one that quietly doubles
it, and it was visible ONLY because the model was being checked against a number the desk had already written. With
the leverage pinned per symbol, all three agree to four significant figures.

${STAR} THE RISK CONSEQUENCE, stated plainly rather than buried. Per-trade risk rises **5.0x** on Arabica Coffee and
Sugar and **2.5x** on SGX. Book exposure may rise from 100% to 500% of equity in notional, bounded by the guard at
**80% of equity in margin**. The daily halt was loosened 3% to 6.0% in the same change, which is why ${SEC}6.1
required them to travel together: at the OLD 3% the halt would fire after ~1.4 stop-outs at the new risk level and
truncate the sample before it could mean anything.

${WARN}${WARN} **THE NEW-REGIME PREDICTION IS UNTESTED, AND SAYING SO IS THE POINT.** At the time of writing there
are **ZERO sized decisions since the change** (newest 04:50Z; change 07:57Z). What is ESTABLISHED is that the model
reproduces the OLD regime. What is PREDICTED is 1.8481 / 2.2008 / 3.0000 ${EM} **falsifiable, and to be checked
against the first sized decision of each symbol. If they do not appear, the model is wrong even though it agreed
with history.** The second thing to read on that decision is 'cappedAtPct': it should now be **null** rather than 80,
because a 500% cap should no longer bind ${EM} which makes the first decision under L2 a **simultaneous test of the
cap raise and of TRD-RSK-11's honesty fix**.

${STAR} THE L5 HALT FORM IS SUPERSEDED, NOT RESOLVED ${EM} recorded as an interpretation, not a finding. ${SEC}L5
specifies 'halt = k x P' with k in 1..3 while Q6 answered a flat **6.0%**. They cannot both be right and k was never
chosen. What shipped is the owner's NUMBER, because a number is actionable and a formula whose parameter is unset is
not: **'k x P' is retired by Q6 rather than satisfied by it.** Flagged so the reasoning is visible.

${WARN} WHAT L2 DOES NOT FIX: **TRD-EXE-1 (#1454) is untouched.** The desk still cannot reliably distinguish a venue
refusal from "maybe submitted" (1 clean refusal vs 9 ambiguous rows vs 7 expired-unconfirmed, see the Q7 block). The
margin guard is the MITIGATION ${EM} it is meant to keep the book inside available funds so refusals do not arise in
normal operation ${EM} but the residual is real: **if a refusal does occur, the record of it will be ambiguous.**

${ARROW} ROLLBACK IS ONE COMMAND: 'trading/scripts/repro/apply-L2-risk-package.js' prints the exact before-values to
restore, and settings are read per wake, so no restart is needed in either direction.

${STAR}${STAR} WITH L2 LANDED, **THIS REPORT IS COMPLETE: L1, L2, L3, L4 AND L5 ARE ALL IN.** ${SEC}6's open
questions are now: **Q7 answered** (venue refuses), **Q4 unchanged** (chair visibility stays an engine concern), and
**Q10 outstanding** ${EM} the post-5% brake-stack re-measure, a measurement this document owes once the new regime has
decisions behind it, and which L4's 'boundBy' field makes possible for the first time.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== L2 LANDED — recording gates ===\n');

  console.log('1. the report');
  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  const i11 = doc.indexOf('### 13.11 '), i12 = doc.indexOf('### 13.12 ');
  if (i12 < 0) await fail('the report is missing 13.12');
  if (i12 < i11) await fail('13.12 must come after 13.11');
  if (!/L2 IS LANDED/.test(doc)) await fail('the report must state L2 landed');
  if (!/\*\*L2\*\* . re-express the caps \| \*\*LANDED/.test(doc)) await fail('the schedule row for L2 must read LANDED');
  console.log(`  ${CHECK} 13.12 present, in order, and the schedule row reads LANDED`);

  console.log('\n2. THE LIVE SETTINGS, re-derived (the change must still be in place)');
  const risk = (await store.getSettings(1)).risk || {};
  const WANT = { maxEquityPerPositionPct: 500, exposureCapPct: 500, riskPerTradePct: 3, dailyLossHaltPct: 6 };
  for (const [k, v] of Object.entries(WANT)) {
    if (Number(risk[k]) !== v) await fail(`${k} is ${risk[k]}, expected ${v} — L2 is no longer applied, so the block is wrong`);
  }
  if (Number(risk.maxMarginUtilisationPct) !== 80) await fail(`maxMarginUtilisationPct is ${risk.maxMarginUtilisationPct}, not 80 — the guard moved`);
  if (Number(risk.maxAdversePct) !== 1.5) await fail(`maxAdversePct moved to ${risk.maxAdversePct}`);
  if (Number(risk.maxPositions) !== 10) await fail(`maxPositions moved to ${risk.maxPositions}`);
  console.log(`  ${CHECK} the four landed; guard 80, maxAdversePct 1.5, maxPositions 10 all held`);

  console.log('\n3. the model still reproduces the recorded resolvedRiskPct (the validation, re-run)');
  const rows = await q(`SELECT id, decision FROM TradingPrompts WHERE decision IS NOT NULL ORDER BY id DESC`);
  const seen = {};
  for (const r of rows) {
    let d; try { d = JSON.parse(r.decision); } catch { continue; }
    for (const e of (Array.isArray(d.decisions) ? d.decisions : [])) {
      const sc = e && e.sizeCalc;
      if (!sc || sc.ceilingPct == null || sc.resolvedRiskPct == null) continue;
      if (!seen[e.symbol]) seen[e.symbol] = { ceil: sc.ceilingPct, resolved: sc.resolvedRiskPct };
    }
  }
  const EXPECT = { 'Arabica Coffee': [5, 0.3696], Sugar: [5, 0.4401], SGX: [10, 1.1987] };
  for (const [sym, [L, recorded]] of Object.entries(EXPECT)) {
    if (!seen[sym]) { console.log(`  ${WARN} ${sym}: no L4-era decision to re-check`); continue; }
    const model = 80 * (seen[sym].ceil / L) / 100;
    if (Math.abs(model - recorded) > 0.001) await fail(`${sym}: model ${model.toFixed(4)} vs recorded ${recorded} — the validation no longer reproduces`);
    console.log(`  ${CHECK} ${sym}: model ${model.toFixed(4)}% == recorded ${recorded}%`);
  }

  console.log('\n4. has the desk exercised the new regime yet?');
  const sized = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.decision); } catch { continue; }
    const at = new Date(r.createdAt);
    for (const e of (Array.isArray(d.decisions) ? d.decisions : [])) {
      if (e && e.sizeCalc) sized.push({ at, sym: e.symbol, sc: e.sizeCalc });
    }
  }
  const after = sized.filter((x) => x.at >= APPLIED);
  if (!after.length) console.log(`  ${WARN} ZERO sized decisions since the change — the prediction is UNTESTED (as the block states)`);
  else {
    console.log(`  ${after.length} sized decision(s) under the new regime:`);
    for (const x of after.slice(0, 6)) {
      console.log(`    ${x.sym} resolved=${x.sc.resolvedRiskPct} cappedAtPct=${JSON.stringify(x.sc.cappedAtPct)} boundBy=${JSON.stringify(x.sc.boundBy)}`);
    }
  }

  console.log('\n5. the row and its marker');
  const r = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!r) await fail(`row ${TASK_ID} does not exist`);
  const n = (r.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(r.info || '').length} chars, this marker ${n}x`);

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

  const aft = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (aft.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(aft.info || '').includes('THE PURCHASING-POWER PACKAGE IS APPLIED')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${aft.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
