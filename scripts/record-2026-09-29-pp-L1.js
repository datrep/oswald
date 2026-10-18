// scripts/record-2026-09-29-pp-L1.js
//
// Records L1 (rev 5 of the purchasing-power design, TRD-RSK-10 #1467) as IMPLEMENTED, and logs the defect
// L1 found on the way as a new dashboard task.
//
// ⚠ WHAT L1 IS, AND WHY IT IS FIRST. The design's own implementation order is L1 -> L3 -> L2 -> L4 -> L5.
// L1 is the only layer that changes NOTHING: it makes the venue's leverage a first-class input and reports
// purchasing power. It is first because the ceiling `L x stopPct` cannot be stated without it, and because
// every later layer needs a denominator it can name.
//
// ⚠ WHY THE CAP RAISE (L2) IS *NOT* IN THIS CHANGE, and this is a decision recorded as a decision:
// the owner asked to "capture trades at 3.0%". riskPerTradePct = 3.0 ALONE IS INERT (the dial reads 5 and
// the desk risks 0.5308%, because maxEquityPerPositionPct = 80 binds first), so capturing at 3.0% requires
// L2, and L2 requires L3 first or 5 Gold positions x 400% notional = 400% of equity in margin. The owner
// is unavailable, so the change that strictly REDUCES or LEAVES UNCHANGED the risk is the one taken:
// L1 (a read). L2 stays gated on Q7 (what the venue does AT the margin limit) rather than shipped unmeasured.
//
// DRY RUN BY DEFAULT (pass --yes to write). Marker-guarded, occurrence-counted, READ BACK after writing.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const ROOT = path.join(__dirname, '..');
const TASK_ID = 1467;
const EDICT_ID = 52;
const MARKER = '##2026-09-29 L1 IMPLEMENTED##';
const REV5_LINE = '##2026-09-29 rev 5 DECISION## THE RISK LEVEL IS DECIDED: r = 3.0%##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const DOT = '\u00B7';
const SEC = '\u00A7';

const WATCHLIST = ['Gold', 'Bitcoin', 'Sugar', 'Arabica Coffee', 'Silver', 'Oil', 'SGX'];

const POINTER = `${WARN} **L1 IS NOW IMPLEMENTED** ${EM} see the L1 block lower in this row. The block below is`
  + ` still the decision and still correct; what changed is that the venue's leverage is no longer a captured-`
  + `but-unread column, so the ceilings quoted below can now be COMPUTED by the desk instead of only by a study.`
  + ` L2 (the cap raise) is deliberately NOT in this change ${EM} see the ordering note in the L1 block.`;

const ADDENDUM = `
${MARKER} LAYER 1 IS IMPLEMENTED ${EM} the venue's leverage is now a first-class risk input##

${STAR} WHAT WAS BUILT. The design's own order is L1 -> L3 -> L2 -> L4 -> L5, and L1 is the layer that changes
nothing: it makes the venue's leverage readable, and reports what the desk could buy.

    trading/agent/instruments.js    venueLeverage(row) -> { leverage, leverageRaw, initialMarginPct,
                                    maintenanceMarginPct }, carried on EVERY resolution shape, success and
                                    failure alike, from the SAME registry row as the minimum
    trading/agent/risk.js           v.venueFloor now carries those four fields plus
                                    purchasingPower = equity x leverage, and sizeCalc.venueFloor rides it
                                    into every decision row
    trading/plus500/instrumentSpec  the stale comment that justified the old flat tolerance, corrected
    test/venue-leverage.test.js     8 tests (new)
    test/instrument-spec.test.js    +1 test pinning the corrected tolerance
    trading/scripts/repro/leverage-live-check.js   the acceptance measurement (new, read-only)

${STAR}${STAR} WHAT IT MEASURED ON THE LIVE REGISTRY ${EM} the point of L1 was that the desk could not state its own
ceiling, and it now can, for all seven watchlist symbols. Ceiling = L x the newest ticket stop on record:

    symbol            leverageRaw   L       100/L    init%    maint%   purchasing power   stop%     CEILING%
    Gold              1:5           5.0000  20.0000  20.0000  10.0000  5.00x equity       0.6635    3.3176
    Bitcoin           1:1.67        1.6700  59.8802  60.0000  30.0000  1.67x equity       0.6770    1.1305
    Sugar             1:5           5.0000  20.0000  20.0000  10.0000  5.00x equity       0.6890    3.4451
    Arabica Coffee    1:5           5.0000  20.0000  20.0000  10.0000  5.00x equity       0.9901    4.9503
    Silver            1:5           5.0000  20.0000  20.0000  10.0000  5.00x equity       0.9766    4.8832
    Oil               1:5           5.0000  20.0000  20.0000  10.0000  5.00x equity       0.3052    1.5261
    SGX               1:10          10.0000 10.0000  10.0000  5.0000   10.00x equity      1.7684    17.6845

  ${ARROW} **max(L)/min(L) = 5.99x** (SGX 10 vs Bitcoin 1.67). ${STAR} A risk dial is NOT a single setting across
    this book: the same r is reachable on one symbol and geometrically impossible on another. Reporting that is
    what L1 is, and no control on the desk could say it before this change.
  ${WARN} The ceilings above are computed on the NEWEST TICKET STOP, so they are NOT the ${SEC}6.1 design
    ceilings (which use the newest DECISION stop). Both are correct for their question. **Quote the stop or do
    not quote the ceiling** ${EM} Gold is 3.3176% here and 2.75% there, same symbol, same leverage.

${STAR}${STAR}${STAR} AND IT FOUND A REAL DEFECT IN A VALIDATOR, WHICH IS NOW FIXED. ${'`'}checkSpec${'`'} asserted
${'`'}|initialMarginPct - 100/leverage| <= 0.01${'`'} with the comment *"enough to absorb the display rounding to
2dp"*. **That was false**, and Bitcoin is the live counter-example:

    venue states   leverageRaw '1:1.67'   and   initialMarginPct 60.00%
    check computed 100 / 1.67 = 59.8802   vs stated 60.0000  =>  discrepancy 0.1198
    => 12x the tolerance it was said to absorb, reported as initial_margin_leverage_mismatch on a row the
       venue itself treats as consistent.

  ${ARROW} The error in the MARGIN is not the error in the RATIO: it scales as ${'`'}100/L^2 x dL${'`'}, so a 2dp
    ratio (dL <= 0.005) permits **0.18 points at L = 1.67** and **0.005 at L = 10**. A flat constant cannot be
    right at both ends of a 5.99x spread in leverage, and that is the tell it was never right at either. Six of
    the seven rows have an error of exactly 0.0000, which is why it survived: the only affected row is the only
    sub-1:2 instrument in scope.
  ${STAR} THE FIX is not a looser constant. The check now asks whether the STATED margin falls inside the
    interval the DISPLAYED ratio permits ${EM} a tolerance DERIVED from the venue's own 2dp presentation.
    Measured evidence for which statement is primary: **maintenanceMarginPct is exactly half of
    initialMarginPct on all seven rows** (60/30, 20/10, 10/5), so the margins are STATED and the ratio is the
    derived, rounded display; and 100/60 = 1.6667 round-trips to the venue's own '1:1.67'.
  ${ARROW} After the fix: **no row disagrees**, and a genuinely misparsed pair still fails (1:5 with 25% and
    1:10 with 9% are both pinned in tests).
  ${WARN} Severity was LOW, and that is measured rather than assumed: ${'`'}MARGIN_LEVERAGE_MISMATCH${'`'} is not in
    ${'`'}FATAL${'`'}, so it never refused a capture, and ${'`'}dbo.Instruments${'`'} has no violations column, so it
    was never persisted. It lived in the capture's return payload and in the trustworthiness of the comment.
  ${STAR} **This defect is logged as its own dashboard task (TRD-RSK-12)** rather than only as a code comment.

${STAR} FOR L3, WHICH IS NEXT: the authoritative denominator is ${'`'}initialMarginPct${'`'}, NOT the 2dp ratio
${EM} the measured receipts are above. On this book the two agree exactly for six of seven symbols and differ by
0.12 points on Bitcoin, so a margin guard built on ${'`'}leverage${'`'} would misstate Bitcoin's margin by 0.2%
while looking perfectly correct on every other symbol.

${WARN}${WARN} WHAT WAS *NOT* DONE, AND WHY ${EM} THE OWNER ASKED FOR 3.0% AND 3.0% IS NOT LIVE. Recorded
deliberately, because a report that says "we did the risk work" while the caps are untouched would be false:
  ${ARROW} ${'`'}riskPerTradePct${'`'} is still **5**, ${'`'}maxEquityPerPositionPct${'`'} still **80**, and the desk
    still risks **0.5308%** per ticket. L1 moved no dial: the gate below re-reads the live settings and compares
    them to ${SEC}7's baseline.
  ${ARROW} The owner's instruction was *"do 3.0 ... then we can start the implementation"*. The literal reading is
    impossible: **3.0 cannot be captured before L2, and L2 without L3 permits 400% of equity in margin.** The
    ordering rule in ${SEC}6.1 is not negotiable, so the layers were entered from the safe end.
  ${ARROW} **L2 remains GATED ON Q7** ${EM} what the venue actually does at the margin limit. Q7 is cheap to
    measure and expensive to guess, and it is now the single next thing standing between this desk and 3.0%.

${STAR} VERIFICATION AT WRITE TIME (all re-measured here, not asserted): every gate below reads the live
registry, the live settings and the live validator. Nothing in this block was copied from a plan.
`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const ins = require('../trading/agent/instruments');
  const spec = require('../trading/plus500/instrumentSpec');

  console.log('\n=== 1. the code carries the change ===');
  const insSrc = src('trading/agent/instruments.js');
  for (const h of ['function venueLeverage', 'venueLeverage(row)', '...venueLeverage(null)', 'leverageRaw: r.leverageRaw || null']) {
    if (!insSrc.includes(h)) await fail(`trading/agent/instruments.js is missing "${h}"`);
  }
  const riskSrc = src('trading/agent/risk.js');
  for (const h of ['purchasingPower:', 'venueLevKnown', 'leverage: venueLevKnown ? venueLev : null']) {
    if (!riskSrc.includes(h)) await fail(`trading/agent/risk.js is missing "${h}"`);
  }
  if (!/module\.exports = \{[^}]*venueLeverage/.test(insSrc)) await fail('venueLeverage is not exported');
  console.log(`  \u2714 instruments.js carries venueLeverage on every shape ${DOT} risk.js reports it and purchasingPower`);

  console.log('\n=== 2. RE-MEASURE the ceiling, live, for every watchlist symbol ===');
  const measured = {};
  for (const sym of WATCHLIST) {
    const res = await ins.resolve(1, { symbol: sym });
    const t = (await q(`SELECT TOP 1 openPrice, stopPrice FROM dbo.Trades
        WHERE userId=1 AND symbol='${sym.replace(/'/g, "''")}' AND openPrice > 0 AND stopPrice IS NOT NULL
        ORDER BY id DESC`))[0];
    const stop = t ? Math.abs(Number(t.openPrice) - Number(t.stopPrice)) / Number(t.openPrice) * 100 : null;
    const L = res.found ? res.leverage : null;
    measured[sym] = { L, stop, ceiling: L != null && stop != null ? L * stop : null, raw: res.leverageRaw, init: res.initialMarginPct };
    if (!res.found) await fail(`${sym} did not resolve (${res.reason}) \u2014 L1's claim is that it does`);
    if (L == null) await fail(`${sym} resolved WITHOUT leverage \u2014 the whole of L1 is that it carries it`);
    console.log(`  ${sym.padEnd(16)} raw=${String(res.leverageRaw).padEnd(7)} L=${String(L).padEnd(7)}`
      + ` init=${String(res.initialMarginPct).padEnd(7)} stop=${stop != null ? stop.toFixed(4) + '%' : 'no ticket'}`
      + `  ceiling=${L != null && stop != null ? (L * stop).toFixed(4) + '%' : 'n/a'}`);
  }
  const Ls = Object.values(measured).map((m) => m.L);
  const spread = Math.max(...Ls) / Math.min(...Ls);
  console.log(`  \u2714 all ${WATCHLIST.length} state a leverage and a ceiling \u2014 max(L)/min(L) = ${spread.toFixed(2)}x`);
  if (spread < 2) await fail('the leverage spread collapsed \u2014 L1\'s motivating measurement no longer holds');

  console.log('\n=== 3. RE-MEASURE the validator defect, and prove it is fixed ===');
  const btc = measured.Bitcoin;
  const flatErr = Math.abs(100 / btc.L - btc.init);
  console.log(`  Bitcoin: venue says ${btc.raw} and ${btc.init}%  =>  100/${btc.L} = ${(100 / btc.L).toFixed(4)}`);
  console.log(`  the OLD flat-constant test would see a discrepancy of ${flatErr.toFixed(4)} points (tolerance 0.01)`);
  if (Math.abs(flatErr - 0.1198) > 0.001) {
    await fail(`the Bitcoin discrepancy measured ${flatErr.toFixed(4)}, not the 0.1198 recorded \u2014 the registry` +
      ' row moved, so re-derive the finding before recording it');
  }
  const btcCodes = spec.checkSpec({ unitAmount: 1, unitKind: 'Bitcoin', instrumentClass: 'spot', leverageRaw: btc.raw, initialMarginPct: btc.init });
  const stillFlagged = btcCodes.includes(spec.CODES.MARGIN_LEVERAGE_MISMATCH);
  console.log(`  checkSpec on that exact row now returns: [${btcCodes.join(', ') || 'no violations'}]`);
  if (stillFlagged) await fail('checkSpec STILL flags the real Bitcoin row \u2014 the tolerance fix did not land');
  // And the fix must not have blunted the check: a genuine misparse still fails.
  const bad5 = spec.checkSpec({ unitAmount: 15, unitKind: 'Options', instrumentClass: 'option', leverageRaw: '1:5', initialMarginPct: 25 });
  const bad10 = spec.checkSpec({ unitAmount: 10, unitKind: 'Shares', instrumentClass: 'spot', leverageRaw: '1:10', initialMarginPct: 9 });
  if (!bad5.includes(spec.CODES.MARGIN_LEVERAGE_MISMATCH) || !bad10.includes(spec.CODES.MARGIN_LEVERAGE_MISMATCH)) {
    await fail('the corrected tolerance no longer catches a REAL mismatch \u2014 that would be a loosened check, not a fixed one');
  }
  const maintPairs = [];
  for (const sym of WATCHLIST) {
    const r = await ins.resolve(1, { symbol: sym });
    if (r.initialMarginPct != null && r.maintenanceMarginPct != null) {
      maintPairs.push({ sym, ok: Math.abs(r.maintenanceMarginPct - r.initialMarginPct / 2) <= 0.005 });
    }
  }
  if (!maintPairs.every((p) => p.ok)) await fail('maintenance != initial/2 on some row \u2014 the "margins are STATED" evidence is gone');
  console.log(`  \u2714 both real mismatches STILL fail, and maintenance == initial/2 on all ${maintPairs.length} rows`);
  console.log('  \u2714 the tolerance is now derived from the venue\'s display precision, not chosen');

  console.log('\n=== 4. L1 MOVED NO DIAL \u2014 the live settings, against \u00a77\'s baseline ===');
  const st = (await q('SELECT settings FROM TradingSettings WHERE userId = 1'))[0];
  if (!st) await fail('no TradingSettings row for userId 1');
  const s = JSON.parse(st.settings || '{}');
  const live = {
    riskPerTradePct: s.risk?.riskPerTradePct,
    maxRiskPerTradePct: s.risk?.maxRiskPerTradePct,
    maxEquityPerPositionPct: s.risk?.maxEquityPerPositionPct,
    exposureCapPct: s.risk?.exposureCapPct,
    dailyLossHaltPct: s.risk?.dailyLossHaltPct,
    maxPositions: s.risk?.maxPositions,
  };
  console.log(`  live: ${JSON.stringify(live)}`);
  const BASELINE = { riskPerTradePct: 5, maxRiskPerTradePct: 5, maxEquityPerPositionPct: 80, exposureCapPct: 100, dailyLossHaltPct: 3, maxPositions: 10 };
  for (const [k, v] of Object.entries(BASELINE)) {
    if (live[k] != null && Number(live[k]) !== v) {
      await fail(`${k} is ${live[k]}, not the \u00a77 baseline ${v} \u2014 a dial HAS moved, so "L2 is not in this change" is false`);
    }
  }
  const perPos = Number(live.maxEquityPerPositionPct ?? 80);
  const goldStop = measured.Gold.stop;
  const realised = perPos / 100 * goldStop;
  console.log(`  Gold realised risk = ${perPos}% x ${goldStop.toFixed(4)}% = ${realised.toFixed(4)}%  (\u00a71.4 states 0.5308%)`);
  if (Math.abs(realised - 0.5308) > 0.02) await fail(`realised risk measured ${realised.toFixed(4)}%, not 0.5308% \u2014 \u00a71.4 moved`);
  console.log('  \u2714 every dial is at the \u00a77 baseline: L1 changed no behaviour, and 3.0% is NOT yet live');

  console.log('\n=== 5. the row, its markers, and the new task row ===');
  const row = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const info = row.info || '';
  const nMarks = info.split(MARKER).length - 1;
  const hasPointer = info.includes('L1 IS NOW IMPLEMENTED');
  const hasRev5 = info.includes(REV5_LINE);
  console.log(`  #${TASK_ID}: chars ${info.length} ${DOT} L1 markers ${nMarks} ${DOT} pointer ${hasPointer ? 'PRESENT' : 'absent'}`
    + ` ${DOT} rev-5 anchor ${hasRev5 ? 'PRESENT' : 'MISSING'}`);
  if (!hasRev5) await fail('the rev-5 anchor line was not found \u2014 the pointer REPLACE would silently match nothing');

  const existing = (await q(`SELECT id, name FROM dbo.Tasks WHERE edictId = ${EDICT_ID} AND name LIKE 'TRD-RSK-12:%'`))[0];
  console.log(`  TRD-RSK-12 ${existing ? `ALREADY EXISTS as #${existing.id}` : 'does not exist yet'}`);
  const newRowInfo = [
    'FOUND BY L1 (rev 5 of the purchasing-power design, #1467) on its first live run, 2026-09-29.',
    '',
    'THE DEFECT. `instrumentSpec.checkSpec` asserted `|initialMarginPct - 100/leverage| <= 0.01`, with the',
    'comment "Tolerance is a hundredth of a percent: enough to absorb the display rounding to 2dp." That claim',
    'was false. The venue states leverage as a 2dp ratio, and the error it introduces into the MARGIN is not the',
    'error in the RATIO: it scales as 100/L^2 x dL, so dL <= 0.005 permits 0.18 points at L = 1.67 and 0.005 at',
    'L = 10.',
    '',
    'THE LIVE COUNTER-EXAMPLE. Bitcoin: leverageRaw = 1:1.67, initialMarginPct = 60.00. The check computed',
    '100/1.67 = 59.8802 against a stated 60.0000 - a 0.1198 discrepancy, 12x the tolerance - and reported',
    'initial_margin_leverage_mismatch on a row the venue itself treats as consistent. Six of the seven watchlist',
    'rows have an error of exactly 0.0000, which is why it survived: Bitcoin is the only sub-1:2 instrument in',
    'scope, and the defect scales as 1/L^2.',
    '',
    'WHY IT STILL MATTERED. Severity was LOW and that is measured, not assumed: MARGIN_LEVERAGE_MISMATCH is not',
    'in FATAL, so it never refused a capture, and dbo.Instruments has no violations column, so it was never',
    'persisted. It lived in the capture return payload - and in the trustworthiness of a comment that stated the',
    'reasoning for a constant that was wrong at one end of a 5.99x spread in leverage.',
    '',
    'THE FIX (done 2026-09-29). The check now asks whether the STATED margin lies inside the interval the',
    'DISPLAYED ratio permits: lo = 100/(L+0.005), hi = 100/(L-0.005), with 0.01 of slack for the venue\'s own',
    'percent presentation. A tolerance DERIVED from the venue\'s display precision rather than chosen.',
    '',
    'WHICH STATEMENT IS PRIMARY, MEASURED. maintenanceMarginPct is exactly half of initialMarginPct on all seven',
    'rows (60/30, 20/10, 10/5), and 100/60 = 1.6667 round-trips to the venue\'s own 1:1.67 - so the margins are',
    'STATED and the ratio is the derived, rounded display. This governs L3: the margin guard\'s denominator must',
    'be initialMarginPct, not the 2dp ratio, or Bitcoin\'s margin is misstated by 0.2% while every other symbol',
    'looks perfectly correct.',
    '',
    'REGRESSION GUARD. test/instrument-spec.test.js pins both directions: the real Bitcoin row must NOT be',
    'flagged, and 1:5 with 25% and 1:10 with 9% MUST still be. A tolerance that stops catching real mismatches',
    'is a loosened check, not a fixed one.',
    '',
    'MEASUREMENT. trading/scripts/repro/leverage-live-check.js (read-only) prints the live cross-check for the',
    'seven watchlist symbols and routes the verdict through checkSpec itself rather than re-deriving it - an',
    'earlier version of that script held its own copy of the arithmetic and disagreed with the validator, which',
    'is the same defect one level down.',
  ].join('\n');

  if (!YES) {
    console.log('\n  DRY RUN \u2014 would:');
    console.log(`    - append the L1 block (${ADDENDUM.length} chars) to #${TASK_ID}`);
    console.log(`    - insert the in-place pointer under the rev-5 heading in #${TASK_ID}`);
    if (!existing) console.log(`    - INSERT the TRD-RSK-12 task row into edict ${EDICT_ID} (state 3, completed)`);
    console.log('\n  Re-run with --yes to write.');
    await pool.close();
    return;
  }

  const escaped = (x) => String(x).replace(/'/g, "''");

  if (!hasPointer) {
    await pool.request().query(`UPDATE dbo.Tasks
      SET info = REPLACE(info, N'${escaped(REV5_LINE)}', N'${escaped(`${REV5_LINE}\n${POINTER}`)}')
      WHERE id = ${TASK_ID}`);
    const chk = (await q(`SELECT info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0].info || '';
    if (!chk.includes('L1 IS NOW IMPLEMENTED')) await fail('the pointer REPLACE ran but the pointer is NOT in the row');
    console.log('  \u2714 pointer inserted and read back');
  } else console.log('  pointer already present \u2014 left alone (idempotent)');

  if (nMarks === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${escaped(ADDENDUM)}' WHERE id = ${TASK_ID}`);
  } else console.log(`  L1 block already present (${nMarks})\u2014 not appended again (idempotent)`);

  const after = (await q(`SELECT info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0].info || '';
  const finalMarks = after.split(MARKER).length - 1;
  console.log(`  #${TASK_ID}.info is now ${after.length} chars ${DOT} L1 markers ${finalMarks}`);
  if (finalMarks !== 1) await fail(`expected exactly 1 L1 marker, found ${finalMarks}`);
  for (const h of ['venueLeverage(row)', 'TRD-RSK-12', '0.1198', 'max(L)/min(L) = 5.99x', 'L2 remains GATED ON Q7']) {
    if (!after.includes(h)) await fail(`the written block is missing "${h}"`);
  }
  console.log('  \u2714 block present and read back with all its load-bearing claims');

  if (!existing) {
    const nextSort = (await q(`SELECT MAX(sortOrder) m FROM dbo.Tasks WHERE edictId = ${EDICT_ID}`))[0].m;
    const name = 'TRD-RSK-12: Registry - checkSpec derived the margin/leverage tolerance from a 1:5 book, so every 1:1.67 row was flagged as a mismatch the venue considers consistent';
    // `active` is a COMPUTED column on dbo.Tasks (learned by trying to write it: "cannot be modified because
    // it is either a computed column or is the result of a UNION operator"). It is derived from `state`, so
    // writing state 3 is what sets it. Listing a computed column would fail the insert outright.
    // `plannedStart` is NOT NULL and has no default (learned the same way, second attempt) — neighbouring
    // rows set it to the creation instant, so the same is done here. `plannedEnd` is nullable and left alone.
    await pool.request().query(`INSERT INTO dbo.Tasks (name, info, priority, state, edictId, sortOrder, plannedStart, completedAt, createdAt)
      VALUES (N'${escaped(name)}', N'${escaped(newRowInfo)}', 2, 3, ${EDICT_ID}, ${Number(nextSort) + 1}, GETDATE(), GETDATE(), GETDATE())`);
    const made = (await q(`SELECT id, name, state FROM dbo.Tasks WHERE edictId = ${EDICT_ID} AND name LIKE 'TRD-RSK-12:%'`))[0];
    if (!made) await fail('the TRD-RSK-12 insert ran but no such row exists');
    console.log(`  \u2714 TRD-RSK-12 logged as #${made.id} (state ${made.state} = completed, sortOrder ${Number(nextSort) + 1})`);
  }

  console.log('\n\u2714 L1 RECORDED.');
  await pool.close();
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exitCode = 1; });
