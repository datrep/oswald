// scripts/record-2026-09-30-exe10-empirical-fix.js
//
// TRD-EXE-10, the empirical half: the desk now sizes on the MEASURED loss distance rather than the stop's level.
// Appends to #1480. Gates re-derive the measurement from the trades themselves.
// DRY RUN by default (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const MARKER = '##2026-09-30 exe10 empirical fix##';
const INFO = `${MARKER} THE FIX IS IN, AND IT IS A DE-LEVER: THE DIAL NOW MEANS THE LOSS IT PRODUCES.##

${STAR} THE MEASUREMENT THIS RESTS ON. Every venue-closed row carries BOTH the venue's quoted rate AND the real
fill, so the two readings can be compared ON THE SAME TRADE ${EM} and that comparison is what settles it:

| reading | stop-out | take-profit |
|---|---|---|
| exit at the venue's RATE | median **1.006x** the stop distance | median **1.009x** |
| exit at the actual FILL | median **1.305x** (p90 1.431, max 4.370) | median **1.294x** |

**24 venue stop-outs across 14 days, and the ratio is stable**: every day 1.22-1.43 except one row (#1066, Oil,
a 0.284% stop on a weekend gap, 4.37x ${EM} which is why the MEDIAN is used and not the mean, which that single
row drags to 1.449). By symbol Gold n=13 median 1.295 (min 1.249, max 1.431, no outliers).

${STAR} THE SYMMETRY IS THE PROOF, NOT A PUZZLE. The recorded RATE sits ON the level in both cases; the FILL is
what travels. That is right in kind: **a take-profit is a LIMIT**, so it can fill PAST its level when price gaps
through it; **a stop becomes a STOP-MARKET on trigger**, so it fills SHORT of its level. Neither side is
level-precise, and price keeps moving ~30% of the intended distance while the close executes. The first version
of this row asked whether the 1.30x was slippage or a minute-later quote ${EM} it is neither: it is the fill,
measured against a rate that sits exactly where it should.

${CHECK} WHAT CHANGED. 'store.js' gains **'risk.stopSlippageFactor: 1.305'** (the measured median). 'risk.js'
computes **'expectedLossDist = riskStopDist x lossFactor'** and uses it in the three places that express the risk
the ticket TAKES: the sizing divide, the 'maxRiskPerTradePct' cap, and 'resolvedRiskPct'. The stop LEVEL
('v.effectiveStopDistance'), the cost-share ratio and the take-profit geometry all still use 'riskStopDist'
untouched ${EM} this fits a LOSS, it does not move an exit. New fields 'stopSlippageFactor' and
'expectedLossDistance' ride on 'v' and on 'sizeCalc', and a 'reasons' line states the arithmetic on every
ticket, so the seat and the record both see it.

${WARN}${WARN} THIS CHANGES LIVE POSITION SIZES, AND THE DIRECTION IS DOWN. Every size is divided by 1.305, so
positions shrink by **~23%** and exposure falls with them. Settings are read per wake, so it applies from the
next wake WITHOUT a restart. **ROLLBACK: set 'stopSlippageFactor' to 1, which reproduces the previous behaviour
exactly.** A value BELOW 1 is REFUSED in the open with a reason rather than clamped ${EM} it would assert a
stop-out loses less than the stop distance, which the 24 measured rows disprove, and a control that silently
ignores its setting is this repo's oldest defect.

${WARN} WHAT THIS DOES **NOT** DO, stated so the row is not closed on a false premise. **It does not improve the
edge.** The favourable side overshoots by the same 1.294x, so a uniform shrink scales the whole P&L distribution
by one factor. This is a de-lever that makes 'riskPerTradePct' TRUE, not a source of return: a 3% dial used to
produce a realised ~3.9% stop-out and now produces ~3.0%. And the **r = 3.0% choice is unaffected**, because that
experiment derived R from 'grossPnl', which already contains the overshoot on both sides.

${CHECK} AND THREE PINS HAD TO BE CORRECTED, EACH OF WHICH WAS PINNING A NAME RATHER THAN A PROPERTY:
  * 'size-truth-fields.test.js' pinned the literal 'v.size * riskStopDist / equity' for a test NAMED
    "resolvedRiskPct is computed on the SAME stop the sizing used". The property HELD ${EM} both moved together ${EM}
    while the literal failed. It now EXTRACTS both denominators and asserts they are equal, which cannot be
    satisfied by a rename and is strictly stronger.
  * 'decision-stop-reconciliation.test.js' pinned the sizing divide by name; it now pins BOTH links, so the
    denominator must be built on the EFFECTIVE distance and never on the declared one.
  * 'cost-share-gate.test.js' sliced its branch up to the literal text 'let size =', so inserting anything
    between the ceiling check and the sizing broke it. It now ends the slice at the branch's own 'return v;'.

VERIFIED: suite **1,799 / 1,798 pass / 0 fail / 1 skipped**, eslint exit 0.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  console.log('=== TRD-EXE-10 empirical fix ===\n');

  // 1. The measurement must still be reproducible from the trades.
  const rows = await q(`SELECT id, symbol, direction, openPrice, stopPrice, takeProfitPrice, closePrice, closeFillPrice, note
      FROM Trades WHERE status='closed' AND stopPrice IS NOT NULL AND openPrice > 0 AND closeFillPrice IS NOT NULL
        AND note LIKE '%Loss call%' ORDER BY closeAt`);
  const ratio = (t, px) => {
    const open = Number(t.openPrice);
    const d = Math.abs(Number(t.stopPrice) - open) / open * 100;
    if (!(d > 0)) return null;
    const adv = (t.direction === 'sell' ? (px - open) : (open - px)) / open * 100;
    return adv > 0 ? adv / d : null;
  };
  const byFill = rows.map((t) => ratio(t, Number(t.closeFillPrice))).filter(Boolean).sort((a, b) => a - b);
  const byRate = rows.map((t) => ratio(t, Number(t.closePrice))).filter(Boolean).sort((a, b) => a - b);
  const med = (s) => s[Math.round((s.length - 1) * 0.5)];
  if (byFill.length < 20) throw new Error(`only ${byFill.length} stop-outs with a fill; the row cites 24`);
  const medFill = med(byFill), medRate = med(byRate);
  if (Math.abs(medFill - 1.305) > 0.02) throw new Error(`the median fill ratio is ${medFill.toFixed(3)}; the row and the setting say 1.305 — re-measure BOTH`);
  if (!(medRate > 0.98 && medRate < 1.03)) throw new Error(`the venue-rate median is ${medRate.toFixed(3)}; the "rate sits ON the level" claim is wrong`);
  console.log(`  ${CHECK} stop-outs n=${byFill.length}  fill median ${medFill.toFixed(3)}  rate median ${medRate.toFixed(3)}`);

  const tps = await q(`SELECT id, symbol, direction, openPrice, takeProfitPrice, closePrice, closeFillPrice
      FROM Trades WHERE status='closed' AND takeProfitPrice IS NOT NULL AND closeFillPrice IS NOT NULL
        AND note LIKE '%Profit call%'`);
  const tpR = tps.map((t) => {
    const open = Number(t.openPrice);
    const d = Math.abs(Number(t.takeProfitPrice) - open) / open * 100;
    if (!(d > 0)) return null;
    const fav = (t.direction === 'sell' ? (open - Number(t.closeFillPrice)) : (Number(t.closeFillPrice) - open)) / open * 100;
    return fav > 0 ? fav / d : null;
  }).filter(Boolean).sort((a, b) => a - b);
  const medTp = med(tpR);
  if (!(medTp > 1.2 && medTp < 1.4)) throw new Error(`the TP fill median is ${medTp.toFixed(3)} — the DE-LEVER framing depends on it being ~1.29, not ~1.0`);
  console.log(`  ${CHECK} take-profits n=${tpR.length}  fill median ${medTp.toFixed(3)} (the same overshoot ⇒ a DE-LEVER, not a return)`);

  // 2. The fix must be in place in all four places, and the setting must carry the measured number.
  const store = require('fs').readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
  if (!/stopSlippageFactor: 1\.305,/.test(store)) throw new Error('store.js no longer defaults stopSlippageFactor to the measured 1.305');
  const risk = require('fs').readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
  const need = [
    [/const expectedLossDist = riskStopDist \* lossFactor;/, 'the loss distance'],
    [/let size = \(equity \* riskPerTrade\) \/ expectedLossDist;/, 'the sizing divide'],
    [/const impliedRiskPct = \(size \* expectedLossDist\) \/ equity \* 100;/, 'the risk cap'],
    [/resolvedRiskPct = Number\(equity\) > 0 \? Math\.round\(\(v\.size \* expectedLossDist \/ equity\)/, 'resolvedRiskPct'],
    [/v\.effectiveStopDistance = Math\.round\(riskStopDist \* 10000\) \/ 10000;/, 'the untouched stop LEVEL'],
  ];
  for (const [re, what] of need) { if (!re.test(risk)) throw new Error(`risk.js is missing: ${what}`); }
  console.log(`  ${CHECK} risk.js: loss distance, sizing divide, risk cap, resolvedRiskPct, and the STILL-UNTOUCHED stop level`);

  const exe10 = (await q(`SELECT id FROM dbo.Tasks WHERE name LIKE 'TRD-EXE-10:%'`))[0];
  if (!exe10) throw new Error('TRD-EXE-10 not found');
  const already = ((await q(`SELECT CAST(info AS NVARCHAR(MAX)) AS info FROM dbo.Tasks WHERE id=${exe10.id}`))[0].info || '').includes(MARKER);
  console.log(`  would append to TRD-EXE-10 (#${exe10.id})${already ? ' — ALREADY PRESENT' : ''}`);
  if (INFO.includes('\u0060')) throw new Error('the addendum contains a backtick');
  console.log(`  ${CHECK} no backticks`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written. Re-run with --yes.\n`); await pool.close(); return; }
  if (!already) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${INFO.replace(/'/g, "''")}' WHERE id = ${exe10.id}`);
    const after = (await q(`SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${exe10.id}`))[0].n;
    console.log(`  ${CHECK} appended; TRD-EXE-10 (#${exe10.id}) is now ${after} chars`);
  }
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
