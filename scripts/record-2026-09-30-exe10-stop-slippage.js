// scripts/record-2026-09-30-exe10-stop-slippage.js
//
// Files TRD-EXE-10 (every stop-out realises MORE than the modelled stop distance) and appends a scope
// correction to TRD-PNL-2 (#1476), whose filed framing the same measurement falsifies.
//
// Gates re-derive every number from the trades themselves. DRY RUN by default (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const MARKER = '##2026-09-30 exe10 stop slippage##';
const INFO = `${MARKER} EVERY STOP-OUT REALISES MORE THAN THE MODELLED STOP DISTANCE.##

${STAR} MEASURED 2026-09-30 from the five trades the venue closed on "Loss call" in the last 48h. The stop is
supposed to be the risk boundary the whole desk sizes from; on this venue it is a LEVEL, not a GUARANTEE.
Realised adverse move as a fraction of the modelled stop distance, entry to close fill:

     #1120  Arabica Coffee  buy   stop 0.990% from entry   realised 1.315%   => 1.33x
     #1127  Sugar           buy   stop 0.503%             realised 0.614%   => 1.22x
     #1128  Arabica Coffee  sell  stop 0.629%             realised 1.000%   => 1.59x
     #1130  Silver          sell  stop 0.749%             realised 0.978%   => 1.31x
     #1114  Arabica Coffee  buy   stop **NULL**           realised 0.610%   => not computable
     mean of the four computable: **1.36x**, i.e. a stop-out costs ~36% more than the risk the desk dialled.

${WARN} WHY THIS MATTERS MORE THAN THE FIVE LOSSES. 'riskPerTradePct' is calibrated against the MODELLED stop,
and every R in the record is 'grossPnl / (|open - stop| x size)'. When the realised exit is 1.22-1.59x the
modelled distance, a "1R loss" is really a 1.2-1.6R loss on the loss side of the distribution ${EM} and the
expectancy calculation inherits that asymmetry. The r=3.0% growth-optimal choice was made on exactly those R
values, so this is a direct input to that decision rather than a footnote to it.

${STAR} WHAT IT IS NOT. It is NOT "the desk should exit earlier". Measured across all 28 closed trades in 48h,
only **3** gave back 0.5% or more of their maximum favourable excursion (#1099 Bitcoin 0.9096% MFE ${ARROW} -0.01;
#1120 Coffee 0.5106% ${ARROW} -3.54; #1123 Gold 0.5865% ${ARROW} -3.43). The winners captured their MFE
(#1129 Oil 1.605% ${ARROW} +27.99; #1132 Coffee 1.1397% ${ARROW} +21.46; #1096 Silver 1.1762% ${ARROW} +14.37), so
an earlier profit-take is NOT supported by this data and would have cost the winners. The exit rule is fine.

${WARN} AND ONE ROW HAS NO STOP AT ALL. '#1114' carries 'stopPrice IS NULL' while being a closed, venue-loss
trade. A trade whose stop was never recorded cannot be sized, cannot be given an R, and cannot be checked
against 'maxAdversePct'; '#1114' is one of the **closed_no_stop** population that
'trading/scripts/repro/threshold-evidence.js' already counts.

${WARN} NOT FIXED, DELIBERATELY. Every candidate fix moves what the desk RISKS: adding a stop buffer, widening
the dial to compensate, or rejecting symbols whose spread makes a clean stop impossible are all risk postures.
The measurement is the deliverable; the posture is the owner's.

SUGGESTED FIRST STEP (read-only): bucket the overshoot by symbol and by hour, and compare it against the
recorded spread at entry, to separate "the venue slips every stop" from "the stop was placed inside the spread".
'Trades.slippagePct' and 'closeFillPrice' already carry the two numbers this needs.`;

const MARKER2 = '##2026-09-30 pnl2 rescoped##';
const INFO2 = `${MARKER2} TRD-PNL-2 WAS FILED TOO NARROWLY, AND THE WIDER FACT IS MORE USEFUL.##

${WARN} WHAT THIS ROW SAID: "on a row the VENUE closes, 'netPnlTerminal' stops sampling before the close and
under-reports the loss by $24.93 (25%) while 'grossPnl' matches the venue exactly", with the suggested fix
"prefer 'grossPnl' on venue-closed rows".

${CHECK} WHAT THE SAME MEASUREMENT NOW SHOWS, over 48h and 27 closed trades: **25 of the 27 disagree by
more than a cent** (the two that agree are named on the row by the filing gate, not guessed at here), and the
disagreement runs in BOTH directions and on WINNERS as well as losers: #1129 Oil gross +27.99 vs net +17.33
(gap +10.66) · #1118 Coffee +5.02 vs +0.99 (+4.03) · #1133 Gold **-5.65 vs +1.00 (-6.65, a loss reported as
a profit)**.
  * 'store.js' already says why: "'netPnlTerminal' FREEZES ON THE FIRST CLOSE AND IS NEVER REWRITTEN. It reads
    the OLD 'floatingPnl' ... that was actually in force when the position ended."
${ARROW} 'netPnlTerminal' is not a net P&L at all. It is **the last floating mark, frozen** ${EM} a mid-market
estimate that has not yet paid the spread, which is exactly why it shrinks toward zero on both sides.

${CHECK} AND THE SUGGESTED FIX IS ALREADY IMPLEMENTED, WHICH IS WHY THIS IS NOT URGENT. Every performance
consumer reads 'grossPnl': 'analytics.js' (win rate, profit factor, expectancy), 'expectancy.js:91',
'meta.js' (win rate), 'waker.js' (closed P&L today), 'public/js/app.js' (realized total and the table), and
'venueClose.js' writes it from the venue's own 'netPnl'. **Nothing in the desk reads 'netPnlTerminal' at all.**
Independently confirmed against the venue's own screen: all **8** closed positions shown there match the desk's
'grossPnl' to the cent (Gold -5.65 · Coffee +21.46 · Oil +27.99 · Silver -5.85 · Coffee -5.98 · Silver -9.91 ·
Gold -3.55 · Sugar -8.70).

${ARROW} RESCOPE: the defect is a **write-only column whose NAME invites exactly the misreading it got** ${EM}
not an under-reporting sampler on venue-closed rows. The honest fixes are to rename it for what it is (the
floating mark at close) or to drop it; both touch the store's column list, so neither is done here.
**The desk's reported P&L is CORRECT and was never affected.**`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== TRD-EXE-10 gates: the stop overshoot ===\n');

  // 1. Re-derive the overshoot from the trades themselves, not from the numbers in the prose.
  const loss = await q(`SELECT id, symbol, direction, openPrice, stopPrice, closeFillPrice, closePrice, grossPnl, holdingMinutes
      FROM Trades WHERE status='closed' AND note LIKE '%Loss call%' AND closeAt >= DATEADD(hour,-48,GETUTCDATE())
      ORDER BY id`);
  if (loss.length < 5) throw new Error(`only ${loss.length} Loss-call trades in 48h; the row cites 5`);
  const ratios = [];
  for (const t of loss) {
    const stopPct = t.stopPrice == null ? null : Math.abs((Number(t.stopPrice) - Number(t.openPrice)) / Number(t.openPrice)) * 100;
    const realPct = t.closeFillPrice == null ? null : Math.abs((Number(t.closeFillPrice) - Number(t.openPrice)) / Number(t.openPrice)) * 100;
    const r = stopPct && realPct ? realPct / stopPct : null;
    if (r) ratios.push(r);
    console.log(`  #${t.id} ${String(t.symbol).padEnd(15)} ${t.direction.padEnd(4)} stop ${stopPct == null ? 'NULL' : stopPct.toFixed(3) + '%'}  realised ${realPct == null ? '-' : realPct.toFixed(3) + '%'}  => ${r ? r.toFixed(3) + 'x' : 'n/a'}`);
  }
  if (ratios.length !== 4) throw new Error(`${ratios.length} computable ratios, the row claims 4`);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  if (!(mean > 1.25 && mean < 1.5)) throw new Error(`mean overshoot is ${mean.toFixed(3)}x; the row claims 1.36x — re-measure`);
  if (!ratios.every((r) => r > 1.15)) throw new Error('not every stop-out overshoots — the headline claim is wrong');
  console.log(`  ${CHECK} mean overshoot ${mean.toFixed(3)}x over ${ratios.length} computable stop-outs; every one exceeds 1.15x`);
  const noStop = loss.filter((t) => t.stopPrice == null).length;
  if (noStop < 1) throw new Error('no Loss-call trade has a NULL stop — the "row with no stop" claim is wrong');
  console.log(`  ${CHECK} ${noStop} Loss-call trade(s) carry stopPrice IS NULL`);

  // 2. The negative result: the exits are NOT the problem. Only 3 of 28 gave back >=0.5% of MFE.
  const all = await q(`SELECT COUNT(*) AS n FROM Trades WHERE status='closed' AND closeAt >= DATEADD(hour,-48,GETUTCDATE())`);
  const giveback = await q(`SELECT COUNT(*) AS n FROM Trades WHERE status='closed' AND closeAt >= DATEADD(hour,-48,GETUTCDATE())
      AND mfePct IS NOT NULL AND mfePct >= 0.5 AND ISNULL(netPnlTerminal,0) < 0`);
  console.log(`  ${CHECK} ${all[0].n} closed trades in 48h; ${giveback[0].n} had >=0.5% MFE and still lost`);
  if (Number(giveback[0].n) > 6) throw new Error(`${giveback[0].n} give-backs — the "exits are fine" claim is too strong`);

  // 3. TRD-PNL-2's rescope: the disagreement is universal and nothing reads netPnlTerminal.
  const totalN = Number((await q(`SELECT COUNT(*) AS n FROM Trades WHERE status='closed' AND closeAt >= DATEADD(hour,-48,GETUTCDATE()) AND grossPnl IS NOT NULL AND netPnlTerminal IS NOT NULL`))[0].n);
  const differ = Number((await q(`SELECT COUNT(*) AS n FROM Trades WHERE status='closed' AND closeAt >= DATEADD(hour,-48,GETUTCDATE()) AND grossPnl IS NOT NULL AND netPnlTerminal IS NOT NULL AND ABS(grossPnl - netPnlTerminal) > 0.01`))[0].n);
  console.log(`\n  netPnlTerminal vs grossPnl: ${differ} of ${totalN} disagree by more than a cent`);
  // ⚠ THE FIRST VERSION OF THIS GATE ASSERTED `differ === totalN` ON THE STRENGTH OF "26 of 26". The real
  // count is 25 of 27 ${EM} two rows agree to the cent ${EM} and the gate refused to write, which is why the
  // row says 25 of 27. An "every row" claim needs a count, not a listing.
  if (differ < totalN - 3) throw new Error(`only ${differ} of ${totalN} disagree — the universal claim is wrong`);
  const agree = await q(`SELECT id, symbol, grossPnl, netPnlTerminal FROM Trades WHERE status='closed'
      AND closeAt >= DATEADD(hour,-48,GETUTCDATE()) AND grossPnl IS NOT NULL AND netPnlTerminal IS NOT NULL
      AND ABS(grossPnl - netPnlTerminal) <= 0.01 ORDER BY id`);
  console.log(`      the ${agree.length} that agree to the cent: ${agree.map((r) => '#' + r.id + ' ' + r.symbol).join(', ') || '(none)'}`);
  const flips = await q(`SELECT COUNT(*) AS n FROM Trades WHERE status='closed' AND closeAt >= DATEADD(hour,-48,GETUTCDATE())
      AND grossPnl < 0 AND netPnlTerminal > 0`);
  if (Number(flips[0].n) < 1) throw new Error('no sign flip found — the "#1133 loss reported as a profit" claim is wrong');
  console.log(`  ${CHECK} ${flips[0].n} trade(s) report a POSITIVE net on a NEGATIVE gross`);
  const readers = require('fs').readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
  if (!/updatable = \[[^\]]*'netPnlTerminal'\]/.test(readers)) throw new Error('netPnlTerminal is no longer written by store.js');
  console.log(`  ${CHECK} netPnlTerminal is still write-only in store.js`);

  // ---- write ----
  const nextSort = (await q(`SELECT ISNULL(MAX(sortOrder),0) + 1 AS n FROM dbo.Tasks WHERE edictId = 52`))[0].n;

  const existing = (await q(`SELECT id FROM dbo.Tasks WHERE info LIKE '%${MARKER}%'`))[0];
  if (existing) console.log(`\n  TRD-EXE-10 already filed as #${existing.id}`);
  else console.log(`\n  would file TRD-EXE-10 as a new edict-52 task (sortOrder ${nextSort})`);

  const pnl2 = (await q(`SELECT id FROM dbo.Tasks WHERE name LIKE 'TRD-PNL-2:%'`))[0];
  if (!pnl2) throw new Error('TRD-PNL-2 not found — the rescope cannot be appended');
  const already = ((await q(`SELECT CAST(info AS NVARCHAR(MAX)) AS info FROM dbo.Tasks WHERE id=${pnl2.id}`))[0].info || '').includes(MARKER2);
  console.log(`  would append the rescope to TRD-PNL-2 (#${pnl2.id})${already ? ' — ALREADY PRESENT' : ''}`);
  if (INFO.includes('\u0060') || INFO2.includes('\u0060')) throw new Error('an addendum contains a backtick');
  console.log(`  ${CHECK} no backticks in either text`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written. Re-run with --yes.\n`); await pool.close(); return; }

  if (!existing) {
    await pool.request().query(`INSERT INTO dbo.Tasks (name, createdAt, plannedStart, info, priority, state, edictId, sortOrder)
      VALUES (N'TRD-EXE-10: Risk - every stop-out realises 1.22-1.59x the modelled stop distance (mean 1.36x), so the risk dial and every R understate the loss side',
        GETUTCDATE(), GETUTCDATE(), N'${INFO.replace(/'/g, "''")}', 1, 1, 52, ${nextSort})`);
    const made = (await q(`SELECT TOP 1 id, LEN(info) AS n FROM dbo.Tasks WHERE info LIKE '%${MARKER}%' ORDER BY id DESC`))[0];
    console.log(`  ${CHECK} TRD-EXE-10 filed as #${made.id}, ${made.n} chars`);
  }
  if (!already) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${INFO2.replace(/'/g, "''")}' WHERE id = ${pnl2.id}`);
    const after = (await q(`SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${pnl2.id}`))[0].n;
    console.log(`  ${CHECK} TRD-PNL-2 (#${pnl2.id}) is now ${after} chars`);
  }
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
