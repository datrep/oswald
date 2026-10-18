// scripts/append-trd-grd4-step1-2026-09-25.js — record TRD-GRD-4 STEP 1's measurement on its own row.
//
// ★ APPEND, NOT REPLACE. This row carries 9,690 chars of prior design work and is not rewritten.
//
// ★ NO BACKTICKS INSIDE THE TEMPLATE LITERAL. The first draft escaped them as \\` and the escaping itself
// broke the file ("Unexpected identifier") — the same class as the apostrophe that killed the first
// TRD-FED-1 registration script. Identifiers in the text below are written plainly rather than dressed up.
//
// Guard shape, corrected from the TRD-29 lesson: whitespace-normalised marker checks (these rows are
// hard-wrapped, so a marker spanning a line break reports MISSING), an idempotency guard (a re-run would
// duplicate the section), and the CHECK RESULT printed rather than the list lengths.
//
// Usage:
//   node scripts/append-trd-grd4-step1-2026-09-25.js          # DRY RUN
//   node scripts/append-trd-grd4-step1-2026-09-25.js --yes    # writes
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const ID = 1385;
const MUST_ALREADY_EXIST = ['WHAT IS LEFT, AND WHY IT IS NOT DONE YET', 'TRD-GRD-3 landed the OBSERVE-MODE half'];
const MUST_EXIST_AFTER = ['STEP 1 MEASURED', 'NOTHING WAS RECORDED AT ALL', 'SILENCE PROVES NOTHING', '41,829', '881'];
const ALREADY_APPLIED_MARK = '2026-09-25 - STEP 1 MEASURED';

const norm = (s) => String(s).replace(/\s+/g, ' ');
const has = (text, m) => norm(text).includes(norm(m));

const ADDITION = `
---------------------------------------------------------------------------
2026-09-25 - STEP 1 MEASURED. THE ANSWER IS NOT "THE FIELD ARRIVES"; IT IS THAT THE
RECORD CANNOT SAY, AND THE INSTRUMENTATION IS WHY.
---------------------------------------------------------------------------
STEP 1 asks whether engine.chart.symbol arrives at all, or whether "unrecorded" dominates, with this row's
own warning attached: "if unrecorded dominates ... ENFORCEMENT MUST NOT BE BUILT ON IT - that would be a
guard that can never fire, which this repo has already shipped once (activity days)."

  capture_chart_identity events in the record:  0

That is NOT "unrecorded dominates". It is "NOTHING WAS RECORDED AT ALL" - and that turns out to be a
property of the INSTRUMENT, not of the data.

WHY THE SILENCE IS UNINFORMATIVE. TRD-GRD-3 logs the verdict ONLY when it is MISMATCH or UNRECORDED. So
zero events is equally consistent with:
  (a) every capture MATCHED - the field is fine and there is nothing to enforce; and
  (c) the telemetry call is UNREACHABLE - the verdict is inert whatever the data says.
STEP 1 cannot tell those apart from the event log, so STEP 1 cannot be answered by the instrumentation built
to answer it.

WHAT CAN BE ESTABLISHED, AND IT IS ONLY PARTIAL. The capture path demonstrably RAN:
  plus500_chart bars: 41,829 total; 881 with barStart >= 2026-09-24 (GRD-3's landing), across ~17 symbols,
  last 2026-09-25T00:30Z; bars_built events last 2026-09-25T00:18Z.
And the INDEPENDENT swap detector is equally quiet: the flagged column is 2 of 41,829 plus500_chart rows
(0.00%), and 0 of 263,463 rows across every other venue. Two mechanisms, both silent, while captures run -
which is CONSISTENT with clean captures.

★ IT IS NOT EVIDENCE THAT THE IDENTITY CHECK FUNCTIONS. A failure-only signal that never fires has said
nothing about the check itself; the flagged column corroborates that SWAPS are rare, NOT that the identity
verdict executes. Reading this silence as a pass is the same mistake as reading "unrecorded" as a pass.

=> RECOMMENDATION, AND IT COMES BEFORE STEP 2 OR STEP 3: make the identity telemetry ALSO record the MATCH
case - or at minimum a periodic heartbeat carrying match / mismatch / unrecorded / flagged counts. Only then
does silence become evidence, and only then can a threshold be calibrated from a record that contains its
own successes. Everything in STEP 2 (calibrate the normaliser) and STEP 3 (refuse / bank-but-flag / do
nothing) rests on a verdict whose EXECUTION is currently unproven.

⚠ THE ASYMMETRY WITH THIS ROW'S OWN CONCERN IS THE POINT: the row worries about a guard that CANNOT FIRE.
The measured situation is the mirror image - a guard whose SILENCE PROVES NOTHING. Both are fatal to the same
decision, and the second is harder to see, because the log looks clean rather than broken.

NO CODE CHANGE WAS MADE. This entry is STEP 1's measurement and the instrumentation finding that blocks
STEP 2 until it is addressed.
`;

async function main() {
  const tasks = await taskModel.getTasksByEdict(52);
  const row = tasks.find((t) => Number(t.id) === ID);
  if (!row) { console.error(`REFUSING: no task ${ID} in edict 52`); process.exit(1); }
  const current = String(row.info || '');

  if (has(current, ALREADY_APPLIED_MARK)) {
    console.error(`ALREADY APPLIED - task ${ID} already carries "${ALREADY_APPLIED_MARK}". Refusing a SECOND copy.`);
    process.exit(1);
  }
  const missing = MUST_ALREADY_EXIST.filter((m) => !has(current, m));
  if (missing.length) {
    console.error(`REFUSING: task ${ID} is missing its own history markers (${missing.join(' | ')}). Nothing written.`);
    process.exit(1);
  }

  const next = current.replace(/\s*$/, '') + '\n' + ADDITION;
  const previewMissing = MUST_EXIST_AFTER.filter((m) => !has(next, m));
  console.log(`TRD-GRD-4 (id ${ID})  state ${row.state}  priority ${row.priority}`);
  console.log(`  existing text begins: ${JSON.stringify(current.slice(0, 140))}`);
  console.log(`  info: ${current.length} -> ${next.length} chars (+${next.length - current.length})`);
  console.log(`  existing-history markers checked: ${MUST_ALREADY_EXIST.length - missing.length}/${MUST_ALREADY_EXIST.length} present`);
  console.log(`  new-section markers checked:      ${MUST_EXIST_AFTER.length - previewMissing.length}/${MUST_EXIST_AFTER.length} present`
    + (previewMissing.length ? '  MISSING: ' + previewMissing.join(' | ') : ''));
  if (previewMissing.length) { console.error('\nREFUSING: section is missing its own markers. Nothing written.'); process.exit(1); }
  if (!APPLY) { console.log('\nDRY RUN - pass --yes to write. No DB write performed.'); return; }

  await taskModel.updateTask(ID, { info: next });
  const back = (await taskModel.getTasksByEdict(52)).find((t) => Number(t.id) === ID);
  const text = String((back && back.info) || '');
  const missOld = MUST_ALREADY_EXIST.filter((m) => !has(text, m));
  const missNew = MUST_EXIST_AFTER.filter((m) => !has(text, m));
  console.log(`\n  read-back: ${text.length} chars, state ${back.state}`);
  console.log(`  history preserved: ${missOld.length ? 'MISSING ' + missOld.join(' | ') : 'yes, all markers'}`);
  console.log(`  new section:       ${missNew.length ? 'MISSING ' + missNew.join(' | ') : 'all markers present'}`);
  if (missOld.length || missNew.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
