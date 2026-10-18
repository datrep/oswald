// scripts/record-2026-09-25-chart-interval.js — record "1 then 2" on the dashboard.
//
//   1. creates TRD-GRD-6 (the chart interval was never pinned, and the number it reported was falsifiable)
//   2. APPENDS to TRD-GRD-4 (#1385) — its enforcement blocker was registry COVERAGE, and that is now closed
//   3. APPENDS to TRD-GRD-5 (#1386) — the interval is now measured rather than trusted, and a 15m read now
//      refreshes the 1h structure series instead of skipping it
//
// Appends, never replaces: `info` is the row's history and a rewrite would destroy the record of what was
// believed earlier. Dry by default.
//
//   node scripts/record-2026-09-25-chart-interval.js          # report what would change
//   node scripts/record-2026-09-25-chart-interval.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
// ⚠ THE MARKER MUST BE LIKE-SAFE, AND `[...]` IS NOT. The first version used `[2026-09-25 chart-interval]`
// and its guard `info LIKE '%[…]%'` matched **192 rows** — because in T-SQL LIKE a bracket introduces a
// CHARACTER CLASS, so that pattern means "contains any of these characters", which is nearly every row. An
// idempotency guard that always says "already done" is worse than none. `#` is not a LIKE metacharacter.
const MARK = '##2026-09-25 chart-interval##';

const GRD6_NAME = 'TRD-GRD-6: Capture integrity — nothing pinned the chart interval, so the only structure '
  + 'venue was refreshed by luck; and the interval the capture reported was FALSIFIABLE';

const COMMON = `
${MARK}
★ MEASURED LIVE, NOT ASSUMED. \`readChartBars\` reports \`layout.interval * unitSec\` from whatever the SHARED TAB
was last left on, and \`bankChartBars\` banks rows under \`TF_MAP[thatInterval]\`. Nothing in the desk ever SET it.
On 2026-09-25 the tab read \`getPeriodicity() = {period:1, interval:15, timeUnit:'minute'}\` with its own bar
spacing at 900000 ms — FIFTEEN MINUTES. Two consequences, both silent:

 1. WHICH TIMEFRAME THE SERIES IS WRITTEN UNDER. \`TF_MAP[900]\` is \`'15m'\` and it is the ONLY entry below 1h, so
    a 15m tab writes \`'15m'\` rows and the \`'1h'\` series receives NOTHING. Structure reads exactly one series —
    \`quant.STRUCTURE_CHART_VENUE\` at \`timeframe:'1h'\`, the primary AND ONLY venue since TRD-STR-1 — and nothing
    consumes \`plus500_chart\` at \`'15m'\` (\`quant.BIG_TFS\` is \`['5m','1h','4h','1d']\`; yahoo/binance/okx win the
    rest). So the only structure venue was refreshed ONLY in the sweeps where the tab happened to be left on 1h,
    on 30m, or on an unmapped interval that falls through to 1h. GRD-5's "13,729 native-1h rows of 22,739" is
    that lottery's distribution, not merely a mixed label.
 2. HOW MUCH HISTORY ONE READ OVERWRITES. ChartIQ caps masterData at \`maxMasterDataSize\` = 1000 bars (read off
    the live engine), so a read reaches 1000 x interval: 15m is ~10.4 days, native 1h ~41.7 days.

★ THE INTERVAL IS FALSIFIABLE, WHICH IS WHY IT IS NO LONGER TRUSTED. \`stx.setPeriodicity\` EXISTS and returns
without throwing, and on this venue it is a LABEL-CHANGER. Its own minified source records the new layout
UNCONDITIONALLY and only then tries to reload:

    ke.periodicity=me, ke.interval=be, ke.timeUnit=Ce;            // the CLAIM, made FIRST
    ... if (needDifferentData) { if (quoteDriver) {...} else dataCallback ? dataCallback()
          : console.log("cannot change periodicity because neither dataCallback or quoteDriver are set") }

and on the live engine \`dataCallback === null\` and \`quoteDriver === false\`, so the reload branch cannot run at
all and the failure is a console.log rather than a throw. MEASURED: \`layout\` read 3600s while the series
measured 900000 ms of bar spacing, for 45 seconds across five navigations. Driving it would therefore write rows
labelled 1h, built from 15m bars, carrying \`sourceIntervalSec = 3600\` — §4.1 with a FALSIFIED provenance, which
is strictly worse than the absent one it replaces. IT IS NOT CALLED, and a test asserts it is not.

The venue's own controls were located and neither is a usable pin: \`CQ-MENU.ciq-period\` drives the same inert
path, and \`p500-range-menu\` / \`div.range-item\` (\`5m 1H 5H 1D 1M 3M\`) is a RANGE control — clicking its \`1H\`
left \`layout\` at 900s and the spacing at 900000 ms.

★★ THE FIX, IN TWO PARTS.
 A. THE INTERVAL IS MEASURED BESIDE THE CLAIM. \`barSpacingSec\` is pure and takes the MINIMUM POSITIVE delta
    between consecutive bar timestamps — not the first, not the mean. A closed market leaves GAPS and a gap can
    only INFLATE a delta, so the smallest positive spacing IS the interval; on the live Gold 15m series the
    histogram is 988 deltas of 900000 ms, 9 of 4500000, 2 of 177300000, whose MEAN is ~1257s — neither real
    value. \`chartIntervalVerdict({layoutSec, measuredSec})\` returns agree / disagree / unmeasured, and
    \`unmeasured\` is NOT agreement. \`bankChartBars\` writes only on \`agree\`; a refusal goes out as
    \`chartErr: interval_<verdict>: layout Xs vs series Ys\`, riding the EXISTING chartErr path that TRD-68 wired
    to \`chartMissing\` and to telemetry. A provenance field that LIES is worse than an absent one.
 B. THE 15-MINUTE HOLE IS CLOSED BY ROLLING UP. When the bucket is below 1h, \`store.upsertAggBars\` rolls the
    fine series up to 1h, declaring \`sourceIntervalSec = 900\` — so those rows are recorded as AGGREGATED, not
    native, which is exactly what \`barIntervalProvenance\` exists to tell apart. Guarded on the BUCKET and not on
    the literal \`'15m'\` so the rule survives a change to the map. The mapping GRD-5 ruled on is UNTOUCHED.

★ LIVE ACCEPTANCE, one real sweep after the restart (2026-09-25 02:41Z, pid 6328):
    chartInterval: { agree: 12, disagree: 0, unmeasured: 0, rollups: 2876 }   chartBars: 11881
    capture_chart_identity heartbeat: { of: 12, match: 12, mismatch: 0, unregistered: 0, unrecorded: 0 }
    merge: { merged: 0, fallThrough: 0, largest: { symbol: 'Bitcoin', intervalSec: 900, histogram: { '1': 978 } } }
  i.e. every symbol's claim agreed with its series, 2,876 1h rows were contributed to the structure venue, and
  the largest group was 978 buckets built from exactly ONE source bar each — native 15m, nothing aggregated.

⚠ RESIDUALS, recorded rather than implied.
  · The chart still cannot be PINNED, only measured. The venue exposes no interval control this code can drive,
    so the desk's series provenance depends on where the last navigation left the tab. What is now guaranteed is
    that the row cannot claim an interval the bars do not support, and that the 1h series is refreshed anyway.
  · \`sourceIntervalSec = 900\` rows in the 1h series are AGGREGATED. Structure can tell them apart via
    \`barIntervalProvenance\`, but the range-fidelity question GRD-5 raised still applies to those hours.
  · Pinning to native 1h would multiply any wrong-instrument blast radius from ~10.4 days to ~41.7 days, which is
    one more reason the enforcement decision in GRD-4 stays an owner call.
`;

const GRD4_ADD = `
${MARK}
★ ITS ENFORCEMENT BLOCKER IS CLOSED — MEASURED, AND BY THE ROUTE THE ROW ITSELF IMPLIES. The blocker was
registry COVERAGE: 6 of 13 observed chart pairs had no \`Instruments\` row, so \`chartIdentityVerdict\` returned
\`unregistered\` and the check COULD NOT RUN for those symbols — and a guard that is ABSENT for a symbol looks
exactly like a guard that PASSED for it. (Recorded: 513 \`unregistered\` observations over 177 sweeps.)

All six are now registered: 1304 China overseas, 3224 Gasoline, 1302 HKEx, 3989 Sands China, 1301 Sinopec,
1484 ZTE Corporation. Coverage is 6 of 6.

HOW, and the how matters more than the what: \`trading/scripts/backfill-chart-identity-registry.js\` probes each
symbol through \`POST /instruments/probe {symbol, select:true}\` — it NEVER writes a registry row itself. A row is
an id -> symbol mapping, and the only mapping worth trusting is the VENUE'S OWN: writing the desk's symbol
against the chart's id would make \`mismatch\` unable to fire for that pair, i.e. a guard that exists, runs, and
always passes — strictly worse than the missing row it replaced. The route reads the selected row's
\`data-instrument-id\` and the instrument sidebar, and \`captureFromObservation\` refuses a pairing whose sidebar
does not match the selected row.

★ A TRAP FOUND WHILE DOING IT, worth keeping: that self-check proves the sidebar describes the selected ROW —
NOT that the row is the instrument REQUESTED. Asking for \`Gasoline\` (3224) landed on a page still showing CHINA
OVERSEAS (1304), the probe reported success, and the first version of the backfill called it ✓ because it took
\`stored[0]\`. That re-registered 1304 and reported Gasoline as covered while 3224 stayed missing. The script now
requires the RETURNED id to equal the id it ASKED about, and prints the ids the venue actually returned.

★ ACCEPTANCE, the first clean sweep after the change (2026-09-25 02:41Z):
    capture_chart_identity heartbeat: { of: 12, match: 12, mismatch: 0, unregistered: 0, unrecorded: 0 }
so every watchlist symbol now RESOLVES. Both gates the row named are therefore measured: \`mismatch\` has never
fired on the current emitter (0 in 1,946 observations), and coverage is complete.

⚠ WHAT IS STILL NOT DONE, stated because the row is still open: enforcement is NOT enabled. Refusing a capture
costs that symbol its series, so switching observe-mode to enforce is an owner decision and this work does not
take it. The row's heartbeat note no longer claims a cleared blocker — a stale recorded claim is the class of
defect this whole series of rows exists to stop.
`;

const GRD5_ADD = `
${MARK}
★ ITS CAUSE IS NOW HANDLED, AND ITS PREMISE WAS RE-MEASURED AGAIN. GRD-5 recorded that every \`plus500_chart\` 1h
row was aggregated from a 5m or 30m chart; the measurement on 2026-09-25 shows the opposite distribution (native
1h had become the LARGEST group, 13,729 of 22,739) — and the cause of that inversion is the subject of
TRD-GRD-6: NOTHING PINNED THE CHART INTERVAL, so the series' provenance was decided by wherever the shared tab
was last left. It was left on 15m.

★ WHAT CHANGED FOR THIS ROW. The bucketing itself is untouched (the mapping ruling stands: mapping 300 to its
own timeframe would stop refreshing the 1h series, and there is no \`'30m'\` in \`BAR_TIMEFRAMES\`). What is new is
that the interval feeding it is now MEASURED beside the layout's claim and a row is written only when the two
agree, and that a sub-1h read is ROLLED UP to 1h so the structure venue is refreshed at EVERY chart interval
instead of only those that happen to map to 1h. Rolled rows declare \`sourceIntervalSec = 900\`, so
\`barIntervalProvenance\` marks them AGGREGATED rather than native.

★ THE ROW'S OWN CONCRETE NEXT ACTION IS NOW DISCHARGED AND RECORDED. It asked to record HOW MANY SOURCE BARS BUILT
EACH STORED ROW, because an aggregated hour and a native hour are OHLC-INDISTINGUISHABLE (proven by a
non-vacuity test) and volume is 0 on every chart row. \`merge.histogram\` carries it, and the first live sweep
after the change reports \`{ merged: 0, fallThrough: 0, largest: { symbol: 'Bitcoin', intervalSec: 900,
histogram: { '1': 978 } } }\` — 978 buckets of exactly one source bar each, i.e. NO aggregation in that sweep —
beside \`chartInterval: { agree: 12, disagree: 0, unmeasured: 0, rollups: 2876 }\`.

⚠ WHAT REMAINS OPEN HERE. The range-fidelity half of the gate is still not discharged for AGGREGATED hours: the
venue's own 5m/15m bars are still not stored natively, so an aggregated hour cannot be recomputed from them. The
rollup writes aggregate rows that are LABELLED as aggregate, which is a real improvement in what is knowable,
but it is not the same as a fidelity measurement.
`;

(async () => {
  const pool = await getPool();

  const existing = await pool.request().query(
    `SELECT id, name, LEN(CAST(info AS nvarchar(max))) AS info_len, state FROM Tasks WHERE id IN (1385, 1386)`);
  const byId = new Map(existing.recordset.map((r) => [r.id, r]));
  for (const id of [1385, 1386]) {
    const r = byId.get(id);
    if (!r) { console.error(`row #${id} not found — aborting rather than writing blind`); process.exit(1); }
    console.log(`#${id} state=${r.state} info=${r.info_len} chars  ${String(r.name).slice(0, 70)}`);
  }

  const already = await pool.request().query(
    `SELECT id FROM Tasks WHERE (edictId = 52 AND name LIKE 'TRD-GRD-6:%') OR info LIKE '%${MARK}%'`);
  const marks = already.recordset.length;
  console.log(`\nrows already carrying the marker (or a GRD-6 row): ${marks}`);

  const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  const sortOrder = Number(maxSort.recordset[0].m) + 1;

  const plan = [
    { kind: 'create', name: GRD6_NAME, info: COMMON },
    { kind: 'append', id: 1385, info: GRD4_ADD },
    { kind: 'append', id: 1386, info: GRD5_ADD },
  ];

  for (const p of plan) {
    if (p.kind === 'append') {
      const cur = byId.get(p.id);
      console.log(`  append #${p.id}: ${cur.info_len} -> ${Number(cur.info_len) + p.info.length} chars`);
    } else {
      console.log(`  create "${GRD6_NAME.slice(0, 60)}..." info ${p.info.length} chars`);
    }
  }

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  const now = new Date();
  // ⚠ plannedStart is NOT NULL and must be written in UTC or the row renders "Inactive" for 8 hours.
  const ins = await pool.request()
    .input('name', GRD6_NAME).input('info', COMMON)
    .input('plannedStart', now).input('sortOrder', sortOrder)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT inserted.id
            VALUES (@name, @info, @plannedStart, 1, 1, 52, @sortOrder, GETUTCDATE())`);
  const newId = ins.recordset[0].id;
  console.log(`\ncreated TRD-GRD-6 as #${newId}`);

  for (const p of plan.filter((x) => x.kind === 'append')) {
    const r = await pool.request().input('info', p.info).input('id', p.id)
      .query(`UPDATE Tasks SET info = ISNULL(CAST(info AS nvarchar(max)), '') + @info WHERE id = @id`);
    console.log(`appended #${p.id}: rowsAffected=${r.rowsAffected[0]}`);
  }

  // Verify by READING BACK, not by trusting the row counts above.
  const check = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS info_len,
            CASE WHEN CAST(info AS nvarchar(max)) LIKE '%${MARK}%' THEN 1 ELSE 0 END AS has_mark
       FROM Tasks WHERE id IN (1385, 1386, ${Number(newId)}) ORDER BY id`);
  console.log('\nverify:');
  for (const c of check.recordset) console.log(`  #${c.id} state=${c.state} info=${c.info_len} marker=${c.has_mark}`);
  const missing = check.recordset.filter((c) => !c.has_mark);
  console.log(missing.length ? `⚠ ${missing.length} row(s) LACK the marker` : 'all rows carry the marker');
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
