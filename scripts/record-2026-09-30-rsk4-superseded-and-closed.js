// scripts/record-2026-09-30-rsk4-superseded-and-closed.js
//
// TRD-RSK-4 (#1453): "SGX is structurally untradeable: its venue floor forces 2.34x the risk cap".
//
// THE MECHANISM WAS REAL AND THE ROW WAS RIGHT WHEN IT WAS WRITTEN. IT IS NOT TRUE NOW, AND NOTHING CHANGED
// IN THE CODE :: a SETTINGS CHANGE retired it. The settings_write journal records
//     risk.maxRiskPerTradePct  0.07 -> 5   at 2026-09-28T19:36:38Z
// and on 2026-09-28T05:13:57Z that same 0.07% is verbatim in decision #105106 ("0.1640% of equity instead of
// 0.0700% ... 2.34x the intended risk"). Every SGX floor verdict before the change reads below_venue_minimum;
// every one after reads above_venue_minimum, the first sizing 148.0699 Shares = 7.4 venue minimums.
//
// Closes #1453 and appends the account. DRY RUN by default (pass --yes). Gates re-derive and REFUSE.
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const CHANGE_AT = '2026-09-28T19:36:38.110Z';
const MARKER = '##2026-09-30 rsk4 superseded by the cap change and closed##';
const INFO = `${MARKER} THE 2.34x WAS A PROPERTY OF THE CAP, NOT OF SGX. A SETTINGS CHANGE RETIRED IT AND THE CODE DID NOT MOVE.##

${STAR} THIS ROW'S MECHANISM, RESTATED SO IT CAN BE CHECKED: at 'maxRiskPerTradePct' = **0.07%** and equity
~4,128, one SGX venue minimum (20 Shares at a 0.3390 effective stop) risks **0.1642%** of equity. 0.1642 > 0.07, so
NO size in SGX satisfies the dial and the venue at once. The row's own decision is that arithmetic on the record,
verbatim: decision **#105106** carries *"this ticket carries 0.1640% of equity instead of 0.0700% (2.34x the
intended risk)"*. **The row was correct.**

${STAR}${STAR} AND THE JOURNAL SAYS WHAT HAPPENED TO IT ${EM} a SETTINGS CHANGE, NOT A CODE CHANGE:
    risk.maxRiskPerTradePct   0.07 ${ARROW} 5     at **2026-09-28T19:36:38Z**  (settings_write #116764)
Live now: 'riskPerTradePct' 3, 'maxRiskPerTradePct' 5, 'maxEquityPerPositionPct' 35, 'exposureCapPct' 50,
'maxMarginUtilisationPct' 80, 'acceptVenueFloor' false.

${CHECK} THE FALSIFIABLE TEST, AND IT PASSES IN BOTH DIRECTIONS: partition every SGX decision carrying a floor
verdict by that instant.
    BEFORE  2026-09-28T07:13 .. 07:53${EM}and earlier   every one **below_venue_minimum**   (the refusals this row counted)
    AFTER   2026-09-29T04:28, 04:50                     every one **above_venue_minimum**, the first sizing
                                                       **148.0556** and then **148.0699** Shares = **7.4 venue minimums**
${ARROW} the floor did not move (20 Shares, and its own addendum had already re-confirmed that against the venue's
positions page). **The BUDGET moved, and that was the whole of it.** At a 3% dial the same floor is slack.

${WARN} SO THE HEADLINE IS RETIRED AND THE FINDING IS NOT. SGX is not "structurally untradeable"; it was untradeable
**at a 0.07% budget**, which is a statement about the DIAL. The generalisation the row correctly drew survives and is
what was worth keeping: **a symbol whose venue floor exceeds the risk budget is a symbol that can never fire.**

${CHECK} ACCEPTANCE, ITEM BY ITEM.
  1. **a ruling on SGX** ${EM} SATISFIED BY THE CAP CHANGE. Nothing further: the symbol clears and has cleared since
     2026-09-29T04:28. 'acceptVenueFloor' stays **false**, which is correct ${EM} it exists to force a size UP to a floor
     the desk cannot reach, and there is no longer a floor it cannot reach.
  2. **the TRD-RSK-2 declared-stop-widening candidate** ${EM} belongs to #1418, not here, and is UNCHANGED. It was
     never load-bearing for this row's headline in the end: the stop distance is a constant 0.339/0.336 across every
     SGX decision on file, so it moves the floor's absolute risk but not whether the floor clears.
  3. **a standing check for this class** ${EM} LANDED, in its data form. 'risk.evaluate' now records, on EVERY decision
     that reaches the floor check, 'venueFloor.riskAtFloorPct' (the percent of equity ONE venue minimum risks, at the
     MEASURED loss distance) and 'venueFloor.floorHeadroomMultiple' (how many venue minimums the ticket is worth).
     That is the comparison this row had to make by hand, now on every row. **test/venue-step.test.js** pins it,
     including that it reproduces this row's own 0.164% and that 'venue_minimum' still has exactly ONE emission site.

${WARN} THE RESIDUAL, NAMED RATHER THAN CLOSED OVER: it is a RECORD, not a dashboard. Nothing yet SURFACES
'riskAtFloorPct > the dial' as a warning, so a symbol drifting toward its floor still has to be noticed by a reader.
Claiming otherwise would be exactly the kind of status line this session has twice had to correct. The data needed to
flag it now exists on every decision; the surface does not.

${WARN} AND THE ONE THING TO CARRY FORWARD: this row was closed by an OWNER SETTINGS EDIT that no code change
annotated. 'maxRiskPerTradePct' 0.07 ${ARROW} 5 was made for its own reasons on 2026-09-28 and silently made a Tier-2
finding obsolete. **A settings journal is the only thing that can connect the two, and it is the reason this can be
stated at all rather than guessed.**`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  console.log('=== TRD-RSK-4: superseded? ===\n');

  const row = (await q(`SELECT id, state, name, LEN(CAST(info AS NVARCHAR(MAX))) AS n, CAST(info AS NVARCHAR(MAX)) AS info
      FROM dbo.Tasks WHERE name LIKE 'TRD-RSK-4:%'`))[0];
  if (!row) throw new Error('TRD-RSK-4 not found');
  if (Number(row.state) === 3) throw new Error('TRD-RSK-4 is already archived');
  const already = String(row.info).includes(MARKER);
  console.log(`  ${CHECK} TRD-RSK-4 is #${row.id}, state ${row.state}, ${row.n} chars${already ? ' — MARKER ALREADY PRESENT' : ''}`);

  // ---- 1. the journal carries the move, and it is the ONLY one ------------------------------------
  const moves = await q(`SELECT id, CONVERT(varchar(23), createdAt, 126) AS at, CAST(payload AS NVARCHAR(MAX)) AS p
    FROM TradingEvents WHERE kind='settings_write' AND CAST(payload AS NVARCHAR(MAX)) LIKE '%maxRiskPerTradePct%' ORDER BY id`);
  const changes = [];
  for (const m of moves) for (const c of (JSON.parse(m.p).changes || [])) if (c.key === 'risk.maxRiskPerTradePct') changes.push({ id: m.id, at: m.at, before: c.before, after: c.after });
  if (changes.length !== 1) throw new Error(`${changes.length} maxRiskPerTradePct move(s) in the journal, not the 1 this record cites`);
  const mv = changes[0];
  if (Number(mv.before) !== 0.07 || Number(mv.after) !== 5) throw new Error(`the move is ${mv.before} -> ${mv.after}, not 0.07 -> 5`);
  console.log(`  ${CHECK} the journal has exactly one move: maxRiskPerTradePct ${mv.before} -> ${mv.after} at ${mv.at} (event #${mv.id})`);

  // ---- 2. the cap was 0.07% on the decision the row quotes ----------------------------------------
  const d = (await q(`SELECT CAST(payload AS NVARCHAR(MAX)) AS p FROM TradingEvents WHERE id=105106`))[0];
  if (!d) throw new Error('decision #105106 is gone — the row\'s own evidence cannot be cited');
  const dj = JSON.parse(d.p);
  const forced = Number(dj.sizeCalc.venueFloor.forcedRiskPct);
  if (Math.abs(forced - 0.1640) > 0.001) throw new Error(`#105106 forcedRiskPct is ${forced}, not ~0.1640`);
  if (Math.abs(Number(dj.sizeCalc.venueFloor.multiple) - 2.3423) > 0.001) throw new Error(`#105106 multiple is ${dj.sizeCalc.venueFloor.multiple}, not ~2.3423`);
  console.log(`  ${CHECK} #105106 carries the row's arithmetic verbatim: forcedRiskPct ${forced.toFixed(4)} = ${Number(dj.sizeCalc.venueFloor.multiple).toFixed(4)}x the dial`);

  // ---- 3. THE DISCRIMINATOR: before the move refused, after the move clears ------------------------
  const verdicts = await q(`
    SELECT id, CONVERT(varchar(23), createdAt, 126) AS at,
      CAST(JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.size') AS FLOAT) AS size,
      JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.sizeCalc.venueFloor.reason') AS reason
    FROM TradingEvents
    WHERE kind='decision'
      AND JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.symbol')='SGX'
      AND JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.sizeCalc.venueFloor.minUnits') IS NOT NULL
    ORDER BY id`);
  const cut = Date.parse(CHANGE_AT);
  const before = verdicts.filter((v) => Date.parse(String(v.at).replace(' ', 'T') + 'Z') < cut);
  const after = verdicts.filter((v) => Date.parse(String(v.at).replace(' ', 'T') + 'Z') > cut);
  if (!before.length || !after.length) throw new Error(`the partition is empty (before ${before.length}, after ${after.length}) — the change instant is not the split`);
  const badBefore = before.filter((v) => v.reason !== 'below_venue_minimum');
  const badAfter = after.filter((v) => v.reason !== 'above_venue_minimum');
  if (badBefore.length) throw new Error(`${badBefore.length} SGX verdict(s) BEFORE the change are not below_venue_minimum — the timeline does not split cleanly`);
  if (badAfter.length) throw new Error(`${badAfter.length} SGX verdict(s) AFTER the change are not above_venue_minimum (#${badAfter.map((v) => v.id).join(', #')}) — the supersession claim is falsified`);
  const sized = after.filter((v) => Number.isFinite(v.size) && v.size > 0);
  if (!sized.length) throw new Error('no SGX decision after the change carries a size — the "7.4 minimums" claim cannot be made');
  const biggest = sized.reduce((a, b) => (Number(a.size) >= Number(b.size) ? a : b));
  if (Number(biggest.size) < 20) throw new Error(`the largest post-change SGX size is ${biggest.size}, below the 20-Share floor`);
  console.log(`  ${CHECK} SGX floor verdicts: ${before.length} before the move ALL below_venue_minimum · ${after.length} after ALL above_venue_minimum · largest size ${biggest.size} = ${(Number(biggest.size) / 20).toFixed(1)} venue minimums`);

  // ---- 4. the standing check landed and is pinned --------------------------------------------------
  const risk = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
  const test = fs.readFileSync(path.join(__dirname, '..', 'test', 'venue-step.test.js'), 'utf8');
  if (!/riskAtFloorPct:/.test(risk) || !/floorHeadroomMultiple:/.test(risk)) throw new Error('the standing check is not in risk.js');
  if (!/riskAtFloorPct/.test(test)) throw new Error('the standing check is not pinned by test');
  if (!/acceptVenueFloor === true/.test(risk)) throw new Error('the acceptVenueFloor gate is gone — this row\'s item 1 justification depends on it still existing');
  console.log(`  ${CHECK} riskAtFloorPct + floorHeadroomMultiple are recorded on every cleared decision and pinned by test`);

  const settings = JSON.parse((await q(`SELECT CAST(settings AS NVARCHAR(MAX)) AS j FROM TradingSettings WHERE userId=1`))[0].j);
  if (settings.risk.acceptVenueFloor !== false) throw new Error('acceptVenueFloor is ON — the ruling recorded here no longer describes the desk');
  if (Number(settings.risk.maxRiskPerTradePct) !== 5) throw new Error(`maxRiskPerTradePct is ${settings.risk.maxRiskPerTradePct}, not the live 5 this record cites`);
  console.log(`  ${CHECK} live: maxRiskPerTradePct 5, acceptVenueFloor ${JSON.stringify(settings.risk.acceptVenueFloor)}`);

  if (INFO.includes('\u0060')) throw new Error('the addendum contains a backtick');
  console.log(`  ${CHECK} no backticks (${INFO.length} chars)`);
  console.log(`  would appraise #${row.id} and close it (state 3)`);
  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.\n`); await pool.close(); return; }

  if (!already) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${INFO.replace(/'/g, "''")}', state = 3, completedAt = GETUTCDATE() WHERE id = ${row.id}`);
  } else {
    await pool.request().query(`UPDATE dbo.Tasks SET state = 3, completedAt = ISNULL(completedAt, GETUTCDATE()) WHERE id = ${row.id}`);
  }
  const back = (await q(`SELECT state, completedAt, LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${row.id}`))[0];
  if (Number(back.state) !== 3) throw new Error('the state did not change — the close did not land');
  console.log(`  ${CHECK} #${row.id} closed: state ${back.state}, completedAt ${new Date(back.completedAt).toISOString()}, ${back.n} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
