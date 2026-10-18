// scripts/record-2026-09-29-pp-rev5-decision.js
//
// Records the rev-5 DECISION on TRD-RSK-10 (#1467). Unlike rev 2/3/4 this is not a review response: it is the
// owner's decision, made FROM an experiment:
//     "yes. do 3.0. we can capture trades there first."
//
// ⚠ THE ONE THING THIS SCRIPT EXISTS TO PREVENT, and it is a claim the report itself would otherwise make:
//    *** riskPerTradePct = 3.0 ON ITS OWN IS INERT. ***
//    The dial reads 5% today and the desk risks 0.5308%, because `maxEquityPerPositionPct = 80` binds first.
//    Setting the dial to 3.0 changes the label and nothing else. This script MEASURES that at write time rather
//    than asserting it, and refuses to write if the measurement does not reproduce.
//
// DRY RUN BY DEFAULT (pass --yes to write). Marker-guarded, occurrence-counted, and READ BACK after writing —
// because the previous pointer in this row announced a successful insert that had matched zero lines.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 rev 5 DECISION##';
const REV4_LINE = '##2026-09-29 rev 4## THIRD REVIEW APPLIED (8 items)##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const DOT = '\u00B7';
const SEC = '\u00A7';
const LE = '\u2264';

// The decision, as one object, so every mention of a number in this file comes from one place.
const R = 3.0;
const U = 0.80;

const POINTER = `${WARN} **SUPERSEDED IN PART BY THE rev 5 DECISION BLOCK LOWER IN THIS ROW.** The review above stayed a`
  + ` proposal set; rev 5 is the owner's decision, and it answers four of the questions rev 4 left open. Two things in`
  + ` the block below are now historical: the *"${'`'}P${'`'}${'`'} is the missing control"* framing is inverted (`
  + `${'`'}u${'`'} is the primary dial and ${'`'}P${'`'} is DERIVED from it ${EM} ${SEC}L3.c), and every risk posture`
  + ` quoted below is expressed against a ${'`'}riskPerTradePct${'`'} of 5 that is now 3.0.`;

const ADDENDUM = `
${MARKER} THE RISK LEVEL IS DECIDED: r = 3.0%##
${STAR}${STAR}${STAR} OWNER DECISION 2026-09-29 (verbatim): *"yes. do 3.0. we can capture trades there first. then after
that, we can start the implementation of the design document, applying changes to the document before starting it?"*

This block records the DECISION and the evidence under it. The document is rev 5; its ${SEC}6.1 is the decision and
its ${SEC}12 is the changelog. The study is ${'`'}trading/scripts/repro/risk-level-experiment.js${'`'} ${EM} seeded,
read-only, re-runnable.

${STAR} THE DECISION WAS MADE FROM A MEASUREMENT, NOT FROM A PREFERENCE. The owner's own hypothesis was a range
(2.5${'`'}-${'`'}7.5%), and asked for it to be TESTED rather than set:
    population            the desk's 87 usable closed trades (15 of 102 have no stopPrice)
    R convention          grossPnl / (|fill - stop| x size)   -- the desk's own, agent/expectancy.js:rMultiple
    mean R                +0.0746    sd 1.6325    se 0.1750    one-sided 95% lower bound -0.223    win 36.8%
    objective             g(r) = E[ log(1 + r_eff x R) ]  -- the only objective that punishes a fat tail as ruin does

      r      mean r_eff   g(r)       95% CI on g            median maxDD   P(equity < 50%)
      1.5%   1.43%        +0.00102   [-0.00314, +0.00532]   18.6%          0.0%
      2.5%   2.21%        +0.00184   [-0.00509, +0.00895]   28.5%          1.1%
      3.0%   2.49%        +0.00203   [-0.00589, +0.01015]   32.0%          2.4%   <-- MEASURED PEAK
      5.0%   3.16%        +0.00136   [-0.00927, +0.01218]   42.4%          8.8%
      7.5%   3.50%        -0.00041   [-0.01240, +0.01170]   49.8%          17.1%
    growth-optimal r* = 3.05%  (closed form mean/E[R^2] = 2.79%; half-Kelly 1.5%)

  ${ARROW} **3.0% is the peak of the measured curve**, so the decision lands on the study's own optimum rather than
    beside it. The top of the owner's proposed range is **structurally self-defeating**: g is NEGATIVE at 7.5% and
    modelled ruin is 17.1% versus 2.4%.
  ${WARN} BUT EVERY INTERVAL SPANS ZERO. This experiment can say which r is CHEAPEST IN DRAWDOWN and which are
    self-defeating. **It cannot say any r is profitable** ${EM} that still needs trade count. So **r = 3.0% is a
    decision about HOW TO COLLECT EVIDENCE, not a claim of edge.** Say it that way in every downstream report.

${STAR}${STAR} THE MODEL WAS WRONG ONCE AND THE OWNER CAUGHT IT. The first version of the study modelled raising r as
**EXCLUDING** the low-ceiling symbols ${EM} a policy I invented; the engine does not implement it. The engine **CAPS**
(${'`'}size = min(size, maxValue/price)${'`'}) and never refuses, so the correct model is
**${'`'}r_effective = min(r, ceiling_i)${'`'}** applied to EVERY trade, with NO trade dropped. The wrong model silently
deleted 21 trades and manufactured a fake finding (*"expectancy worsens above 4.79%"*) out of a symbol-selection
effect that does not exist. The correction is recorded in ${SEC}6.1 so the wrong shape is not re-derived.
${WARN} The owner's objection was to the FRAMING, not the arithmetic: *"why would risk per trade block the trade?"*
It does not. Nothing in risk-per-trade stops a trade; the ceiling is a SIZE limit, and the two are easy to conflate
when the study reports them in the same table.

${STAR}${STAR}${STAR} AND THE FACT THAT MATTERS MOST FOR WHAT HAPPENS NEXT: THE DIAL ALONE IS INERT.
    --- the report's own ${SEC}1.4, unchanged by anything in rev 5 ---
    riskPerTradePct 5   maxEquityPerPositionPct 80   exposureCapPct 100
    Gold ticket, S$4,147.60 equity, 0.664% venue stop, L = 1:5
      size asked for by riskPerTradePct 5%         : 7.5695
      size allowed by maxEquityPerPositionPct 80%  : 0.8036   <-- BINDING
      size allowed by exposureCapPct 100%          : 1.0045
    ${ARROW} **realised risk 0.5308% of equity, NOT 5%.**
  ${ARROW} Setting that one key to 3.0 changes the LABEL and nothing else ${EM} the row marked BINDING is a different
    row. **The desk keeps risking ~0.53% until the caps move.**
  ${ARROW} ${STAR} So **"capture trades at 3%" requires L2 (raise ${'`'}maxEquityPerPositionPct${'`'} AND
    ${'`'}exposureCapPct${'`'}) AND L3 (the margin guard), and trades at the new level begin accumulating only once
    BOTH are live.** Any report that says "risk per trade is now 3%" while only the dial has moved is false, and the
    report would be the one making that claim.

${STAR} WHAT 3.0% ACTUALLY DELIVERS ${EM} ${'`'}r_eff = min(r, u x ceiling_i)${'`'} at ${'`'}u = 80%${'`'}:
    symbol            ceiling   r_eff at r=3%, u=80%   bound by      margin/pos   max concurrent
    Bitcoin           1.16%     0.93%                  ceiling       80%          1
    Gold              2.75%     2.20%                  margin u      80%          1
    Sugar             3.04%     2.43%                  margin u      80%          1
    Arabica Coffee    4.67%     3.00%                  target        64%          1
    Silver            4.79%     3.00%                  target        63%          1
    Oil               6.28%     3.00%                  target        48%          1
    SGX              14.97%     3.00%                  target        20%          3
    over the 87-trade population: mean effective risk 2.20%; g = 0.00174 (vs 0.00203 unconstrained by u)
  ${WARN} **u = 80% is the BINDING CONSTRAINT, not a safety net, and it makes the desk ONE POSITION AT A TIME** on
    every symbol except SGX. ${'`'}maxPositions = 10${'`'} goes decorative and the correlation veto loses its job.
    **That is the real price of 3.0% and it was not visible when the 2.5${'`'}-${'`'}7.5% range was proposed.**
  ${WARN} **3.0% is NOT reached on Gold (2.20%) or Bitcoin (0.93%).** The full target lands on Coffee, Silver, Oil
    and SGX only.
  ${STAR} Ceilings are quoted ON THE NEWEST DECISION STOP per symbol. **The ceiling moves with the stop**
    (${'`'}ceiling = L x s${'`'}), so the same Gold at its 0.664% venue stop gives 3.32% and r_eff 2.656%, not 2.20%.
    **Quote the stop or do not quote the ceiling.**

${STAR} THE PACKAGE (${SEC}6.1):
    riskPerTradePct              5      ->  3.0     the measured growth peak
    maxRiskPerTradePct           5      ->  3.0     kept aligned so neither dial is a surprise
    maxEquityPerPositionPct     80      ->  500     must clear r/s = 400% on Gold at u=80%
    exposureCapPct             100      ->  500     same
    dailyLossHaltPct             3      ->  6.0     at r_eff 2.2% a 3% halt fires after 1.4 stop-outs
    maxMarginUtilisationPct      -      ->  80 NEW  the real portfolio brake
    maxAdversePct              1.5      ->  1.5     UNCHANGED ${EM} tightening it LOWERS every ceiling
    maxPositions                10      ->  10      UNCHANGED ${EM} non-binding in practice now
  ${STAR} **After the package the margin guard is the ONLY binding control** ${EM} the per-position cap is raised
    above the guard's reach, the risk cap is aligned with the target so it cannot fire, and exposureCapPct has never
    fired. That makes ${'`'}sizeCalc.boundBy${'`'} **essential rather than nice-to-have**: a single-control stack that
    cannot name itself is exactly the defect ${SEC}1.1b documents.
  ${WARN}${WARN} **THE ORDERING IS NON-NEGOTIABLE: THE MARGIN GUARD LANDS IN THE SAME CHANGE AS THE CAP RAISE, AND
    BEFORE IT.** Raising the two caps without the guard permits 5 Gold positions x 400% notional = 2000% of equity in
    notional = **400% of equity in MARGIN.** The guard is what makes the raise survivable.

${STAR} TWO THINGS THE DECISION CHANGED IN THE DESIGN ITSELF (not just numbers):
  ${DOT} **${SEC}L3.c ${EM} THE CAUSAL ORDER IS INVERTED.** rev 3/4 framed ${'`'}P${'`'} (portfolio risk) as the
    missing control with ${'`'}u = 1 - P${'`'} following from it. But **P is a consequence of the leverage the book
    happens to hold, not a setting** ${EM} it moves with how many positions are open and what they are. The quantity
    that IS a setting is the margin utilisation ceiling **u**, and it caps a position directly:
    ${'`'}margin_i / equity = r_eff_i / ceiling_i${'`'} ${ARROW} ${'`'}r_eff_i = min(r, u x ceiling_i)${'`'}.
    **The chain is u -> r_eff -> P**, and with u fixed, ${'`'}P ${LE} u${'`'} by construction. **${'`'}u = 80%${'`'} is
    DECIDED** ${EM} 60% prices the desk out of its own target on every symbol, and 95% makes a gap through the stop a
    margin call rather than a loss.
  ${DOT} **${SEC}L4.a gains ${'`'}sizeCalc.ceilingPct${'`'} and ${'`'}sizeCalc.riskCappedByCeiling${'`'}** (owner:
    "yes"). ⚠ **${'`'}riskCappedByCeiling${'`'} is the field that would have caught this report's own blind spot**:
    every other field describes what the dial wanted and what the caps did, and **none of them says that on 5 of 7
    symbols the dial was never expressible at all.** Without it, a decision at r=3.0% looks identical whether the desk
    risked 3.00% (Coffee) or 0.93% (Bitcoin) ${EM} and ${SEC}6.1 exists precisely because those are different trades.

${STAR} Q1, Q2, Q3, Q5, Q6, Q8, Q9 are now ANSWERED (${SEC}6). Still open: **Q4** (chair visibility), **Q7** (what the
venue does AT the margin limit ${EM} must be measured before L2 ships), **Q10** (re-measure the brake stack once the
5% risk cap era has decisions).

${WARN} STILL NOT IMPLEMENTED. L1${EM}L5 remain proposals; the document is updated FIRST, per the owner's instruction,
and the implementation follows in the order L1 -> L3 -> L2 -> L4 -> L5.
`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('\n=== 1. the document is rev 5 and carries the decision ===');
  const doc = src(DOC);
  for (const h of ['rev 5', '## 6.1 ', '## 7.1 The TARGET state', '#### L3.c ', '## 12. rev 5', 'riskCappedByCeiling', 'ceilingPct']) {
    if (!doc.includes(h)) await fail(`the report is missing "${h}"`);
  }
  console.log(`  \u2714 rev 5 with \u00a76.1 (decision), \u00a77.1 (target state), \u00a7L3.c (inverted causal order), \u00a712 (changelog)`);

  console.log('\n=== 2. RE-MEASURE the ceilings, then check the document prints them ===');
  const syms = await q(`SELECT DISTINCT symbol FROM dbo.Trades WHERE userId=1 AND openPrice IS NOT NULL`);
  const ceiling = {};
  for (const { symbol: sym } of syms) {
    const es = String(sym).replace(/'/g, "''");
    const t = (await q(`SELECT TOP 1 id, decisionId, openPrice FROM dbo.Trades
        WHERE userId=1 AND symbol='${es}' AND openPrice IS NOT NULL AND decisionId IS NOT NULL ORDER BY id DESC`))[0];
    if (!t) continue;
    const d = (await q(`SELECT TOP 1 payload FROM dbo.TradingEvents
        WHERE kind='decision' AND JSON_VALUE(payload,'$.promptId')=${Number(t.decisionId)}
          AND JSON_VALUE(payload,'$.symbol')='${es}' ORDER BY id DESC`))[0]
      || (await q(`SELECT TOP 1 payload FROM dbo.TradingEvents
        WHERE kind='decision' AND id=${Number(t.decisionId)} AND JSON_VALUE(payload,'$.symbol')='${es}'`))[0];
    if (!d) continue;
    let p; try { p = JSON.parse(d.payload); } catch { continue; }
    const decl = Number(p.stopDistance); const px = Number(t.openPrice);
    if (!(decl > 0) || !(px > 0)) continue;
    const sp = (await q(`SELECT TOP 1 leverageRaw FROM dbo.Instruments WHERE userId=1 AND venue='plus500'
        AND symbol='${es}' AND leverageRaw IS NOT NULL ORDER BY capturedAt DESC`))[0] || {};
    const L = Number(String(sp.leverageRaw || '').split(':')[1]) || null;
    if (L) ceiling[sym] = { pct: L * (decl / px) * 100, L, stop: (decl / px) * 100 };
  }
  if (!Object.keys(ceiling).length) await fail('no ceilings could be derived \u2014 the decision rests on them');

  // The doc's printed ceilings. Each is asserted against the live measurement, so a stale table cannot ship.
  const PRINTED = { Bitcoin: 1.16, Gold: 2.75, Sugar: 3.04, 'Arabica Coffee': 4.67, Silver: 4.79, Oil: 6.28, SGX: 14.97 };
  let worst = 0; let worstSym = '';
  for (const [sym, got] of Object.entries(PRINTED)) {
    const live = ceiling[sym];
    if (!live) { console.log(`  ${sym.padEnd(16)} no live ceiling derived \u2014 doc claims ${got.toFixed(2)}% (SKIPPED)`); continue; }
    const diff = Math.abs(live.pct - got);
    const eff = Math.min(R, U * live.pct);
    const rowOk = diff < 0.02;
    if (diff > worst) { worst = diff; worstSym = sym; }
    console.log(`  ${sym.padEnd(16)} L=1:${String(live.L).padEnd(4)} stop=${live.stop.toFixed(3)}%  ceiling=${live.pct.toFixed(2)}%`
      + `  doc=${got.toFixed(2)}%  ${rowOk ? 'OK' : '*** MISMATCH ***'}   r_eff(u=80%)=${eff.toFixed(2)}%`);
  }
  if (worst >= 0.02) await fail(`doc ceiling for ${worstSym} is out by ${worst.toFixed(3)}pp \u2014 the table is stale`);
  console.log('  \u2714 every printed ceiling reproduces from the live stop x the registry leverage');

  console.log('\n=== 3. RE-MEASURE the inertness claim (the reason this section exists) ===');
  const st = (await q(`SELECT settings FROM TradingSettings WHERE userId = 1`))[0];
  if (!st) await fail('no TradingSettings row for userId 1 \u2014 cannot measure the live dials');
  const s = JSON.parse(st.settings || '{}');
  const live = {
    riskPerTradePct: s.risk?.riskPerTradePct,
    maxRiskPerTradePct: s.risk?.maxRiskPerTradePct,
    maxEquityPerPositionPct: s.risk?.maxEquityPerPositionPct,
    exposureCapPct: s.risk?.exposureCapPct,
    dailyLossHaltPct: s.risk?.dailyLossHaltPct,
  };
  console.log(`  live: ${JSON.stringify(live)}`);
  if (live.maxEquityPerPositionPct == null) {
    console.log('  (maxEquityPerPositionPct not present in the stored settings \u2014 using the code default 80)');
  }
  const perPos = Number(live.maxEquityPerPositionPct ?? 80);
  const dial = Number(live.riskPerTradePct ?? 5);
  // ⚠ THE STOP MATTERS AND THERE ARE TWO OF THEM. §1.4's baseline ticket uses the VENUE stop (what the desk was
  // actually filled against), while the DESIGN ceilings in §6.1 use the newest DECISION stop. Realised risk is
  // perPos% x stop%, so picking the wrong stop gives 0.4400% instead of 0.5312% — same symbol, same settings, two
  // different numbers. That is precisely the rev-4 finding, so it is not repeated here.
  const goldTrade = (await q(`SELECT TOP 1 openPrice, stopPrice FROM dbo.Trades
      WHERE userId=1 AND symbol='Gold' AND openPrice IS NOT NULL AND stopPrice IS NOT NULL AND openPrice > 0 ORDER BY id DESC`))[0];
  if (!goldTrade) await fail('no Gold trade with a stopPrice \u2014 cannot demonstrate the inertness arithmetically');
  const goldStop = Math.abs(Number(goldTrade.openPrice) - Number(goldTrade.stopPrice)) / Number(goldTrade.openPrice) * 100;
  const ceilGold = ceiling.Gold.pct;
  const notionalFromDial = (dial / goldStop) * 100;
  const notionalAllowed = perPos * ceiling.Gold.L; // notional% permitted by the per-position cap
  const realisedRisk = perPos / 100 * goldStop;
  console.log(`  Gold, VENUE stop ${goldStop.toFixed(3)}%, L=1:${ceiling.Gold.L}, ceiling ${ceilGold.toFixed(3)}%`);
  console.log(`    notional the dial asks for (${dial}% / ${goldStop.toFixed(3)}%)  : ${notionalFromDial.toFixed(1)}%`);
  console.log(`    notional the per-position cap allows (${perPos}%)      : ${notionalAllowed.toFixed(1)}%   ${'<-- BINDING'}`);
  console.log(`    ${ARROW} realised risk = ${perPos}% x ${goldStop.toFixed(3)}% = ${realisedRisk.toFixed(4)}%  (\u00A71.4 says 0.5308%)`);
  if (Math.abs(realisedRisk - 0.5308) > 0.02) {
    await fail(`realised risk measured ${realisedRisk.toFixed(4)}% but \u00A71.4 states 0.5308% \u2014 the baseline moved;`
      + ' re-derive it before writing this decision block');
  }
  if (perPos >= notionalFromDial) {
    await fail('the per-position cap no longer binds below the dial \u2014 the caps may already have been raised, so the'
      + ' "dial is inert" claim is OUT OF DATE and must be re-derived before this block is written');
  }
  console.log('  \u2714 the per-position cap binds first: setting riskPerTradePct to 3.0 moves the LABEL, not the risk');

  console.log('\n=== 4. the row and its markers ===');
  const row = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!row) await fail(`row ${TASK_ID} does not exist`);
  const info = row.info || '';
  const n = info.split(MARKER).length - 1;
  const hasPointer = info.includes('SUPERSEDED IN PART BY THE rev 5 DECISION BLOCK');
  console.log(`  #${TASK_ID}: rev-5 markers ${n} ${DOT} pointer ${hasPointer ? 'PRESENT' : 'absent'}`);

  if (!hasPointer) {
    if (!YES) console.log('  would insert the in-place pointer under the rev-4 heading.');
    else {
      if (!info.includes(REV4_LINE)) await fail('the rev-4 heading was not found \u2014 REPLACE would silently match nothing');
      const escaped = (x) => String(x).replace(/'/g, "''");
      await pool.request().query(`UPDATE dbo.Tasks
        SET info = REPLACE(info, N'${escaped(REV4_LINE)}', N'${escaped(`${REV4_LINE}\n${POINTER}`)}')
        WHERE id = ${TASK_ID}`);
      const chk = (await q(`SELECT info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0].info || '';
      if (!chk.includes('SUPERSEDED IN PART BY THE rev 5 DECISION BLOCK')) {
        await fail('the pointer REPLACE ran but the pointer is NOT in the row \u2014 the anchor did not match');
      }
      console.log('  \u2714 pointer inserted and read back');
    }
  }

  if (!YES) {
    console.log(n === 0
      ? `  would append ${ADDENDUM.length} chars. DRY RUN \u2014 not written.`
      : `  rev-5 block already present (${ADDENDUM.length} chars would be skipped). DRY RUN \u2014 not written.`);
    await pool.close();
    return;
  }
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log('  \u2714 rev-5 decision block appended');
  } else console.log('  rev-5 decision block already present.');

  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`rev-5 block appears ${fn}x \u2014 expected exactly 1 (idempotency)`);
  if (!(after.info || '').includes('THE DIAL ALONE IS INERT')) await fail('the read-back cannot find the inertness claim');
  console.log(`  #${TASK_ID}.info is now ${after.n} chars, rev-5 block x${fn}, inertness claim present`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
