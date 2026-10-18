// scripts/record-2026-09-29-risk-dial-inert-again.js
//
// TRD-RSK-6 (#1457): "one trade size has five inputs and no single line states the resolved outcome". This
// supplies the resolved outcome for the live dials, and the answer is that the risk dial is INERT A SECOND TIME
// — at 0.07% the risk cap bound; at 5% the NOTIONAL cap binds, so a 71x dial change bought 6.4x of risk.
//
// Dry by default:  node scripts/record-2026-09-29-risk-dial-inert-again.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool, sql } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ID = 1457;                       // TRD-RSK-6 — the resolved-outcome row
const CROSS = 1271;                    // TRD-30, CLOSED with the same conclusion
const MARK = '##2026-09-29 risk-dial-inert-again##';
const CROSS_MARK = '##2026-09-29 rsk6-resolved-outcome##';
const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };
const f = (v, d = 4) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(d));

const NOTE = `

${MARK}
★★★ THE RESOLVED OUTCOME, MEASURED — AND THE RISK DIAL IS INERT A SECOND TIME, FOR A DIFFERENT REASON.

This row's whole subject is that one size has five inputs and nothing states which one won. Here is which one won.

★ THE DIALS NOW LIVE (userId 1):
    riskPerTradePct 5   maxRiskPerTradePct 5   maxEquityPerPositionPct 80   exposureCapPct 100
    maxPositions 10     maxNewTradesPerDay 20   dailyLossHaltPct 3
    atrStopMultiple 2   maxAdversePct 1.5       takeProfitOffsetPct 5        takeProfitAnchor 'declared'
★ AND THE CHANGE IS ATTRIBUTABLE, WHICH IS THE FIRST TIME THAT HAS BEEN TRUE. The settings journal added under
TRD-RSK-8 (#1462) caught both writes:
    event 116764  2026-09-28T19:36:38Z  risk.maxRiskPerTradePct  0.07 -> 5
    event 116767  2026-09-28T19:36:54Z  risk.riskPerTradePct     2.5  -> 5
The owner's own observation was correct and is confirmed: 2.5% was INERT because the 0.07% cap was smaller and both
divide the SAME stop distance, so the realised risk was 0.07%. Sixteen seconds later the cap was moved to match.

★★★ AND AT 5% THE DIAL IS INERT AGAIN — THE NOTIONAL CAP IS NOW THE BINDING ONE. Arithmetic, live:
    equity S$4,147.60 · Gold 4,129.13 · declared stop 0.664% of price (Trades #1123) = 27.40
      size allowed by riskPerTradePct 5%          : 7.5693   <- what the dial asks for
      size allowed by maxEquityPerPositionPct 80% : **0.8036**  <- BINDING
      size allowed by exposureCapPct 100%         : 1.0045
    => the position is 0.8036 oz, i.e. a realised risk of **0.5308% of equity, not 5%**.
⇒ **A 71x change of the dial bought 7.6x of realised risk** (0.07% -> ~0.53%), and the dial now overstates by 9x.
The general form, which is the single line this row was missing:
    realisedRiskPct  ~=  min( riskPerTradePct , maxEquityPerPositionPct x stopPct/100 , ... )
i.e. a notional cap expressed as a % OF EQUITY places a ceiling of (notionalCap% x stop%) on the risk per trade.
With an 80% notional cap and a 0.664% stop the ceiling is 0.53% — so **no risk dial above 0.53% can act at all.**

★★ AND THE VENUE'S OWN LEVERAGE PUTS A HARD CEILING UNDER ALL OF IT: **max risk per trade = leverage x stop%**.
Gold is 1:5, so the most margin the account can post caps the notional at 5x equity, and at a 0.664% stop the
largest risk expressible is 5 x 0.664% = **3.318%**. **The dial's 5% is UNREACHABLE on Gold at this stop, even with
every dollar of margin committed.** To risk 5% at 1:5 you need a stop of about 1.0% — the stop has to widen, or the
leverage has to rise. This is the arithmetic answer to "should we use that leverage": it is ALREADY in use (the two
open positions are $830.64 of notional against about S$210 of margin, i.e. the full 1:5), and leverage does not
create risk capacity out of nothing — it multiplies the notional a given stop width can be applied to.

⚠⚠ AND ONE INTERACTION TO SETTLE BEFORE ANY HIGHER-RISK EXPERIMENT: **dailyLossHaltPct is 3 and riskPerTradePct is
5.** At the DIAL's value a single stop-out would be SIX POINTS worse than the daily halt, so the halt would fire on
the first loss of the day and block every subsequent entry — the desk would take ONE trade a day and stop. Today
that is not live, because the notional cap holds the realised risk at 0.53% and one stop-out costs 0.53%.
means the two dials are inconsistent with each other, and raising the notional cap without raising
\`dailyLossHaltPct\` converts the desk from "risks 5%" to "risks 5% once, then stops".

★ WHAT I DID NOT DO: I changed no setting. The owner has flagged an intention to experiment with higher risk, and
the arithmetic above is what the experiment should be run against, not a reason to pre-empt it.
⚠ AND THE HONEST LIMIT OF THAT EXPERIMENT: today's geometry work (TRD-TP-1 #1412) found **no identifiable edge** in
this sample — every confidence interval spanned zero and no cell won a majority of resamples. Risk sizing SCALES an
expectancy; it cannot create one. Raising risk therefore amplifies variance first and return only if an edge exists.

τ MEASURED WITH: \`temp/probe-risk-dials.js\` (dials, positions, the binding arithmetic) and the settings journal
(\`kind='settings_write'\`).`;

const CROSS_NOTE = `

${CROSS_MARK}
★ CROSS-NOTE FROM TRD-RSK-6 (#1457): THIS ROW'S CLOSED CONCLUSION STILL HOLDS, AND IT HAS NOW BEEN REPRODUCED.
TRD-30 concluded "the notional cap is the real risk control, not riskPerTradePct". On 2026-09-29 the risk dial was
raised from 0.07% to 5% (settings-journal events 116764/116767) and the notional cap took over as the binding input
exactly as this row says: the dial asks for 7.57 oz of Gold and 0.8036 is what the 80% cap allows, so the realised
risk is 0.53%, not 5%. **A closed row is not evidence its defect is gone (TRD-87 #1338)** — this one is a live
behaviour that came back the moment the dial moved, and the arithmetic ceiling is
\`realisedRiskPct ~= min(riskPerTradePct, notionalCapPct x stopPct/100)\`.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the rows ===');
  const row = (await q(`SELECT state, CAST(info AS nvarchar(max)) AS info FROM Tasks WHERE id = ${ID}`))[0];
  if (!row) await fail(`#${ID} does not exist`);
  if (row.info.includes(MARK)) { console.log(`  #${ID} marker present - nothing to do.`); await pool.close(); return; }
  console.log(`  \u2714 #${ID} state=${row.state} ${row.info.length} chars`);
  const cross = (await q(`SELECT state, CAST(info AS nvarchar(max)) AS info FROM Tasks WHERE id = ${CROSS}`))[0];
  if (!cross) await fail(`#${CROSS} (TRD-30) is missing`);
  if (!/notional cap is the real risk control/i.test(String((await q(`SELECT name FROM Tasks WHERE id = ${CROSS}`))[0].name)))
    await fail(`#${CROSS} does not carry the notional-cap finding — the cross-note would have no target`);
  console.log(`  \u2714 #${CROSS} state=${cross.state} owns the notional-cap conclusion`);

  console.log('\n=== 2. the dials, and the journalled change that set them ===');
  const st = J((await q(`SELECT settings FROM TradingSettings WHERE userId = 1`))[0].settings);
  const r = st.risk || {};
  console.log(`  riskPerTradePct=${r.riskPerTradePct} maxRiskPerTradePct=${r.maxRiskPerTradePct} ` +
    `maxEquityPerPositionPct=${r.maxEquityPerPositionPct} exposureCapPct=${r.exposureCapPct} dailyLossHaltPct=${r.dailyLossHaltPct}`);
  if (!(Number(r.riskPerTradePct) > 0)) await fail('riskPerTradePct is not positive — the premise is gone');
  const j = await q(`SELECT id, createdAt, payload FROM TradingEvents WHERE kind='settings_write'
      AND CAST(payload AS nvarchar(max)) LIKE '%maxRiskPerTradePct%' ORDER BY id DESC`);
  if (!j.length) await fail('the journal has no record of the maxRiskPerTradePct write — the attribution claim is unfounded');
  for (const e of j.slice(0, 2)) {
    const p = J(e.payload);
    console.log(`  journal #${e.id} ${e.createdAt.toISOString()} ${JSON.stringify(p.changes)}`);
  }
  console.log('  \u2714 the change is attributable to a journalled write');

  console.log('\n=== 3. THE RESOLVED OUTCOME: which input binds, re-derived ===');
  const eq = Number((await q(`SELECT TOP 1 equity FROM EquityTicks WHERE userId = 1 ORDER BY id DESC`))[0].equity);
  const tick = await require('../trading/store/ticks').latestTick(1, 'Gold', 'plus500');
  const px = tick ? require('../trading/store/ticks').midOf(tick) : null;
  if (!(px > 0)) await fail('no usable Gold tick — the binding arithmetic cannot be re-derived');
  // The declared stop width, taken from a RECORDED ticket rather than assumed.
  const t = (await q(`SELECT TOP 1 id, openPrice, stopPrice FROM Trades WHERE userId = 1 AND symbol = 'Gold'
      AND status = 'open' AND stopPrice IS NOT NULL ORDER BY id DESC`))[0];
  if (!t) await fail('no open Gold ticket with a stop — the stop width would have to be assumed');
  const stopPct = (Math.abs(Number(t.openPrice) - Number(t.stopPrice)) / Number(t.openPrice)) * 100;
  const stopDist = px * stopPct / 100;
  const byRisk = (eq * (Number(r.riskPerTradePct) / 100)) / stopDist;
  const byNotional = (eq * (Number(r.maxEquityPerPositionPct) / 100)) / px;
  const byExposure = (eq * (Number(r.exposureCapPct) / 100)) / px;
  const binding = Math.min(...[byRisk, byNotional, byExposure].filter((x) => Number.isFinite(x) && x > 0));
  const realised = (binding * stopDist / eq) * 100;
  console.log(`  equity ${f(eq, 2)}  Gold ${f(px, 2)}  declared stop ${f(stopPct, 3)}% (from Trades #${t.id}) = ${f(stopDist, 4)} price`);
  console.log(`  by riskPerTradePct ${r.riskPerTradePct}%: ${f(byRisk, 4)}   by maxEquityPerPositionPct ${r.maxEquityPerPositionPct}%: ${f(byNotional, 4)}   by exposureCapPct ${r.exposureCapPct}%: ${f(byExposure, 4)}`);
  console.log(`  -> binding ${f(binding, 4)} => realised risk ${f(realised, 4)}% of equity (the dial says ${r.riskPerTradePct}%)`);
  if (!(realised < Number(r.riskPerTradePct) * 0.5))
    await fail(`the realised risk ${f(realised, 4)}% is not far below the dial ${r.riskPerTradePct}% — "the dial is inert" would be wrong`);
  console.log('  \u2714 the notional cap binds, so the dial overstates the risk actually taken');
  // And the leverage ceiling, which is what makes the dial unreachable rather than merely idle.
  const leverage = 5; // Gold, 1:5 — registry initialMarginPct 20
  const leverageCeiling = leverage * stopPct;
  console.log(`  venue ceiling at ${leverage}:1 with a ${f(stopPct, 3)}% stop = max risk ${f(leverageCeiling, 3)}% per trade`);
  if (!(leverageCeiling < Number(r.riskPerTradePct)))
    await fail(`the leverage ceiling ${f(leverageCeiling, 3)}% is not below the dial ${r.riskPerTradePct}% — the "unreachable" claim is wrong`);
  console.log('  \u2714 the dial is unreachable even at full margin');

  console.log('\n=== 4. the halt interaction ===');
  console.log(`  dailyLossHaltPct=${r.dailyLossHaltPct}  riskPerTradePct=${r.riskPerTradePct}`);
  if (!(Number(r.riskPerTradePct) > Number(r.dailyLossHaltPct)))
    await fail(`riskPerTradePct ${r.riskPerTradePct} is not above dailyLossHaltPct ${r.dailyLossHaltPct} — the warning inverts`);
  console.log(`  \u2714 one full-risk stop-out (${r.riskPerTradePct}%) would exceed the ${r.dailyLossHaltPct}% daily halt`);

  console.log('\n=== 5. the record ===');
  console.log(`  #${ID} info ${row.info.length} -> ${row.info.length + NOTE.length}   cross-note -> #${CROSS}`);
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }
  await pool.request().input('t', sql.NVarChar(sql.MAX), NOTE)
    .query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  await pool.request().input('t', sql.NVarChar(sql.MAX), CROSS_NOTE)
    .query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${CROSS}`);
  for (const id of [ID, CROSS]) {
    const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${id}`))[0];
    console.log(`  \u2714 #${id} appended -> ${b.len} chars`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
