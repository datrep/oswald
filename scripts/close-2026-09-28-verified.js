// scripts/close-2026-09-28-verified.js — close ONLY rows whose work I verified by running a check this session.
//
// ⚠ EVERY ROW HERE WAS VERIFIED, NOT ASSUMED. The check that produced each closure is named in the note, so a
// reader can re-run it. Rows whose work is done but whose LIVE confirmation waits on the process restart are
// deliberately LEFT OPEN — a row closed on "the code is in place" is exactly TRD-87's subject ("a closed task is
// not evidence its defect is gone"), and the restart is what turns `in place` into `in force`.
//
//   node scripts/close-2026-09-28-verified.js          # report what would change
//   node scripts/close-2026-09-28-verified.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 closed##';

const ROWS = [
  {
    id: 1445, tag: 'TRD-GRD-7',
    note: `CLOSED 2026-09-28. The demo guard searched \`document.body.innerText\` for "switch to real money", and that
string lives in the ACCOUNT MENU — which \`innerText\` omits while COLLAPSED. \`not_demo\` is fail-closed at four call
sites, so the desk refused every other read while \`readAccount\` still returned a plausible balance off the always
visible banner: it read like a dead session and was misdiagnosed for roughly two days, with \`watchdog_login_death\`
firing every ~5 minutes as a downstream symptom.
VERIFIED: \`webtrader.js\` now has \`pageTextIncludingHidden\` (\`innerText + '\\n' + textContent\`), \`assertDemo\`
searches IT, and \`textContent\` is used for that exact-string check only — \`pageText\` stays \`innerText\` for the
layout and rendered-value parsers. Proven live at the open: the plus500 tick resumed (first tick in 59.6 hours) and
\`SESSION_LOCK\` cleared itself, so no workaround was needed.
⚠ RESIDUAL, retained: \`trading/public/js/app.js\` still renders the login chip from the watchdog's LAST OPINION with
NO AGE, while two lines below it \`// F4:\` already fixed the identical staleness for the wake line. Not part of this
row's ask and not done here.`,
  },
  {
    id: 1386, tag: 'TRD-GRD-5',
    note: `CLOSED 2026-09-28 on a RE-RUN, not on the earlier statement. Every \`plus500_chart\` 1h row is aggregated
from a 5m or 30m chart and NONE is native 1h, so the fidelity question is whether the aggregation is exact.
VERIFIED by re-running \`trading/scripts/repro/grd5-aggregate-fidelity.js\` this session:
    checkable 3297 · EXACT H+L match 3297 (100.0%) · max high error 0 · max low error 0
    rate_high_impossible 0 · rate_low_impossible 0
    VERDICT: FAITHFUL
★ The script prints its SOURCE POPULATION before the verdict, and that is load-bearing: the first version of this
measurement reported "16% wrong / 4871 errors" and every one was its own source-selection error (\`timeframe <> '1h'\`
admitted \`1d\`/\`4h\` rows, and symbol-only matching compared a \`yahoo\` series against \`plus500_chart\` hours).
⚠ RESIDUAL, retained in the row: fidelity of the AGGREGATED rows is now proven; PINNING the chart to native 1h is a
separate question (TRD-GRD-4) with an owner call attached, and the 5m/900s rows the 1h series is built from carry
their own range-fidelity question.`,
  },
  {
    id: 1404, tag: 'TRD-FED-1',
    note: `CLOSED 2026-09-28. Oil (yahoo_rest) lagged the venue by 2.3% for ~10 minutes during the 09-24 move, and
nothing recorded that the desk's price view disagreed with itself. The ask was that a venue disagreement be
DETECTED and LOGGED rather than silently averaged into a prompt.
VERIFIED LIVE: 19 \`price_divergence\` events on record, newest window 2026-09-27T20:35 .. 23:55Z — \`quant.pickTick\`
computes \`{maxSpreadPct, venues, mids, compared, freshVenues}\` over FRESH candidates only, the snapshot carries
\`priceDivergence\`, and \`wakePipeline\` emits one event per wake at >= 1%. Observed at the open: Sugar 5.79%
(plus500 18.535 vs yahoo 17.52) and Gold 1.06% (yahoo 4321.2 vs binance/okx 4276).
⚠ RESIDUAL, retained: the event records the DISAGREEMENT; nothing yet conditions on it. Whether a >1% venue
disagreement should refuse or resize the ticket is a policy question this row did not ask and does not answer.`,
  },
  {
    id: 1422, tag: 'TRD-DAT-1',
    note: `CLOSED 2026-09-28. The defect: pre-policy data silently produced three wrong answers in one session, the
last of which was written into a report as a conclusion — a wake census that called 237 self-describing wakes
"empty", a target-anchor study that averaged ONE mean over 57 trades spanning two stop regimes, and a Step-0
measurement whose sample was 83% pre-policy.
The ask was that the policy epoch be a RECORDED VALUE and the feature timeline a registry rather than a comment.
VERIFIED: \`FeatureEpochs\` exists with 4 rows; \`trading/agent/epoch.js\` carries \`ranges()\`, \`rangeFor()\`,
\`featuresBetween()\`, \`annotate({about})\` (returning \`regime\`, \`currentRegime\`, \`supersededBy\`, \`safe\`, \`reason\`),
\`windowLine()\` and \`sqlEpochJoin()\`; \`GET /api/trading/epoch\` is exposed and declared \`diagnostic\` in
\`test/ui-routes.test.js\`; and a check confirms the epoch constant is NOT restated in the aggregator (one definition).
★ AND IT IS NOW CONSUMED, WHICH IS THE PART THAT USUALLY GETS LEFT UNDONE: \`fieldContracts.venueLevelGeometry\` reads
its boundary from the registry BY REFERENCE (\`FEATURES.find(f => f.id === 'stop-cap').landedAt\`), so the F20 floor
check measures one era and names the rows it excludes. 10 tests.
⚠ RESIDUAL, retained: the registry covers the features whose landing dates were recorded; a feature added without
an entry is a boundary a reader crosses blind, which is why \`test/epoch-registry.test.js\` fails when a CLOSED row
carries a landing date newer than the newest entry.`,
  },
  {
    id: 1430, tag: 'LST-16',
    note: `CLOSED 2026-09-28. \`Listings.other\` was written by the service and rendered NOWHERE, so a clearance sold
at a loss read as an ERROR on the workbench rather than as a deliberate decision.
VERIFIED: the column exists; \`listings/public/js/app.v2.js\` has the \`f-other\` field in \`listingForm\`, \`saveListing\`
sends \`other\`, \`searchText\` has the previously-missing \`listings\` case (the search box could not find listings at
all), and the \`.adj-mark\` superscript renders on Net. \`listings/public/css/main.css\` carries the rule.
⚠ RESIDUAL, retained: the value is recorded and displayed; nothing validates it against the parts' arithmetic, so
"other" remains an explanation a human reads rather than a number the margin is computed from.`,
  },
  {
    id: 1406, tag: 'TRD-PNL-1',
    note: `CLOSED 2026-09-28. The defect: a single P/L column was OVERWRITTEN at 2.4-second cadence, so the path a
trade took was destroyed by the act of observing it — the minimum and maximum excursion could not be recovered
afterwards, which is exactly what an exit-policy counterfactual needs.
VERIFIED: \`Trades\` carries \`netPnlMin\`, \`netPnlMax\`, \`netPnlSamples\` and \`netPnlTerminal\`; the \`NetPnlPath\`
extended property is present (859 chars on \`netPnlMin\`, carrying the reasoning); \`store.updateTrade\` widens the
min/max, increments the sample count, and FREEZES \`netPnlTerminal = ISNULL(netPnlTerminal, floatingPnl)\` on close so
the terminal value cannot be rewritten by a later tick. 4 tests in \`test/net-pnl-path.test.js\`.
⚠ RESIDUAL, MEASURED RATHER THAN ASSUMED: of 98 trades, **1 carries any samples and 0 has a terminal value** — a path
is only recorded while a position is live, so the field is wired but has not yet been EXERCISED. Trust it after the
next closed position, not before.`,
  },
];

(async () => {
  const pool = await getPool();
  const ids = ROWS.map((r) => r.id);
  const cur = await pool.request().query(
    `SELECT id, state, LEFT(name, 60) AS name, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id IN (${ids.join(',')}) ORDER BY id`);
  const byId = new Map(cur.recordset.map((r) => [r.id, r]));

  for (const r of ROWS) {
    const row = byId.get(r.id);
    if (!row) { console.error(`⚠ #${r.id} (${r.tag}) NOT FOUND — aborting rather than closing blind`); process.exit(1); }
    console.log(`#${row.id} ${r.tag.padEnd(11)} state=${row.state} info=${String(row.len).padStart(6)} -> ${Number(row.len) + r.note.length + MARK.length + 4}  ${row.name}`);
  }

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  for (const r of ROWS) {
    const row = byId.get(r.id);
    if (row.state === 3) { console.log(`#${r.id} already closed — skipping`); continue; }
    // ⚠ Only `info` gains the note and `state` moves to the Archived band. plannedStart/updatedAt are untouched:
    // 1 = Draft (open band), 2 = Published, 3 = Archived = the DONE pile on this edict.
    await pool.request()
      .input('note', `\n${MARK}\n${r.note}\n`).input('id', r.id)
      .query('UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @note, state = 3 WHERE id = @id');
    console.log(`✔ #${r.id} ${r.tag} closed`);
  }

  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id IN (${ids.join(',')}) ORDER BY id`);
  console.log('\nread-back:');
  for (const r of chk.recordset) console.log(`  #${r.id} state=${r.state} info=${r.len}`);
  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('edict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  const all = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks GROUP BY state ORDER BY state');
  console.log('all tasks by state: ' + all.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
