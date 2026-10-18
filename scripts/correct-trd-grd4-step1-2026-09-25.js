// scripts/correct-trd-grd4-step1-2026-09-25.js — RETRACT the false STEP 1 finding, same day, on the row.
//
// The previous entry on this row claims "capture_chart_identity events in the record: 0 ... NOTHING WAS
// RECORDED AT ALL". That is FALSE: the event is written as kind='telemetry' with payload.source=
// 'capture_chart_identity', and the first query used `kind = 'capture_chart_identity'` — a value that does
// not exist. The zero was a property of my WHERE clause, not of the instrument.
//
// ★ THE WRONG ENTRY IS NOT DELETED. It is left standing and explicitly retracted from below, because the
// repo's convention is to record corrections rather than erase them, and because a reader who saw the claim
// needs to find the retraction next to it.
//
// Usage:
//   node scripts/correct-trd-grd4-step1-2026-09-25.js          # DRY RUN
//   node scripts/correct-trd-grd4-step1-2026-09-25.js --yes    # writes
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const ID = 1385;
const MUST_ALREADY_EXIST = ['2026-09-25 - STEP 1 MEASURED', 'SILENCE PROVES NOTHING'];
const MUST_EXIST_AFTER = ['CORRECTION, WRITTEN SAME DAY', 'mismatch 48 2.5%', 'unrecorded 0 0.0%', 'false all-clear', 'per SWEEP, not per pair'];
const ALREADY_APPLIED_MARK = 'CORRECTION, WRITTEN SAME DAY';

// ★ WHITESPACE-NORMALISED AND CASE-INSENSITIVE. These rows are hard-wrapped, so a marker spanning a line
// break reports MISSING; and three of my scripts this session refused themselves on a case difference alone
// (`NOT alike` vs `not alike`, `NOTHING WAS RECORDED` vs `nothing was recorded`, `FALSE ALL-CLEAR` vs `false
// all-clear`). A prose sentinel's job is to prove the SECTION IS PRESENT, and typography is not the property
// being asserted — so it is folded away. It cannot cause a false positive: the marker still has to appear.
const norm = (s) => String(s).replace(/\s+/g, ' ').toLowerCase();
const has = (text, m) => norm(text).includes(norm(m));

const ADDITION = `
---------------------------------------------------------------------------
2026-09-25 - CORRECTION, WRITTEN SAME DAY. THE STEP 1 ENTRY ABOVE IS WRONG, AND I
PUBLISHED IT. THE ZERO WAS A PROPERTY OF MY WHERE CLAUSE, NOT OF THE INSTRUMENT.
---------------------------------------------------------------------------
WHAT THE ENTRY ABOVE CLAIMS: "capture_chart_identity events in the record: 0 ... That is NOT 'unrecorded
dominates'. It is 'NOTHING WAS RECORDED AT ALL' - and that turns out to be a property of the INSTRUMENT, not
of the data."

WHAT IS TRUE: the event is written as kind='telemetry' with payload.source='capture_chart_identity'
(capture.js:289-290). I queried kind = 'capture_chart_identity', which is a column value that does not
exist, and then read the resulting zero as a property of the instrument. It was a property of my query.

THE REAL NUMBERS, on the right field (163 sweeps, 2026-09-23 .. 2026-09-25, 1,946 verdicts):
  match         1427   73.3%
  mismatch        48    2.5%    <- the real anomaly, and it DOES fire
  unrecorded       0    0.0%    <- STEP 1's own question
  unregistered   471   24.2%    <- REGISTRY coverage gap

★ STEP 1 IS ANSWERED AND THE ANSWER IS YES: unrecorded = 0 of 1,946. engine.chart.symbol ARRIVES. This row's
own gate ("if unrecorded dominates ... ENFORCEMENT MUST NOT BE BUILT ON IT") is satisfied - the condition it
feared is not present. My "STEP 1 cannot be answered" conclusion was wrong.

★★ AND THIS EXPOSES A DEFECT IN THE ACCEPTANCE INSTRUMENT ITSELF. The designated check,
trading/scripts/repro/chart-identity-check.js, prints "tally: {match: 7, unregistered: 6}" over "13 distinct
pair(s)" and concludes "No mismatches observed." Those figures are per DISTINCT PAIR, not per SWEEP, so the 48
recorded mismatches are INVISIBLE to it. It is the instrument whose output is meant to authorise enforcement
- its own header says "ENFORCEMENT MUST NOT BE AUTHORISED UNTIL THIS SHOWS ZERO MISMATCHES" - and it returns
a FALSE ALL-CLEAR. That must be corrected before it authorises anything: a count per SWEEP, not per pair.

WHAT THE REAL BLOCKER IS: unregistered = 471 (24.2%). All 13 distinct pairs show registry=(none) on the
sweeps carrying that field, so for those symbols the check cannot run at all - and a guard that is ABSENT
looks exactly like a guard that PASSED. This is the same conclusion the repro script reaches, but derived
from the counts rather than from the pair list.

CONSEQUENCES FOR THE WORK ALREADY APPROVED:
 1. The MATCH-heartbeat I recommended is still worth having (a fully-clean sweep writes nothing today, so
    silence would remain ambiguous in that state) - but it is NO LONGER THE BLOCKER. Registry coverage is.
 2. THE 48 MISMATCHES MUST BE SAMPLED BEFORE ANY ENFORCEMENT IS DESIGNED. They are the rows STEP 2's
    normaliser was meant to be calibrated from, and they are sitting in the record unread.
 3. The acceptance script must count per sweep before it is used to authorise enforcement.

METHOD NOTE, since the same mistake is available to the next reader: I did dump the kind distribution first,
saw telemetry with 50,362 rows, and still queried a kind that was not in the list. Printing the shape is
only useful if the query is then written from it.
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
    console.error(`REFUSING: task ${ID} is missing ${missing.join(' | ')} — the entry being retracted is not present. Nothing written.`);
    process.exit(1);
  }

  const next = current.replace(/\s*$/, '') + '\n' + ADDITION;
  const previewMissing = MUST_EXIST_AFTER.filter((m) => !has(next, m));
  console.log(`TRD-GRD-4 (id ${ID})  state ${row.state}  priority ${row.priority}`);
  console.log(`  info: ${current.length} -> ${next.length} chars (+${next.length - current.length})`);
  console.log(`  retraction target present: ${MUST_ALREADY_EXIST.length - missing.length}/${MUST_ALREADY_EXIST.length}`);
  console.log(`  new-section markers checked: ${MUST_EXIST_AFTER.length - previewMissing.length}/${MUST_EXIST_AFTER.length} present`
    + (previewMissing.length ? '  MISSING: ' + previewMissing.join(' | ') : ''));
  if (previewMissing.length) { console.error('\nREFUSING: section is missing its own markers. Nothing written.'); process.exit(1); }
  if (!APPLY) { console.log('\nDRY RUN - pass --yes to write. No DB write performed.'); return; }

  await taskModel.updateTask(ID, { info: next });
  const back = (await taskModel.getTasksByEdict(52)).find((t) => Number(t.id) === ID);
  const text = String((back && back.info) || '');
  const missNew = MUST_EXIST_AFTER.filter((m) => !has(text, m));
  console.log(`\n  read-back: ${text.length} chars, state ${back.state}`);
  console.log(`  new section: ${missNew.length ? 'MISSING ' + missNew.join(' | ') : 'all markers present'}`);
  if (missNew.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
