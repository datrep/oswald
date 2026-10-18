// scripts/record-2026-09-30-exe3-snapped.js
//
// TRD-EXE-3 (#1463): "the desk records the size it computed while the venue holds a size SNAPPED to its minimum
// increment, so every R is computed off a size that was never filled".
//
// MEASURED, and two of the three findings are not in the row's own text:
//   1. the snap is to the NEAREST MULTIPLE of the venue's minimum, reproducing the venue on 28 of 28 divergent rows;
//   2. 'unitAmount' IS the venue's step (32 of 32 exact multiples, 0 counterexamples), which FALSIFIES
//      'docs/INSTRUMENT_MIRROR.md' §9.2 — the sentence that declined to implement the rounding;
//   3. a SECOND and larger mechanism: 'aggregator.js' applies the chair-offline degrade (x0.5) AFTER 'risk.js'
//      satisfied the floor, and nothing re-checked it — 16 of 44 degraded decisions sent a below-floor size.
//
// FIXED, and the fix is RISK-NEUTRAL BY CONSTRUCTION: the venue applies the same rounding function, so a size
// snapped onto the step is the size the venue would have held anyway. It changes the RECORD, not the position.
//
// Appends to #1463. DRY RUN by default (pass --yes). Every gate re-derives its number and REFUSES on a mismatch.
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192', SIGMA = '\u03A3';

const MARKER = '##2026-09-30 exe3 the venue step is measured and snapped##';
const INFO = `${MARKER} THE VENUE SNAPS TO THE NEAREST MULTIPLE OF ITS MINIMUM, AND THAT MINIMUM IS THE STEP. BOTH RECORDED AND FIXED.##

${STAR} WHAT WAS MEASURED. Over every position carrying an observed venue size ('position_pnl.size' ${EM} the ONLY
venue-side size the desk stores; 'Trades.size' is the desk's own number):
  * **32 of 32 held an EXACT integer multiple** of 'Instruments.unitAmount', with **0 counterexamples**; and
  * **round(deskSize / floor) * floor reproduced the venue's held size on 28 of 28 DIVERGENT rows**, median error
    **3.99%**, max **+100%**.
${ARROW} so the rule is not "the venue raises a size to its minimum". It is "the venue resolves a size to the
NEAREST whole multiple of its minimum, with an exact half going UP". The two differ wherever the size is above the
floor and off the step, which is 28 of 32 rows.

${WARN}${WARN} THIS FALSIFIES A SENTENCE IN 'docs/INSTRUMENT_MIRROR.md' §9.2, AND THAT SENTENCE IS WHAT LICENSED THE
DEFECT. It reads: *"Phase 0 found 'unitAmount' is a **minimum, not a step**, so no rounding to a multiple is
implemented ${EM} inventing a granularity the venue never stated would be the same class of error."* A granularity the
venue applies on every fill IS a granularity the venue stated, however the sidebar's wording was read. The doc is
corrected in place, with the measurement, and the VETO that §9.2 correctly argues for is left standing.

${WARN}${WARN} AND A SECOND, LARGER MECHANISM THE ROW DID NOT NAME: THE DEGRADE IS APPLIED AFTER THE FLOOR IS
SATISFIED. 'risk.js' enforces size >= the venue minimum; 'aggregator.js' then multiplies the RESULT by the
chair-offline factor (0.5 by default) and NOTHING re-checked the floor. Measured: **16 of the 44 degraded decisions
on file sent a size BELOW the venue's minimum.** Because the pre-degrade size is always at least the floor and the
factor is 0.5, the halved size is always at least HALF a floor ${EM} so the venue resolved it to **exactly one floor**,
every time. The "50% size" safety measure was therefore defeated on every symbol whose floor was binding, while the
record still claimed a halving.

  THE WORKED CASE, ENTIRELY FROM ROWS THE DESK WROTE: decision **#105106** (SGX, 2026-09-28T05:13:57Z) carries the
  floor clamp's own record ${EM} 'acceptedSize: 20', 'intendedRiskPct: 0.07', 'forcedRiskPct: 0.1640', 'multiple:
  2.3423' ${EM} beside a top-level 'size: 10'. 'order_attempt' #105118 shows **size 10 physically sent**. 'Trades.size'
  for #1106 recorded **10**. 'position_pnl' #105138 shows the venue holding **20 Shares**. So the desk recorded a
  position carrying **0.07%** of equity while it carried **0.164%**, and it recorded a degraded entry as reduced when
  the degradation had been undone in full.

${CHECK} WHAT WAS FIXED, AND WHY IT IS ALLOWED TO TOUCH A LIVE SIZE.
  * 'instruments.snapToVenueStep(size, minUnits)' ${EM} pure, returns the size, the step count, and whether an exact
    half was resolved up (the half is NAMED rather than left to Math.round's convention, because #1106 is exactly
    that case). It NEVER returns zero for a sub-floor size: the nearest multiple of a floor to a size below it is 0,
    and a zero-unit order is not what the venue does.
  * 'risk.js' snaps ONCE THE FLOOR VERDICT HAS PASSED, and only there. size >= m implies round(size/m) >= 1, so the
    snap cannot dip below the floor and cannot pre-empt the veto ${EM} the ordering is pinned by test.
  * 'aggregator.js' RE-SNAPS after the degrade and records 'degradedFactorEffective' beside 'degradedFloorDefeated',
    so the record stops claiming a reduction the venue undid.
${ARROW} RISK-NEUTRAL BY CONSTRUCTION, which is the only reason this may touch a live size: the venue already applies
this exact function, so the size sent is the size the venue would have held anyway. It changes what the desk
RECORDS, never what the desk GETS. Nothing was clamped upward toward a floor the desk was not granted.

${SIGMA} 8 tests added ('test/venue-step.test.js'), each pinning a numbered instance of the live measurement rather
than an invented proportion. Suite: **1807 tests, 1806 pass, 0 fail, 1 skipped** (was 1799/1798/0/1).

${WARN} WHAT IS *NOT* DONE, AND IT IS THE OWNER'S CALL, NOT A CODE DECISION. When the venue floor defeats the
degrade, the entry still PROCEEDS ${EM} at exactly one floor, which is what the venue did anyway, so the position is
unchanged. But 'degradedFactorEffective' is **1** on those symbols, which means the desk is taking a full-risk entry
while the wake note says "degraded at 50% size". The alternative is to REFUSE such an entry, on the same principle
'risk.js' already uses for a sub-floor size ("an unmeetable minimum means the trade does not fit this dial"). That
would remove trades the desk currently takes, so it is a behavioural change on a live risk path and stays with the
owner. **The condition is now REPORTED ('degradedFloorDefeated') instead of inferred from the venue's own fill.**

${WARN} STILL OPEN, UNCHANGED BY THIS WORK: the desk records 'Trades.size' at submit time and never reconciles it to
the venue's size afterwards. The snap makes the two agree AT SUBMIT, which is the case every one of the 32 measured
rows falls into; it does not add a read-back, and a venue that resolves differently from the measured rule would still
diverger silently.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  console.log('=== TRD-EXE-3: the venue step, re-derived ===\n');

  // ---- 1. the row -----------------------------------------------------------------------------------
  const row = (await q(`SELECT id, state, LEN(CAST(info AS NVARCHAR(MAX))) AS n, CAST(info AS NVARCHAR(MAX)) AS info
      FROM dbo.Tasks WHERE name LIKE 'TRD-EXE-3:%'`))[0];
  if (!row) throw new Error('TRD-EXE-3 not found');
  if (Number(row.state) === 3) throw new Error('TRD-EXE-3 is already archived — this is not the live row');
  const already = String(row.info || '').includes(MARKER);
  console.log(`  ${CHECK} TRD-EXE-3 is #${row.id}, state ${row.state}, ${row.n} chars${already ? ' — MARKER ALREADY PRESENT' : ''}`);

  // ---- 2. 32 of 32 exact multiples, 0 counterexamples ------------------------------------------------
  const rows = await q(`
    WITH venue AS (
      SELECT JSON_VALUE(payload,'$.positionId') AS positionId,
             CAST(JSON_VALUE(payload,'$.size') AS FLOAT) AS venueSize,
             ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(payload,'$.positionId') ORDER BY createdAt DESC) AS rn
      FROM TradingEvents WHERE kind='position_pnl'
    ),
    minamt AS (
      SELECT symbol, MIN(unitAmount) AS floorAmt FROM Instruments
      WHERE userId=1 AND instrumentClass='spot' GROUP BY symbol
    )
    SELECT tr.id, tr.size AS deskSize, v.venueSize, m.floorAmt
    FROM Trades tr
    JOIN venue v ON v.positionId = CAST(tr.plus500PositionId AS NVARCHAR(32)) AND v.rn = 1
    LEFT JOIN minamt m ON m.symbol = tr.symbol
    WHERE tr.userId=1 AND tr.plus500PositionId IS NOT NULL`);
  const withFloor = rows.filter((r) => Number.isFinite(Number(r.floorAmt)) && Number(r.floorAmt) > 0 && Number.isFinite(Number(r.venueSize)));
  if (withFloor.length !== 32) throw new Error(`${withFloor.length} comparable rows, not the 32 this record cites — re-measure before writing`);
  // ⚠ TESTED WITH THE SHIPPED RULE, NOT WITH A MODULO. A first version of this gate used
  // `(venueSize / floor) % 1 > 1e-9`, which reports a FLOAT RATIO of 0.9999999999999998 as off-step while
  // `Math.round` correctly calls it 1 — the gate disagreed with the very function it was checking.
  const rule = require('../trading/agent/instruments').snapToVenueStep;
  const nonMultiple = withFloor.filter((r) => rule(Number(r.venueSize), Number(r.floorAmt)).snapped);
  if (nonMultiple.length !== 0) throw new Error(`${nonMultiple.length} venue size(s) are NOT on the floor's step (#${nonMultiple.map((r) => r.id).join(', #')}) — the STEP claim is falsified`);
  console.log(`  ${CHECK} ${withFloor.length} of ${withFloor.length} venue sizes lie exactly ON the floor's step, 0 counterexamples ⇒ unitAmount is the STEP`);

  // ---- 3. 28 of 28 divergent rows reproduced --------------------------------------------------------
  const divergent = withFloor.filter((r) => Math.abs(Number(r.venueSize) - Number(r.deskSize)) > 1e-9);
  if (divergent.length !== 28) throw new Error(`${divergent.length} divergent rows, not the 28 this record cites`);
  const misses = divergent.filter((r) => Math.abs(rule(Number(r.deskSize), Number(r.floorAmt)).size - Number(r.venueSize)) > 1e-6);
  if (misses.length) throw new Error(`snapToVenueStep MISSES ${misses.length} row(s): #${misses.map((r) => r.id).join(', #')}`);
  console.log(`  ${CHECK} snapToVenueStep reproduces the venue on ${divergent.length} of ${divergent.length} divergent rows`);

  // ---- 4. the degrade defeat: 16 of 44 --------------------------------------------------------------
  const deg = await q(`
    SELECT JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.symbol') AS symbol,
           CAST(JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.size') AS FLOAT) AS sent,
           CAST(JSON_VALUE(CAST(payload AS NVARCHAR(MAX)),'$.sizeCalc.venueFloor.minUnits') AS FLOAT) AS minUnits
    FROM TradingEvents
    WHERE kind='decision' AND CAST(payload AS NVARCHAR(MAX)) LIKE '%"degradedFactor"%'`);
  const under = deg.filter((r) => Number.isFinite(r.sent) && Number.isFinite(r.minUnits) && r.minUnits > 0 && r.sent < r.minUnits);
  if (deg.length !== 44) throw new Error(`${deg.length} degraded decisions, not the 44 this record cites`);
  if (under.length !== 16) throw new Error(`${under.length} degraded decisions sent a below-floor size, not the 16 this record cites`);
  console.log(`  ${CHECK} ${under.length} of ${deg.length} degraded decisions sent a size BELOW the venue floor (symbols: ${[...new Set(under.map((r) => r.symbol))].join(', ')})`);

  // ---- 5. the worked case, entirely from rows the desk wrote ----------------------------------------
  const dec = await q(`SELECT CAST(payload AS NVARCHAR(MAX)) AS p FROM TradingEvents WHERE id=105106`);
  if (!dec.length) throw new Error('decision #105106 is gone — the worked case cannot be cited');
  const dj = JSON.parse(dec[0].p);
  if (Number(dj.size) !== 10) throw new Error(`#105106 size is ${dj.size}, not 10`);
  if (Number(dj.sizeCalc.venueFloor.acceptedSize) !== 20) throw new Error(`acceptedSize is ${dj.sizeCalc.venueFloor.acceptedSize}, not 20`);
  if (Number(dj.sizeCalc.venueFloor.intendedRiskPct) !== 0.07) throw new Error(`intendedRiskPct is ${dj.sizeCalc.venueFloor.intendedRiskPct}, not 0.07`);
  if (Math.abs(Number(dj.sizeCalc.venueFloor.forcedRiskPct) - 0.1640) > 0.001) throw new Error(`forcedRiskPct is ${dj.sizeCalc.venueFloor.forcedRiskPct}, not ~0.1640`);
  const attempt = (await q(`SELECT CAST(payload AS NVARCHAR(MAX)) AS p FROM TradingEvents WHERE id=105118`))[0];
  if (!attempt || Number(JSON.parse(attempt.p).order.size) !== 10) throw new Error('#105118 does not show size 10 physically sent');
  const t1106 = (await q(`SELECT size, plus500PositionId FROM Trades WHERE id=1106`))[0];
  if (!t1106 || Number(t1106.size) !== 10) throw new Error(`Trades #1106 size is ${t1106 && t1106.size}, not 10`);
  const pnl = (await q(`SELECT TOP 1 CAST(payload AS NVARCHAR(MAX)) AS p FROM TradingEvents
      WHERE kind='position_pnl' AND JSON_VALUE(payload,'$.positionId')='1888436082' ORDER BY id`))[0];
  if (!pnl || Number(JSON.parse(pnl.p).size) !== 20) throw new Error('position_pnl for 1888436082 does not show the venue holding 20');
  console.log(`  ${CHECK} #1106: clamped 20 · degraded 10 · SENT 10 · recorded 10 · venue held 20 (recorded 0.07% of equity, carried 0.164%)`);

  // ---- 6. the wiring ------------------------------------------------------------------------------
  const inst = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'instruments.js'), 'utf8');
  const risk = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
  const agg = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'aggregator.js'), 'utf8');
  const mirror = fs.readFileSync(path.join(__dirname, '..', 'trading', 'docs', 'INSTRUMENT_MIRROR.md'), 'utf8');
  if (!/function snapToVenueStep\(/.test(inst)) throw new Error('snapToVenueStep is not in instruments.js');
  if (!/snapToVenueStep\(size, floor\.resolved/.test(risk)) throw new Error('risk.js does not snap the size');
  if (!/snapToVenueStep\(halved,/.test(agg)) throw new Error('aggregator.js does not re-snap after the degrade');
  if (!/degradedFactorEffective/.test(agg) || !/degradedFloorDefeated/.test(agg)) throw new Error('the degrade record is not honest');
  if (!/CORRECTED 2026-09-30 \(TRD-EXE-3\)/.test(mirror)) throw new Error('INSTRUMENT_MIRROR.md §9.2 is not corrected');
  if (!fs.existsSync(path.join(__dirname, '..', 'test', 'venue-step.test.js'))) throw new Error('test/venue-step.test.js is missing');
  console.log(`  ${CHECK} snapToVenueStep exists · risk.js snaps · aggregator.js re-snaps and records · the doc correction is in place · 8 tests on file`);

  // ---- 7. the live dial the residual turns on -------------------------------------------------------
  const raw = (await q(`SELECT CAST(settings AS NVARCHAR(MAX)) AS j FROM TradingSettings WHERE userId=1`))[0];
  const settings = JSON.parse(raw.j);
  console.log(`  ${CHECK} live: acceptVenueFloor=${JSON.stringify(settings.risk.acceptVenueFloor)}, chairDegraded=${JSON.stringify(settings.deliberation && settings.deliberation.chairDegraded)} ⇒ the defeat now REPORTS itself instead of being inferred`);

  // ---- 8. the addendum must survive a T-SQL literal ------------------------------------------------
  if (INFO.includes('\u0060')) throw new Error('the addendum contains a backtick');
  console.log(`  ${CHECK} no backticks (${INFO.length} chars)`);
  console.log(`  would append to TRD-EXE-3 (#${row.id})`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.\n`); await pool.close(); return; }
  if (already) { console.log(`  ${CHECK} already present; nothing appended`); await pool.close(); return; }
  await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${INFO.replace(/'/g, "''")}' WHERE id = ${row.id}`);
  const after = (await q(`SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${row.id}`))[0].n;
  console.log(`  ${CHECK} appended; TRD-EXE-3 (#${row.id}) is now ${after} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
