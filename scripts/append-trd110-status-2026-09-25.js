// scripts/append-trd110-status-2026-09-25.js — append the re-measured evidence clock to TRD-110.
//
// ★ APPEND, NOT REPLACE — same discipline as the TRD-29 script, and for the same reason: this row carries
// the recorded history of earlier sessions INCLUDING a self-correction ("I ALSO CORRECT MY OWN EARLIER
// ANNOTATION IN THIS ROW"). Rewriting it would destroy that.
//
// ★ AND IT USES THE CORRECTED GUARD SHAPE. The first version of the TRD-29 script reported its markers as
// "N/N present" by printing LENGTHS rather than the check result — a report that cannot fail — and had no
// idempotency guard, so a re-run would have appended the section a second time. Both faults are fixed here
// from the start: the check result is computed and printed, and an already-applied section REFUSES.
//
// Usage:
//   node scripts/append-trd110-status-2026-09-25.js          # DRY RUN
//   node scripts/append-trd110-status-2026-09-25.js --yes    # writes
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const ID = 1361;

const MUST_ALREADY_EXIST = ['THE UNIVERSE LEVER', 'TRD-79 (composition', 'OWNER DECISION among the three routes'];
const MUST_EXIST_AFTER = ['CLOCK RE-MEASURED', '28    -0.98', '20   -40.56', 'NOT ALIKE'];
const ALREADY_APPLIED_MARK = '2026-09-25 - CLOCK RE-MEASURED';

// ★ WHITESPACE-NORMALISED MARKER CHECK. These rows are hard-wrapped at ~100 columns, so a marker such as
// "OWNER DECISION among the three routes" is really stored as "OWNER\nDECISION among the three routes" and
// a literal `includes` reports it MISSING. The first run of this script refused itself for exactly that
// reason. Collapsing runs of whitespace to one space on BOTH sides makes the check mean what it says — and
// it cannot cause a false positive, because the marker still has to be present in order.
const norm = (s) => String(s).replace(/\s+/g, ' ');
const has = (text, m) => norm(text).includes(norm(m));

const ADDITION = `
---------------------------------------------------------------------------
2026-09-25 - CLOCK RE-MEASURED: THE ETA MOVES ~3 WEEKS EARLIER, AND SPLITS PER STRATEGY
---------------------------------------------------------------------------
Counting rule: origin='agent', status='closed', closeAt IS NOT NULL. Rejected rows are NOT closes.
Measured with temp/trd29-forward.js - THE SAME SCRIPT used on TRD-29, so the two rows are read on ONE
basis rather than two that happen to agree.

  strategy   n     net      median/trade   last close
  survgold   28    -0.98      -0.04        2026-09-24T12:52Z
  survoil    20   -40.56      -2.03        2026-09-24T16:16Z

Against THIS ROW's 09-22 figures (survgold 14 / survoil 13, ETA 2026-10-19 and 2026-10-20): the union
clock is NOT 2026-10-20. Both survivors essentially DOUBLED in three days:
  survgold  22 to go at ~5/day (09-23: 6 closes, 09-24: 4)   -> ~5 more days,  ~2026-09-30
  survoil   30 to go at ~2.5/day (09-23: 4, 09-24: 1)        -> ~12 more days, ~2026-10-07
⚠ The recent pace is a TWO-DAY window - exactly the thin evidence this row exists to complain about. Both
figures are INDICATIVE; this row's own 1.3/day basis gives a later date. Neither is a promise.

★★ THE SUBSTANTIVE CHANGE IS NOT THE DATE, IT IS THE ASYMMETRY - and it is NOT ALIKE between the two.
survgold is effectively FLAT (-0.04 mean over 28 closes). survoil is LOSING at -2.03 per close over 20
(net -40.56). At the 09-22 reading the two looked like one block. They are not, and survoil is the one
that decides whether the n>=50 gate can be met with a PASSING strategy rather than merely met.
⚠ n=20 does not settle it; that is why the gate is n>=50. Recorded as a trajectory, not a verdict. No
look spent, no parameter touched, no rule changed (§16.9: retuning voids the candidate).

NOTHING HERE CHANGES THIS ROW'S CONCLUSION, which stands verbatim and is repeated so it is not re-derived:
the universe lever is NOT currently available, every route to widen costs something, and what remains is
an OWNER DECISION among the three routes or the deliberate acceptance of a wait. This entry only
RE-DATES the wait and splits it per strategy. One further note it did not carry: rsi2 remains at 17 closes
with a last close of 2026-09-18 and is DISABLED, so it contributes zero to the clock.
`;

async function main() {
  const tasks = await taskModel.getTasksByEdict(52);
  const row = tasks.find((t) => Number(t.id) === ID);
  if (!row) { console.error(`REFUSING: no task ${ID} in edict 52`); process.exit(1); }
  const current = String(row.info || '');

  if (has(current, ALREADY_APPLIED_MARK)) {
    console.error(`ALREADY APPLIED — task ${ID} already carries "${ALREADY_APPLIED_MARK}".`);
    console.error('Refusing to append a SECOND copy. Nothing written.');
    process.exit(1);
  }
  const missing = MUST_ALREADY_EXIST.filter((m) => !has(current, m));
  if (missing.length) {
    console.error(`REFUSING: task ${ID} is missing its own history markers (${missing.join(' | ')}).`);
    console.error('Appending to a row that does not carry that history would fork the record. Nothing written.');
    process.exit(1);
  }

  const next = current.replace(/\s*$/, '') + '\n' + ADDITION;
  const previewMissing = MUST_EXIST_AFTER.filter((m) => !has(next, m));
  console.log(`TRD-110 (id ${ID})  state ${row.state}  priority ${row.priority}`);
  console.log(`  info: ${current.length} -> ${next.length} chars (+${next.length - current.length})`);
  console.log(`  existing-history markers checked: ${MUST_ALREADY_EXIST.length - missing.length}/${MUST_ALREADY_EXIST.length} present`);
  console.log(`  new-section markers checked:      ${MUST_EXIST_AFTER.length - previewMissing.length}/${MUST_EXIST_AFTER.length} present`
    + (previewMissing.length ? '  MISSING: ' + previewMissing.join(' | ') : ''));
  if (previewMissing.length) { console.error('\nREFUSING: the section does not contain its own markers. Nothing written.'); process.exit(1); }
  if (!APPLY) { console.log('\nDRY RUN — pass --yes to write. No DB write performed.'); return; }

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
