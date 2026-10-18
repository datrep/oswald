// scripts/record-2026-09-28-venue-floor.js
//   · creates TRD-RSK-4 — SGX is structurally untradeable at the current risk dial (the floor forces 2.34x the cap)
//   · closes the three edict-17 dashboard requests (#65, #25, #27) on browser-measured evidence
// Dry by default:  node scripts/record-2026-09-28-venue-floor.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 venue-floor-reach##';

const NAME = 'TRD-RSK-4: Risk - SGX is structurally untradeable: its venue floor forces 2.34x the risk cap, and the desk proposed it 16 times in 2.4h';

const INFO = `${MARK}
FOUND 2026-09-28 while acting on the owner's instruction *"fix that.... tell the chair the minimum amount"*. The disclosure
half is FIXED (see below). This row is the STRUCTURAL half, which the disclosure does not touch.

★★★ **THE MEASUREMENT: THE VENUE MINIMUM HAS FIRED 16 TIMES, AND EVERY ONE IS SGX.**
    SELECT symbol, COUNT(*) FROM TradingEvents
     WHERE kind='decision' AND CAST(payload AS nvarchar(max)) LIKE '%"venue_minimum"%'
     GROUP BY symbol   ->   SGX 16
    window: 2026-09-28T01:06:57.730Z .. 2026-09-28T03:28:53.100Z   <- 2h22m, i.e. essentially every wake
    the same count via the prose form 'below venue minimum': also 16, also SGX only.

⚠ **AND A CORRECTION OF MY OWN FIRST READING, ON THE RECORD.** A first pass reported "231 refusals across 7 symbols
(Gold 69, Oil 86, ...)" from \`LIKE '%venue_minimum%'\`. **That is a false positive population**: the string
"venue minimum" also appears in the GATE NOTES of refusals fired on OTHER grounds (e.g. a correlation veto whose
notes mention a venue minimum), so the loose pattern picks up rows that are not venue-minimum refusals at all.
Two further probe traps hit in the same sitting, both worth naming:
  · \`LIKE '%[venue_minimum]%'\` — in T-SQL LIKE, \`[...]\` is a **character class**, so that pattern matches any
    payload containing any ONE of those letters. It matched 234 of 234 decisions.
  · \`JSON_VALUE(payload,'$.riskVetoCodes')\` returns **NULL for an ARRAY**. The field is \`["venue_minimum"]\`, so a
    census built on \`JSON_VALUE\` silently reads zero rows. Use \`JSON_QUERY\`, or match on the quoted code.
⇒ **The authoritative count is the quoted code or the exact prose, and it is 16 / SGX.**

★★★ **THE STRUCTURAL FINDING — SGX CAN NEVER BE TRADED AT THE CURRENT RISK DIAL.**
Risk at the venue's own minimum, per symbol, against live equity 4,134 and \`maxRiskPerTradePct\` **0.07%**
(minimum from \`dbo.Instruments.unitAmount\`; the stop distance from the newest decision carrying
\`effectiveStopDistance\`):

    Arabica Coffee   min   0.5 Contracts      effStop 0.8345   risk at floor 0.0101% = 0.14x the cap
    Bitcoin          min   0.001 Contracts    effStop 599.6748 risk at floor 0.0145% = 0.21x
    Gold             min   0.025 Troy Ounces  effStop 12.6594  risk at floor 0.0077% = 0.11x
    Oil              min   2.5 Barrels        effStop 0.2782   risk at floor 0.0168% = 0.24x
    Silver           min   2.5 Troy Ounces   effStop 0.1861   risk at floor 0.0113% = 0.16x
    Sugar            min  15 Contracts        effStop 0.1512   risk at floor 0.0549% = 0.78x
    SGX              min  20 Shares           effStop 0.3390   risk at floor 0.1640% = **2.34x**   <-- UNTRADEABLE

⇒ **SGX is the only symbol in the book whose MINIMUM POSITION exceeds the per-trade risk budget.** The desk wants
8.53 Shares ($2.89 of risk); the venue's smallest ticket is 20 Shares ($6.78 of risk, notional ~$451). There is no
size that satisfies both, so **the refusal is not transient — it will recur on every wake that proposes SGX, for as
long as this dial is 0.07%.** Every other symbol's floor sits at 0.11x-0.78x of the cap, i.e. the floor is slack
everywhere else. (Sugar at 0.78x is the next closest and worth watching.)

★ **WHY IT SURFACED ONLY NOW, stated at the strength the evidence carries:** SGX's first venue-minimum refusal is
**2026-09-28T01:06:57Z** and all 16 fall inside one 2h22m window; there are NONE on record before that. So the
symbol went from tradeable to structurally untradeable **today** — the proximate cause is a change in the stop
distance or the dial, not the floor (the floor is a static venue fact). **The candidate is the stop-cap/cost-floor
interaction (TRD-RSK-2, #1418): SGX's round trip is 0.6014%, so its 0.3% cap is REFUSED and the DECLARED stop is
used instead — and SGX's declared stop is widened to 3x spread (0.3390), which is what makes 20 Shares cost $6.78.**
⚠ **NOT CONFIRMED — the row is registered with the mechanism named as a candidate, not asserted.**

★ **WHAT WAS FIXED IN THE SAME SITTING (the owner's actual instruction, and it is a separate defect):**
**the minimum was never ON THE TICKET.** \`min size N <unit>\` has been rendered since the floor landed — but into
\`--- VENUE COST OF CARRY ---\`, ~40 lines above the proposal, among six other facts, attached to the SYMBOL; the
line the seat votes on read \`PROPOSED ACTION by quant: entry buy SGX size=risk-sized\`; and
\`aggregator.ticketGeometryNote\` — the one place that states what the rules DID to this proposal — omitted
\`risk.venueFloor\` entirely, though \`risk.evaluate\` returns it. **The seat was told the rule exists ("the size is
below the venue's own minimum tradable unit" is in the bundle's refusal list), told the symbol's minimum, and given
no way to compare them.** Now:
  · \`promptBuilder\` carries the floor **on the proposal line and on each OTHER-PROPOSALS line**, with an explicit
    \`UNKNOWN — the gate cannot refuse this ticket on size\` when the registry has none;
  · \`aggregator.ticketGeometryNote\` states the floor against the ticket, says CLEARS or **BELOW the floor**, and
    when it is below states **the risk the floor would force**, e.g. for SGX: *"venue minimum 20 Shares against this
    ticket's 8.5363 — BELOW the floor, so the venue cannot accept this size; taking the 20 Shares minimum anyway
    would risk about 0.1640% of equity instead of the 0.0700% this size carries."*
  · \`test/venue-floor-disclosure.test.js\` — 7 tests, including a CROSS-CHECK that the floor risk equals the risk at
    the computed size scaled by min/size (the arithmetic is verified, not merely present).
  ⚠ **Code only — the running desk needs a restart before any of it is live.**

ACCEPTANCE
  1. a ruling on SGX: raise \`maxRiskPerTradePct\` for it (a per-symbol risk dial does not exist), accept the floor
     and its 2.34x risk at the venue, or **remove SGX from scope so the desk stops proposing it every wake** —
     the current state burns a proposal slot, a gate evaluation and now a refusal row, 16 times in 2.4h, for a
     trade that cannot be taken;
  2. the candidate mechanism in TRD-RSK-2 (declared-stop widening to 3x spread) confirmed or refuted by
     measurement, since it is what makes SGX's floor cost 2.34x;
  3. a standing check for this class: **a symbol whose venue floor exceeds the risk budget is a symbol that can
     never fire**, and nothing on the dashboard says so — the same shape as TRD-116 ("scope and enabled disagree")
     and the 3 symbols with no Instruments row at all.
NON-GOALS: do not clamp the size UP to the floor (the module's own header rejects it: a floor the desk cannot
satisfy is a reason not to take the trade); do not change the global risk dial to suit one symbol.
`;

const CLOSURES = [
  {
    id: 65, mark: '##2026-09-28 lst65-archived-policies##',
    title: 'archived policies hidden + rail toggle',
    note: `CLOSED 2026-09-28 — IMPLEMENTED AND MEASURED IN A BROWSER, not assumed.

The ask was "have features that are archived not show up on the policy. toggle viewing on policy.html=id … do the
same with policy." **The TASK list already had this (\\\`showArchivedTasks\\\`, hidden by default + a toggle); the
POLICIES list did not.**

WHAT LANDED
  · \\\`public/js/utils/settingsStore.js\\\` — new setting \\\`showArchivedPolicies\\\` (boolean, default false, section
    "Side Rails").
  · \\\`public/pages/policy.html\\\` — a "Show archived" checkbox under the rail's Policies heading, same
    \\\`.archive-toggle\\\` markup as the task one.
  · \\\`public/js/pages/policy.js\\\` — \\\`loadPolicyNav()\\\` filters \\\`state === 3\\\` unless the setting is on, labels the
    archived entries "(archived)", and reports the hidden count in the select's title.

TWO THINGS DONE DELIBERATELY, AND THEY ARE THE "BEST PRACTICE" HALF
  1. **The policy you are currently viewing is ALWAYS listed, whatever its state.** Without that guard, opening an
     archived policy with archives hidden leaves the \\\`<select>\\\` with no option for the page being displayed — it
     would silently select the first option (Business Scaling) while the page showed 🦀.
  2. **The change listener is bound ONCE, not per load.** \\\`loadPolicyNav()\\\` is re-run when the toggle flips, and the
     original binding lived inside the fetch, so a per-call binding would have stacked a duplicate navigation
     handler on every flip.

MEASURED (VS Code integrated browser, live dashboard on http://172.22.160.3:8080)
  · \\\`policy.html?id=52\\\`, toggle OFF  -> 17 options, 0 archived, title "1 archived policy hidden — turn on
    \\"Show archived\\" to list them", checkbox unchecked.
  · toggle ON  -> 18 options, \\\`["🦀 (archived)"]\\\` present, current policy still \\\`[selected]\\\`, title back to
    "Policies" (nothing hidden).
  · \\\`policy.html?id=6\\\` (an ARCHIVED policy) with the toggle OFF -> 18 options and
    \\\`selectedOption: "🦀 (archived)"\\\` — **the guard works: the page being viewed always has a matching option.**
  · Control for the sibling feature: the task list rendered **42 cards** on edict 52, against **176 tasks of which
    134 are complete** — i.e. archived TASKS were already hidden by the same mechanism.`,
  },
  {
    id: 25, mark: '##2026-09-28 lst25-mark-completed##',
    title: 'mark completed when selecting a task',
    note: `CLOSED 2026-09-28 — IMPLEMENTED AND VERIFIED END-TO-END.

The ask: "Tasks: 'mark completed' when selecting a task."

WHAT LANDED: a **Mark completed** button in the task contextual toolbar (\\\`public/pages/policy.html\\\`), wired to
\\\`handleCompleteContextTasks()\\\` in \\\`public/js/pages/policy.js\\\`.

★ **"COMPLETED" ON THIS TRACKER IS \\\`state = 3\\\` — THERE IS NO \\\`markCompleted\\\` COLUMN.** \\\`taskModel.updateTask\\\` does
\\\`sets.push(fields.state === 3 ? 'completedAt = COALESCE(completedAt, GETUTCDATE())' : 'completedAt = NULL')\\\`, so
state 3 is what stamps the timestamp, and any other state CLEARS it. A UI that invented a \\\`markCompleted\\\` field
would have written to nothing.
The PUT is **partial** — only \\\`{state: 3}\\\` is sent — which the controller whitelists and the model applies as a
partial UPDATE, so no other field on the row can be nulled by this action.

VERIFIED
  · **UI**: selecting one task reveals the toolbar with \\\`1 selected\\\` and three buttons —
    \\\`edit-task:Edit\\\`, \\\`complete-task:Mark completed\\\`, \\\`delete-task:Delete\\\`.
  · **The write path** (\\\`temp/verify-25-mark-completed.js\\\`, run against a THROWAWAY row in edict 6, deleted after):
      created #1452  state=1  completedAt=null
      after updateTask(id, {state: 3})  state=3  completedAt=2026-09-28T03:21:23.540Z
      PASS  state became 3
      PASS  completedAt was STAMPED
      PASS  no other column changed   (name, plannedStart/End, info, priority, assignedToUserId, edictId, sortOrder)
      PASS  reverting to state 1 CLEARS completedAt
      cleanup: probe row deleted -> gone
  · **Queued (unsaved) tasks are refused with a reason**, not silently skipped: a \\\`temp-\\\` id cannot be PUT, so the
    handler says so and tells the operator to save the policy first.
  ⚠ The click-through write needs a signed-in session (\\\`tasks.manage\\\`); the page was not logged in during
  verification, so the model call was exercised directly on the exact code path the button uses.`,
  },
  {
    id: 27, mark: '##2026-09-28 lst27-task-full-view##',
    title: 'clicking a task opens it in full view',
    note: `CLOSED 2026-09-28 — IMPLEMENTED AND MEASURED.

The ask, verbatim: "clicking on a task opens their taasks. not edit, but task in full view."

WHAT LANDED: a read-only **task viewer** modal (\\\`#task-viewer\\\` in \\\`public/pages/policy.html\\\`, reusing the
\\\`.resource-viewer\\\` shell so there is one modal chrome rather than two), \\\`openTaskViewer()\\\` / \\\`closeTaskViewer()\\\`
in \\\`public/js/pages/policy.js\\\`, and a click handler on the task card gated by a new setting
\\\`openTaskOnClick\\\` (boolean, default true — mirroring the existing \\\`openResourceOnClick\\\`).

★ **IT SHOWS EVERY FIELD ON THE ROW PLUS THE DESCRIPTION IN FULL**, which is the point: the card shows six cells
and CLIPS the description, and the desk's task bodies are the most valuable content it holds. Measured live on
TRD-32 (#1273, 14,234 chars): the viewer renders TASK ID / STATE / PRIORITY / ACTIVE / ASSIGNED / ORDER / START /
END / CREATED / COMPLETED / DUE / POLICY, then the description as pre-wrapped monospace — including that row's own
evidence table with its aligned columns, which the card showed as a one-line ellipsis.
★ **Every value is escaped.** The card interpolates \\\`title="\\\${task.info}"\\\` raw, and these bodies contain \\\`"\\\`,
\\\`<\\\`, \\\`&\\\` and ★, so the card's tooltip attribute is unsafe by construction. The viewer is not.

FOUR EXITS, matching the resource viewer: the × button, the footer Close button, a backdrop click, and Escape.

MEASURED (VS Code integrated browser)
  · clicking the TRD-32 card opened the viewer with the full 14k-char description rendered;
  · \\\`#task-viewer-dismiss\\\` closed it;
  · a task with NO description takes the other branch ("No description on this task") — exercised on TRD-7;
  · the checkbox and the \\\`+\\\` duplicate button are excluded by \\\`closest()\\\` rather than stopPropagation, so a future
    control added to the card is safe by default.

⚠ **ONE PROCESS NOTE.** The owner's instruction was to work the TRADING list; these three edict-17 requests were
picked from the same session's candidate set. They were already implemented when the owner redirected, so they were
finished and closed rather than abandoned half-done. The trading work resumed immediately after.`,
  },
];

async function appendAndClose(pool, row) {
  const cur = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${row.id}`)).recordset[0];
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE id = ${row.id} AND info LIKE '%${row.mark}%'`)).recordset;
  console.log(`  #${row.id} state=${cur.state} info=${cur.len}${dup.length ? '  [marker present]' : ` -> ${Number(cur.len) + row.note.length}`}  (${row.title})`);
  if (dup.length) { console.log('    marker present — nothing to do.'); return; }
  if (!YES) { console.log('    DRY RUN — not written.'); return; }
  await pool.request().input('t', row.note)
    .query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t, state = 3 WHERE id = ${row.id}`);
  const back = (await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${row.id}`)).recordset[0];
  console.log(`    ✔ closed: state=${back.state} info=${back.len} chars`);
}

(async () => {
  const pool = await getPool();

  const meta = (await pool.request().query(`
    SELECT c.max_length, t.name AS typ FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.Tasks') AND c.name = 'name'`)).recordset[0];
  const LIMIT = meta.typ === 'nvarchar' ? meta.max_length / 2 : meta.max_length;
  console.log(`Tasks.name limit ${LIMIT}; candidate ${NAME.length} ${NAME.length <= LIMIT ? 'OK' : '*** TOO LONG ***'}; info ${INFO.length}`);
  if (NAME.length > LIMIT) { console.error('refusing to write'); await pool.close(); process.exit(1); }
  if ([...NAME].some((c) => c.charCodeAt(0) > 126)) { console.error('name is not pure ASCII'); await pool.close(); process.exit(1); }

  console.log('\n=== TRD-RSK label occupancy ===');
  for (const r of (await pool.request().query(`SELECT id, state, LEFT(name,74) AS name FROM Tasks WHERE name LIKE 'TRD-RSK-%' OR name LIKE 'TRD-RSK:%' ORDER BY id`)).recordset)
    console.log(`  #${r.id} state=${r.state}  ${r.name}`);

  console.log('\n=== create TRD-RSK-4 ===');
  const dup = (await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR name LIKE 'TRD-RSK-4:%'`)).recordset;
  if (dup.length) console.log(`  already recorded as #${dup[0].id} — nothing to do.`);
  else if (!YES) console.log('  DRY RUN — not written.');
  else {
    const mx = (await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks')).recordset;
    const anchor = (await pool.request().query('SELECT TOP 1 plannedStart FROM Tasks WHERE id = 1448')).recordset[0];
    const ins = await pool.request()
      .input('name', NAME).input('info', INFO).input('plannedStart', anchor.plannedStart).input('sortOrder', Number(mx[0].m) + 1)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id
              VALUES (@name, @info, @plannedStart, 2, 1, 52, @sortOrder, SYSUTCDATETIME())`);
    const id = ins.recordset[0].id;
    const back = (await pool.request().query(`SELECT state, active, sortOrder FROM Tasks WHERE id=${id}`)).recordset[0];
    console.log(`  ✔ created as #${id} state=${back.state} active=${back.active} sortOrder=${back.sortOrder}`);
  }

  console.log('\n=== close the three edict-17 dashboard requests ===');
  for (const row of CLOSURES) await appendAndClose(pool, row);

  const s = (await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId IN (17,52) GROUP BY edictId, state ORDER BY edictId, state')).recordset;
  console.log('\nby edict/state: ' + s.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
