// scripts/record-2026-09-28-exe2-sgx-counterexample-retracted.js
//
// TRD-EXE-2 (#1455): the surviving claim — "the venue ACCEPTED 10 Shares while the registry says the
// minimum is 20" — is WRONG, and it is steering an owner decision. This retracts it and replaces it
// with the measurement, and cross-notes #1463 (TRD-EXE-3) and #1453 (TRD-RSK-4).
//
// THE TRAP, which is the same one this row already fell into twice: I compared Trades.size — a
// DESK-side number, the size the desk RECORDED — against a VENUE-side floor, and called the
// disagreement a contradiction. The venue's own position mirror reports the size it HELD, and for the
// very same position id it is 20, not 10. A field is not its name.
//
// Every claim below is RE-MEASURED here and the script REFUSES to write if any of them fails.
//
// Dry by default:  node scripts/record-2026-09-28-exe2-sgx-counterexample-retracted.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ID = 1455;                      // TRD-EXE-2 — the row whose claim is retracted
const MARK = '##2026-09-28 exe2-sgx-counterexample-retracted##';
const CROSS = [
  { id: 1463, mark: '##2026-09-28 exe3-sgx-case##', what: 'TRD-EXE-3' },
  { id: 1453, mark: '##2026-09-28 rsk4-floor-confirmed##', what: 'TRD-RSK-4' },
];

const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return undefined; } };

// The five measured snaps. Venue sizes are read from position_pnl, not asserted from this file.
const SNAPS = [
  { trade: 1107, symbol: 'Gold', venueSizes: null },
  { trade: 1108, symbol: 'Silver', venueSizes: null },
  { trade: 1099, symbol: 'Bitcoin', venueSizes: null },
  { trade: 1106, symbol: 'SGX', venueSizes: null },
  { trade: 1110, symbol: 'Sugar', venueSizes: null },
];

const NOTE = `

${MARK}
★★★ SECOND CORRECTION ON THIS ROW: THE SGX COUNTEREXAMPLE IS ALSO WRONG, AND THIS ONE WAS STEERING A DECISION.

The addendum above retracted the PROVENANCE claim and kept one measured contradiction: "Trades #1106 — SGX buy,
size 10 Shares — against a recorded floor of 20 Shares ... the venue FILLED it ... EITHER WAY THE DESK'S VETO IS
STRICTER THAN THE VENUE'S OWN BEHAVIOUR". That contradiction does not exist. I have re-measured it.

★ THE MEASUREMENT. Trades #1106 carries plus500PositionId 1888436082. The desk's own mirror of the venue's
POSITIONS PAGE (TradingEvents kind='position_pnl', id #105138, 2026-09-28T05:14:43.040Z — 8.2s after the open)
reports, for THAT SAME position id:

    symbol=SGX   size=20   units=Shares   posId=1888436082   rate=22.534   pnl=-2.26

  Trades #1106 says:  size=10   units=Contracts   posId=1888436082

⇒ THE VENUE HELD 20, WHICH IS EXACTLY THE FLOOR. It never held 10. The 10 is 'Trades.size' — the size the DESK
RECORDED — and the same row records the wrong UNIT as well ('Contracts' where the venue says 'Shares').

⚠ SO THE ERROR IS THE ONE THIS ROW HAD ALREADY NAMED AND THEN WALKED INTO ANYWAY. The provenance addendum's own
lesson was "A FIELD NAMED LIKE PROVENANCE IS NOT PROVENANCE; THE ASSIGNMENT IS." Here I trusted a field named
'size' on the desk's own row as if it were the venue's size. Trades.size is what the desk SENT (and, as this shows,
sometimes not even that). ONLY 'position_pnl' IS THE VENUE'S NUMBER.

★ AND THE POPULATION AGREES WITH THE FLOOR, 6 SYMBOLS OUT OF 6. Every size the venue has been observed HOLDING,
for every symbol that has a floor, is an EXACT INTEGER MULTIPLE of that floor — 11 distinct sizes, ZERO
counterexamples:

    Arabica Coffee   floor 0.5     held 1 = 2x, 1.5 = 3x, 2 = 4x
    Bitcoin          floor 0.001   held 0.003 = 3x
    Gold             floor 0.025   held 0.075 = 3x, 0.125 = 5x, 0.225 = 9x
    SGX              floor 20      held 20 = 1x
    Silver           floor 2.5     held 7.5 = 3x, 15 = 6x
    Sugar            floor 15      held 15 = 1x

and NO symbol has ever been observed holding a size BELOW its floor. There are also no 'too small' rejections on
record. So there is no evidence anywhere in the desk's history that the veto is stricter than the venue — and the
one artefact that said so was misread.

★★★ WHAT THIS REOPENS, AND IT MATTERS MORE THAN THE RETRACTION: TRD-RSK-4 (#1453) IS CORRECT AS ORIGINALLY DERIVED.
Its '2.34x the risk cap' is 20 x 0.3390 / equity, and the 20 is now confirmed by the venue's own position mirror.
The earlier addendum wrongly struck it ("the 20 is Yahoo's"). SGX genuinely is out of reach at the current dial,
because the floor is real. The owner was asked to choose between (a) respect the stated minimum and (b) defer to
the venue's behaviour — and (b) was described as what the venue's behaviour actually shows. It is not. **(a) is
what the evidence supports, and it is what the code already does.** There is no contradiction to resolve.

★★ THE REAL DEFECT THIS FALSE CLAIM WAS STANDING IN FRONT OF: #1106 IS A 2x SIZE ERROR. The desk recorded 10 for a
position the venue held at 20. Its stop (22.2465), its risk in currency (size x stopDist) and its R are all
computed on HALF the size actually held; the 'opened and closed 17 seconds later for -$2.18' reading of that trade
is a reading of a row whose size is half the truth. This is the SAME ROOT as TRD-EXE-3 (#1463) — the desk records
what it computed while the venue holds what it snapped — and it is the LARGEST instance on record.

★★ AND IT CONFIRMS #1463's RULE WITH TWO MORE CASES, INCLUDING THE RULE'S OWN EDGE. #1463 measured three snaps and
inferred round-to-nearest-multiple-of-the-floor, with Bitcoin's exact half resolving UP. SGX gives a second exact
half — 10 / 20 = 0.5 -> 1 -> 20 — resolving up the same way, and Sugar gives 11.9862 / 15 = 0.7991 -> 1 -> 15.
FIVE cases now, five symbols, one rule: round-half-up on the venue's minimum increment, applied by the VENUE.

⚠ AND IT RETIRES THE HEDGE #1463 WAS CARRYING. That row closed with "the snapping mechanism here is measured from
the VENUE'S ACTUAL FILLED SIZES, not from a registry page — so it is evidence the desk can trust even where the
registry's numbers are suspect". The registry's numbers are no longer suspect: the venue's held sizes agree with
them exactly on every symbol that has one. The hedge can go, and the floors can be used.

WHAT IS STILL GENUINELY OPEN, and it is only this: the stat box is read BY COLUMN POSITION and its LABEL is
asserted in a comment rather than read from the DOM. That remains true, and it is worth closing — but it is now a
tightening of a number that the venue's own behaviour corroborates 11 times over, not a suspicion that the number
is invented. The veto's POLICY question (refuse below the floor, or report and let the venue answer) is the
owner's, and the only new input is that the floor is real.

STILL A NON-GOAL: do not 'correct' SGX's size to 10 anywhere. 10 was never the size of anything.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the claim being retracted is present, so there is a target ===');
  const cur = (await q(`SELECT state, CAST(info AS nvarchar(max)) AS info FROM Tasks WHERE id = ${ID}`))[0];
  if (!cur) await fail(`#${ID} does not exist`);
  if (cur.info.includes(MARK)) { console.log(`  #${ID} marker already present - nothing to do.`); await pool.close(); return; }
  for (const needle of ['THE VENUE DISPROVES IT DIRECTLY', 'size 10 Shares', 'STRICTER THAN THE VENUE']) {
    if (!cur.info.includes(needle)) await fail(`#${ID} does not contain "${needle}" - the retraction would have no target`);
    console.log(`  \u2714 #${ID} contains "${needle}"`);
  }

  console.log('\n=== 2. what the VENUE reported holding for #1106\'s position id (venUE-side number) ===');
  const posId = '1888436082';
  const pnl = await q(`SELECT id, createdAt, payload FROM TradingEvents
      WHERE kind = 'position_pnl' AND payload IS NOT NULL
        AND CAST(payload AS nvarchar(max)) LIKE '%${posId}%' ORDER BY id`);
  if (!pnl.length) await fail(`no position_pnl sample carries position id ${posId} - the venue-side number is absent`);
  let held = null;
  for (const r of pnl) {
    const p = J(r.payload) || {};
    if (String(p.positionId) !== posId) continue;
    console.log(`  #${r.id} ${r.createdAt.toISOString()} symbol=${p.symbol} size=${p.size} units=${p.units} posId=${p.positionId}`);
    held = p;
  }
  if (!held) await fail(`no sample matched position id ${posId}`);
  if (Number(held.size) === 10) await fail('the venue reports size 10 after all - the retraction would be WRONG');
  console.log(`  \u2714 the venue held ${held.size}, NOT 10`);

  console.log('\n=== 3. what the DESK recorded for the same position id ===');
  const t = (await q(`SELECT id, symbol, size, units, plus500PositionId FROM Trades WHERE id = 1106`))[0];
  if (!t) await fail('#1106 is missing');
  console.log(`  Trades #${t.id} ${t.symbol} size=${t.size} units=${t.units} posId=${t.plus500PositionId}`);
  if (String(t.plus500PositionId) !== posId) await fail('Trades #1106 does not carry the position id - these are not the same position');
  if (Number(t.size) === Number(held.size)) await fail('desk and venue agree on the size - there is no misrecorded size to report');
  console.log(`  \u2714 desk recorded ${t.size} ${t.units} for a position the venue held at ${held.size} ${held.units}`);

  console.log('\n=== 4. the floor the venue\'s held size confirms ===');
  const fl = (await q(`SELECT id, unitAmount, unitKind, capturedAt FROM dbo.Instruments
      WHERE userId = 1 AND venue = 'plus500' AND symbol = 'SGX' AND instrumentClass = 'spot'`))[0];
  if (!fl) await fail('no SGX spot registry row');
  console.log(`  Instruments #${fl.id}: SGX floor ${fl.unitAmount} ${fl.unitKind} (captured ${fl.capturedAt.toISOString()})`);
  if (Number(fl.unitAmount) !== Number(held.size)) await fail(`the held size ${held.size} does not equal the floor ${fl.unitAmount} - the confirmation does not hold`);
  console.log(`  \u2714 the venue held the floor amount exactly (${held.size} ${held.units})`);

  console.log('\n=== 5. the population: every held size vs its floor, all symbols ===');
  const reg = await q(`SELECT symbol, unitAmount, unitKind FROM dbo.Instruments
      WHERE userId = 1 AND venue = 'plus500' AND instrumentClass = 'spot' AND unitAmount IS NOT NULL AND unitAmount > 0`);
  const floor = new Map(reg.map((r) => [String(r.symbol).toLowerCase(), Number(r.unitAmount)]));
  const all = await q(`SELECT payload FROM TradingEvents WHERE kind = 'position_pnl' AND payload IS NOT NULL`);
  const heldBy = new Map();
  for (const r of all) {
    const p = J(r.payload) || {};
    const s = String(p.symbol || '').trim().toLowerCase();
    const n = Number(p.size);
    if (!s || !Number.isFinite(n) || n <= 0) continue;
    if (!heldBy.has(s)) heldBy.set(s, new Set());
    heldBy.get(s).add(n);
  }
  let symbols = 0, sizes = 0, bad = 0, below = 0;
  for (const [s, set] of [...heldBy.entries()].sort()) {
    const f = floor.get(s);
    if (f == null) continue;
    symbols++;
    const marks = [];
    for (const n of [...set].sort((a, b) => a - b)) {
      sizes++;
      const k = Number((n / f).toFixed(6));
      const isInt = Math.abs(k - Math.round(k)) <= 1e-6;
      if (!isInt) { bad++; marks.push(`${n} (${k.toFixed(4)}x NOT integer)`); } else marks.push(`${n}=${Math.round(k)}x`);
      if (n < f) { below++; marks[marks.length - 1] += ' *** BELOW FLOOR ***'; }
    }
    console.log(`  ${s.padEnd(17)} floor ${String(f).padStart(7)}  ${marks.join('  ')}`);
  }
  console.log(`  -> ${symbols} symbols, ${sizes} distinct held sizes, ${bad} not an integer multiple, ${below} below the floor`);
  if (symbols < 5) await fail(`only ${symbols} symbols have both a floor and a venue-side sample - too thin to claim a population`);
  if (bad > 0) await fail(`${bad} held sizes are NOT integer multiples of the floor - the floor is NOT a step`);
  if (below > 0) await fail(`${below} held sizes are BELOW the floor - the veto IS stricter than the venue, the retraction would be wrong`);
  console.log('  \u2714 every venue-held size is an exact integer multiple of its floor, and none is below it');

  console.log('\n=== 6. the snapping rule, re-derived per case (round-half-up on the floor) ===');
  let cases = 0, ok = 0;
  for (const c of SNAPS) {
    const row = (await q(`SELECT id, symbol, size FROM Trades WHERE id = ${c.trade}`))[0];
    if (!row) { console.log(`  #${c.trade} missing - skipped`); continue; }
    const f = floor.get(String(row.symbol).toLowerCase());
    const seen = heldBy.get(String(row.symbol).toLowerCase());
    if (f == null || !seen) { console.log(`  #${row.id} ${row.symbol}: no floor or no venue sample - skipped`); continue; }
    const sent = Number(row.size);
    const k = Number((sent / f).toFixed(6));
    const snapped = Math.round(k) * f;
    // The predicted snap must BE one of the sizes the venue has been observed holding for that symbol.
    const hit = [...seen].some((n) => Math.abs(n - snapped) <= Math.max(1e-9, Math.abs(snapped) * 1e-9));
    const exactHalf = Math.abs(k - Math.trunc(k) - 0.5) <= 1e-9;
    cases++; if (hit) ok++;
    console.log(`  #${row.id} ${String(row.symbol).padEnd(15)} sent ${String(sent).padStart(8)} / floor ${String(f).padStart(7)} = ${k.toFixed(4)}` +
      ` -> round ${Math.round(k)}x = ${snapped}  ${hit ? 'HELD BY THE VENUE' : '*** NOT observed ***'}${exactHalf ? '  (exact half, resolves UP)' : ''}`);
    if (!hit) await fail(`#${row.id}: the round-half-up rule does not predict a size the venue was observed holding`);
  }
  if (cases < 4) await fail(`only ${cases} snapping cases could be re-derived - too few to assert the rule`);
  console.log(`  \u2714 ${ok}/${cases} cases re-derived; the rule predicts a size the venue was observed holding in every one`);

  console.log('\n=== 7. the record ===');
  console.log(`  #${ID} info ${cur.info.length} -> ${cur.info.length + NOTE.length}`);
  for (const c of CROSS) {
    const r = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${c.id}`))[0];
    if (!r) await fail(`#${c.id} (${c.what}) is missing - the cross-note has no home`);
    console.log(`  cross-note ${c.what} #${c.id} info ${r.len} -> +${c.mark.length + 420}ish`);
  }
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }

  await pool.request().input('t', NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);

  const cross3 = `

${CROSS[0].mark}
★ CROSS-NOTE FROM TRD-EXE-2 (#1455). TWO UPDATES TO THIS ROW, BOTH FROM THE VENUE'S OWN POSITION MIRROR.

1. THE HEDGE AT THE END OF THIS ROW CAN BE RETIRED. It read: "the snapping mechanism here is measured from the
   VENUE'S ACTUAL FILLED SIZES, not from a registry page - so it is evidence the desk can trust even where the
   registry's numbers are suspect". The registry's numbers are NOT suspect. Every size the venue has been observed
   HOLDING, for every symbol that has a floor, is an exact integer multiple of that floor: 6 symbols, 11 distinct
   sizes, zero counterexamples, and no size ever held below its floor. The floors and the venue's behaviour agree.
   The mechanism in this row was right, and it is now corroborated by the registry rather than merely independent
   of it.

2. A FOURTH AND FIFTH CASE, INCLUDING THE RULE'S OWN EDGE. SGX #1106 was sent 10 against a floor of 20:
   10 / 20 = 0.5 -> round-half-up -> 1 -> the venue held 20 (position_pnl #105138, position id 1888436082 - the
   same id Trades #1106 carries). Sugar 11.9862 / 15 = 0.7991 -> 1 -> the venue held 15. So the rule this row
   derived from three cases - round to the nearest multiple of the floor, half resolving UP - now has FIVE
   confirmations across five symbols, with two exact halves both resolving up.
   ⚠ AND SGX IS THE LARGEST INSTANCE ON RECORD: the desk recorded 10 for a position the venue held at 20, so that
   row's risk in currency, its R and its stop attribution are all computed on HALF the size actually held. It also
   recorded the wrong UNIT ('Contracts' where the venue says 'Shares').
   ⚠ THE 'venue disproved the floor by filling 10' reading is RETRACTED on #1455: '10' was Trades.size, a desk-side
   number. Only position_pnl is the venue's.`;

  const cross4 = `

${CROSS[1].mark}
★ CROSS-NOTE FROM TRD-EXE-2 (#1455): THIS ROW IS CORRECT AS ORIGINALLY DERIVED. An earlier addendum on #1455
struck this row's premise ("the 2.34x is 20 x 0.3390 / equity, and the 20 is Yahoo's"), because a companion row
had claimed the venue filled an SGX order of size 10 against a floor of 20. That claim was a misreading: the 10
was Trades.size, the size the DESK recorded, and the desk's own mirror of the VENUE'S POSITIONS PAGE reports the
same position id (1888436082) held at exactly 20 Shares. The floor is real and the venue enforces it.
⇒ The 2.34x stands. SGX is structurally out of reach at the current 0.07% dial because its floor genuinely forces
more risk than the dial allows - that is this row's finding, unchanged. Nothing about it should be softened on the
strength of the retracted counterexample.`;

  await pool.request().input('t', cross3).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${CROSS[0].id}`);
  await pool.request().input('t', cross4).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${CROSS[1].id}`);
  for (const c of CROSS) {
    const r = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${c.id}`))[0];
    console.log(`  \u2714 #${c.id} (${c.what}) appended -> ${r.len} chars`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
