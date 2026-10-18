// scripts/record-2026-09-29-pp-L3L4-acceptance.js
//
// Records the L3 + L4 ACCEPTANCE READ (PASS) on TRD-RSK-10 (#1467).
//
// The block records three things, in order of how much they matter:
//   · L3 and L4 are CONFIRMED LIVE on a real decision — the guard armed and stood down, and the five truth fields
//     named which of four controls actually bound;
//   · that read FALSIFIED this document's own claim that 'exposureCapPct' has never bound (it bound on all three
//     sized tickets in one wake) — a window statistic that had been quoted forward as a standing fact;
//   · the read exposed a live-vs-printed CEILING discrepancy (Coffee 2.02x, Sugar 10%) which is left as a
//     measurement and is now a PRECONDITION ON L2, not a footnote to L4.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
// The strongest gate here RE-RUNS the acceptance read and refuses to write if it does not still return 0.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { execFileSync } = require('child_process');
const { getPool } = require('../shared/db');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TOOL = 'trading/scripts/repro/l3-l4-acceptance-read.js';
const CUTOFF = '2026-09-29T04:18:18Z';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 L3 L4 ACCEPTANCE PASS##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const ADDENDUM = `
${MARKER} L3 AND L4 ARE CONFIRMED LIVE, AND THE READ FALSIFIED ONE OF OUR OWN CLAIMS.##

${STAR} THE READ. '${TOOL} <cutoffIso>' is read-only and returns **0 = PASS, 3 = NOT YET AVAILABLE,
2 = FAIL**. It takes decisions written AFTER a caller-supplied cutoff, so a pre-restart row can never satisfy it,
and it asserts five things: a 'sizeCalc' exists, all five L4 fields are present,
'marginGuard.armed === true', 'boundBy' is in the four-control enum or null, and
'resolvedRiskPct > 0'. Against the **2026-09-29T04:18:18Z restart** it returned **PASS** on wake
**#5633** (04:28:19.320Z), which sized THREE symbols ${EM} Arabica Coffee, Sugar and SGX:

| symbol | riskDialPct | ceilingPct | riskCappedByCeiling | resolvedRiskPct | boundBy |
|---|---|---|---|---|---|
| Arabica Coffee | 5 | 2.3101 | true | 0.3696 | exposureCapPct |
| Sugar | 5 | 2.751 | true | 0.4401 | exposureCapPct |
| SGX | 5 | 14.9866 | false | 1.1987 | exposureCapPct |

${STAR} THE ROW THAT JUSTIFIES L4 BY ITSELF. **The dial says 5% of equity; Coffee's ticket risked 0.3696% ${EM} a
13.5x gap** ${EM} and the causes are now NAMEABLE from the payload (ceiling 2.3101, then exposureCapPct). Before
L4 that gap was invisible; the desk could only read the number it set, never the number it got.

${STAR} AND THE GUARD WAS ARMED **AND STOOD DOWN** ON ALL THREE, exactly as ${SEC}13.2 claims:
'armed: true, capPct: 80, capMargin: 3320.14, usedMargin: 166.13, usedPct: 4.0029' with
'fitted: false, full: false, unknown: false'. So L3's inertness is now **observed on a live decision**
rather than argued from a fixture, and its 4.0029% reproduces the live check's 4.00% independently.

${WARN}${WARN} **CORRECTION TO ${SEC}1.1b, FOUND BY THIS READ: 'exposureCapPct' HAS NOW BOUND.** All three
entries carry 'boundBy: exposureCapPct', with the reason "sized down to exposure budget: 20.0% open + 80.0%
wanted > 100% cap -> 80.0% position". So the measured **0 of 414 decisions was true of its WINDOW and is not a
property of the desk**, and L3.a's load-bearing line ${EM} "the brake stack is one control deep" ${EM} now has a
counter-example and must be restated as a RATE PER WINDOW. The historical figure is preserved in the report; the
three places that leaned on it as a standing fact are corrected in place. **This is ${SEC}1.1b's own failure mode one
level up: a window statistic quoted forward as a standing fact.**

${WARN} **AND A SECOND DISCREPANCY, LEFT AS A MEASUREMENT RATHER THAN A CONCLUSION.** ${SEC}6.1's ceiling table is
calibrated on per-symbol STOPS, and the checker re-derives those stops' ceilings self-consistently. The live
decisions disagree: **SGX matches to four figures** (live 14.9866 vs printed 14.97), **Sugar is 10% low**
(2.751 vs 3.04), **Arabica Coffee is 2.02x low** (2.3101 vs 4.68) ${EM} a live stop of 0.462% where ${SEC}6.1 uses
0.935%. The live stop is 'max(2xATR, 3x spread)' clamped by 'maxAdversePct', and SGX's own reason line shows
that branch firing ("stop widened to 3x spread (0.3360 > 2xATR 0.0536)"). So **the printed stop is a backtest
constant while the live stop is a per-wake function of the current spread**, and they part company where a spread
floor binds. **Direction matters for L2: Coffee's live ceiling is HALF the printed one, so a cap raised against
4.68% would be calibrated on capacity the desk does not have** ${EM} which is why this is now a **PRECONDITION ON
L2: measure per-symbol live-vs-printed ceilings across many wakes before raising any cap.** Three tickets from one
wake is not a distribution.

${WARN} **AND THE MONITOR ITSELF WAS WRONG TWICE, BOTH TIMES CAUGHT BY A REAL PAYLOAD, NOT BY REVIEW.** (1) The
first predicate was 'LIKE %sizeCalc%', which matched a decision that merely MENTIONED the string ${EM} the same
defect as the recorded 'LIKE % equity' ${EM} so it now requires the QUOTED JSON KEY. (2) **The field is NOT
top-level.** The wake payload's keys are 'action/reason/symbol/direction/llmCalled/decisions/executions', and the
per-symbol geometry lives INSIDE 'decisions[]', because **one wake writes one decision PER SYMBOL.** A top-level
lookup read a shape that does not exist, so this tool would have reported **"not available" FOREVER while sized
tickets sat in the table** ${EM} and a monitor that cannot pass is worse than no monitor, because it converts an
unknown into a false "still waiting". It now searches 'decisions[]', falls back to top-level, and PRINTS the
payload shape on a miss instead of failing bare.

${ARROW} STATUS: suite **1,746 tests / 1,745 pass / 0 fail / 1 skipped**; eslint exit 0 on every touched file; the
report carries ${SEC}13.8 and stands at 112,853 chars with fences even and its 8-glyph inventory unchanged.
${ARROW} NEXT: L2 stays GATED ON Q7 (what the venue actually does AT the margin limit), and is now ALSO gated on the
live-vs-printed ceiling measurement above. L5's 'halt = k x P' (rev 5 Q6 = 6.0) ships WITH L2.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('=== L3 + L4 ACCEPTANCE READ — recording gates ===\n');

  // 1. THE STRONGEST GATE: re-run the read and refuse unless it still PASSES. A record that claims a verification
  //    passed must RE-DERIVE that verification, or it is just prose about a memory of a terminal.
  console.log('1. re-run the acceptance read (this gate re-measures the claim)');
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, TOOL), CUTOFF], { encoding: 'utf8' });
  } catch (e) {
    await fail(`the acceptance read did not return 0 (exit ${e.status}) — the claim cannot be recorded\n${e.stdout || ''}${e.stderr || ''}`);
  }
  if (!out.includes('PASS')) await fail('the acceptance read returned 0 but printed no PASS');
  const armed = /armed=true capPct=80 usedPct=([\d.]+)/.exec(out);
  if (!armed) await fail('the read did not report an ARMED margin guard — L3 is the load-bearing half');
  const bound = /boundBy="([A-Za-z_]+)"/.exec(out);
  console.log(`  ${CHECK} PASS; guard armed, usedPct=${armed[1]}, boundBy=${bound ? bound[1] : 'null'}`);

  // 2. the three sized entries and their boundBy, read straight from the payload rather than from the tool.
  console.log('\n2. the payload itself (#5633)');
  const row = (await q(`SELECT decision FROM dbo.TradingPrompts WHERE id = 5633`))[0];
  if (!row) await fail('#5633 is gone — the evidence row must still exist to be cited');
  const d = JSON.parse(row.decision);
  const sized = (Array.isArray(d.decisions) ? d.decisions : []).filter((x) => x && x.sizeCalc);
  if (sized.length < 3) await fail(`expected 3 sized entries in #5633, found ${sized.length}`);
  for (const e of sized) {
    if (e.sizeCalc.marginGuard.armed !== true) await fail(`${e.symbol}: the guard is not armed`);
    if (!('boundBy' in e.sizeCalc)) await fail(`${e.symbol}: boundBy is missing (L4)`);
    if (!('resolvedRiskPct' in e.sizeCalc)) await fail(`${e.symbol}: resolvedRiskPct is missing (L4)`);
  }
  const exposureBound = sized.filter((e) => e.sizeCalc.boundBy === 'exposureCapPct').length;
  if (exposureBound !== 3) await fail(`the ${SEC}1.1b correction claims 3 of 3 bound by exposureCapPct; measured ${exposureBound}`);
  console.log(`  ${CHECK} ${sized.length} sized entries, guard armed on all, boundBy present; exposureCapPct bound ${exposureBound}/3`);

  // 3. the ceiling discrepancy must still be a discrepancy — if it vanished, the correction text is wrong.
  console.log('\n3. the live-vs-printed ceiling gap');
  const coffee = sized.find((e) => /coffee/i.test(e.symbol || ''));
  if (!coffee) await fail('no Coffee entry to check the ceiling claim against');
  const coffeeCeil = coffee.sizeCalc.ceilingPct;
  if (!(coffeeCeil > 2.2 && coffeeCeil < 2.4)) await fail(`Coffee ceiling is ${coffeeCeil}, not ~2.31 — the 2.02x gap does not reproduce`);
  const sgx = sized.find((e) => /^sgx/i.test(e.symbol || ''));
  if (!sgx || !(sgx.sizeCalc.ceilingPct > 14.9)) await fail('SGX no longer matches the printed 14.97 — re-measure before recording');
  console.log(`  ${CHECK} Coffee ${coffeeCeil} vs printed 4.68 (2.02x); SGX ${sgx.sizeCalc.ceilingPct} vs printed 14.97 (match)`);

  // 4. the report.
  console.log('\n4. the report');
  const doc = read(DOC);
  if (doc.indexOf('### 13.8 ') < 0) await fail('the report is missing 13.8');
  if (doc.indexOf('### 13.7 ') > doc.indexOf('### 13.8 ')) await fail('13.8 must come after 13.7');
  if (!/CORRECTION \(2026-09-29T04:28:19Z/.test(doc)) await fail('the 1.1b correction is missing from the report');
  console.log(`  ${CHECK} 13.8 present and in order; the 1.1b correction is in place`);

  // 5. the row and its marker.
  console.log('\n5. the row and its marker');
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
  if (!(after.info || '').includes('CONFIRMED LIVE, AND THE READ FALSIFIED')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
