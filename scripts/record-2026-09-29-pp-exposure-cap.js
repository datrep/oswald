// scripts/record-2026-09-29-pp-exposure-cap.js
//
// Records the EXPOSURE-CAP tightening and the whole revision cascade on TRD-RSK-10 (#1467).
//
// The gates re-derive rather than restate: the journal must show the expected sequence of risk-key changes, the
// live block must match, and the exposure arithmetic that produces the VETO must be recomputed from the open book.
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
const MARKER = '##2026-09-29 EXPOSURE CAP 50##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';

const ADDENDUM = `
${MARKER} EXPOSURE CAP CUT TO 50% ${EM} AND IT STOPS THE DESK ENTERING UNTIL THE BOOK FITS.##

${STAR} THE CHANGE: 'risk.exposureCapPct' **100 -> 50**. The owner's reasoning is arithmetically right and worth
recording: **at 1:5 leverage, 500% of equity in notional is 100% of equity in MARGIN, i.e. one position consuming
the entire account.** ${WARN} One correction to it though: the L3 guard already caps total margin at 80% of equity,
so a 500% exposure cap was never independently reachable ${EM} it was ~2x looser than the guard. The guard was the
binding brake; the 500 was slack above it.

${STAR} BUT THIS SETTING HAS AN IMMEDIATE CONSEQUENCE THAT IS NOT VISIBLE IN ITS NAME. 'fitExposureBudget' RESIZES
when there is room and **HARD-VETOES when there is not**: 'remainingPct = cap - open'; if that is <= 0 the helper
returns 'full' and risk.js raises 'veto(exposure_budget)'. It does NOT resize to nothing. Measured on the open book
at the moment of the change:
    #1123 Gold   sell  notional $527.39   ( 12.7% of equity)  origin=agent
    #1125 Sugar  sell  notional $11983.46 (288.8% of equity)  origin=agent
    TOTAL $12,510.85 on equity $4,149.67  =>  exposurePct = **301.49%**
    remaining = 50 - 301.49 = **-251.49**  =>  'full'  =>  **EVERY new entry is VETOED with 'exposure_budget'**
${ARROW}${ARROW} **SO THE DESK CANNOT OPEN ANYTHING UNTIL SUGAR CLOSES.** Sugar alone is 288.8% against a 50%
budget; Gold alone (12.7%) would fit comfortably. This is the control working as designed ${EM} the book is SIX TIMES
over budget, so adding risk would be wrong ${EM} but it is a hard stop rather than a squeeze, and it should be a
deliberate choice rather than a surprise. Both positions are PROTECTED (stop AND limit present, origin=agent), so
"let it close by itself" remains safe and the freeze self-resolves when Sugar exits.

${STAR} RISK IF THE 50% BUDGET IS WHAT BINDS ('risk = cap x stop%', 'stop = ceiling / L'):
    Arabica Coffee  50% x 0.46202% = **0.2310%**   (pre-L2 80% would have been 0.3696%)
    Sugar           50% x 0.55020% = **0.2751%**   (pre-L2 80% would have been 0.4402%)
    SGX             50% x 1.49866% = **0.7493%**   (pre-L2 80% would have been 1.1989%)
${ARROW} **THAT IS 62.5% OF THE PRE-L2 RISK ON EVERY SYMBOL**, and the 'r = 3.0%' target is now nowhere near
reachable ${EM} the budget binds at 0.23% to 0.75%. The package today delivers the TIGHTENINGS without the loosening
it was designed around.

${STAR}${STAR} THE FULL CASCADE, FROM THE JOURNAL ${EM} because the journal is now the ONLY place it can be read.
'cappedAtPct: null' no longer records the cap in force (a consequence of TRD-RSK-11), so this sequence is
reconstructable ONLY from the 'settings_write' events, which is exactly the record TRD-RSK-8 asked for:

  #124956  07:57:43Z  'maxEquityPerPositionPct' 80 -> **500**  · 'riskPerTradePct' 5 -> 3
                      'exposureCapPct' 100 -> **500**  · 'dailyLossHaltPct' 3 -> 6
  #125102  08:09:36Z  'maxEquityPerPositionPct' 500 -> **60**  · 'exposureCapPct' 500 -> **100**
  #125174       ${EM}     'maxEquityPerPositionPct' 60 -> **35**
  this change         'exposureCapPct' 100 -> **50**

${ARROW} **LIVE NOW: 'maxEquityPerPositionPct 35' · 'exposureCapPct 50' · 'riskPerTradePct 3' ·
'dailyLossHaltPct 6' · 'maxMarginUtilisationPct 80' · 'maxPositions 10'.**
${ARROW} Note the SHAPE of that cascade: the caps went UP to 500 and came back to 35 and 50 within the hour, each
step a correction to the previous number. **The end state is not a compromise between the two ${EM} on every
measurable symbol it is ~37.5% TIGHTER than the 80% the desk ran before L2 began. 'maxPositions: 10' is now
entirely theoretical: with a 35% per-position and a 50% portfolio budget the book fits about **one full-size
position plus a partial**.

${STAR} WHAT DID *NOT* CHANGE, and is still therefore still unaudited: **TRD-EXE-1 (#1454)** ${EM} the desk still
cannot reliably distinguish a venue refusal from "maybe submitted". The caps being lower reduces how often the
margin limit could be approached, which reduces the exposure but does not fix the record.

${WARN} METHODS NOTE, since it cost a run: this change was dry-run TWICE because the first apply omitted '--yes'.
The deployer is correct to default to dry-run, but the lesson is that a dry run and a real run print the SAME
prediction block, so the ONLY thing distinguishing them is the trailing 'applying' section. Read the tail, not the
middle.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== exposure cap 50 — recording gates ===\n');

  console.log('1. the journal shows the expected cascade');
  const sw = await q(`SELECT id, createdAt, payload FROM TradingEvents WHERE kind = 'settings_write' ORDER BY id`);
  const caps = [];
  for (const s of sw) {
    let p; try { p = JSON.parse(s.payload); } catch { continue; }
    for (const c of (p.changes || [])) {
      if (c.key === 'risk.maxEquityPerPositionPct') caps.push(`pos:${c.before}->${c.after}`);
      if (c.key === 'risk.exposureCapPct') caps.push(`exp:${c.before}->${c.after}`);
    }
  }
  const seen = caps.join(' ');
  for (const want of ['pos:80->500', 'pos:500->60', 'pos:60->35', 'exp:100->500', 'exp:500->100', 'exp:100->50']) {
    if (!seen.includes(want)) await fail(`the journal is missing ${want}. Got: ${seen}`);
  }
  console.log(`  ${CHECK} ${caps.length} cap changes journalled, including all six expected transitions`);

  console.log('\n2. the live block matches the end state');
  const risk = (await store.getSettings(1)).risk || {};
  const WANT = { maxEquityPerPositionPct: 35, exposureCapPct: 50, riskPerTradePct: 3, dailyLossHaltPct: 6, maxMarginUtilisationPct: 80 };
  for (const [k, v] of Object.entries(WANT)) {
    if (Number(risk[k]) !== v) await fail(`${k} is ${risk[k]}, expected ${v}`);
  }
  console.log(`  ${CHECK} 35 / 50 / 3 / 6 / 80`);

  console.log('\n3. the VETO arithmetic, recomputed from the open book');
  const open = await q(`SELECT id, symbol, size, openPrice, stopPrice, takeProfitPrice FROM Trades WHERE status = 'open' ORDER BY id`);
  const equity = Number(risk.initialEquity);
  const total = open.reduce((s, t) => s + (Number(t.size) || 0) * (Number(t.openPrice) || 0), 0);
  const exposurePct = total / equity * 100;
  const remaining = Number(risk.exposureCapPct) - exposurePct;
  console.log(`  open: ${open.map((t) => `#${t.id} ${t.symbol} ${((Number(t.size) * Number(t.openPrice)) / equity * 100).toFixed(1)}%`).join('  ')}`);
  console.log(`  exposurePct = ${exposurePct.toFixed(2)}%   remaining = ${remaining.toFixed(2)}`);
  if (remaining > 0) {
    console.log(`  ${WARN} remaining > 0 — the block's "every new entry is vetoed" claim does NOT currently hold (the book changed).`);
    await fail('the veto claim does not reproduce; re-measure before recording it');
  }
  if (!open.every((t) => t.stopPrice != null && t.takeProfitPrice != null)) {
    await fail('an open position is missing a stop or limit — "let it close by itself" is not safe, do not record that');
  }
  console.log(`  ${CHECK} remaining <= 0 => 'full' => exposure_budget veto; and every open position IS protected`);

  console.log('\n4. the report');
  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  if (doc.indexOf('### 13.13 ') < 0) await fail('the report is missing 13.13');

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
  if (!(aft.info || '').includes('STOPS THE DESK ENTERING')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${aft.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
