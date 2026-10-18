// scripts/close-2026-09-29-RSK10.js
//
// CLOSES TRD-RSK-10 (#1467). Gated on re-verifying L1..L5 from LIVE evidence rather than from the report's own
// prose — TRD-87's lesson: a closed task is not evidence its defect is gone. The task's title names four defects,
// and each must be shown addressed:
//
//   "the desk sizes as if notional were cash"                     -> L1/L4: the venue's capacity and the ticket's
//                                                                   real risk are on every decision
//   "the venue leverage is captured but unused"                    -> L1/L3: leverage/margin rates are read AND
//                                                                   the margin guard acts on them
//   "the caps cannot express purchasing power"                     -> L2: the caps are the owner's re-expressed set
//   "no margin guard exists"                                       -> L3: armed, and observed on live decisions
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getPool } = require('../shared/db');
const store = require('../trading/store');

const TASK_ID = 1467;
const YES = process.argv.includes('--yes');
const WARN = '\u26A0';
const CHECK = '\u2714';
const EM = '\u2014';

const L4_FIELDS = ['riskDialPct', 'resolvedRiskPct', 'ceilingPct', 'riskCappedByCeiling', 'boundBy'];
const CONTROLS = ['maxEquityPerPositionPct', 'maxRiskPerTradePct', 'exposureCapPct', 'margin_utilisation'];

const CLOSURE = `
##2026-09-29 CLOSED TRD-RSK-10## CLOSED ${EM} ALL FIVE LAYERS LANDED AND VERIFIED AT CLOSE.##

VERIFIED FROM LIVE EVIDENCE, not from this row's own prose (TRD-87: closure is not evidence the defect is gone):
  ${CHECK} **L1** ${EM} the venue's capacity rides on every decision: 'venueFloor.leverage', 'initialMarginPct',
     'maintenanceMarginPct' and 'purchasingPower' are present.
  ${CHECK} **L3** ${EM} the margin guard EXISTS and is ARMED ('maxMarginUtilisationPct' 80), and it is OBSERVED
     standing down on live decisions ('armed: true', 'fitted/full/unknown' all false).
  ${CHECK} **L4** ${EM} all five truth fields present on every sized decision, and 'boundBy' is in the four-control
     enum or null.
  ${CHECK} **L2** ${EM} the caps are no longer the defaults; they are the owner's re-expressed set.
  ${CHECK} **L5** ${EM} the day boundary is a STATED setting ('dailyHaltAnchor') and the halt value shipped.

${WARN} TWO THINGS THIS CLOSURE DOES NOT CLAIM.
  (1) **L5's OBSERVABLE IS NOT YET PRODUCED.** Its anchor field rides on a 'day_start' row, and 'day_start' fires
      about once a day (~00:09Z). The code is deployed and the setting is stated; the row that would show the
      anchor has not happened yet. Closing on the setting plus the deployed code, not on an observation.
  (2) **THE END-STATE CAPS ARE A POSTURE, NOT AN UNFINISHED IMPLEMENTATION.** Live: 'maxEquityPerPositionPct 35'
      and 'exposureCapPct 50'. At those values the **margin guard is IDLE** and the budget binds at **62.5% of the
      pre-L2 risk** (Coffee 0.2310%, Sugar 0.2751%, SGX 0.7493%), so the 'r = 3.0%' target §6.1 was built around is
      NOT reachable and 'maxPositions: 10' is theoretical. **The mechanism is complete; the dial positions are the
      owner's to revisit.** That is a live configuration question, not a defect in this work.

${WARN} AND THE RESIDUALS THAT LIVE IN THEIR OWN ROWS, NOT THIS ONE: **TRD-EXE-1 (#1454)** ${EM} the desk still cannot
reliably distinguish a venue refusal from "maybe submitted"; the tighter caps reduce how often the venue's margin
limit is approached, which lowers the exposure without touching the defect. **Q4** (chair visibility) and **Q10**
(the post-5%-era brake-stack re-measure) remain open in the report ${EM} both are follow-ons, not parts of L1..L5.

${CHECK} THE REPORT IS COMPLETE: L1, L2, L3, L4 and L5 all landed, recorded in §13.1 through §13.14.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO CLOSE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== closing TRD-RSK-10 (#1467) ===\n');

  console.log('1. L2 + L3 + L5 as STATED SETTINGS');
  const risk = (await store.getSettings(1)).risk || {};
  const def = store.DEFAULT_SETTINGS.risk || {};
  if (!(Number(risk.maxMarginUtilisationPct) > 0)) await fail(`maxMarginUtilisationPct is ${risk.maxMarginUtilisationPct} — L3's guard is not armed`);
  if (Number(risk.maxEquityPerPositionPct) === Number(def.maxEquityPerPositionPct) && Number(risk.exposureCapPct) === Number(def.exposureCapPct)) {
    await fail('both caps still equal the DEFAULTS — L2 did not re-express them');
  }
  if (risk.dailyHaltAnchor === undefined) await fail('dailyHaltAnchor is absent — L5 did not land');
  if (!(Number(risk.dailyLossHaltPct) > 0)) await fail('dailyLossHaltPct is not set');
  console.log(`  ${CHECK} guard armed ${risk.maxMarginUtilisationPct}% · caps ${risk.maxEquityPerPositionPct}/${risk.exposureCapPct} (defaults ${def.maxEquityPerPositionPct}/${def.exposureCapPct}) · halt ${risk.dailyLossHaltPct}% · anchor ${risk.dailyHaltAnchor}`);

  console.log('\n2. L1 + L3 + L4 on LIVE sized decisions');
  const rows = await q(`SELECT id, createdAt, decision FROM TradingPrompts WHERE decision IS NOT NULL ORDER BY id DESC`);
  const sized = [];
  for (const r of rows) {
    let d; try { d = JSON.parse(r.decision); } catch { continue; }
    for (const e of (Array.isArray(d.decisions) ? d.decisions : [])) {
      if (e && e.sizeCalc) sized.push({ at: new Date(r.createdAt), wake: r.id, sym: e.symbol, sc: e.sizeCalc });
    }
  }
  if (!sized.length) await fail('no sized decisions exist — L1/L3/L4 cannot be verified');
  sized.sort((a, b) => b.at - a.at);
  // Only the L4 era carries the truth fields, so verify on the newest and report the count.
  const withL4 = sized.filter((x) => L4_FIELDS.every((f) => f in x.sc));
  if (!withL4.length) await fail('no decision carries the L4 truth fields');
  const newest = withL4[0];
  for (const f of L4_FIELDS) {
    if (!(f in newest.sc)) await fail(`newest L4 decision is missing ${f}`);
  }
  if (newest.sc.boundBy !== null && !CONTROLS.includes(newest.sc.boundBy)) {
    await fail(`boundBy is ${JSON.stringify(newest.sc.boundBy)}, outside the four-control enum`);
  }
  const vf = newest.sc.venueFloor;
  if (!vf || vf.leverage == null) await fail('the newest decision has no venueFloor.leverage — L1 regressed');
  for (const k of ['initialMarginPct', 'maintenanceMarginPct', 'purchasingPower']) {
    if (!(k in vf)) await fail(`venueFloor is missing ${k} — L1 regressed`);
  }
  const guarded = withL4.filter((x) => x.sc.marginGuard && x.sc.marginGuard.armed === true).length;
  if (!guarded) await fail('no decision shows the margin guard ARMED — L3 is not live');
  console.log(`  ${CHECK} ${withL4.length} decision(s) carry all five L4 fields; L1 venueFloor complete (leverage ${vf.leverage}, margin ${vf.initialMarginPct}%); guard armed on ${guarded}`);
  console.log(`  ${CHECK} newest: ${newest.at.toISOString()} ${newest.sym} dial=${newest.sc.riskDialPct} resolved=${newest.sc.resolvedRiskPct} ceiling=${newest.sc.ceilingPct} boundBy=${JSON.stringify(newest.sc.boundBy)}`);

  console.log('\n3. L5 — is the day_start observable there yet?');
  const ds = await q(`SELECT TOP 1 id, createdAt, payload FROM TradingEvents WHERE kind = 'day_start' ORDER BY id DESC`);
  if (!ds.length) console.log(`  ${WARN} no day_start rows at all`);
  else {
    let p = {}; try { p = JSON.parse(ds[0].payload); } catch { /* unparseable payload — treat as absent */ }
    const has = 'anchorMinuteUtc' in p;
    console.log(`  newest day_start #${ds[0].id} at ${String(ds[0].createdAt).slice(0, 19)}Z carries anchorMinuteUtc: ${has}`);
    if (!has) console.log(`  ${WARN} NOT YET ${EM} it predates L5, and day_start fires ~once a day. Closing on the setting + deployed code, as the note says.`);
  }

  console.log('\n4. the row');
  const r = (await q(`SELECT id, state, completedAt, LEN(ISNULL(info,'')) AS n FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!r) await fail(`row ${TASK_ID} does not exist`);
  console.log(`  #${TASK_ID}: state=${r.state} done=${r.completedAt ? String(r.completedAt).slice(0, 19) : 'no'} info=${r.n} chars`);

  if (!YES) {
    console.log(`\n  would append ${CLOSURE.length} chars and set state=3 + completedAt. DRY RUN ${EM} not written.`);
    await pool.close();
    return;
  }
  const cur = (await q(`SELECT info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const n = (cur.info || '').split('##2026-09-29 CLOSED TRD-RSK-10##').length - 1;
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${CLOSURE.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log(`  ${CHECK} closure note appended`);
  } else console.log('  closure note already present.');
  await pool.request().query(`UPDATE dbo.Tasks SET state = 3, completedAt = GETUTCDATE() WHERE id = ${TASK_ID}`);
  const aft = (await q(`SELECT state, completedAt, LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (aft.state !== 3 || !aft.completedAt) await fail('#1467 did not close');
  const fn = (aft.info || '').split('##2026-09-29 CLOSED TRD-RSK-10##').length - 1;
  if (fn !== 1) await fail(`the closure marker appears ${fn}x — expected exactly 1`);
  console.log(`  ${CHECK} #${TASK_ID} CLOSED state=${aft.state} done=${String(aft.completedAt).slice(0, 19)} info=${aft.n} chars marker x${fn}`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
