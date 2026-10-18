// scripts/record-2026-09-27-bar1.js — TRD-BAR-1: correct the diagnosis, record the fix, close it.
//
//   1. APPENDS to TRD-BAR-1 (#1420) — the cause is NOT the bars work, and the fix is not a bigger timeout
//   2. CLOSES  TRD-BAR-1 (#1420) — a housekeeping step no longer aborts a trading wake
//   3. CREATES TRD-CAP-1 — the tick feed collapsed to 22/hour from 09:00Z on 09-25, hours before the failures
//
// Appends, never replaces. Dry by default.
//   node scripts/record-2026-09-27-bar1.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const M1 = '##2026-09-27 bar1-diagnosis##';
const M2 = '##2026-09-27 tick-collapse##';

const ADD = `
${M1}
★★★ DIAGNOSED, AND THE OBVIOUS READING WAS WRONG. The step accounts for **51 of the 67 failed wakes** in 14 days,
so "the bars work is too slow" is the natural conclusion. It is false, and the measurement says so:

  · **The whole step takes 197 ms.** Run through the desk's own endpoint (\`POST /bars/build\`, in-process, with the
    venue closed so it cannot disturb a session): HTTP 200 in **197 ms**, returning \`hourly 33, daily 81,
    ticksDeleted 1661\`.
  · **Every table it touches is indexed for the way it is asked.** \`PriceBars\` has
    \`UQ(userId, venue, symbol, timeframe, barStart)\` — which matches the hour-MERGE's \`ON\` clause
    **column-for-column**, so it is a seek and not a scan. \`PriceTicks\` has \`(capturedAt DESC)\` and
    \`(venue, symbol, capturedAt DESC)\`. \`TradingEvents\` and \`EquityTicks\` both carry \`(userId, <time>)\`.
  · **The hot reads are fast:** a census over \`TradingEvents\` (92,569 rows) and \`EquityTicks\` (156,315) returns in
    **44 ms**.

★ SO WHAT IS THE 60s? It is \`shared/db.js\`'s deliberately-set \`requestTimeout\`, and that file already says of
itself: *"it is HEADROOM, not a cure... A larger timeout converts 'aborted request' into 'slow request' — it does not
make the desk fast."* A 60s abort is what any query gets when the INSTANCE stalls for a minute, and 409k-row
\`ApiLogs\`, \`EquityTicks\` at a 1s write cadence and 12k \`TradingEvents\`/day all share one SQL Express instance with
three other apps.

⚠ **WHY THIS STEP, AND NOT ANOTHER.** It runs on EVERY wake — the 15-minute throttle skips the WORK, never the
step — while the other steps run less often. So it is simply the most FREQUENT sampler of a database that stalls,
and the step most likely to be holding a request when a stall lands. The 300s-deadline failures on \`capture\`,
\`risk\`, \`floor\` and \`deliberate\` are the same stall, seen from steps that run less often.

★★★ **THE ACTUAL BUG, AND IT IS NOT ABOUT TIME AT ALL: A HOUSEKEEPING FAILURE ABORTED A TRADING WAKE.** The step
rethrew, so the wake died at the prune — **no quant scout, NO EXITS AND NO POSITION REVIEW.** The desk stops
managing open positions because a tick-prune did not finish, and the direction of that failure is the dangerous one:
a lost exit is unbounded, a skipped prune is trivial.

★ **AND THE PRECEDENT WAS ALREADY IN THE FILE.** \`step()\` carries an \`optional\` mode added by owner decision on
2026-09-15 after MEASURING the same shape on the \`floor\` step: *"the ENTIRE wake died - no bars, no quant, no
deliberation, no execution."* \`autoclose\`'s budget carries the same reasoning. The bars step simply never got it —
and \`optional\` could not be reused directly, because it forgives a **DEADLINE only** (\`e.deadline === true\`) and
this failure is a **thrown SQL timeout**. So the tolerance is local to the bars step and named, rather than widening
\`optional\` into exactly the blanket catch its own comment forbids.

★★ **THE FIX.** The bars step catches, logs under the same \`bars_build\` kind (so nothing that reads it changes),
and DOES NOT RETHROW. It returns \`{skipped:'bars_failed'}\` so the step mirror still renders the failure, and the
error rides the wake event as \`barsError\` — a swallowed error that looks like a clean wake is the defect class this
codebase keeps closing, and 51 lost wakes stayed invisible precisely because a failed prune and an empty prune
rendered identically.

★ WHY CONTINUING IS SAFE, stated rather than assumed: a stale-bars condition is already guarded — \`quant\`'s
staleness SLA refuses new ENTRIES on old bars. So a failed prune degrades to "no new entries, but the book is still
managed", which is strictly safer than "no wake at all". The failure mode of the fix is therefore bounded by an
existing gate; the failure mode it replaces was not bounded at all.

⚠ WHAT THIS DOES NOT DO: it does not stop the DB stalling. It removes the consequence that mattered (a lost wake)
and makes the degradation visible. **The stall itself is now the open question**, and the most useful next evidence
would be instance-level wait stats captured DURING a stall rather than after it — the desk is idle when anyone looks.

4 tests in \`test/bars-step-not-fatal.test.js\`, including one that pins the \`optional\` contract UNCHANGED, so the
bars tolerance cannot quietly become a blanket catch.
`;

const CAP_NAME = 'TRD-CAP-1: Price capture — the tick feed collapsed to 22/hour from 09:00Z on 09-25, with whole '
  + 'hours missing, hours before the bars failures began';

const CAP_INFO = `
${M2}
★ FOUND WHILE DIAGNOSING TRD-BAR-1, and it is a separate defect. \`PriceTicks\` per hour, 2026-09-24 -> 09-25:

    2026-09-24  11:00Z 335 · 12:00Z 561 · 13:00Z 349 · 14:00Z 541 · 15:00Z 1025 · 16:00Z 695
                17:00Z 543 · 18:00Z 517 · 19:00Z 531 · 20:00Z 429 · 21:00Z 225
                22:00Z 346 · 23:00Z 382
    2026-09-25  00:00Z 651 · 01:00Z 503 · 02:00Z 348 · 03:00Z 254 · 04:00Z 486 · 05:00Z 384
                06:00Z 424 · 07:00Z 192 · **08:00Z — MISSING ENTIRELY —**
                **09:00Z 22 · 15:00Z 22 · 16:00Z 22 · 20:00Z 22**

★★ THE FEED FALLS FROM ~200-1000 TICKS/HOUR TO **22/HOUR** AT 09:00Z AND NEVER RECOVERS, with the 08:00Z hour
absent altogether. That is a **~97% collapse six hours before the venue closed**, and it is NOT explained by the
session: 09-25 was a Friday, the venue closes 21:00Z, and the hours 10:00-20:00Z are inside the session.

★ WHY IT MATTERS BEYOND ITSELF. The desk's entire quant layer reads ticks → bars → signals. A capture running at 2%
of its normal rate means the bar aggregates are built from a handful of samples, which degrades \`atr14\`, Donchian
and the signal itself — and none of that surfaces as an ERROR, because a bar built from 3 ticks is a perfectly
valid bar as far as the schema is concerned.

⚠ NOT DIAGNOSED. Unestablished: whether the capture loop kept RUNNING and simply received less (a venue/feed
problem), whether it stalled and retried (a bridge problem), and whether the remaining 22/hour are one symbol out of
the seven (a per-instrument problem). The next step is to read the capture's own telemetry for that window —
\`captureOnce\` records counts and the chart-interval tally — rather than inferring from the tick table, which is
where this was found and which cannot distinguish the three.

★ AND IT IS WORTH NOTING THE COINCIDENCE WITHOUT CLAIMING CAUSATION: the bars step began failing at 19:04Z the same
day, and a capture in a degraded state is one of the candidates \`shared/db.js\` lists for the DB stalls. That is a
hypothesis to test, not a finding.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1420`);
  if (!cur.recordset.length) { console.error('#1420 not found — aborting'); process.exit(1); }
  const c = cur.recordset[0];
  const d1 = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${M1}%'`);
  const d2 = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${M2}%' OR (edictId = 52 AND name LIKE 'TRD-CAP-1:%')`);
  console.log(`#1420 state=${c.state} info=${c.len}${d1.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  console.log(`TRD-CAP-1 already present: ${d2.recordset.map((x) => x.id).join(', ') || 'no'}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  if (!d1.recordset.length) {
    await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = 1420`);
    console.log('✔ #1420 appended');
  }
  await pool.request().query('UPDATE Tasks SET state = 3 WHERE id = 1420 AND state <> 3');
  console.log('✔ #1420 closed (housekeeping no longer aborts a trading wake)');

  if (!d2.recordset.length) {
    const m = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
    const ins = await pool.request()
      .input('name', CAP_NAME).input('info', CAP_INFO)
      .input('plannedStart', new Date()).input('sortOrder', Number(m.recordset[0].m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    console.log(`✔ created TRD-CAP-1 as #${ins.recordset[0].id}`);
  }

  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = 1420 OR (edictId = 52 AND name LIKE 'TRD-CAP-1:%') ORDER BY id`);
  console.log('\nread-back:');
  for (const r of chk.recordset) console.log(`  #${r.id} state=${r.state} info=${r.len}`);
  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('edict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
