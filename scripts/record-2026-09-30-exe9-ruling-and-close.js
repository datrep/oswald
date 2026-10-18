// scripts/record-2026-09-30-exe9-ruling-and-close.js
//
// TRD-EXE-9 (#1479): "a risk refusal happens BEFORE the committee, so the venue-floor disclosure the desk puts on
// the ticket is written into a bundle nobody reads".
//
// THE RULING IS THAT THE ROW IS WORKING AS DESIGNED, and both of its routes are refused for reasons rather than
// for precedence:
//   (a) convene the seat on a floor refusal  — REJECTED. Cannot change the outcome, and manufactures deliberation.
//   (b) risk.acceptVenueFloor: true          — RETIRED AS UNMOTIVATED. RSK-4 removed its only measured motive.
//   (c) the stored 41k-char bundle           — THE REAL RESIDUAL, MEASURED AND FILED SEPARATELY, NOT TAKEN.
//
// Inserts TRD-EXE-11 for (c), appends the ruling to #1479, and closes it. DRY RUN by default (pass --yes).
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const MARKER = '##2026-09-30 exe9 ruling nothing to land and closed##';
const NEW_NAME = 'TRD-EXE-11: Wake - the desk ASSEMBLES a full prompt bundle on 63% of wakes and never sends it, so the refusal audit trail is ~41k chars per row and is read by nobody';
const NEW_INFO = `##2026-09-30 exe11 the bundle nobody sends## THE REFUSAL AUDIT TRAIL IS PAID FOR ON EVERY WAKE AND READ BY NOBODY. FOUND AS EXE-9 (c), FILED SEPARATELY SO A CLOSED ROW DOES NOT CARRY AN OPEN DEFECT.##

${STAR} MEASURED, on 'TradingPrompts' (the stored bundles), re-derived by the gate below rather than quoted:
  * **1,784 bundles assembled, 662 with a response (37.1%), 1,122 NEVER SENT (62.9%)**;
  * **63.6 M characters of bundle text held**, average **~41,000 chars** on 'schedule' and 'micro' wakes, with the
    largest unsent rows at **~56,000 chars** each.
${ARROW} the unsent majority is concentrated exactly where the desk is busiest: 'schedule' 859 of 1,225 unsent, 'micro'
222 of 341. 'pulse' is the exception (18 of 135) because a pulse bundle is only ~3,000 chars and is nearly always sent.

${WARN} WHAT THIS IS NOT, STATED FIRST BECAUSE THE OBVIOUS READING IS WRONG: **it is not an LLM spend leak.** An unsent
bundle costs zero tokens. The cost is assembly CPU on every wake that will refuse, plus 63.6 M chars of database with
no reader. **The waste is a RECORD, not a purchase.**

${STAR} AND THE RECORD IS NOT THE ONLY COPY OF THE INFORMATION ${EM} WHICH IS WHAT MAKES THIS FIXABLE WITHOUT LOSING ANYTHING.
The refusal is ALSO written as a compact 'TradingEvents' row of kind 'decision', and that row already carries the
symbol, the resolved size, 'sizeCalc.venueFloor' (minUnits, unitKind, floorHeadroomMultiple, riskAtFloorPct),
'vetoCodes', 'vetoReasons', 'riskReasons' and 'blockedReason'. Every number EXE-9 needed was read out of THAT row on
2026-09-30, not out of a bundle. So the 41k-char bundle is the SECOND copy of a fact the desk already stores in a
queryable form, and it is the copy with no consumer.

${CHECK} THE DIRECTION OF THE FIX, NOT TAKEN HERE BECAUSE IT IS THE WAKE PIPELINE. Two shapes, and they are not
equivalent:
  (i) STOP ASSEMBLING the full bundle when the decision is already determined without a model call ${EM} store the
      compact refusal instead. Cheapest, and the risk is that the bundle is the desk's record of what the SEAT would
      have been given, which is not the same fact as what the GATE decided;
  (ii) KEEP assembling and SURFACE it ${EM} a queryable refusal summary, so the 63.6 M chars stop having no reader.
      Keeps every fact and answers the "written into a bundle nobody reads" complaint at its source.
${WARN} (i) and (ii) differ in what they destroy, so this row does NOT pick one. **What EXE-9 actually asked for was for
the seat to SEE the floor, and that half is DONE AND VERIFIED** ${EM} see the parent row. This row is only about cost and
consumers, and it should be judged on that alone.`;

const RULING = `${MARKER} THE ROW IS WORKING AS DESIGNED. BOTH ROUTES ARE REFUSED, AND ONE OF THEM IS NOW UNMOTIVATED.##

${STAR} THE DISCLOSURE HALF IS DONE AND WAS RE-VERIFIED, so this row's remaining content is only the part nobody reads.
'promptBuilder.js' puts the floor on the line the seat votes on ${EM} "PROPOSED ACTION by quant: entry buy SGX
size=risk-sized ${ARROW} venue minimum 20 Shares" ${EM} and a stored bundle carrying that exact string is asserted by the
gate below, on live data rather than on the code.

${WARN} (a) CONVENE THE SEAT ON A FLOOR REFUSAL ${EM} **REJECTED**, for three reasons of increasing force.
  1. **It cannot change the outcome.** The gate is deterministic and terminal; a committee verdict on a ticket that
     cannot be sent has no decision attached to it. The desk would pay for an opinion it is not allowed to act on.
  2. **It MANUFACTURES THE APPEARANCE OF DELIBERATION.** A stored bundle reading "the committee considered SGX at 20
     Shares" for a ticket that could never be sent is a record that reads as coverage where there is none. That is
     the failure this desk has now paid for four times: a guard whose silence read as coverage, a doc sentence that
     licensed the EXE-3 defect, a degrade the venue undid while the record claimed a halving, and (this session) a
     margin guard whose ceiling was 28% looser than it read.
  3. **It BREAKS THE INVARIANT THIS ROW'S OWN EVIDENCE RESTS ON.** "200 of 200 no-model decisions are refusals" is
     only a finding while "no model was called" implies "nothing was owed to it". Convene the seat on refusals and
     that sentence stops meaning anything ${EM} the census would then be measuring the new policy, not the old defect.
${ARROW} AND THE ORDER IS THE STANDARD ONE, ALREADY IN PLACE AND VERIFIED HERE: the cheap deterministic gate runs
before the expensive non-deterministic one. 'aggregator.js' returns on 'risk.veto' BEFORE it calls 'chairVotes', and the
module header states it as a rule ("veto ABSOLUTE: risk.veto returns before any chair is called"). **Fail fast is not a
compromise the desk settled for; it is the correct ordering, and this row proposed to undo it.**

${WARN} (b) 'risk.acceptVenueFloor: true' ${EM} **RETIRED AS UNMOTIVATED, WHICH IS STRONGER THAN REFUSED.**
Its ONLY measured motive was SGX: a 20-Share floor forcing 0.1640% of equity against a 0.07% budget = **2.34x** the
dial. **TRD-RSK-4 (#1453) closed that on 2026-09-30**: 'risk.maxRiskPerTradePct' went 0.07 ${ARROW} 5 at
2026-09-28T19:36:38Z, and every SGX floor verdict after that move reads 'above_venue_minimum' (5 of 5), the largest
sizing **148.0699 Shares = 7.4 venue minimums**. There is no longer a floor the desk cannot reach, so the clamp has
nothing to do but RAISE risk on the tightest stops, which are exactly the tickets the sizing formula makes smallest.
${ARROW} 'acceptVenueFloor' stays **false**, and the gate below asserts it, so this row can never be mistaken for a
control change. **If floor-forced risk is ever wanted, the lever is the DIAL, set once for the whole book, not a
per-ticket clamp.** Enabling it for one symbol is not expressible and enabling it globally takes 2.34x on every
tightest-stop ticket in every symbol.

${CHECK} (c) THE REAL RESIDUAL, MEASURED, AND FILED RATHER THAN TAKEN: **1,784 bundles assembled, 662 sent (37.1%),
1,122 NEVER SENT (62.9%), 63.6 M chars of bundle text held, ~41,000 chars per 'schedule'/'micro' bundle.** An unsent
bundle costs zero tokens, so this is not an LLM spend leak ${EM} it is an audit trail with no reader, and the refusal is
ALREADY stored in a compact queryable form on the 'decision' event. Filed as **TRD-EXE-11** rather than folded in here,
because the two shapes of the fix destroy different things (stop assembling vs surface it) and that choice belongs to
the owner.
${ARROW} EXE-9's own note calls those bundles "the desk's only record of what it was thinking when it refused to trade".
**The parent row has now been checked against that claim and it is only half true**: the 'decision' event carries the
veto codes, the venue floor, the resolved size and the reasons, and it is the row every number in this session was
actually read from. What the bundle adds is the SEAT'S VIEW ${EM} which nothing consumed, because nothing was asked.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  console.log('=== TRD-EXE-9: the ruling, re-derived ===\n');

  const row = (await q(`SELECT id, state, LEN(CAST(info AS NVARCHAR(MAX))) AS n, CAST(info AS NVARCHAR(MAX)) AS info
      FROM dbo.Tasks WHERE name LIKE 'TRD-EXE-9:%'`))[0];
  if (!row) throw new Error('TRD-EXE-9 not found');
  if (Number(row.state) === 3) throw new Error('TRD-EXE-9 is already archived');
  const already = String(row.info).includes(MARKER);
  console.log(`  ${CHECK} TRD-EXE-9 is #${row.id}, state ${row.state}, ${row.n} chars${already ? ' — MARKER ALREADY PRESENT' : ''}`);

  // ---- 1. the ordering the rejection of (a) rests on ----------------------------------------------
  const agg = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'aggregator.js'), 'utf8');
  const vetoAt = agg.indexOf('if (risk.veto)');
  const chairsAt = agg.indexOf('await chairVotes(');
  if (vetoAt < 0 || chairsAt < 0) throw new Error('the veto return or the chair call is not where this record says it is');
  if (!(vetoAt < chairsAt)) throw new Error('chairVotes is called BEFORE the veto return — route (a) is already implemented and this ruling is wrong');
  console.log(`  ${CHECK} risk.veto returns before chairVotes is called — fail-fast ordering is in place (the rejection of (a) rests on this)`);

  // ---- 2. the disclosure is real, on live data -----------------------------------------------------
  const pb = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'promptBuilder.js'), 'utf8');
  if (!/PROPOSED ACTION by quant:.*venue minimum/.test(pb)) throw new Error('the floor is not on the PROPOSED ACTION line — the "disclosure is done" half cannot be claimed');
  const live = await q(`SELECT TOP 1 id, LEN(CAST(bundle AS NVARCHAR(MAX))) AS chars FROM TradingPrompts
      WHERE CAST(bundle AS NVARCHAR(MAX)) LIKE '%venue minimum 20 Shares%' ORDER BY id DESC`);
  if (!live.length) throw new Error('no stored bundle carries "venue minimum 20 Shares" — the live example cannot be cited');
  console.log(`  ${CHECK} the floor is on the seat's own line and a stored bundle carries it (TradingPrompts #${live[0].id}, ${live[0].chars} chars)`);

  // ---- 3. (b) has no motive left -------------------------------------------------------------------
  const settings = JSON.parse((await q(`SELECT CAST(settings AS NVARCHAR(MAX)) AS j FROM TradingSettings WHERE userId=1`))[0].j);
  if (settings.risk.acceptVenueFloor !== false) throw new Error('acceptVenueFloor is ON — the retirement recorded here no longer describes the desk');
  const store = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
  if (!/acceptVenueFloor:\s*false/.test(store)) throw new Error('the acceptVenueFloor default is not false in store.js');
  const sgx = await q(`SELECT JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.sizeCalc.venueFloor.reason') AS reason,
      CAST(JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.size') AS FLOAT) AS size
    FROM TradingEvents WHERE kind='decision'
      AND JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.symbol')='SGX'
      AND JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.sizeCalc.venueFloor.minUnits') IS NOT NULL
      AND createdAt > '2026-09-28T19:36:38.110'`);
  if (!sgx.length) throw new Error('no SGX floor verdict after the cap change — the "no floor is out of reach" claim is unbacked');
  const stillRefused = sgx.filter((v) => v.reason !== 'above_venue_minimum');
  if (stillRefused.length) throw new Error(`${stillRefused.length} SGX verdict(s) after the cap change are still below the floor — route (b) would still have work to do`);
  console.log(`  ${CHECK} acceptVenueFloor false in the live settings AND in store.js; ${sgx.length} of ${sgx.length} post-cap-change SGX verdicts clear the floor ⇒ (b) is unmotivated`);

  // ---- 4. the (c) measurement, re-derived ----------------------------------------------------------
  const t = (await q(`SELECT COUNT(*) AS n,
      SUM(CASE WHEN response IS NOT NULL AND LEN(CAST(response AS NVARCHAR(MAX))) > 0 THEN 1 ELSE 0 END) AS sent,
      SUM(LEN(CAST(bundle AS NVARCHAR(MAX)))) AS chars FROM TradingPrompts`))[0];
  const unsent = Number(t.n) - Number(t.sent);
  const share = unsent / Number(t.n) * 100;
  if (unsent < 1000) throw new Error(`only ${unsent} unsent bundle(s) — the finding has gone away`);
  if (Number(t.chars) < 50e6) throw new Error(`only ${(Number(t.chars) / 1e6).toFixed(1)} M chars of bundle text — not the ~63.6 M this record cites`);
  if (Math.abs(share - 62.9) > 3) throw new Error(`the unsent share is ${share.toFixed(1)}%, not the ~62.9% this record cites`);
  console.log(`  ${CHECK} ${t.n} bundles, ${t.sent} sent, ${unsent} NEVER SENT (${share.toFixed(1)}%), ${(Number(t.chars) / 1e6).toFixed(2)} M chars held`);

  // ---- 5. the refusal is genuinely on a compact decision row too ------------------------------------
  const dec = await q(`SELECT TOP 1 id, LEN(CAST(payload AS NVARCHAR(MAX))) AS n FROM TradingEvents
      WHERE kind='decision' AND CAST(payload AS NVARCHAR(MAX)) LIKE '%venue_minimum%' ORDER BY id DESC`);
  if (!dec.length) throw new Error('no decision event carries a venue_minimum refusal — the "already stored compactly" claim is unbacked');
  console.log(`  ${CHECK} the refusal is ALSO on a compact decision event (#${dec[0].id}, ${dec[0].n} chars vs ~41,000 for the bundle) ⇒ the bundle is the SECOND copy`);

  // ---- 6. the new row ------------------------------------------------------------------------------
  const existing = await q(`SELECT id FROM dbo.Tasks WHERE name LIKE 'TRD-EXE-11:%'`);
  if (existing.length > 1) throw new Error(`${existing.length} TRD-EXE-11 rows exist`);
  if (NEW_NAME.length > 255) throw new Error(`the new name is ${NEW_NAME.length} chars and dbo.Tasks.name holds 255`);
  console.log(`  ${CHECK} TRD-EXE-11 ${existing.length ? `already exists as #${existing[0].id}` : 'will be inserted'} (${NEW_NAME.length}-char name)`);

  for (const [what, text] of [['the ruling', RULING], ['the new row', NEW_INFO]]) {
    if (text.includes('\u0060')) throw new Error(`${what} contains a backtick`);
  }
  console.log(`  ${CHECK} no backticks (ruling ${RULING.length} chars, new row ${NEW_INFO.length} chars)`);
  console.log(`  would insert TRD-EXE-11 and append to + close TRD-EXE-9 (#${row.id})`);
  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.\n`); await pool.close(); return; }

  const esc = (s) => s.replace(/'/g, "''");
  if (!existing.length) {
    await pool.request().query(`INSERT INTO dbo.Tasks (name, info, state, plannedStart) VALUES (N'${esc(NEW_NAME)}', N'${esc(NEW_INFO)}', 1, GETUTCDATE())`);
    const made = (await q(`SELECT id, state FROM dbo.Tasks WHERE name LIKE 'TRD-EXE-11:%'`))[0];
    if (!made || Number(made.state) !== 1) throw new Error('the new row did not land in state 1');
    console.log(`  ${CHECK} TRD-EXE-11 filed as #${made.id}`);
  }
  if (!already) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${esc(RULING)}', state = 3, completedAt = GETUTCDATE() WHERE id = ${row.id}`);
  } else {
    await pool.request().query(`UPDATE dbo.Tasks SET state = 3, completedAt = ISNULL(completedAt, GETUTCDATE()) WHERE id = ${row.id}`);
  }
  const back = (await q(`SELECT state, completedAt, LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${row.id}`))[0];
  if (Number(back.state) !== 3) throw new Error('the state did not change — the close did not land');
  console.log(`  ${CHECK} #${row.id} closed: state ${back.state}, completedAt ${new Date(back.completedAt).toISOString()}, ${back.n} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
