// scripts/record-2026-09-27-fed1-divergence.js — TRD-FED-1 (#1404): the divergence is now DETECTED and LOGGED.
// Dry by default:  node scripts/record-2026-09-27-fed1-divergence.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 divergence-logged##';
const ID = 1404;

const ADD = `

${MARK}
★★★ **BUILT: THE DIVERGENCE IS NOW DETECTED AND LOGGED. That was the one actionable gap left, and the row was
right about why it mattered: *"a divergence that is DETECTED and not LOGGED is still invisible to the next
investigation."* It was invisible because it was **not detected at all** — \`pickTick\` chooses ONE candidate and
never compared them to each other, so the 09-24 Oil spike (2.293%) and the worse 2026-09-18 one (5.124%) were only
findable by post-hoc analysis of \`PriceTicks\`. Both are now a recorded event.

★ **FIRST, ONE RESIDUAL IS ALREADY DISCHARGED AND THE ROW SHOULD STOP CARRYING IT.** The row's item (b) reads
"\`staleVenues\`/\`comparability\` not being persisted". **They are.** \`quant.js\` has persisted them since C3:

    priceStaleVenues:   picked.staleVenues.length ? picked.staleVenues : null          // quant.js ~481
    priceSubstituteGate: picked.comparability && picked.comparability.gated ? ... : null // quant.js ~485

So the "computed and thrown away" framing applies to the CROSS-SOURCE comparison, not to those two fields.

★★ **WHAT WAS ADDED**, and where each piece sits:

  · **\`pickTick\` (\`quant.js\`) now compares the candidates it already holds** and returns
    \`divergence = { maxSpreadPct, venues, mids, compared, freshVenues }\`. It compares pairs over the FRESH ones
    and reports the WIDEST pair. It picks a price; it does not decide what is alarming — the number is returned.
  · **the snapshot carries \`priceDivergence\`**, so the number is on the bundle the prompt path and the record
    both read, whether or not it is alarming.
  · **\`wakePipeline\` emits \`price_divergence\`** at **>= 1%**, one event per wake naming every diverging symbol
    with its venue pair, both mids, the pair count and whether the price was substituted.

★★ **THREE DECISIONS, because each is a place this could have been built wrong:**

  1. **ONLY FRESH CANDIDATES ARE COMPARED.** A stale quote is *expected* to disagree — that is what staleness
     means — so folding it in would report every ordinary outage as a divergence and drown the signal this row is
     about. Stale venues keep their own field (\`priceStaleVenues\`), so nothing is lost. Pinned by a test that
     feeds the *same 2.3% gap* twice, once fresh and once an hour old, and requires \`divergence: null\` in the
     second case while \`staleVenues\` still reports the venue.
  2. **\`compared\` TRAVELS WITH THE ALARM.** \`maxSpreadPct\` is a maximum, and a maximum over ONE pair and over SIX
     are different claims — without the count, "5.1% divergence" cannot be told from "5.1% between the only two
     quotes available". \`freshVenues\` travels too, so a thin comparison is visible rather than implied.
  3. **ONE EVENT PER WAKE, NOT ONE PER SYMBOL.** The 09-24 condition ran **~10 minutes**, so a per-symbol event
     would emit a storm during the exact window an operator is trying to read. One event listing every diverging
     symbol is the same information at a readable rate.

★ **THE THRESHOLD IS MEASURED, NOT CHOSEN.** Ordinary venue disagreement in this record is a fraction of a
percent; the two recorded events were **2.293%** and **5.124%**. So **1%** separates the two populations with room
on both sides. It is deliberately LOOSE, because the cost of a false fire is one event while the cost of a miss is
the 09-24 state — an unexplained equity move found days later by hand. Tighten it only with a measurement.

★ **VERIFIED:** \`test/price-divergence.test.js\` — **7 tests, all passing**; full suite **1,540 / 1,539 pass /
0 fail / 1 skipped**.

⚠ **THE TEST FILE CARRIES TWO CASES I DID NOT WRITE, AND THE HONEST NOTE IS THAT AN EXTERNAL SAVE LANDED OVER MY
VERSION BETWEEN WRITING IT AND RUNNING IT.** I authored six; the file on disk has seven, including *"divergence is
null on a stale-only set, and the mid is STILL the least-stale substitute"* and *"a genuinely empty candidate list
is the ONLY way to get mid null"*. **Both are better than what I had** — they pin the distinction between "no
comparison possible" and "no price at all", which my version left implicit — so they were kept rather than
overwritten, and the file was left exactly as found. Recorded here because a test file that changes under a run is
worth knowing about, and because attributing those two cases to me would be false.

⚠ **STILL OPEN, AND IT IS A DECISION RATHER THAN AN INVESTIGATION:** the other residual the row named — "the
anchor-age band the SLA leaves unlabelled" — is **built and OFF under TRD-ANC-1**, with its own measured options
and revisit trigger. Nothing here changes it.
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
