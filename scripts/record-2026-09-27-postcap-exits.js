// scripts/record-2026-09-27-postcap-exits.js — append the post-cap measurements where they belong.
// Appends, never rewrites. Idempotent by marker. Dry by default.
//   node scripts/record-2026-09-27-postcap-exits.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');

const SHARED = `
★ WINDOW, stated because the last three wrong answers in this record came from an unstated one: **the closed book
since the POLICY EPOCH \`2026-09-21\`, n=27 closes.** Before the epoch the sample is a different regime
(\`trading/agent/epoch.js\` regimes: \`stop-cap\` 09-19..09-21, \`policy-epoch\` 09-21..09-25). Every figure below is
that window unless it says otherwise. Measured 2026-09-27 by \`temp/sustainability.js\`, \`temp/loss-and-quiet.js\`,
\`temp/recheck.js\` — read-only.

★ MEASURED, ONE LINE: **expectancy −0.059R over n=27, hit rate 33.3% against a 35.0% breakeven.** Dollar P&L over
the same window is **+5.63 USD** and equity ran **4105.70 → 4111.45 (+5.75, +0.14%)** — so the R-figure and the
dollar figure disagree in SIGN, which is stated rather than smoothed over: the R measure normalises each trade by
its own risk and says the edge is negative, while the dollars were carried by a few larger winners. **Do not quote
either alone.**
`;

const APPENDS = [
  {
    id: 1412, mark: '##2026-09-27 postcap-rr-band##',
    label: 'TRD-TP-1 — the outcome half of the geometry argument',
    text: `
##2026-09-27 postcap-rr-band##

${SHARED}
★★★ **THE OUTCOME HALF OF THIS ROW'S ARGUMENT, which was geometry-only until now.** §above proves from the code that
capping the stop **moved the TARGET** (target = \`LEVEL_RR x DECLARED\` = 1.5 x 2xATR; the cap shrinks the STOP only,
so effective R:R = 1.5 x declared / stopDist). The \`stop_capped\` events confirm the mechanism exactly, declaring
\`declaredRR: 1.5\` on every fire while recording:

    Gold  declaredStopDist 15.809  -> stopDist 12.795  declaredRR 1.5  effectiveRR 1.853
    Gold  declaredStopDist 18.746  -> stopDist 12.817  declaredRR 1.5  effectiveRR 2.194
    Gold  declaredStopDist 21.045  -> stopDist 12.828  declaredRR 1.5  effectiveRR 2.461
    Oil   declaredStopDist  1.1966 -> stopDist  0.2857 declaredRR 1.5  effectiveRR 6.282
    Oil   declaredStopDist  1.1796 -> stopDist  0.2764 declaredRR 1.5  effectiveRR 6.401

**The declared R:R is 1.5 on every single fire. The effective R:R ranges 1.57 to 6.40, and that spread is nothing but
HOW MUCH THE CAP BOUND.** Oil's declared stop was 1.256% of price and was cut to 0.3% — a 4.19x tightening — so a
trade designed at 1.5R is carried as 6.28R.

★★★ **AND THE BAND PREDICTS THE OUTCOME. This is the missing half:**

    effective R:R <= 2.2x   n=10   hit 50.0%   total R  +2.60   expectancy +0.260R   mean stop 0.371%   mean target 0.638%
    effective R:R >  2.2x   n=17   hit 23.5%   total R  -4.20   expectancy -0.247R   mean stop 0.268%   mean target 1.101%

**A 0.507R per-trade difference across a cut at 2.2x, and the losing band is 63% of the book.**

★★ **THE DISCRIMINATOR IS TARGET DISTANCE, NOT STOP TIGHTNESS — and my own first hypothesis was REFUTED by this
measurement.** I expected the tight-stop group to lose, because a 0.28% stop sits inside the noise. It does not sort
that way:

    stop >= 0.30% (cap did NOT bind)  n=15  hit 33.3%  expectancy -0.204R  mean target 0.948%
    stop <  0.30% (cap DID bind)      n=12  hit 33.3%  expectancy +0.122R  mean target 0.907%

**Same hit rate, and the CAPPED group did BETTER.** So the cap is not the cause; **the TARGET is.** The cap is only
the mechanism that *manufactures* a far target out of a 1.5R design. Stated plainly because the wrong diagnosis
would have produced the wrong fix (widen the stop), which the numbers do not support.

★★ **"REACHED THE TARGET" IS THE EXPLANATORY VARIABLE: only 6 of 27 trades ever reached their own target distance.**
Winners reached theirs almost exactly (1074: target 0.590%, MFE 0.5921% · 1089: 0.509% / 0.5197% · 1081: 0.653% /
0.6876%), and the losers fell short by a hair or by a lot (1093: target 0.735%, MFE 0.697% — **missed by 0.036% of
price and then reversed to a full stop, a 2.4R swing decided by 3.6 basis points**; 1094: 1.879% / 1.575%).

★★★ **THE COST RAISES THE BAR, which is the part that makes the far band unwinnable rather than merely unlucky.** A
round-trip cost of c x R on a trade with reward:risk r needs a hit rate of **p = (1+c)/(1+r)**, not 1/(1+r):

    Gold  cost 0.1194% of price = 39.8% of a 0.3% R  ->  breakeven p = 1.398/3.0 = 46.6%   (33.3% without cost)
    Oil   cost 0.1728% of price = 57.6% of a 0.3% R  ->  breakeven p = 1.576/3.0 = 52.5%   (33.3% without cost)

**So Gold needs 46.6% and Oil needs 52.5% on a 2R trade; the desk delivers 33.3% overall, and 50.0% only in the
near-target band.** The near band clears Gold's bar; the far band (23.5%) clears nothing. ★ And because cost is a
PERCENTAGE OF PRICE while R is a percentage of price too, **capping R tighter raises the cost's share of R** — the
two dials are one dial, which is TRD-RSK-2's subject.
`,
  },
  {
    id: 1273, mark: '##2026-09-27 postcap-exit-recheck##',
    label: 'TRD-32 — its own conclusion is PRE-CAP and does not survive the epoch',
    text: `
##2026-09-27 postcap-exit-recheck##

${SHARED}
★★★ **THIS ROW'S HEADLINE CONCLUSION IS A PRE-CAP MEASUREMENT AND DOES NOT HOLD POST-CAP.** The row reads:

> **a) The TPs are NOT the leak.** All three venue take-profits captured 100% of the sampled favourable move.
> Widening the take-profit has nothing left to collect — reject that amendment.

**Its evidence is the 7 closes of 2026-09-11.** The stop cap landed **2026-09-19** and the policy epoch begins
**2026-09-21**, so that sample is **8 to 10 days BEFORE the geometry this row reasons about existed.** Re-measured on
the post-epoch book (n=27) the finding INVERTS:

    reached their own target distance:  6 of 27
    winners' MFE ~= their target distance (they reached it); losers' mean target 1.101% against a mean MFE of 0.519%

**Post-cap the target IS the leak — not because 100% of the favourable move is captured, but because the target now
sits roughly TWICE as far as the instrument typically travels.** No code changed here; the era did. This is recorded
as an EPOCH correction rather than as a contradiction, and it is the class of error
\`trading/agent/epoch.js\` exists to make visible: *a mean computed over a window that spans the epoch describes
neither side of it.*

★ **THE GIVE-BACK FINDING, which is this row's subject matter and the strongest case in the record for a
profit-protecting exit: 7 of 27 trades (26%) ran to a PROFITABLE excursion and closed at a LOSS.**

    #1094 Oil  buy   MFE +1.575%  ->  -1.27R  (Loss call)
    #1088 Oil  sell  MFE +0.901%  ->  -1.03R  (executor close)
    #1093 Gold sell  MFE +0.697%  ->  -1.34R  (Loss call)
    #1092 Gold sell  MFE +0.613%  ->  -0.90R  (executor close)
    #1076 Gold sell  MFE +0.376%  ->  -1.35R  (Loss call)
    #1068 Gold sell  MFE +0.357%  ->  -1.22R  (executor close)
    #1095 Gold sell  MFE +0.334%  ->  -1.29R  (Loss call)

**−8.40R from seven trades that were all in profit at some point.** Note the top two: **every one of these MFE
figures exceeds the 0.28-0.30% stop distance**, so a trail anchored on the position's own peak (which is what
TRD-33 fixed the anchor FOR — do not re-seed from pre-entry bars) would have been armed on all seven.

⚠ **NOT A NO-CODE CLAIM AND NOT A COUNTERFACTUAL.** These are excursions, not guaranteed fills: a trail fills on a
retrace, so it banks LESS than the MFE and can still be gapped through. The honest statement is that the desk held
seven positions that were ahead and banked none of it, and that the MECHANISM to bank some already exists
(\`peak - k x ATR\`, k=2 on Oil per the exit decisions quoted on TRD-33) — what is unmeasured is whether it was armed
on these trades and, if not, why. **That question is this row's next action, and it is answerable from the stored
tick paths without a live venue.**
`,
  },
  {
    id: 1420, mark: '##2026-09-27 review-not-blocked##',
    label: 'TRD-BAR-1 — the stated rationale is refuted by measurement',
    text: `
##2026-09-27 review-not-blocked##

${SHARED}
★★ **A CORRECTION TO THIS ROW'S OWN RATIONALE, found by measuring rather than by reasoning.** The fix shipped here
rests on the claim, stated in the code comment at \`trading/agent/wakePipeline.js\` ~line 415:

> A failed wake evaluates NO EXITS and NO POSITION REVIEW — the desk stops managing open positions because a
> tick-prune did not finish.

**That is FALSE, and the record says so plainly.** In the very window where the failure was at its worst —
**2026-09-25 08:31Z → 21:00Z, 42 of 54 wakes dying on \`bars\`** — position review ran **150 times, evenly, every
hour (11-13 per hour, 09:00Z through 20:00Z), without a single missed hour.** Position review is driven by its own
loop, not by the wake pipeline, so a dead wake never suspended it.

★ **THE FIX IS STILL CORRECT — for a different and better-stated reason.** A wake that dies evaluates no QUANT, no
DELIBERATION and no ENTRY, and it writes no wake record that a reader can see dying. Continuing is right because it
keeps the pipeline's own account of itself intact; the position-management argument was simply the wrong one, and
carrying a wrong justification forward is how a correct change gets reverted by the next reader.

★ **AND THE ERROR IS REAL, NOT HYPOTHETICAL: 87 x \`ETIMEOUT — "Timeout: Request failed to complete in 60000ms"\`
fired continuously from 2026-09-25T08:39:56Z to 2026-09-25T21:01:26Z** — straight through the market close and
beyond it, on a 60-second socket timeout. So this is a genuine 60s database/provider stall and **not** the "step is
just slow" reading the row previous rejected, nor a market-hours artefact: it did not stop when the market did.
The step measured at 197ms in the earlier work was measured at a QUIET moment; under the stall it holds a request
for the full 60s. **Both readings are true and the row should carry both.**
`,
  },
];

(async () => {
  const pool = await getPool();
  for (const a of APPENDS) {
    const cur = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${a.id}`);
    if (!cur.recordset.length) { console.log(`#${a.id} NOT FOUND — skipping`); continue; }
    const c = cur.recordset[0];
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${a.mark}%'`);
    console.log(`#${a.id} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + a.text.length}`}  ${a.label}`);
  }
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  for (const a of APPENDS) {
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${a.mark}%'`);
    if (dup.recordset.length) { console.log(`#${a.id} marker present — skipped`); continue; }
    await pool.request().input('t', a.text).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${a.id}`);
    const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${a.id}`);
    console.log(`✔ #${a.id} appended -> ${back.recordset[0].len} chars`);
  }
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
