// scripts/record-2026-09-29-pp-autonomous.js
//
// Records the AUTONOMOUS PASS on TRD-RSK-10 (#1467): the six open decisions, the defaults taken, the ceiling
// measurement, and the fact that the report CANNOT be completed.
//
// The load-bearing gate is #3: it proves L2 DID NOT SHIP. A record that says "nothing risk-bearing changed" has to
// demonstrate it from the live settings, not assert it.
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
const MARKER = '##2026-09-29 OWNER UNAVAILABLE AUTONOMOUS PASS##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const ADDENDUM = `
${MARKER} SIX QUESTIONS PUT TO THE OWNER; OWNER UNAVAILABLE; DEFAULTS TAKEN THAT MOVE NO RISK.##

${STAR} THE SITUATION. Six questions were needed to close L2 and L5: Q7 (the venue's behaviour at the margin
limit), the L5 halt form, the live-vs-printed ceiling precondition, the day-boundary anchor, when to deploy, and Q4
(chair visibility). The owner was unavailable and instructed me to proceed autonomously under the standing rule:
**take only paths that strictly reduce risk or leave it unchanged.** So the default taken for every question is the
one that changes NO risk posture, and the question that IS a risk posture is left open rather than guessed.

${STAR} WHAT WAS REFUSED, and why it is the right refusal:
  ${ARROW} **Q7 ${EM} NOT MEASURED, AND L2 NOT SHIPPED.** Measuring the venue at the margin limit means submitting an
    oversized order on the demo account to see a refusal, a reduction or an accept-then-call. That is a spend/risk
    action, so it is refused unilaterally. **L2 stays gated and unshipped**, which is also what the report already
    required before this pass.
  ${ARROW} **L5's halt form ${EM} NOT RESOLVED, NOTHING CHANGED.** The report specifies 'halt = k x P' (k in 1..3)
    while Q6 answered a flat 6.0%. Choosing 'k' is a risk posture, and the halt belongs to the package that raises
    the caps, so it ships WITH L2 regardless. **The conflict is recorded, not resolved** ${EM} two live
    specifications are better than one invented number.
  ${ARROW} **Day anchor ${EM} UNCHANGED** ('utc_midnight'). Switching makes the halt stricter for 21h and looser for
    the 3h after the venue's close: a risk posture.
  ${ARROW} **Q4 chair visibility ${EM} UNCHANGED.** Adding capacity to the prompt invites the model to reason about
    it, which is not a neutral change.

${STAR} WHAT WAS DONE:
  ${ARROW} **THE CEILING PRECONDITION IS NOW MEASURED** ${EM} read-only, and it has an answer. The live stop is
    derivable as 'ceilingPct / L', so the live column compares directly against ${SEC}6.1:
      Arabica Coffee  printed stop 0.935% -> live 0.462%  (0.494x)   printed ceiling 4.67% -> live 2.3101% (0.495x)  n=3
      Sugar           printed stop 0.608% -> live 0.550%  (0.905x)   printed ceiling 3.04% -> live 2.7510% (0.905x)  n=3
      SGX             printed stop 1.497% -> live 1.499%  (1.001x)   printed ceiling 14.97% -> live 14.9866% (1.001x) n=2
    ${ARROW} **Coffee's live ceiling is HALF the printed column and Sugar's is 10% below, while SGX matches to four
    figures.** ${SEC}6.1's stops are BACKTEST CONSTANTS; the live stop is 'max(2xATR, 3xspread)' clamped by
    'maxAdversePct', so where a spread or cost floor binds the printed ceiling OVERSTATES the capacity the desk has
    at that moment ${EM} by 2.02x on Coffee. **Sugar and Coffee agreeing with themselves across three wakes each is
    the useful part: the ratio is a property of the SYMBOL, not of one wake.** ${WARN} Only **3 of 7** symbols are
    observable in the L4 era, and three wakes per symbol is still not a distribution.
  ${ARROW} **RESTARTED at 2026-09-29T06:36:42Z (pid 44620, healthz ok)**, deploying L5 plus the two reporting fixes.
    It changes no risk setting: L5's default reproduces the existing behaviour exactly, and the other two alter what
    the desk SAYS, never what it sizes. Book was FLAT; a wake was in flight and the restart waited for it.

${WARN}${WARN} **CONSEQUENCE FOR L2, AS A PRECONDITION: THE CAPS MUST NOT BE SIZED AGAINST ${SEC}6.1's PRINTED
COLUMN.** Raising 'maxEquityPerPositionPct' against Coffee's printed 4.67% would calibrate a cap on capacity the
desk does not have ${EM} the live figure is **2.31%**. ${SEC}6.1 must be re-derived from live stops before any cap
in the L2 package moves, and four symbols remain unmeasured.

${STAR} AND ONE CROSS-CHECK THAT IS THE ONLY REASON TO TRUST THE REST: TRD-RSK-11's stated consequence was "35
decisions carry a seat-facing claim that a cap bound when it did not." Counted independently here over the
'TradingEvents' sizing window: **410 sized entries, 35 dishonest** ${EM} **the figure reproduces exactly.** (The same
count over 'TradingPrompts' wake payloads gives 533 sized and 70 dishonest; that is a different population, not a
contradiction.)

${WARN} **POST-RESTART STATE, VERIFIED RATHER THAN ASSUMED.** 12 events after the restart and the desk running
normally, but **ZERO sized decisions so far** ${EM} so TRD-RSK-11's fix is **LOADED BUT UNPROVEN at the field**; the
next sized decision is what proves it, and it should carry 'cappedAtPct: null' whenever the portfolio budget is what
bound. L5's observable is the anchor on a 'day_start' row, and 'day_start' fires ~once a day (~00:09Z) ${EM} the
newest rows predate L5 entirely, so **L5 is likewise deployed but unverified until the next day boundary.**
TRD-TUN-1's guard **cannot be verified live at all**, because retention removed every 'tune' event that could
trigger it.

${ARROW}${ARROW} **STATUS OF THIS REPORT: IT CANNOT BE MARKED COMPLETED.** L1 LANDED ${EM} L3 LANDED and guarded
${EM} L4 LANDED ${EM} **L5 LANDED except the one value that ships with L2** ${EM} **L2 NOT STARTED AND BLOCKED ON
Q7.** Two questions are answered in the negative sense (nothing changed), one is measured, and **three remain open
decisions that are not mine to make.** The blocker is not effort: the only remaining routes to finishing L2 are the
owner's answer about the venue, or a decision to probe the venue with real order flow on the demo account.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('=== autonomous pass — recording gates ===\n');

  console.log('1. the report');
  const doc = read(DOC);
  const i9 = doc.indexOf('### 13.9 '), i10 = doc.indexOf('### 13.10 ');
  if (i10 < 0) await fail('the report is missing 13.10');
  if (i10 < i9) await fail('13.10 must come after 13.9');
  if (!/CANNOT BE MARKED COMPLETED/.test(doc)) await fail('the report must state plainly that it cannot be completed');
  console.log(`  ${CHECK} 13.10 present, in order, and states the report cannot be completed`);

  console.log('\n2. the ceiling measurement REPRODUCES (a recorded number must survive a re-measure)');
  const rowsP = await q(`SELECT id, decision FROM TradingPrompts WHERE decision IS NOT NULL ORDER BY id DESC`);
  const per = {};
  for (const r of rowsP) {
    let d; try { d = JSON.parse(r.decision); } catch { continue; }
    for (const e of (Array.isArray(d.decisions) ? d.decisions : [])) {
      const sc = e && e.sizeCalc;
      if (!sc || sc.ceilingPct == null || !sc.venueFloor || !sc.venueFloor.leverage) continue;
      (per[e.symbol] = per[e.symbol] || []).push(sc.ceilingPct / Number(sc.venueFloor.leverage));
    }
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const PRINTED_STOP = { 'Arabica Coffee': 0.935, Sugar: 0.608, SGX: 1.497 };
  const want = { 'Arabica Coffee': 0.494, Sugar: 0.905, SGX: 1.001 };
  for (const [sym, pStop] of Object.entries(PRINTED_STOP)) {
    if (!per[sym]) await fail(`no live rows for ${sym} — the measurement cannot be reproduced`);
    const ratio = mean(per[sym]) / pStop;
    if (Math.abs(ratio - want[sym]) > 0.02) await fail(`${sym} ratio measured ${ratio.toFixed(3)}, block claims ${want[sym]}`);
    console.log(`  ${CHECK} ${sym}: live/printed stop = ${ratio.toFixed(3)} (n=${per[sym].length})`);
  }

  console.log('\n3. L2 DID NOT SHIP — proven from the live settings, not asserted');
  const st = await store.getSettings(1);
  const risk = st.risk || {};
  const caps = {
    maxEquityPerPositionPct: risk.maxEquityPerPositionPct,
    exposureCapPct: risk.exposureCapPct,
    dailyLossHaltPct: risk.dailyLossHaltPct,
    maxMarginUtilisationPct: risk.maxMarginUtilisationPct,
  };
  console.log(`  live risk settings: ${JSON.stringify(caps)}`);
  if (Number(risk.maxEquityPerPositionPct) === 500) await fail('maxEquityPerPositionPct is 500 — L2 SHIPPED, the block is wrong');
  if (Number(risk.exposureCapPct) === 500) await fail('exposureCapPct is 500 — L2 SHIPPED, the block is wrong');
  if (Number(risk.maxMarginUtilisationPct) !== 80) await fail(`maxMarginUtilisationPct is ${risk.maxMarginUtilisationPct}, not 80 — L3's arming changed`);
  console.log(`  ${CHECK} the L2 cap package (500/500) is NOT in the live settings; L3's 80% guard is armed`);

  console.log('\n4. the row and its marker');
  const t = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!t) await fail(`row ${TASK_ID} does not exist`);
  const n = (t.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(t.info || '').length} chars, this marker ${n}x`);

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

  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(after.info || '').includes('IT CANNOT BE MARKED COMPLETED')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
