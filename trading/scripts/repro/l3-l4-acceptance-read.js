// trading/scripts/repro/l3-l4-acceptance-read.js — THE ACCEPTANCE READ FOR L3 + L4.
//
// ⚠ WHY THIS IS A SCRIPT AND NOT A SENTENCE. Both layers were recorded as "LANDED" while one of them was missing
// from disk, and the reason nobody noticed is that BOTH states (working, and absent) produce the same observable:
// no size change. So the acceptance criteria are written down here as an executable check, with the restart
// instant supplied as an ARGUMENT so the read can never be satisfied by a row that predates the code.
//
// WHAT IT ASSERTS, and each one is a thing that was actually broken:
//   1. the decision carries a `sizeCalc` at all               (micro wakes carry NONE — they never reach risk);
//   2. all FIVE L4 fields are present                        (riskDialPct / resolvedRiskPct / ceilingPct /
//                                                             riskCappedByCeiling / boundBy);
//   3. `marginGuard.armed === true`                          (the store default that arms the L3 guard exists);
//   4. `boundBy` is one of the four controls, or null        (the enum, never a fifth thing);
//   5. `resolvedRiskPct` is a POSITIVE number                (a zero would be a veto path, not a sized ticket).
//
// EXIT CODES: 0 = PASS, 3 = NOT YET AVAILABLE (nothing to read; this is the normal state for hours), 2 = FAIL.
//
// READ-ONLY. Run from the repo root:
//   node trading/scripts/repro/l3-l4-acceptance-read.js 2026-09-29T04:18:18Z
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');

const SINCE = process.argv[2] || '2026-09-29T04:18:18Z';
const CONTROLS = ['maxEquityPerPositionPct', 'maxRiskPerTradePct', 'exposureCapPct', 'margin_utilisation'];
const FIELDS = ['riskDialPct', 'resolvedRiskPct', 'ceilingPct', 'riskCappedByCeiling', 'boundBy'];

(async () => {
  const pool = await getPool();
  const since = new Date(SINCE);
  if (!Number.isFinite(since.getTime())) {
    console.error(`unusable cutoff: ${SINCE}`);
    process.exit(2);
  }
  console.log(`=== L3 + L4 ACCEPTANCE READ — decisions after ${since.toISOString()} ===\n`);

  const q = (t) => pool.request().query(t).then((r) => r.recordset);
  // ⚠ THE PREDICATE REQUIRES THE **QUOTED JSON KEY**, not the bare word. The first version used
  // `LIKE '%sizeCalc%'` and matched a decision whose payload only MENTIONED the string — the same defect class as
  // the recorded `LIKE '% equity'` that matched two different controls. A pattern that can match inside another
  // field's explanation will always over-count, so the candidate set is now "payloads that declare the key".
  const rows = await q(`SELECT TOP 40 id, CONVERT(varchar(23),createdAt,126) AS at, decision
    FROM dbo.TradingPrompts
    WHERE createdAt > '${since.toISOString().slice(0, 19).replace('T', ' ')}' AND decision IS NOT NULL
    ORDER BY id DESC`);
  const withSC = rows.filter((r) => String(r.decision || '').includes('"sizeCalc"'));

  console.log(`decisions since the cutoff : ${rows.length}`);
  console.log(`...whose payload declares a sizeCalc: ${withSC.length}`);
  if (!withSC.length) {
    console.log('\n⏳ NOT YET AVAILABLE — no scheduled wake has produced a sized ticket since the cutoff.');
    console.log('   (Micro wakes are excluded by design: `action: none`, no sizeCalc, nothing to inspect.)');
    await pool.close();
    process.exit(3);
  }

  // ★ WHERE THE FIELD ACTUALLY LIVES, WHICH TOOK A FAILED RUN TO LEARN. The wake payload's TOP-LEVEL keys are
  // `action/reason/symbol/direction/llmCalled/decisions/executions` — it is a SUMMARY of the wake. The per-symbol
  // geometry, `sizeCalc` included, lives inside `decisions[]`, because **one wake writes one decision PER SYMBOL**.
  // So a top-level key lookup reads a shape that does not exist, and this tool would have reported "not available"
  // forever while sized tickets sat in the table. (Same family as joining on `promptId` alone and reading an
  // arbitrary symbol's geometry.)
  let row = null;
  let d = null;
  let sc = null;
  let scSym = null;
  for (const r of withSC) {
    let parsed = null;
    try { parsed = JSON.parse(r.decision); } catch { continue; }
    if (!parsed) continue;
    const list = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const sized = list.find((x) => x && x.sizeCalc);
    if (sized) { row = r; d = parsed; sc = sized.sizeCalc; scSym = sized.symbol; break; }
    if (parsed.sizeCalc) { row = r; d = parsed; sc = parsed.sizeCalc; scSym = parsed.symbol; break; }
  }
  if (!row) {
    console.log('\n⏳ NOT YET AVAILABLE — the payloads declare `sizeCalc` somewhere but no ENTRY carries one.');
    await pool.close();
    process.exit(3);
  }
  console.log(`\nsized entry: wake #${row.id} at ${row.at}Z ${'\u00B7'} symbol ${scSym}`);

  let bad = 0;
  const ck = (ok, label, detail) => {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) bad += 1;
  };

  ck(!!sc, 'the decision carries a sizeCalc');
  if (!sc) {
    // DIAGNOSE, DO NOT JUST FAIL. A bare "FAIL" would send the reader hunting the wrong defect.
    console.log(`\n  payload shape: ${JSON.stringify(Object.keys(d || {}))}`);
    console.log(`  action=${JSON.stringify(d && d.action)} symbol=${JSON.stringify(d && d.symbol)}`);
    console.log(`  the raw payload mentions 'sizeCalc' ${(String(row.decision).match(/sizeCalc/g) || []).length}x`);
    console.log('  ⏳ NOT YET AVAILABLE (no sized entry in this payload).');
    await pool.close();
    process.exit(3);
  }

  const missing = FIELDS.filter((f) => !(f in sc));
  ck(missing.length === 0, 'all five L4 fields present', missing.length ? `missing: ${missing.join(', ')}` : FIELDS.join(' · '));

  const mg = sc.marginGuard;
  ck(mg && mg.armed === true, 'the margin guard is ARMED on the decision',
    mg ? `armed=${JSON.stringify(mg.armed)} capPct=${JSON.stringify(mg.capPct)} usedPct=${JSON.stringify(mg.usedPct)}` : 'no marginGuard');

  ck(sc.boundBy === null || CONTROLS.includes(sc.boundBy), 'boundBy is one of the four controls, or null',
    `boundBy=${JSON.stringify(sc.boundBy)}`);

  ck(Number(sc.resolvedRiskPct) > 0, 'resolvedRiskPct is a positive number',
    `resolvedRiskPct=${JSON.stringify(sc.resolvedRiskPct)} dial=${JSON.stringify(sc.riskDialPct)} ceiling=${JSON.stringify(sc.ceilingPct)} riskCappedByCeiling=${JSON.stringify(sc.riskCappedByCeiling)}`);

  console.log(`\n${bad === 0 ? '✔ PASS — L3 and L4 are live and inspectable on a real decision'
    : `✘ FAIL — ${bad} check(s) failed`}`);
  await pool.close();
  process.exit(bad === 0 ? 0 : 2);
})().catch((e) => { console.error('acceptance read failed:', e); process.exit(2); });
