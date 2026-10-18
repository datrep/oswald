// scripts/record-2026-09-28-vet2-measured.js — the tie counterfactual, and A shipped.
//   node scripts/record-2026-09-28-vet2-measured.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 tie-measured##';
const ID = 1448;

const ADD = `

${MARK}
★★★ **THE MEASUREMENT WAS RUN, AND THE ANSWER IS "NO MEASURABLE EDGE" — SO THE RULE DOES NOT MOVE AND ONLY THE
ATTRIBUTION SHIPPED. The owner's rule going in was: *"B, but only if it has a measurable edge, if not, A."*

**METHOD — the same first-touch counterfactual TRD-TP-1 used for target distances, applied to the ties.** Each
ticket's levels are rebuilt from the DECISION ROW ITSELF (\`payload.stopDistance\` = the 2xATR declared,
\`payload.effectiveStopDistance\` = the distance the venue would have received, and the target at 1.5 x DECLARED
less the 5% offset **only for decisions on/after the offset epoch 2026-09-25, read from \`epoch.js\` by reference
rather than restated here**). The entry price comes from the **VENUE'S OWN TICK FEED** at the decision instant —
\`PriceTicks\`, bid/ask mid — and the tape is then walked forward for 24h asking which level was touched FIRST.

⚠ **\`PriceTicks\` IS ONLY ~7 DAYS DEEP, which is the only reason this was measurable at all and the reason it
cannot be extended backwards**: of 20,083 all-time Gold ticks, **20,035 fall inside this very window**. A repeat
needs a deeper tick store or another source.

    ties replayed        57 of 57 measurable (no skips)
    resolved             52   target 23 · stop 29 · censored 5
    hit rate on resolved 44.2%
    mean effective R:R   1.60
    EV per trade         +0.1019 R resolved-only   /   +0.0929 R with censored counted as scratch

⚠ **AND THE AGGREGATE IS CARRIED BY NOTHING. This is why it is not an edge:**

    Oil/buy           n=44   resolved 44   hit  39%   EV -0.034R     <-- 77% OF THE POPULATION, FLAT-TO-NEGATIVE
    Oil/sell          n= 7   resolved  4   hit 100%   EV +1.444R     <-- FOUR resolved trades
    Arabica Coffee/buy n=2   resolved  2   hit 100%   EV +1.511R     <-- TWO trades
    Gold/sell         n= 2   resolved  2   hit   0%   EV -1.000R     <-- two trades
    offset OFF        n=46   resolved 46   hit  39%   EV -0.022R  meanRR 1.50
    offset ON         n=11   resolved  6   hit  83%   EV +1.050R  meanRR 2.04   <-- 5 of 11 CENSORED, unusable

★★ **TWO REASONS n=44 IS NOT 44 OBSERVATIONS, and either alone is enough to refuse the claim:**
 * **THEY OVERLAP ALMOST COMPLETELY.** The 44 Oil buys are 13 hours of one afternoon-into-night episode on the
   SAME signal — \`#56551\` 04:29, \`#56588\` 04:32, \`#56613\` 04:34, \`#56649\` 04:35 are four entries inside SIX
   MINUTES. The effective sample is a handful of Oil episodes, so a -0.034R mean has a standard error far wider
   than the effect being claimed.
 * **THEIR R:R IS EXACTLY 1.50**, i.e. \`effectiveStopDistance == stopDistance\` — **the cap was NOT binding on
   them.** So this population is not even a cap-distorted one: it says nothing about the TRD-RSK-1/TRD-TP-1
   geometry question either way.

**⇒ WITH NO EDGE, THE OWNER'S RULE SELECTS A.** The tie still declines, which is the default set on 2026-09-20
and which the only outcome measurement on record supports (TRD-VET-1: 13 overruled-dissent decisions → −37.27
gross on 4W/7L).

★ **WHAT SHIPPED (A): \`committeeVerdict\` now returns \`tie\` AND \`attribution\`, and the decision record carries
both.** Attribution is one of \`approved · chair_veto · tie · chair · quant · both\`, derived from the SAME locals
the outcome was, so it cannot drift from it. **\`approved\`, \`total\`, \`vetoApplies\` and \`reason\` are UNCHANGED** —
the revision is that the record now names WHO decided instead of leaving 57 of 92 declines reading exactly like a
moderate chair-majority decline. 13 tests in \`test/chair-veto.test.js\` pin every case, including the one the row
originally turned on ("a tie is not a veto" — now also a countable fact rather than only an absence).

⚠ **A DISCREPANCY I COULD NOT RECONCILE, RECORDED RATHER THAN SMOOTHED.** Two runs of the SAME predicate
(\`kind='decision'\`, \`total === 0\`) produced **71** ties and then **57**. The 57 is the working figure here because
that run is visible end to end in one file and every one of its 57 was measurable; the 71 came from an earlier
pass whose count I can no longer reproduce. **The direction of every conclusion above is the same at either
count** (both populations are Oil-dominated and the dominant group is flat-to-negative), but the number **must be
reconciled before any rule change**, and it is the third time this session that a convenient filter produced a
different population from the one a sentence was about.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`#${ID} not found`); process.exit(1); }
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  const c = cur.recordset[0];
  console.log(`#${ID} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('DRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  console.log(`✔ #${ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
