// scripts/create-trd-reg1-task.js — register the duplicate-label defect found 2026-09-24.
//
// TRD-REG-1 was NOT in any approved task set. Registered under the owner's standing rule that a novel,
// repo-specific finding becomes a policy/task rather than only a memory note.
//
// Same discipline as scripts/create-trd-shw4-task.js: writes through `models/taskModel.createTask` so
// `sortOrder` is allocated per edict and `completedAt` is set by the STATE, never by the caller.
//
// ★ THE TWO SCHEMA TRAPS (both hit on 2026-09-24; also recorded in create-trd-aih1-task.js):
//   1. `Tasks.plannedStart` is NOT NULL and there are NO column defaults, so it cannot be omitted.
//   2. `Tasks.active` is COMPUTED — `GETUTCDATE() >= plannedStart` (sql/migrations/013_utc_edicts_tasks.sql:101)
//      — and must never be named in an INSERT. A raw `GETDATE()` writes the server's LOCAL wall-clock (SGT,
//      UTC+8 on this box), which is 8 hours ahead of the UTC comparison, so the row lands with active = 0:
//      created, present, and reading as not-yet-started. Passing a JS `Date` through createTask is correct
//      because the mssql driver writes it as its UTC wall-clock.
//
// Usage (from the repo root):
//   node scripts/create-trd-reg1-task.js          # DRY RUN — prints exactly what would be written
//   node scripts/create-trd-reg1-task.js --yes    # writes
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;   // "Trading Agent"
const OPEN = 1;
const TODAY = new Date(); // written as UTC wall-clock — this is what makes `active` compute to 1

const NAME = 'TRD-REG-1: Register — tasks.name has no uniqueness check, so a label can point at two open tasks (4th occurrence)';

const INFO =
  'FOUND 2026-09-24 by inspection of the register while answering "any outstanding tasks?" — a by-product of '
  + 'reading the register, not of a code change.\n\n'
  + '★★ THE REGISTER HAS NO UNIQUENESS CHECK ON A LABEL, AND THIS IS THE FOURTH TIME IT HAS COST TIME. '
  + '`Tasks.name` carries no constraint — only `id` does (verified from INFORMATION_SCHEMA.COLUMNS on dbo.Tasks: '
  + 'NOT NULL = id, name, plannedStart, sortOrder, active, with `active` a COMPUTED column; there are no column '
  + 'defaults). Measured 2026-09-24 over the 147 TRD-labelled rows: **135 distinct labels, 3 repeated '
  + 'prefixes.** Two are live defects and **all four of their rows are OPEN**:\n'
  + '  TRD-118 -> id 1370 ("closeAt is COARSE on 39% of closes - and the captured tick path is NOT offset") '
  + 'AND id 1387 ("Learning - a hand retirement is NOT remembered").\n'
  + '  TRD-119 -> id 1371 ("exits - the exit chair verdicts are still compared to NOTHING") AND id 1388 '
  + '("Learning - the desk runs TWO R conventions").\n\n'
  + '⚖️ THE THIRD REPEAT IS **NOT** A DEFECT, AND IT REFUTES THE OBVIOUS FIX. `TRD-12` appears **11 times** '
  + '(ids 200-210: Learning / Analytics / Risk / Backtest / Orders / Data / Connector / Budget / Strategy / Nav, '
  + '10 closed + id 210 open) — that IS the house convention for a numbered SET split by domain, because the '
  + 'convention says a function name of 4+ letters goes in the DOMAIN rather than as its own segment. ⇒ '
  + '**A unique index on the label prefix would be WRONG: it would fail the existing register.** Repetition is '
  + 'only a defect when it was not intended, and no constraint can express intent — so the guard must be a '
  + 'pre-insert ADVISORY plus a checker with an explicit, documented allowlist. The recommendation on record '
  + '(2026-09-24) was "a unique index on a normalised label prefix, or a pre-insert check"; **the index half is '
  + 'now measured to be wrong**, and that correction is the main content of this task.\n\n'
  + 'PRIOR OCCURRENCES — the class is documented, the fix never landed:\n'
  + '  1. `TRD-36` — the options plan cites `TRD-36: SPOT-1` as its one pre-gate item that "ships now", while '
  + 'the register\'s TRD-36 (id 1277) is "chgPct horizon - a 120-bar lookback labelled a 5-minute move"; and '
  + '`plus500/webtrader.js:693` carries `// TRD-36: accept only a class-correct title`, so anyone following '
  + 'that comment lands on the wrong task.\n'
  + '  2. `TRD-EVD-1` — id 1394 was registered while id 1374 already held the label ("Strategy evidence - '
  + 'condition-paired decision unit"). Corrected by renaming 1394 -> TRD-EVD-2.\n'
  + '  3./4. the two above.\n\n'
  + 'WHY IT MATTERS HERE MORE THAN ELSEWHERE: the label is the ONLY citation handle this repo uses — docs, '
  + 'pre-registrations, code comments and task bodies all cite `TRD-n`. Two OPEN rows behind one label make the '
  + 'citation unresolvable at exactly the moment someone is trying to act on it, and this repo has already '
  + 'spent 13 days aimed at the wrong object through a stale reading (the PRDS hunt, TRD-STR-4).\n\n'
  + 'FIX, TWO INDEPENDENT PARTS:\n'
  + '  (a) the DATA — rename the NEWCOMERS, following the EVD-2 precedent that the row arriving second yields: '
  + '1387 -> `TRD-LRN-1`, 1388 -> `TRD-LRN-2` (`LRN` verified free in the label inventory; the domain is '
  + '"Learning"). Nothing in the workspace cites TRD-118 or TRD-119 (grepped), so the rename is safe.\n'
  + '  (b) the GUARD — `models/taskModel.createTask` should warn-or-refuse when the same label prefix already '
  + 'exists and name the existing row, unless the caller declares a set; and '
  + '`node scripts/task-label-hygiene.js --check` must exit non-zero on any repeat NOT in an explicit '
  + 'documented allowlist, with the allowlist entry carrying its own reason (currently `TRD-12`, with its 11 '
  + 'ids, so the exception is visible rather than folkloric).\n\n'
  + 'DELIVERED 2026-09-24: `scripts/task-label-hygiene.js` (report / --fix, with the allowlist and the '
  + 'newcomer-yields repair); 1387/1388 renamed; this task registered.\n\n'
  + 'ACCEPTANCE: (1) `--check` exits 0 today and non-zero the moment an unexpected repeat appears; (2) the '
  + 'allowlist names `TRD-12` with its ids and its reason; (3) createTask warns on a repeat and the warning '
  + 'names the existing row; (4) a test pins the guard — and the fixture must be built from the ACTUAL '
  + '`Tasks.name` strings read back from the register, because a fixture built from a re-typed regex CANNOT '
  + 'FAIL (the standing lesson, and the same trap that hid the shadow-scorer defect for a week).';

async function main() {
  console.log(`edict ${EDICT} — would write:\n`);
  console.log(`  ${NAME}`);
  console.log(`  state 1 (open) · priority 2 · assignedToUserId null · ${INFO.length} chars of info`);
  console.log(`  plannedStart ${TODAY.toISOString()} (written as UTC wall-clock so active computes to 1)\n`);
  if (!APPLY) {
    console.log('DRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  // ★ Idempotency guard — `createTask` has none (that absence IS this task), so a re-run would silently create
  // a SECOND row behind the same label: the exact defect being registered. Check the label first.
  const existing = (await taskModel.getTasksByEdict(EDICT))
    .filter((t) => /^TRD-REG-1\s*:/.test(String(t.name || '')));
  if (existing.length) {
    console.log('ALREADY REGISTERED — refusing to insert a second row behind the same label:');
    for (const t of existing) {
      console.log(`  id ${t.id} state=${t.state} active=${t.active} sortOrder=${t.sortOrder}  ${String(t.name).slice(0, 110)}`);
    }
    return;
  }

  // NOTE: `taskModel.createTask` returns void, so the id is read back by name.
  await taskModel.createTask(NAME, TODAY, null, INFO, 2, OPEN, null, EDICT);
  const made = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.name === NAME);
  console.log(made ? `created TRD-REG-1 as task id ${made.id} (sortOrder ${made.sortOrder}, active ${made.active})`
                   : 'created, but the row was not found on read-back — check the DB');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
