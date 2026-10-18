// scripts/record-2026-09-25-scope-and-capture.js — write this session's four rows.
//
// WHY ONE SCRIPT FOR FOUR ROWS. The four tasks are independent in subject but share one cause, and they were
// worked in one pass. The discipline is unchanged per row: the `.md` is the single source of truth, LENGTH and
// MARKERS are checked BEFORE the write (the failure being guarded is a truncated write that looks successful),
// the append is IDEMPOTENT, and the result is verified again after.
//
// ★ THE ROWS ARE APPENDED, NEVER REPLACED. TRD-116 in particular carries a 2026-09-24 reasoning correction that
// a future reader needs, and TRD-116 is being CLOSED here — "history: preserved" is the first thing read back,
// because a close that overwrites the evidence it cites is how a defect stops being visible.
//
// Usage:
//   node scripts/record-2026-09-25-scope-and-capture.js          # DRY RUN
//   node scripts/record-2026-09-25-scope-and-capture.js --yes    # writes
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;
const CLOSED = 3;

// Markers are ASCII-only substrings drawn from DIFFERENT parts of each document, so a head-only write fails on
// the tail. Matching is case-insensitive and whitespace-normalised: the first version of this checker compared
// raw text and rejected three documents for line-wrapping and case alone, which is a checker bug, not a document
// bug. The prose still carries em-dashes and arrows; the markers deliberately do not.
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');

const ROWS = [
  {
    label: 'TRD-116',
    // Closing: the row's residual ("observed, not prevented") is discharged — the write reports the
    // contradiction and the observer now judges it with the resolver instead of against a copy of the rule.
    close: true,
    doc: 'docs/trd116-scope-resolution-2026-09-25.md',
    min: 6500,
    markers: [
      'the scope rule, in one place',
      'that reading was wrong, and the row itself said so',
      'that was supposed to cover this was itself wrong, in three ways',
      'a default key is not a symbol',
      'option (a) is not the way to do it',
      'residual, stated plainly',
      'temp/trd116-live-check.js',
      '1430 tests, 1429 pass',
    ],
  },
  {
    label: 'TRD-GRD-4',
    close: false,
    doc: 'docs/trd-grd4-acceptance-harness-2026-09-25.md',
    min: 6000,
    markers: [
      'the 48 "mismatches" are not mismatches',
      'two emitters wrote one event name',
      'zero times in 1,946 observations',
      'wrong in opposite directions',
      'match-case heartbeat (the approved item)',
      'an absent guard looks exactly like a guard that passed',
      'my own errors, corrected on the record',
    ],
  },
  {
    label: 'TRD-GRD-5',
    close: false,
    doc: 'docs/trd-grd5-chart-bucketing-2026-09-25.md',
    min: 6000,
    markers: [
      "the row's central claim is no longer true",
      'native 1h is now the largest group',
      'nothing pins the chart interval',
      'the non-vacuity test is the interesting one',
      'option 1 is rejected on measured grounds',
      'either option is a split, not a fix',
      '41.7 days',
    ],
  },
  {
    label: 'TRD-119',
    close: false,
    doc: 'docs/trd119-exit-chair-population-2026-09-25.md',
    min: 5000,
    markers: [
      'computed before any number is read off it',
      'they are unmeasurable, not negative and not positive',
      'the advisory slice is empty',
      '975 rows (38.9%) carry no',
      'this is not a value claim',
      'what would make it measurable',
    ],
  },
];

function load(spec) {
  const file = path.join(__dirname, '..', spec.doc);
  if (!fs.existsSync(file)) throw new Error(`REFUSING: source document not found at ${file}`);
  const text = fs.readFileSync(file, 'utf8').trim();
  if (text.length < spec.min) {
    throw new Error(`REFUSING ${spec.label}: document is only ${text.length} chars (min ${spec.min}). Nothing written.`);
  }
  const missing = spec.markers.filter((m) => !norm(text).includes(norm(m)));
  if (missing.length) {
    throw new Error(`REFUSING ${spec.label}: document is missing ${missing.length} marker(s): ${missing.join(' | ')}`);
  }
  return text;
}

async function main() {
  const all = await taskModel.getTasksByEdict(EDICT);
  const plan = [];

  for (const spec of ROWS) {
    const text = load(spec);
    const rows = all.filter((t) => String(t.name || '').startsWith(spec.label + ':'));
    if (rows.length !== 1) throw new Error(`REFUSING ${spec.label}: expected exactly one row, found ${rows.length}`);
    const row = rows[0];
    const before = String(row.info || '');

    // ★ IDEMPOTENCY. The section is identified by its own first heading, so re-running this script after a
    // partial failure must not append a second copy. The previous version of this pattern had no guard on an
    // APPENDING script, which would have duplicated the text on every re-run.
    const already = norm(before).includes(norm(spec.markers[0]));
    const next = already ? before : `${before}\n\n${'-'.repeat(75)}\n\n${text}`;
    plan.push({ spec, row, before, next, already, unchanged: next.length === before.length });
  }

  for (const p of plan) {
    console.log(`\n${p.spec.label} = task id ${p.row.id}`);
    console.log(`  source : ${p.spec.doc}  (${p.spec.markers.length}/${p.spec.markers.length} markers present)`);
    console.log(`  info   : ${p.before.length} -> ${p.next.length} chars${p.already ? '   [ALREADY RECORDED — no write]' : ''}`);
    if (p.spec.close) console.log(`  state  : ${p.row.state} -> ${CLOSED} (closed; updateTask stamps completedAt)`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  for (const p of plan) {
    if (!p.already) {
      await taskModel.updateTask(p.row.id, p.spec.close ? { info: p.next, state: CLOSED } : { info: p.next });
    } else if (p.spec.close && Number(p.row.state) !== CLOSED) {
      await taskModel.updateTask(p.row.id, { state: CLOSED });
    }
  }

  console.log('\n--- READ-BACK ---');
  const after = await taskModel.getTasksByEdict(EDICT);
  let bad = 0;
  for (const p of plan) {
    const back = after.find((t) => t.id === p.row.id);
    const text = String((back && back.info) || '');
    const missing = p.spec.markers.filter((m) => !norm(text).includes(norm(m)));
    const historyKept = norm(text).includes(norm(p.before.slice(0, 120)));
    console.log(`\n  ${p.spec.label} (${p.row.id}): state=${back.state} completedAt=${back.completedAt ? 'set' : 'NULL'}`);
    console.log(`    info ${p.before.length} -> ${text.length} chars (wrote ${p.next.length})`);
    console.log(`    history: ${historyKept ? 'preserved' : '⚠ LOST'}   markers: ${missing.length ? 'MISSING ' + missing.join(' | ') : 'all present'}`);
    if (missing.length || !historyKept) bad++;
    if (p.spec.close && Number(back.state) !== CLOSED) { console.error(`    ⚠ state is ${back.state}, expected ${CLOSED}`); bad++; }
  }
  if (bad) process.exit(1);
  console.log('\nall four rows verified.\n');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
