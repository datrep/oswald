// scripts/record-2026-09-30-rsk14-currency-not-rate.js
//
// TRD-RSK-14 (#1477): "the L3 margin guard under-counts the venue's actual initial margin by ~20% (25% charged vs
// 20% modelled), so its 80% ceiling is closer to 96% of what the venue really withholds".
//
// MEASURED, AND THE DIAGNOSIS IN THE ROW IS WRONG IN A WAY THAT MATTERS. The registry's rate is CORRECT. What is
// missing is a CURRENCY: the venue withholds margin in the ACCOUNT's currency (SGD) while the guard applies the
// rate to a notional denominated in the INSTRUMENT's currency (USD for every symbol this desk trades).
//
//   impliedFx = (equity - available) / SUM(notional_i x registryRate_i)
//
// Appends to #1477. DRY RUN by default (pass --yes). Every gate re-derives its number and REFUSES on a mismatch.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192', SIGMA = '\u03A3';

const MARKER = '##2026-09-30 rsk14 the undercount is a currency not a rate##';
const INFO = `${MARKER} THE REGISTRY'S RATE IS RIGHT. WHAT THE GUARD IS MISSING IS A CURRENCY ${EM} AND THE MEASURED FACTOR IS 1.2812, NOT 1.25.##

  impliedFx = (equity - available) / SUM(notional_i x registryRate_i)

${STAR} MEASURED OVER EVERY READABLE BOOK ON FILE (the gate below re-derives it; the count grows as the desk adds
snapshots, so it is deliberately NOT quoted):
  * median impliedFx **1.2812**, p10 **1.2757**, p90 **1.2847**;
  * **99.2% of books lie within 0.02 of that median** ${EM} a single factor of 1.2812 therefore reproduces the venue's
own withheld margin on almost every book.
${ARROW} both of those are ASSERTED by this script's gates, so they cannot silently drift from the live book.

${STAR}${STAR} AND IT DOES NOT DEPEND ON WHAT THE BOOK HOLDS ${EM} WHICH IS THE MEASUREMENT THAT SETTLES WHAT THE FACTOR *IS*.
The registry rates in play differ by a factor of three, and the factor does not move with them:
    Gold only                          median 1.2795
    Gold + Silver                      median 1.2818
    Bitcoin + Gold                     median 1.2820
    Bitcoin + Oil                      median 1.2816
    Bitcoin + Gold + Silver            median 1.2824
    Coffee + Bitcoin + Gold + Silver + Sugar   median 1.2825
A book holding a **60%-margin** instrument and a book holding only **20%-margin** ones give the SAME multiplier. A
"the venue charges more than the registry says" story cannot produce that: it would require the venue to charge 25.6%
on Gold AND 76.9% on Bitcoin, two independent errors that happen to be the same number. **One multiplicative factor
is the only parsimonious explanation, and 1.28 is USD per SGD.** The account is in SGD ${EM} the venue's own screen writes
S$ ("M. Margin S$174.49 / In. Margin S$348.99") and the registry states USD for Gold, Silver, Oil, Coffee, Bitcoin and Sugar.

${WARN}${WARN} SO THE ROW'S OWN NUMBERS ARE RIGHT AND ITS CONCLUSION IS NOT. 20% x 1.28 = 25.6%, which is the ~24.93%
this row recorded ${EM} the arithmetic reproduced, the interpretation did not. **The under-count is 28.12%, not 19.8%**,
because the factor is the exchange rate and not a second margin policy. And the consequence is worse than "closer to 96%":

    the guard's ceiling C% means  C x 1.2812%  of equity in the venue's OWN withheld margin
        C = 80     ${ARROW}  102.50% of equity withheld by the venue  ** ABOVE 100: THE VENUE LIQUIDATES BEFORE THE GUARD STOPS US **
        C = 62.5   ${ARROW}   80.08%  (the value that makes the dial mean what it says)
        C = 100    ${ARROW}  128.12%

${WARN} WHICH IS NOT A LIVE HAZARD TODAY, AND THAT IS MEASURED RATHER THAN ASSUMED. The binding controls are
'maxEquityPerPositionPct' 35 and 'exposureCapPct' 50, both far tighter than 80. A book at the 50% portfolio cap is
50% x 0.20 x 1.2812 = **12.8% of equity** in venue margin on Gold, and at most 50% x 0.60 x 1.2812 = **38.4%** if the
whole book were Bitcoin. The guard cannot be reached, so this is a LATENT miscalibration ${EM} the same standing as L3's
inertness before L2. It becomes live the moment the caps are raised again, which is exactly what L2 did.

${CHECK} THE METHOD, AND WHY THE FIRST TWO ATTEMPTS WERE THROWN AWAY.
  1. 'position_pnl.size' x 'currentRate' is the NOTIONAL, per position, in the instrument's currency.
  2. 'equity - available' is the venue's **In. Margin** (INITIAL); 'account.margin' is **M. Margin** (MAINTENANCE).
     The registry relationship "maintenance is exactly half of initial" holds on EVERY account sample that
     carries a nonzero margin, with the remainder all being margin = 0 ${EM} so the two account fields decompose the way
     this repo already asserts, and 'equity - available' is a valid reading of what the venue withholds.
${ARROW} ATTEMPT 1 filtered to books holding EXACTLY ONE position, so the rate could be attributed to a symbol. That
filter is UNSOUND: a poll second can hold one position while the venue withholds margin for several. The evidence is
in the output ${EM} the SGX sample reads impliedFx **9.6479**, and the desk's own wake event at that instant reports
**3 open positions**. Those rows are contamination, not measurements, and they are why the median is quoted with a
count instead of a maximum. **A per-symbol rate is NOT measurable from stored data; a per-BOOK factor is, and that is
what this entry uses.**

${WARN} NOT FIXED, AND DELIBERATELY. The guard is not binding, so an emergency dial change would be churn against a
live risk path ${EM} and the two available fixes differ in kind:
  (a) STOPGAP, no code: set 'maxMarginUtilisationPct' 80 ${ARROW} 62.5 so the dial means "80% of the venue's margin".
      It is one number and it is correct only while USD/SGD sits at 1.28 and the whole book is USD-quoted.
  (b) PROPER: the desk ALREADY STORES the venue's own withheld margin on every 'account' event, so the OPEN BOOK's
      margin can be READ rather than modelled ${EM} and the FX problem then applies only to the new ticket. That closes
      the calibration loop with no external feed, and the desk can even CALIBRATE its own factor from the same
      snapshots (this entry's own arithmetic, run on the live book).
Both change a live control's arithmetic, so both are the owner's call.

${SIGMA} WHAT THIS MEANS FOR THE DESIGN: L3 was described as "the one control that measures the VENUE'S CAPACITY rather
than the desk's notional". It measures the venue's RATE correctly and the venue's NOTIONAL in the wrong currency, so
its ceiling is ~28% looser than it reads. The layer's remaining L2-gated claim ${EM} that it is the only binding control ${EM}
is unaffected, but the number attached to it is not yet in the venue's units.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  console.log('=== TRD-RSK-14: the under-count, re-derived ===\n');

  const row = (await q(`SELECT id, state, LEN(CAST(info AS NVARCHAR(MAX))) AS n, CAST(info AS NVARCHAR(MAX)) AS info
      FROM dbo.Tasks WHERE name LIKE '%RSK-14%'`))[0];
  if (!row) throw new Error('TRD-RSK-14 not found');
  const already = String(row.info || '').includes(MARKER);
  console.log(`  ${CHECK} TRD-RSK-14 is #${row.id}, state ${row.state}, ${row.n} chars${already ? ' — MARKER ALREADY PRESENT' : ''}`);

  // ---- 1. the account fields decompose -------------------------------------------------------------
  const acc = await q(`SELECT CAST(JSON_VALUE(payload,'$.equity') AS FLOAT) AS equity,
      CAST(JSON_VALUE(payload,'$.available') AS FLOAT) AS available,
      CAST(JSON_VALUE(payload,'$.margin') AS FLOAT) AS margin
    FROM TradingEvents WHERE kind='account'`);
  const withMargin = acc.filter((a) => Number(a.margin) > 0);
  if (!withMargin.length) throw new Error('no account sample carries a nonzero margin — the 1:2 relation cannot be re-derived');
  const halfOk = withMargin.filter((a) => Math.abs((a.equity - a.available) / a.margin - 2) < 0.02).length;
  if (halfOk !== withMargin.length) throw new Error(`${withMargin.length - halfOk} sample(s) break "maintenance is half of initial" — 'equity - available' is not a valid initial-margin reading`);
  console.log(`  ${CHECK} maintenance is exactly half of initial on ${halfOk} of ${halfOk} nonzero-margin samples (equity - available = In. Margin)`);

  // ---- 2. impliedFx over every readable book -------------------------------------------------------
  const REG = new Map((await q(`SELECT symbol, initialMarginPct FROM Instruments WHERE userId=1 AND instrumentClass='spot'`))
    .map((r) => [r.symbol, Number(r.initialMarginPct)]));
  const positions = await q(`SELECT CONVERT(varchar(23), createdAt, 126) AS at,
      JSON_VALUE(payload,'$.positionId') AS positionId, JSON_VALUE(payload,'$.symbol') AS symbol,
      CAST(JSON_VALUE(payload,'$.size') AS FLOAT) AS size,
      CAST(JSON_VALUE(payload,'$.currentRate') AS FLOAT) AS rate
    FROM TradingEvents WHERE kind='position_pnl'`);
  const accounts = await q(`SELECT id, CONVERT(varchar(23), createdAt, 126) AS at,
      CAST(JSON_VALUE(payload,'$.equity') AS FLOAT) AS equity,
      CAST(JSON_VALUE(payload,'$.available') AS FLOAT) AS available
    FROM TradingEvents WHERE kind='account' AND CAST(JSON_VALUE(payload,'$.margin') AS FLOAT) > 0 ORDER BY id`);
  const bySecond = new Map();
  for (const p of positions) {
    const k = String(p.at).slice(0, 19);
    if (!bySecond.has(k)) bySecond.set(k, new Map());
    bySecond.get(k).set(String(p.positionId), p);
  }
  const seconds = [...bySecond.keys()].sort();
  const secMs = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
  const books = [];
  for (const a of accounts) {
    const t = Date.parse(String(a.at).replace(' ', 'T') + 'Z');
    let best = null, bestD = Infinity;
    for (const s of seconds) { const d = Math.abs(secMs(s) - t); if (d < bestD) { bestD = d; best = s; } if (secMs(s) > t + 190000) break; }
    if (!best || bestD > 45000) continue;
    const book = [...bySecond.get(best).values()]
      .map((p) => ({ symbol: String(p.symbol), size: Number(p.size), rate: Number(p.rate) }))
      .filter((p) => Number.isFinite(p.rate) && p.rate > 0 && Number.isFinite(p.size) && p.size > 0 && REG.has(String(p.symbol)));
    if (!book.length || book.length !== [...bySecond.get(best).values()].length) continue;
    const model = book.reduce((s, p) => s + p.size * p.rate * (REG.get(p.symbol) / 100), 0);
    if (!(model > 0)) continue;
    books.push({ id: a.id, held: a.equity - a.available, model, fx: (a.equity - a.available) / model,
      symbols: book.map((p) => p.symbol) });
  }
  const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  if (books.length < 4000) throw new Error(`${books.length} readable books, not enough to state a median`);
  const fx = books.map((b) => b.fx);
  const m = med(fx);
  const tight = fx.filter((x) => Math.abs(x - m) < 0.02).length;
  const share = tight / fx.length * 100;
  if (Math.abs(m - 1.2812) > 0.01) throw new Error(`median impliedFx is ${m.toFixed(4)}, not the 1.2812 this record cites`);
  if (share < 99) throw new Error(`only ${share.toFixed(1)}% of books lie within 0.02 of the median, not the 99.2% this record cites`);
  console.log(`  ${CHECK} ${books.length} readable books: median impliedFx ${m.toFixed(4)}, ${tight} (${share.toFixed(1)}%) within 0.02`);

  // ---- 3. THE DISCRIMINATOR: the factor must not track the registry rate --------------------------
  const goldOnly = books.filter((b) => b.symbols.length && b.symbols.every((s) => s === 'Gold'));
  const btc = books.filter((b) => b.symbols.includes('Bitcoin'));
  if (!goldOnly.length || !btc.length) throw new Error('the composition split cannot be re-derived — no Gold-only or Bitcoin book on file');
  const g = med(goldOnly.map((b) => b.fx)), bb = med(btc.map((b) => b.fx));
  if (Math.abs(g - bb) > 0.01) throw new Error(`Gold-only (${g.toFixed(4)}) and Bitcoin-containing (${bb.toFixed(4)}) books disagree — the factor DOES depend on composition, and the FX claim is falsified`);
  if (REG.get('Gold') === REG.get('Bitcoin')) throw new Error('Gold and Bitcoin share a registry rate — this test would prove nothing');
  console.log(`  ${CHECK} the factor does not track the rate: Gold-only (${REG.get('Gold')}%) x${g.toFixed(4)} vs Bitcoin (${REG.get('Bitcoin')}%) x${bb.toFixed(4)} — agree within ${Math.abs(g - bb).toFixed(4)}`);

  // ---- 4. the dial arithmetic ----------------------------------------------------------------------
  const settings = JSON.parse((await q(`SELECT CAST(settings AS NVARCHAR(MAX)) AS j FROM TradingSettings WHERE userId=1`))[0].j);
  const cap = Number(settings.risk.maxMarginUtilisationPct);
  const posCap = Number(settings.risk.maxEquityPerPositionPct);
  const expCap = Number(settings.risk.exposureCapPct);
  if (!(cap > 0)) throw new Error('maxMarginUtilisationPct is not armed — the guard is off and this row is about a different thing');
  if (Math.abs(cap - 80) > 0.001) throw new Error(`maxMarginUtilisationPct is ${cap}, not the 80 this record cites`);
  const implied = cap * m;
  if (implied <= 100) throw new Error(`C x factor = ${implied.toFixed(2)}%, which is NOT above 100 — the consequence this record states is falsified`);
  const worstBookMargin = Math.min(posCap, expCap) * 0.60 * m;
  if (worstBookMargin >= cap) throw new Error(`the caps DO reach the guard (${worstBookMargin.toFixed(2)}% vs ${cap}%) — this is a live hazard, not latent, and the record must say so`);
  console.log(`  ${CHECK} live: cap ${cap}% x ${m.toFixed(4)} = ${implied.toFixed(2)}% of equity withheld (ABOVE 100) — but the caps (${posCap}% / ${expCap}%) reach only ${worstBookMargin.toFixed(2)}%, so it is LATENT`);

  if (INFO.includes('\u0060')) throw new Error('the addendum contains a backtick');
  console.log(`  ${CHECK} no backticks (${INFO.length} chars)`);
  console.log(`  would append to TRD-RSK-14 (#${row.id})`);
  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written.\n`); await pool.close(); return; }
  if (already) { console.log(`  ${CHECK} already present; nothing appended`); await pool.close(); return; }
  await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${INFO.replace(/'/g, "''")}' WHERE id = ${row.id}`);
  const after = (await q(`SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id=${row.id}`))[0].n;
  console.log(`  ${CHECK} appended; TRD-RSK-14 (#${row.id}) is now ${after} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
