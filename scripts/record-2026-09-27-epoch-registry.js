// scripts/record-2026-09-27-epoch-registry.js — the evidence-provenance mechanism, appended to TRD-DAT-1 (#1422).
// Dry by default.
//   node scripts/record-2026-09-27-epoch-registry.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 epoch-registry##';
const TASK_ID = 1422;

const ADD = `

${MARK}
★★ THE MECHANISM, built because a constant was not enough. The owner's ask, verbatim: *"what if we shift it to
comments and mechanisms that allow an LLM to set the date range, and know of the timeline of features added in so
that [data isn't] being retroactively placed as data made by current version of the codebase. that'll be safer, and
will notify the LLM every time it reads those data."*

★ WHY THAT IS THE RIGHT SHAPE OF FIX. The section above made the cutoff a **recorded value** (\`2026-09-21\`). A value
still requires the reader to *remember to apply it*, and this session produced three separate wrong measurements
because a reader did not. A registry instead hands the reader the provenance **as part of the answer**, so forgetting
is no longer possible on that path. *An epoch filter fixes a contaminated measurement; a delete removes the baseline*
— and a registry fixes the **reader**, which is the actual fault.

★★ **THE FEATURE TIMELINE IS NOW DATA: \`trading/agent/epoch.js\`.** A hand-written \`FEATURES\` list of **14** entries,
each carrying \`id\`, \`landedAt\`, the Oswald **task row** that landed it (\`row\`), a title, and — the field that makes
it more than a changelog — **\`invalidates\`**: a sentence stating *what a measurement can no longer claim* if it
reaches across that boundary. Exported alongside it: \`EPOCH\`, \`ranges()\`, \`rangeFor()\`, \`featureOn()\`,
\`featuresBetween()\`, \`annotate()\`, \`windowLine()\`, \`sqlEpochJoin()\`.

**Four contiguous, disjoint regimes** (\`ranges()\` groups the features by \`landedAt\`; a day that landed more than one
feature becomes one \`day-<date>\` range rather than several overlapping ones):

    stop-cap           2026-09-19 .. 2026-09-21    declared 0.702% stop CAPPED to 0.30%
    policy-epoch       2026-09-21 .. 2026-09-25    the boundary the owner has ruled on three times
    day-2026-09-25     2026-09-25 .. 2026-09-27    bars failure no longer fatal; single wake emitter
    day-2026-09-27     2026-09-27 .. open          chair context, cost-floor disclosure, veto codes

★★ **THREE CHANNELS, because an agent reaches the data three different ways** — the ask was "notify the LLM every
time it reads those data", and there is no single read path to hook:

  1. **HTTP** — \`GET /api/trading/epoch\`. No range returns the whole timeline and the rule, so an agent can discover
     the boundaries *before* choosing a window. \`?since=&until=\` returns \`{safe, crossesEpoch, spansEpochBoundary,
     featuresInWindow, caveats}\`. \`?about=\` names the regime a single date sat in.
  2. **RAW SQL** — the \`v*WithEpoch\` views (\`vTradingEventsWithEpoch\`, \`vTradesWithEpoch\`, \`vTradingPromptsWithEpoch\`,
     \`vPriceBarsWithEpoch\`) carry the regime on every row by joining \`FeatureEpochs\` on a half-open
     \`landedAt <= t < nextLandedAt\`. A reader who never touches Node still gets the boundary, AND three
     \`EpochNotice\` **extended properties** restate the rule on \`TradingEvents\`/\`Trades\`/\`PriceBars\` for anyone
     browsing the schema in SSMS. This channel matters most: **comments do not survive a query, and a view does.**
  3. **SOURCE** — the reasoning is in the module's own comments, for an agent reading files rather than rows.

★ **\`FeatureEpochs\`** (\`trading/sql/2026-09-27-feature-epochs.sql\`, run via \`sqlcmd -E\` because the app login has no
DDL rights) + index \`IX_FeatureEpochs_range\`; kept in sync by \`scripts/sync-feature-epochs.js\`, which imports
\`ranges()\` **by reference** rather than restating the dates — a literal copy is a second implementation that will
drift, which is exactly the defect recorded below.

★ **VERIFIED LIVE, not just written.** \`sync-feature-epochs.js\`: "FEATURES 14 -> 4 contiguous date ranges", ranges
proven contiguous and disjoint, 4 upserts, and a **join check over the newest 5,000 \`TradingEvents\`: 5,000 rows, 0
unmatched** — a boundary typo would have shown as unmatched rows and would have shown as nothing else.
\`temp/verify-epoch-api.js\` exercises all four endpoint shapes against the running desk: a spanning window returns
\`safe:false, crossesEpoch:true\` with 9 boundaries and named caveats; a single-regime window returns \`safe:true,
caveats:0\`; \`about=2026-09-28\` returns the regime in force. \`test/epoch-registry.test.js\`: **10 tests**.

★★ **THREE DEFECTS THE MECHANISM FOUND IN ITSELF, which is the evidence that the pins are load-bearing and not
decoration:**

  1. **A module and a table disagreed on the NAME of a regime.** \`annotate({about})\` answered with the *feature* id
     (\`chair-sees-panel\`) while \`FeatureEpochs\` answered with the *date bucket* (\`day-2026-09-25\`), so one day had
     two names and a reader asking the API could not join what a reader querying the table saw. Caught by this
     section's own test. Fixed by making \`ranges()\` the **single implementation** and having both the annotation and
     the sync script derive from it. *Derive a shared fact in one place, or two places will disagree.*

  2. **★★ \`safe\` MEANT TWO DIFFERENT THINGS, and the wrong one was the dangerous one.** For a *window* it meant "this
     range sits inside one regime". For a *single date* the first version set it to "a regime exists" — so
     \`?about=2026-09-20\`, a date inside the **superseded** \`stop-cap\` regime whose own \`invalidates\` field says its
     geometry is not comparable with what followed, came back **\`safe: true\`**. An agent reading that flag would have
     pooled superseded data with current data — *the precise mistake this mechanism was built to prevent, reintroduced
     by the mechanism's own flag.* A boolean that means "there is a row" is not a boolean a reader can act on.
     \`safe\` now answers the reader's real question in **both** shapes — *is this produced by the code running now?* —
     and an older regime returns \`safe:false\` with \`currentRegime:false\`, \`supersededBy:<regime>\` and a reason naming
     what replaced it. The old regime is still NAMED, because it is documented history, not because it is usable.

  3. **My own verification check was wrong, and the code was right.** The check asked \`?about=2026-09-18\` and expected
     \`stop-cap\`; it returned \`pre-registry\`. The earliest entry is \`2026-09-19\`, so \`2026-09-18\` genuinely has no
     recorded regime, and \`pre-registry\` with \`safe:false\` is the honest answer — a registry that reached backwards
     to cover a date it holds no entry for would be *inventing* provenance. The check was corrected, not the code.
     *Print the raw shape before trusting a derived value*; here the raw shape corrected the expectation written for it.

★ **AND THE ROUTE GUARD CAUGHT THE NEW ENDPOINT.** \`test/ui-routes.test.js\` failed on the first full run — "these
routes have no click path and no declared decision: \`GET /api/trading/epoch\`" — so the endpoint is now declared in
\`SCRIPT_ONLY\` as **\`diagnostic\`**, with the reason stated: its reader is an agent over HTTP, not a person clicking,
and it is *not* \`script-only\` because nothing runs it on a cadence. The guard demanding a **decision** rather than
allowing silence is why a new route could not be added quietly.

★ **FULL SUITE GREEN:** **1,525 tests, 1,524 pass, 0 fail, 1 skipped** (the skip is pre-existing), run after these
changes on a restarted desk (\`healthz: ok\`). Nothing in the epoch work alters a threshold, a gate, a strategy or any
live score: it adds a table, four views, three extended properties, one read-only endpoint, one module, one sync
script and one test file.

⚠ **THE MECHANISM'S OWN WEAKNESS, stated here rather than discovered later: the registry is a HAND-WRITTEN list.** It
can only name boundaries someone recorded. Its failure mode is **silence about a feature that landed with no entry**,
and it cannot detect that gap — which is precisely the class of mistake that put this row on the desk. Two things keep
it honest rather than merely asserted: the test pins that the registry covers the boundaries this session actually
relied on, and anything before the first entry answers **\`pre-registry\`, \`safe:false\`** rather than being silently
absorbed into the nearest regime. So the mechanism's unknown is *loud*: an unrecorded feature produces a window that
still spans a boundary it cannot name. **Adding a feature means adding an entry — that is now part of landing it.**
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT id, name, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${TASK_ID}`);
  if (!cur.recordset.length) { console.error(`#${TASK_ID} not found — aborting`); process.exit(1); }
  const c = cur.recordset[0];
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#${TASK_ID} [${c.name.slice(0, 50)}] state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${TASK_ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${TASK_ID}`);
  console.log(`✔ #${TASK_ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
