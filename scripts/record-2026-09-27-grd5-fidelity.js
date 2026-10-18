// scripts/record-2026-09-27-grd5-fidelity.js — TRD-GRD-5 (#1386): the range-fidelity gate is DISCHARGED.
// Dry by default:  node scripts/record-2026-09-27-grd5-fidelity.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 aggregate-fidelity##';
const ID = 1386;

const ADD = `

${MARK}
★★★ **THE OPEN ITEM IS DISCHARGED, AND THE ANSWER IS THE OPPOSITE OF WHAT THIS ROW EXPECTED. Its residual read:**

> ⚠ WHAT REMAINS OPEN HERE. The range-fidelity half of the gate is still not discharged for AGGREGATED hours:
> the venue's own 5m/15m bars are still not stored natively, so an aggregated hour cannot be recomputed from them.

**They ARE stored, and they DO recompute it — exactly.** The 15m \`plus500_chart\` series holds **12,191 rows**, and
recomputing each aggregated hour from the same-symbol SAME-VENUE sub-hour bars inside it reproduces the stored row
**bit-for-bit**:

    checkable (>=2 sources)   3167
    EXACT H+L match           3167   (100.0%)
    max high error            0.00
    max low error             0.00
    rate_high_impossible      0
    rate_low_impossible       0

**Coverage, stated because a 100% over a subset is not a 100%:** of **5,481** aggregated 1h rows, **3,167 (57.8%)**
are checkable rollups and **2,314 are single-source passthroughs** — a passthrough is not an aggregation and cannot
be verified by this method. **Zero** aggregated rows have no source at all. So the gate is discharged for every row
it can apply to, and the unverifiable remainder is named rather than averaged in.

★★ **THE TEST OF "IMPOSSIBLE": a correct rollup can only ever WIDEN the range** — the max of the sub-hour highs is
>= every sub-hour high. So a stored row whose high sits ABOVE everything in its own hour could not have come from
that hour, and that is the one shape that is a real defect rather than a coarser-but-correct aggregate. Measured
**0 highs and 0 lows.** This matters because the row's own note said an aggregated hour and a native hour are
**OHLC-indistinguishable** (proven by a non-vacuity test) and volume is 0 on every chart row — so this invariant is
the ONLY independent check that exists on these rows, and it holds.

★ **REPRO SCRIPT: \`trading/scripts/repro/grd5-aggregate-fidelity.js\`** (read-only, re-runnable).

★★★ **AND I HAD TO GET THE SOURCES RIGHT FIRST, WHICH IS WHY THE SCRIPT PRINTS THEM BEFORE THE VERDICT. My first
version of this measurement reported 16% high mismatches and a 4,871-point error on a 4,300 instrument. BOTH WERE
MY MISTAKES, not the desk's, and both were caught by printing the source rows instead of only the answer:**

  1. **I took \`timeframe <> '1h'\` as "a source bar".** That admits **\`1d\` and \`4h\`** bars — and a DAILY bar's high
     IS the day's high, so the 4,871 "error" was **one daily Bitcoin bar compared against an hourly one**. The
     give-away was the source list itself (\`tfs=1d:3600,1d:3600,...\`). A source must be strictly NARROWER than the
     row it builds: \`sourceIntervalSec < 3600\`.
  2. **I matched on SYMBOL alone**, so **5,632 of the pairs compared a \`yahoo\` bar to a \`plus500_chart\` hour.** A
     different venue is not a source of another, and these two are known to disagree by **~95.6 bps at the same
     hour** (TRD-STR-1). ★ Note the surviving 5m series is **\`yahoo\`, not \`plus500_chart\`** — so the 5m bars must
     never be used to verify a chart hour, which is exactly the trap.

**A fidelity test that selects the wrong sources measures the SELECTION MISTAKE and reports it as a rollup defect.**
Had I recorded the first number, this row would have been closed as "the aggregation is 16% wrong" — a defect that
does not exist — and the real one (0 impossible rows) would have been buried under it. The verdict statement is
therefore unconditional in the script: it compares EXACT against CHECKABLE and refuses to print a percentage that
skips the population it excluded.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`#${ID} not found`); process.exit(1); }
  const c = cur.recordset[0];
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#${ID} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  console.log(`✔ #${ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
