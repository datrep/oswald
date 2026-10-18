// scripts/record-2026-09-28-rr-is-not-a-parameter.js
//
// TRD-TP-1 (#1412) already owns "capping the stop silently moved the target from 1.5R to ~2.0R". This
// appends the QUANTIFIED consequence, measured on 2026-09-28, and the number that decides whether the
// structure is tunable at all: a COST-INCLUSIVE breakeven win rate.
//
// Dry by default:  node scripts/record-2026-09-28-rr-is-not-a-parameter.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool, sql } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ID = 1412;
const MARK = '##2026-09-28 rr-is-not-a-parameter##';
const SGT_START = '2026-09-27T16:00:00Z';
const J = (s) => { try { return s == null ? s : JSON.parse(s); } catch { return {}; } };

const NOTE = `

${MARK}
★★★ THE PAYOFF RATIO IS NOT A PARAMETER OF THIS SYSTEM. IT IS AN OUTPUT. MEASURED 2026-09-28.

This row already names the mechanism — "capping the stop silently moved the target from 1.5R to ~2.0R, and the
venue target was never part of the [geometry it was measured on]". What follows is the size of it on live tickets,
and it is larger and less stable than "1.5R to 2.0R" suggests.

★ THE TWO NUMBERS THE DESK ACTUALLY CHOOSES, and neither is a payoff ratio:
    (a) the TARGET  = 1.5 x the DECLARED stop distance, pulled in 5%  =>  1.425 x declared
    (b) the CAP     = a % of PRICE (maxAdversePct), which shortens the STOP ONLY
Their ratio IS the payoff ratio. So the desk controls R:R only by accident, through the ratio declared/effective —
a quantity that varies per SYMBOL (each has its own declared stop) and per SETTING (the cap). It is named nowhere.
\`risk.js\` records \`stopCap.cappedBy\` but nothing records an intended payoff ratio, because there isn't one.

★ MEASURED ON THE 10 FILLED TICKETS OF 2026-09-28 (decision joined on promptId AND symbol — see the trap note):
    id    symbol           decl%   eff%    realR:R   intended 1.425xdecl/eff
    #1096 Silver           0.829   0.300     2.906        3.937
    #1097 Gold             0.530   0.300     4.546        2.522
    #1099 Bitcoin          0.695   0.695     1.489        1.425
    #1106 SGX              1.497   1.497     1.053        1.425
    #1107 Gold             0.528   0.300     2.436        2.507
    #1108 Silver           0.976   0.300     3.883        4.635
    #1112 Gold             0.556   0.556     1.191        1.425
    #1113 Sugar            0.608   0.608     1.140        1.425
    #1116 Arabica Coffee   0.372   0.372     0.946        1.425
    #1117 Arabica Coffee   0.487   0.487     1.416        1.425
The INTENDED ratio takes essentially two values — 1.425 when the cap is inert, and 2.5-4.6 when it binds — and
that is the whole design. The REALISED ratio departs from the intended one by -34% to +80% (realised/intended
0.664 to 1.803), which is this row's original complaint quantified: the geometry that reaches the venue is not
the geometry that was computed. ⚠ I HAVE NOT SEPARATED THE CAUSES of that gap and am not asserting one: the named
candidate is the fill lag (F20 / TRD-ANC-1 #1405 — the desk re-anchors against the DECISION price while the
position opens at the venue's fill; that row is OPEN and records the re-anchor firing 0 times in 30 windows).
A separate, CLOSED row (TRD-GEO-1 #1407) covers a MEASUREMENT circularity on capped tickets and does not
explain this. ⚠ SO TUNING R:R WITHOUT ACCOUNTING FOR THE GAP IS TUNING A DIAL THAT DOES NOT HOLD — the
departure is the same size as the parameter under discussion.

★★★ THE NUMBER THAT SETTLES WHETHER THIS IS TUNABLE: THE COST-INCLUSIVE BREAKEVEN WIN RATE.
A win pays RR x R, a loss costs 1 x R, and the venue round trip is charged on EVERY trade. Being a fixed % of
PRICE it is worth c/r of R — so the tighter the stop, the more of the risk unit each trade costs.
    E = p x RR - (1 - p) x 1 - c/r = 0    =>    p = (1 + c/r) / (1 + RR)
    id    symbol           risk r%   cost c%   c/r     R:R    breakeven p   regime
    #1096 Silver           0.300    0.1936   0.645   2.906      42.1%     cap binds
    #1097 Gold             0.300    0.1194   0.398   4.546      25.2%     cap binds
    #1099 Bitcoin          0.695    0.2500   0.360   1.489      54.6%     cap inert
    #1106 SGX              1.497    0.6014   0.402   1.053      68.3%     cap inert
    #1107 Gold             0.300    0.1194   0.398   2.436      40.7%     cap binds
    #1108 Silver           0.300    0.1936   0.645   3.883      33.7%     cap binds
    #1112 Gold             0.556    0.1194   0.215   1.191      55.5%     cap inert
    #1113 Sugar            0.608    0.2634   0.433   1.140      67.0%     cap inert
    #1116 Arabica Coffee   0.372    0.1756   0.472   0.946      75.7%     cap inert
    #1117 Arabica Coffee   0.487    0.1756   0.361   1.416      56.3%     cap inert
    cap BINDS:  mean breakeven 35.4%
    cap INERT:  mean breakeven 62.9%
⚠⚠ AND THE DESK'S REALISED WIN RATE TODAY WAS 5/10 = 50%. **Under the settings live NOW the desk is BELOW its
own breakeven.** Today's profit (+24.46 realised) came from tickets opened while the cap still bound; the ones
opened after it went inert needed ~63% and the desk did not have it. That is this row's finding with a number on
it, and it is why the R:R question cannot be deferred as a tuning preference.

★ THE COST SHARE IS THE OTHER HALF OF THE TRADE-OFF, and it pulls the OPPOSITE way. c/r is 0.40-0.65 on the
capped tickets (the cap at 0.300% is 40-65% of R for the venue's round trip) versus 0.22-0.47 inert. A tighter
stop makes the payoff ratio better AND makes each trade cost more of the unit it risks. That is TRD-114's
measured tension, and it means there is an interior optimum on STOP WIDTH — not on R:R directly.

WHAT THE STRUCTURE COULD BE, stated as options rather than a pick:
  (a) TARGET ON THE DECLARED DISTANCE (today). R:R emergent. The risk dial and the payoff ratio are the same
      dial; turning one turns both. Nothing names the payoff ratio.
  (b) TARGET ON THE EFFECTIVE (RISK) DISTANCE — a named multiple of the stop the venue actually got. R:R becomes
      a real, stable parameter and the cap reverts to a pure risk-size dial. ⚠ On a capped ticket this moves the
      target far closer to the entry, so the cap stops inflating the payoff ratio and the whole outcome
      distribution changes.
  (c) NO CAP AS A GEOMETRY DIAL — choose stop width (ATR multiple) and target multiple on it, two independent
      named dials.

⚠⚠ AND THE REASON THIS CANNOT BE SETTLED FROM WHAT ALREADY EXISTS: \`temp/sweep-stop-cap.js\` KEEPS realising the
recorded P&L for any trade whose MAE is inside the candidate cap, so it holds THE TARGET FIXED while varying the
stop. Its "+18 to +20 from the cap" is therefore a measurement of the cap GIVEN TODAY'S EMERGENT GEOMETRY, and it
does not survive option (b) — moving the target changes every trade's outcome, not just the stopped ones. The two
dials are not independently tunable on the evidence that exists, and no replay in the repo varies them jointly.
A joint test needs the recorded price PATHS (the intra-bar order of the high and the low decides whether a trade
touched its stop or its target first); the MAE/MFE columns cannot answer it, and on one of today's ten rows the
MAE is sourced from the CLOSE rather than the path (TRD-117's circularity).

⚠ WHAT I DID NOT DO: I changed no setting and no geometry code. The choice between (a), (b) and (c) moves the
payoff ratio, the win rate required and the cost share together, and the evidence to prefer one does not exist yet.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };

  console.log('\n=== 1. the row exists and does not already carry this ===');
  const row = (await q(`SELECT state, name, CAST(info AS nvarchar(max)) AS info FROM Tasks WHERE id = ${ID}`))[0];
  if (!row) await fail(`#${ID} does not exist`);
  if (row.info.includes(MARK)) { console.log(`  #${ID} marker present - nothing to do.`); await pool.close(); return; }
  // The phrase lives in the NAME, not the info — checking only `info` refused the write, which is the gate
  // behaving correctly: it refused rather than appending to a row it had not confirmed owned the finding.
  if (!/capping the stop silently moved the target/i.test(String(row.name)))
    await fail(`#${ID}'s name does not carry the "target moved" finding - this note would have no target`);
  console.log(`  \u2714 #${ID} state=${row.state} ${row.info.length} chars, and its NAME owns the target finding`);

  console.log('\n=== 2. re-derive the geometry: is R:R an output? ===');
  const trades = await q(`SELECT id, symbol, direction, openPrice, stopPrice, takeProfitPrice, decisionId
      FROM Trades WHERE userId = 1 AND openAt >= '${SGT_START}' AND openPrice IS NOT NULL
        AND stopPrice IS NOT NULL AND takeProfitPrice IS NOT NULL ORDER BY openAt`);
  if (trades.length < 4) await fail(`only ${trades.length} filled tickets today - too few to claim a structure`);
  let resolved = 0, maxIntended = 0;
  const intendeds = [];
  for (const t of trades) {
    if (!t.decisionId) continue;
    const d = (await q(`SELECT TOP 1 payload FROM TradingEvents WHERE kind='decision'
        AND JSON_VALUE(payload,'$.promptId') = ${t.decisionId}
        AND JSON_VALUE(payload,'$.symbol') = '${String(t.symbol).replace(/'/g, "''")}'`))[0];
    if (!d) continue;
    const p = J(d.payload);
    if (!(Number(p.effectiveStopDistance) > 0)) continue;
    resolved++;
    const intended = (Number(p.stopDistance) / Number(p.effectiveStopDistance)) * 1.5 * 0.95;
    intendeds.push(intended);
    maxIntended = Math.max(maxIntended, intended);
  }
  if (resolved < 3) await fail(`only ${resolved} tickets resolved to a decision on BOTH promptId and symbol`);
  console.log(`  resolved ${resolved} tickets; intended R:R values ${intendeds.map((x) => x.toFixed(3)).join(', ')}`);
  if (maxIntended < 1.8) await fail(`max intended R:R is ${maxIntended.toFixed(3)} - the "cap inflates R:R" claim would be wrong`);
  const spread = new Set(intendeds.map((x) => x.toFixed(2)));
  console.log(`  \u2714 ${spread.size} distinct intended R:R values across ${resolved} tickets — it varies, and nothing names it`);

  console.log('\n=== 3. re-derive the cost-inclusive breakeven, and the two regimes ===');
  const costPctFor = (symbol) => {
    try {
      const bps = require('../trading/agent/venueComparability')
        .roundTripBpsFromCfg(require('../trading/agent/backtest').costCfgFor(symbol));
      return Number.isFinite(bps) ? bps / 100 : null;
    } catch { return null; }
  };
  const cap = { binds: [], inert: [] };
  for (const t of trades) {
    const d = (await q(`SELECT TOP 1 payload FROM TradingEvents WHERE kind='decision'
        AND JSON_VALUE(payload,'$.promptId') = ${t.decisionId}
        AND JSON_VALUE(payload,'$.symbol') = '${String(t.symbol).replace(/'/g, "''")}'`))[0];
    if (!d) continue;
    const p = J(d.payload);
    const px = Number(t.openPrice);
    const r = (Number(p.effectiveStopDistance) / px) * 100;
    const c = costPctFor(t.symbol);
    const rr = Math.abs(Number(t.takeProfitPrice) - px) / Math.abs(px - Number(t.stopPrice));
    if (!(r > 0) || c == null || !(rr > 0)) continue;
    const be = (1 + c / r) / (1 + rr);
    (p.stopCap && p.stopCap.cappedBy ? cap.binds : cap.inert).push(be);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  console.log(`  cap BINDS: n=${cap.binds.length} mean breakeven ${mean(cap.binds) == null ? 'n/a' : (mean(cap.binds) * 100).toFixed(1) + '%'}`);
  console.log(`  cap INERT: n=${cap.inert.length} mean breakeven ${mean(cap.inert) == null ? 'n/a' : (mean(cap.inert) * 100).toFixed(1) + '%'}`);
  if (!(cap.binds.length && cap.inert.length)) await fail('one of the two regimes is empty - the comparison would be vacuous');
  if (!(mean(cap.binds) < mean(cap.inert))) await fail('the capped regime does NOT need a lower win rate - the conclusion inverts');
  console.log('  \u2714 the capped regime needs a materially lower win rate than the inert one');

  console.log('\n=== 4. and the desk\'s realised win rate is BELOW the inert bar ===');
  const wr = (await q(`SELECT COUNT(*) AS n FROM Trades WHERE userId = 1 AND openAt >= '${SGT_START}' AND status='closed' AND openPrice IS NOT NULL`))[0].n;
  const wins = (await q(`SELECT COUNT(*) AS n FROM Trades WHERE userId = 1 AND openAt >= '${SGT_START}' AND status='closed' AND openPrice IS NOT NULL AND grossPnl > 0`))[0].n;
  console.log(`  realised win rate today: ${wins}/${wr} = ${((wins / wr) * 100).toFixed(0)}%`);
  if (!(wins / wr < mean(cap.inert))) await fail(`the realised win rate ${(wins / wr * 100).toFixed(0)}% is NOT below the inert bar - the claim would be wrong`);
  console.log(`  \u2714 ${(wins / wr * 100).toFixed(0)}% is below the inert regime's ${(mean(cap.inert) * 100).toFixed(1)}% — the desk is under its breakeven at the live setting`);

  console.log('\n=== 5. the record ===');
  console.log(`  #${ID} info ${row.info.length} -> ${row.info.length + NOTE.length}`);
  if (!YES) { console.log('\n  DRY RUN - not written.'); await pool.close(); return; }
  await pool.request().input('t', sql.NVarChar(sql.MAX), NOTE)
    .query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
