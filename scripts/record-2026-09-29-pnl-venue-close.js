// scripts/record-2026-09-29-pnl-venue-close.js
//
// Files the netPnlTerminal defect found while reconciling the Sugar trade against the venue's own screen.
//
// The gates re-derive the discrepancy from the row, so the task cannot be filed against a number that has since
// changed or been corrected.
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0';
const STAR = '\u2605';
const EM = '\u2014';
const CHECK = '\u2714';
const ARROW = '\u21D2';

const MARKER = '##2026-09-29 netPnlTerminal understated##';
const INFO = `${MARKER} ON A ROW THE *VENUE* CLOSES, THE NET P/L TERMINAL UNDER-REPORTS THE LOSS.##

${STAR} FOUND 2026-09-29 while reconciling a trade against the venue's own screen rather than against the desk's
record. The reconciliation was being done for an unrelated reason (an oversized position that had just closed), which
is how it surfaced.

${STAR} THE INSTANCE, and the numbers are exact rather than approximate. 'Trades' **#1125** (Sugar, 647.0551
contracts, 18.52 -> 18.64):
    desk 'grossPnl'        = **-99.70**   ${EM} EXACTLY the venue's own Net P&L (0.00 apart)
    desk 'netPnlTerminal'  = **-74.77**   ${EM} **$24.93 LESS than its own gross**
    'fees' = null · 'fundingCost' = 0 · 'fundingSource' = 'no_carry_nights' · 'swapNights' = 0
    venue: Adjustments / Overnight Funding = **S$0.00**
${ARROW} **THERE IS NO COST IN THE ROW TO JUSTIFY THE $24.93 DIFFERENCE.** The desk subtracted something that it did
not record, and the venue says there was nothing to subtract.

${STAR} THE LIKELY MECHANISM, evidenced rather than assumed: 'netPnlMin' = **-74.77**, 'netPnlMax' = **0**,
'netPnlSamples' = **33**, and the terminal EQUALS the minimum. That is consistent with a sampled path that STOPPED
before the position ended ${EM} and the venue's Close Reason on this row is **"Market closed"**, i.e. the VENUE closed
it, not the desk. So the last sample predates the close and the final adverse move is missing from the path.

${WARN} WHY IT MATTERS MORE THAN ONE TRADE: every metric derived from 'netPnlTerminal' inherits the understatement on
exactly the rows where the venue intervened. **The gross figure is the one that agrees with the venue** (it matched to
the cent here), so a study that prefers the "net" column is using the LESS accurate number on vendor-closed rows.
Same family as TRD-108 (closePrice on a venue-closed row is the venue's quoted rate, not the fill).

${WARN} WHAT THIS ROW DOES **NOT** CLAIM: 25% is the error on ONE trade. It is not a distribution, the mechanism is
inferred from the sample count and the close reason rather than observed live, and no other venue-closed row has been
checked. The first job is to measure how many rows are venue-closed and how their 'netPnlTerminal' compares with the
venue ${EM} not to fix a denominator on a sample of one.

SUGGESTED FIRST STEP (not implemented): identify venue-closed rows ('closePriceSource' / close reason, and the
'phantom_fill'-style events), and compare 'netPnlTerminal' against the venue's reported P&L for each. If the gap is
systematic, the fix is to take the terminal sample AT or AFTER the close rather than to stop the sampler at the last
wake tick.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== netPnlTerminal understatement — filing gates ===\n');
  const t = (await q(`SELECT id, grossPnl, netPnlTerminal, netPnlMin, netPnlMax, netPnlSamples, fees, fundingCost, swapNights, closePriceSource FROM Trades WHERE id = 1125`))[0];
  if (!t) throw new Error('Trades #1125 is gone — the instance cannot be cited');
  const gap = Number(t.grossPnl) - Number(t.netPnlTerminal);
  console.log(`  #1125 gross=${t.grossPnl} netTerminal=${t.netPnlTerminal} gap=${gap.toFixed(2)} min=${t.netPnlMin} max=${t.netPnlMax} samples=${t.netPnlSamples}`);
  // ⚠ THE GAP IS SIGNED: gross (-99.70) is MORE negative than net (-74.77), so gross - net = -24.93. Compare the
  // MAGNITUDE — the first version of this gate compared -24.93 against 24.93 and refused to write.
  if (Math.abs(Math.abs(gap) - 24.93) > 0.02) throw new Error(`the gap magnitude is ${Math.abs(gap).toFixed(2)}, the block claims 24.93 — re-measure`);
  if (t.fees != null) throw new Error(`fees is ${t.fees}, not null — the "no cost in the row" claim is wrong`);
  if (Number(t.fundingCost) !== 0) throw new Error(`fundingCost is ${t.fundingCost}, not 0`);
  if (Number(t.netPnlTerminal) !== Number(t.netPnlMin)) throw new Error(`terminal (${t.netPnlTerminal}) != min (${t.netPnlMin}) — the terminal-equals-min evidence is gone`);
  console.log(`  ${CHECK} gap 24.93 reproduced; no fees, no funding; terminal == min`);

  const exists = (await q(`SELECT id FROM dbo.Tasks WHERE info LIKE '%${MARKER}%'`))[0];
  const nextSort = (await q(`SELECT ISNULL(MAX(sortOrder),0) + 1 AS n FROM dbo.Tasks WHERE edictId = 52`))[0].n;
  if (exists) { console.log(`  already filed as #${exists.id}`); await pool.close(); return; }
  console.log(`\n  would file a new edict-52 task (sortOrder ${nextSort})`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.`); await pool.close(); return; }

  await pool.request().query(`INSERT INTO dbo.Tasks (name, createdAt, plannedStart, info, priority, state, edictId, sortOrder)
    VALUES (N'TRD-PNL-2: Trade telemetry - on a row the VENUE closes, netPnlTerminal stops sampling before the close and under-reports the loss by $24.93 (25%) while grossPnl matches the venue exactly',
      GETUTCDATE(), GETUTCDATE(), N'${INFO.replace(/'/g, "''")}', 2, 1, 52, ${nextSort})`);
  const made = (await q(`SELECT TOP 1 id, LEN(info) AS n FROM dbo.Tasks WHERE info LIKE '%${MARKER}%' ORDER BY id DESC`))[0];
  console.log(`  ${CHECK} filed as #${made.id}, ${made.n} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
