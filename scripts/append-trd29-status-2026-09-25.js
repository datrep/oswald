// scripts/append-trd29-status-2026-09-25.js — append a re-measured forward-clock status to TRD-29.
//
// ★ APPEND, NOT REPLACE. This row's `info` carries the measured history of two PREVIOUS agent sessions,
// including records of their own errors ("MY ERROR 1/2"). Rewriting the row would destroy the only record
// of those, so the existing text is READ, VERIFIED, and KEPT — the new section is appended.
//
// Same discipline as the other scripts: the existing text's markers are checked BEFORE the write (so it
// cannot be replaced by a stale copy), and BOTH old and new markers are verified after.
//
// Usage:
//   node scripts/append-trd29-status-2026-09-25.js          # DRY RUN
//   node scripts/append-trd29-status-2026-09-25.js --yes    # writes
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const ID = 271;

// Must ALREADY be present: proof this is the row with that history, not a look-alike.
const MUST_ALREADY_EXIST = ['LABEL CHECK', 'MY ERROR 2', 'survgold   14 closes'];
// Must be present AFTER: the new section, from three different points in it.
const MUST_EXIST_AFTER = ['FORWARD CLOCK RE-MEASURED', '28/50', '20/50', 'NOT alike'];
// ★ THE IDEMPOTENCY GUARD. This script APPENDS, so a second run would write a second copy of the section
// and the row would carry the same status twice — a duplication no marker check would catch, because both
// copies would satisfy every marker. The first run of this script had NO such guard, and its dry-run
// reported "4/4 present" by printing the LENGTHS rather than the check result — vacuous in the exact way
// this codebase keeps naming. Both are fixed here.
const ALREADY_APPLIED_MARK = 'FORWARD CLOCK RE-MEASURED';

const ADDITION = `
---------------------------------------------------------------------------
2026-09-25 - FORWARD CLOCK RE-MEASURED. The row's status was 3 days stale, NOT the desk idle.
Nothing was wrong; the number had simply not been re-read. No state change was needed.
---------------------------------------------------------------------------
Counting rule taken FROM THIS ROW, not chosen here: origin = 'agent', status = 'closed',
closeAt IS NOT NULL. Rejected rows (13 of them) are NOT closes - \`status\` is the source of
truth; \`closeAt\` is not.

AGAINST THE n>=50 ACCEPTANCE:
  survgold     28/50  (56.0% of the way)   net    -0.98   mean  -0.04/trade   last close 2026-09-24T12:52Z
  survoil      20/50  (40.0% of the way)   net   -40.56   mean  -2.03/trade   last close 2026-09-24T16:16Z

The 2026-09-22 measurement was 14 and 13. Both have essentially DOUBLED in three days, so the
clock is RUNNING, not stalled - the previous figure was stale, not the desk.

PACE (closes/day, origin=agent): 09-23 survgold 6 / survoil 4; 09-24 survgold 4 / survoil 1.
At the recent pace: survgold reaches n=50 in roughly 5 more days, survoil in roughly 12.

★★ THE ASYMMETRY, which is the substantive finding here and not a label question:
survgold is effectively FLAT (-0.04 mean over 28 closes). survoil is LOSING at -2.03 per close
over 20 closes, net -40.56. The two frozen survivors are NOT alike, and survoil is the one that
decides whether this row's acceptance can be met at all.
⚠ n=20 does NOT settle it - that is exactly why the acceptance is n>=50 - so this is recorded as
a trajectory to WATCH, not as a verdict. No look spent, no rule changed, no parameter touched
(§16.9: any retuning voids the candidate).

ONE ROW IS STILL OPEN: id 1093 (Gold sell, survgold, opened 2026-09-24T13:30Z, pid 1888006320).

CONTEXT: rsi2 17 closes net -28.82 (last close 09-18, disabled); turtle 3 net +0.74; macd 1 net
-1.15; manual 6 net -15.36; venue 6 net -13.19.

STATE IS UNCHANGED ON PURPOSE. state 2 = PUBLISHED in the Draft/Published/Archived lifecycle,
which is this row's correct value while it accumulates. Re-stated because a previous session
misread state 2 as "blocked" - see the 2026-09-22 section above, where that error is recorded.
`;

async function main() {
  const tasks = await taskModel.getTasksByEdict(52);
  const row = tasks.find((t) => Number(t.id) === ID);
  if (!row) { console.error(`REFUSING: no task ${ID} in edict 52`); process.exit(1); }
  const current = String(row.info || '');
  if (current.includes(ALREADY_APPLIED_MARK)) {
    console.error(`ALREADY APPLIED — task ${ID} already carries "${ALREADY_APPLIED_MARK}".`);
    console.error('Refusing to append a SECOND copy. Nothing written.');
    process.exit(1);
  }
  const missing = MUST_ALREADY_EXIST.filter((m) => !current.includes(m));
  if (missing.length) {
    console.error(`REFUSING: task ${ID} is missing its own history markers (${missing.join(' | ')}).`);
    console.error('Appending to a row that does not carry that history would fork the record. Nothing written.');
    process.exit(1);
  }

  const next = current.replace(/\s*$/, '') + '\n' + ADDITION;
  // ★ THE ACTUAL CHECK, not the lengths. The first version of this script printed
  // `${MUST_EXIST_AFTER.length}/${MUST_EXIST_AFTER.length}` under the word "present", which is true of any
  // list of any string — it could not fail, and it did not.
  const previewMissing = MUST_EXIST_AFTER.filter((m) => !next.includes(m));
  console.log(`TRD-29 (id ${ID})  state ${row.state}  priority ${row.priority}`);
  console.log(`  info: ${current.length} -> ${next.length} chars (+${next.length - current.length})`);
  console.log(`  existing-history markers checked: ${MUST_ALREADY_EXIST.length - missing.length}/${MUST_ALREADY_EXIST.length} present`);
  console.log(`  new-section markers checked:      ${MUST_EXIST_AFTER.length - previewMissing.length}/${MUST_EXIST_AFTER.length} present`
    + (previewMissing.length ? '  MISSING: ' + previewMissing.join(' | ') : ''));
  if (previewMissing.length) { console.error('\nREFUSING: the section does not contain its own markers. Nothing written.'); process.exit(1); }
  if (!APPLY) { console.log('\nDRY RUN — pass --yes to write. No DB write performed.'); return; }

  await taskModel.updateTask(ID, { info: next });
  const back = (await taskModel.getTasksByEdict(52)).find((t) => Number(t.id) === ID);
  const text = String((back && back.info) || '');
  const missingOld = MUST_ALREADY_EXIST.filter((m) => !text.includes(m));
  const missingNew = MUST_EXIST_AFTER.filter((m) => !text.includes(m));
  console.log(`\n  read-back: ${text.length} chars, state ${back.state}`);
  console.log(`  history preserved: ${missingOld.length ? 'MISSING ' + missingOld.join(' | ') : 'yes, all markers'}`);
  console.log(`  new section:       ${missingNew.length ? 'MISSING ' + missingNew.join(' | ') : 'all markers present'}`);
  if (missingOld.length || missingNew.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
