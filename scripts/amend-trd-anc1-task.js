// scripts/amend-trd-anc1-task.js — refresh TRD-ANC-1's `Tasks.info` from its doc after the observe half
// turned up a further finding (the entry drift is destroyed at close) and a correction (the false sign
// check).
//
// ★ WHY AN AMEND SCRIPT AND NOT A NEW ROW. The finding belongs to the SAME defect — the entry drift's
// record — so a second label would split one subject across two tasks. The doc is the single source; this
// re-reads it and writes it, so the row cannot drift away from the document that justifies it.
//
// ★ THE TEXT COMES FROM THE `.md`, and the length and ALL markers are checked BEFORE the write, because the
// failure mode being guarded is a truncated write that looks successful. It is verified AGAIN after.
//
// Usage:
//   node scripts/amend-trd-anc1-task.js          # DRY RUN — shows the before/after
//   node scripts/amend-trd-anc1-task.js --yes    # writes
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;
const LABEL = 'TRD-ANC-1';
const DOC = path.join(__dirname, '../docs/trd-anc-1-inert-reanchor-false-join-2026-09-25.md');

// Every marker must live near a DIFFERENT part of the document, so a head-only write fails on the tail.
// ASCII-ONLY on purpose: a marker written with an ASCII hyphen where the doc has a Unicode minus matches
// nothing and refuses the run, which is how the TRD-FED-1 script caught itself.
const MARKERS = [
  '30 of 30',
  'shift: 0',
  'written into the fix for F20',
  'smoke_note',
  'FROZEN forward-validation candidate',
  'Observe first, enforce later',
  'ADDITIONAL FINDING, added 2026-09-25',
  '27 / 29',
  'tautological',
];
const MIN_CHARS = 6000;

async function main() {
  if (!fs.existsSync(DOC)) {
    console.error(`REFUSING: source document not found at ${DOC}`);
    process.exit(1);
  }
  const info = fs.readFileSync(DOC, 'utf8').trim();

  if (info.length < MIN_CHARS) {
    console.error(`REFUSING: INFO is only ${info.length} chars (min ${MIN_CHARS}). Nothing written.`);
    process.exit(1);
  }
  const missing = MARKERS.filter((m) => !info.includes(m));
  if (missing.length) {
    console.error(`REFUSING: source document is missing ${missing.length} marker(s):`);
    for (const m of missing) console.error(`  ${m}`);
    process.exit(1);
  }

  const all = await taskModel.getTasksByEdict(EDICT);
  const rows = all.filter((t) => String(t.name || '').startsWith(LABEL + ':'));
  if (rows.length !== 1) {
    console.error(`REFUSING: expected exactly one ${LABEL} row in edict ${EDICT}, found ${rows.length}`);
    process.exit(1);
  }
  const row = rows[0];
  const before = String(row.info || '').length;

  console.log(`${LABEL} = task id ${row.id} (state ${row.state}, active ${row.active})`);
  console.log(`  info BEFORE: ${before} chars`);
  console.log(`  info AFTER:  ${info.length} chars`);
  console.log(`  source:      ${path.relative(path.join(__dirname, '..'), DOC)}`);
  console.log(`  markers:     ${MARKERS.length}/${MARKERS.length} present in the source`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  await taskModel.updateTask(row.id, { info });
  const back = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.id === row.id);
  const text = String((back && back.info) || '');
  const missingBack = MARKERS.filter((m) => !text.includes(m));
  console.log(`\n  read-back: ${text.length} chars (wrote ${info.length}) — `
    + `${missingBack.length ? 'MISSING ' + missingBack.join(' | ') : 'all markers present'}`);
  if (missingBack.length) process.exit(1);
  console.log(`  ${LABEL} id ${row.id}: info ${before} -> ${text.length} chars`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
