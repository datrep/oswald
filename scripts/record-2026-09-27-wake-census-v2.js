// scripts/record-2026-09-27-wake-census-v2.js — correct the wake census and close TRD-WAK-1 properly.
//
//   1. APPENDS to TRD-GAT-1 (#1417) — the §7 census is WRONG in two ways and both pushed the same direction
//   2. APPENDS to TRD-WAK-1 (#1419) — its PREMISE was false, and states what the real defect turned out to be
//   3. CLOSES TRD-WAK-1 (#1419) — the duplicate emitter is fixed (one wake, one event)
//   4. CREATES TRD-BAR-1 — the `bars` step timed out 51 times in 14 days, and will again when the market opens
//
// Appends, never replaces. Dry by default.
//   node scripts/record-2026-09-27-wake-census-v2.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const M1 = '##2026-09-27 census-v2##';
const M2 = '##2026-09-27 premise-correction##';
const M3 = '##2026-09-27 wake-single-emitter##';
const M4 = '##2026-09-27 bars-timeout##';

const GAT_ADD = `
${M1}
★★★ THE §7 CENSUS BELOW IS WRONG, IN TWO WAYS, AND BOTH PUSHED THE SAME DIRECTION — IT OVER-COUNTED THE DESK'S
MYSTERIES. Corrected from the same 14 days.

ERROR 1 — IT READ ONE FIELD OUT OF THREE. The wake envelope carries its "why" in up to three places: \`reason\` (a
decision outcome), \`skipped\` (an early exit that never reached a decision) and \`failedStep\` + \`error\` (a THROWN
step, written by \`log.error\`). The census read \`$.reason\` only. Of the 301 events it called "no reason at all",
**237 said \`skipped:"market_closed"\`** and the rest named a \`failedStep\`. The wakes were self-describing; the
census was the thing that could not read them.
ERROR 2 — IT DEDUPLICATED ON A KEY THAT DOES NOT COLLAPSE THE PAIR. One wake could write TWO events — the
aggregator's and the pipeline's — MILLISECONDS apart, so a full-millisecond ISO timestamp keeps both. The census
counted 1,849 "distinct wakes" from 2,321 events and was in fact counting events.

★ THE CORRECTED CENSUS. Cluster by the SECOND, canonicalise the why across all three fields. **2,247 events in
14 days collapse to 1,426 wakes** (histogram: 609 wrote one event, 815 wrote two, one wrote three, one five):

    638   44.7%   no_proposal        (no signal / committee not convened — no layer is ever reached)
    429   30.1%   skipped_early      market_closed 307 · bridge_paused 56 · kill_switch_hard 54 · session_lock 12
    273   19.1%   layer 5            the committee
     67    4.7%   ERROR              a THROWN step — see TRD-BAR-1
     11    0.8%   layer 4            risk veto — correlation 8, exposure_budget 3
      8    0.6%   other

★★ AND THIS CHANGES THE HEADLINE THAT MATTERS FOR THE GATE. §1 said layer 5 is where entries die. Corrected:
**44.7% of wakes never reach ANY layer, and a further 30.1% skip before a decision exists** — so three quarters of
the desk's outcomes are decided before the gate is consulted, and only 19.1% of wakes ever put a proposal in front
of the committee. The risk layer is 0.8% over the window, and was 100% of the binding constraint on 2026-09-25
(8 of the day's refusals) — which is the same lesson as before, now measured on a correct denominator: **a layer is
"where entries die" only for the window, and the layer that matters is the first one that is not already refusing.**

★ THE 4.7% ERROR RATE IS THE PART THAT SHOULD WORRY SOMETHING. 67 wakes died on a THROWN step, and 51 of those
were the SAME step timing out at 60s — \`bars\`. Recorded as **TRD-BAR-1** because 49 of the 67 fall on 2026-09-25
and the last one is 2026-09-25T21:01Z, i.e. the market close, which is exactly when the desk next has work to do.

⚠ THE CORRECTION SPANS TWO ROWS. §7 of \`trading/docs/instrument-gate-and-patterns-DRAFT.md\` is amended in place.
TRD-WAK-1's premise ("25% of wakes record NO REASON") is RETRACTED on its own row.
`;

const WAK_ADD = `
${M2}
★★★ THE PREMISE OF THIS ROW IS RETRACTED, AND THE RETRACTION IS THE MOST USEFUL THING ON IT.

This row was written on a census that found "455 of 1,849 wakes (24.6%) record an EMPTY reason" and concluded a
quarter of the desk's outcomes "cannot be audited". **That was false, and the fault was the census, not the
desk.** The wake envelope carries its reason in THREE fields — \`reason\` (a decision outcome), \`skipped\` (an early
exit that never reached a decision) and \`failedStep\` + \`error\` (a thrown step). The census read \`$.reason\` and
nothing else, so **237 of the events it called empty said \`skipped:"market_closed"\`** and the remainder named a
\`failedStep\`. Every one of them was self-describing.

★★ WHAT THE REAL DEFECT WAS, and it is worth naming precisely because it is not the one that was written down:
**the wake envelope has no canonical "why" field.** There are three, a consumer must know all three, and a
consumer that reads one silently mis-classifies the other two — which is exactly what happened to the census that
produced this row, twice (it also counted EVENTS as WAKES: 2,247 events were 1,426 wakes). A telemetry shape that
requires every reader to re-derive its semantics will produce a different answer per reader, and one of those
readers will be a report.

★ THE OTHER HALF, AND IT IS NOW FIXED. Investigating the count revealed that a wake wrote its event TWICE:
\`aggregator\` wrote one on three separate paths and \`wakePipeline\` wrote a fourth, guarded by
\`if (!String(result.reason || '').startsWith('no_signal'))\` — a test on the PROSE of the reason, which covers
exactly ONE of the aggregator's three reasons. So \`positions open, no proposal - committee not convened\`, the most
common outcome on this desk, was written twice. MEASURED: **815 of 1,426 wakes carried a duplicate pair** (one
carried five).

FIX, ${M3}: **one wake, one event.**
  · The aggregator no longer writes ANY \`wake\` event — ownership expressed structurally instead of as a string
    comparison. Its three paths now RETURN the fields the pipeline needs (\`blocked\`, \`quant\`, \`committee\`).
  · \`wakePipeline.demoWakePayload\` merges them, INCLUDING the per-decision \`reason\` that only the aggregator's
    copy carried — because removing a duplicate must not turn into losing a field.
  · The prose-prefix guard is deleted. A prefix test cannot decide who owns a write, and it is the same class of
    defect as a test that pins a sentence: it works until the sentence changes.
  · \`extraQuantFields\` is deleted — its only purpose was the duplicate.
  6 tests in \`test/wake-single-emitter.test.js\`, and the important ones are STRUCTURAL: they assert the aggregator
  contains zero wake writes and that the prose guard is gone, because the failure mode is a new writer appearing
  rather than a wrong value.

⚠ NOT YET CONFIRMED LIVE, stated rather than implied: the duplicate only occurs on a wake that REACHES a decision,
and the desk is in its weekend SESSION_LOCK (market closed until Sun 21:00 UTC), where every wake exits early and
writes exactly one event. The fix is verified by test and by construction; the live confirmation is the first
committee-path wake after the open.

⚠ AND THE CANONICAL-WHY DEFECT IS NOT FIXED HERE. It is the reason this row existed under a wrong name, and it
stays open as a design question: either every emitter writes a single \`why\` field, or the envelope gains a
documented resolution order that consumers share instead of each re-deriving.
`;

const BAR_NAME = 'TRD-BAR-1: Bars step — 51 wakes in 14 days died on a 60s timeout in `bars`, including at the '
  + 'market close, and nothing flags it';

const BAR_INFO = `
${M4}
★ MEASURED 2026-09-27 over 14 days, deduplicated by wake (2,247 events -> 1,426 wakes): **67 wakes (4.7%) died on a
THROWN step**, and the single dominant cause is \`bars\`:

    step="bars"        n=51   first 2026-09-22T04:11:57Z   last 2026-09-25T21:01:26Z
                              sample: "Timeout: Request failed to complete in 60000ms"
    step="capture"     n=8    "step 'capture' exceeded its 300000ms deadline"
    step="risk"        n=4    "step 'risk' exceeded its 300000ms deadline"
    step="floor"       n=2    "step 'floor' exceeded its 300000ms deadline"
    step="deliberate"  n=1    "step 'deliberate' exceeded its 300000ms deadline"

★ SO THERE ARE TWO SHAPES AND THEY DIFFER IN KIND. \`bars\` dies on a **60-second socket timeout** — a provider
request that never answered — while the others die on the pipeline's own **300-second step deadline**, which is the
watchdog doing its job. The distinction matters because only the first is a provider/transport problem.

★ WHY IT SHOULD WORRY SOMETHING RATHER THAN BE FILED. **49 of the 67 fall on 2026-09-25 alone**, and the last
\`bars\` failure is **2026-09-25T21:01Z — the market close**. A wake that dies in \`bars\` loses the entire wake: no
quant scout, no deliberation, no position review, and \`llmCalled\` false. On a day the desk was already only
entering on a fraction of its candidates, the bars step was killing whole cycles, and the only trace is a
\`failedStep\` field on a wake event that almost nothing reads.

⚠ NOT YET DIAGNOSED, stated rather than implied: whether the 60s timeout is a provider that is slow at the close,
a rate limit, an unhandled socket, or a request with no timeout configured at all. The next step is to read the
\`bars\` step's fetch path and check what supplies 60000 — a deadline the step sets, or one lower down that it
inherits.

★ THE FIRST CONCRETE STEP, and it is cheap: the desk already has a self-health pass. A step that throws in ~5% of
wakes should be visible on the health surface rather than discoverable only by grouping \`failedStep\` values by
hand, which is how it was found here.
`;

(async () => {
  const pool = await getPool();
  const rows = [
    { id: 1417, tag: 'TRD-GAT-1', mark: M1, add: GAT_ADD },
    { id: 1419, tag: 'TRD-WAK-1', mark: M2, add: WAK_ADD },
  ];
  for (const r of rows) {
    const cur = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${r.id}`);
    if (!cur.recordset.length) { console.error(`#${r.id} not found — aborting`); process.exit(1); }
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${r.mark}%'`);
    const c = cur.recordset[0];
    console.log(`#${r.id} ${r.tag.padEnd(10)} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker already present]' : ` -> ${Number(c.len) + r.add.length}`}`);
  }
  const dupBar = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${M4}%' OR (edictId = 52 AND name LIKE 'TRD-BAR-1:%')`);
  console.log(`TRD-BAR-1 already present: ${dupBar.recordset.map((x) => x.id).join(', ') || 'no'}`);

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  for (const r of rows) {
    const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${r.mark}%'`);
    if (dup.recordset.length) { console.log(`#${r.id} already carries its marker — skipped`); continue; }
    await pool.request().input('t', r.add).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${r.id}`);
    console.log(`✔ #${r.id} appended`);
  }

  // Close TRD-WAK-1: the duplicate emitter is fixed. The canonical-why question stays open and is named in the note.
  await pool.request().query(`UPDATE Tasks SET state = 3 WHERE id = 1419 AND state <> 3`);
  console.log('✔ #1419 closed (duplicate emitter fixed; canonical-why recorded as the open design question)');

  if (!dupBar.recordset.length) {
    const m = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
    const ins = await pool.request()
      .input('name', BAR_NAME).input('info', BAR_INFO)
      .input('plannedStart', new Date()).input('sortOrder', Number(m.recordset[0].m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id
              VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    console.log(`✔ created TRD-BAR-1 as #${ins.recordset[0].id}`);
  }

  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id IN (1417, 1419) OR (edictId = 52 AND name LIKE 'TRD-BAR-1:%') ORDER BY id`);
  console.log('\nread-back:');
  for (const r of chk.recordset) console.log(`  #${r.id} state=${r.state} info=${r.len}`);
  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('edict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
