// scripts/close-trd-geo1-task.js — close TRD-GEO-1, syncing `Tasks.info` to its doc.
//
// Same discipline as scripts/amend-trd-anc1-task.js: the `.md` is the single source of truth for the text,
// length AND markers are checked BEFORE the write (the failure being guarded is a truncated write that looks
// successful), and the result is verified again after. `state: 3` makes `updateTask` stamp `completedAt`.
//
// Usage:
//   node scripts/close-trd-geo1-task.js          # DRY RUN
//   node scripts/close-trd-geo1-task.js --yes    # writes
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;
const LABEL = 'TRD-GEO-1';
const CLOSED = 3;
const DOC = path.join(__dirname, '../docs/trd-geo-1-level-geometry-derivation-2026-09-25.md');

// ASCII-only substrings, each from a different part of the document, so a head-only write fails on the tail.
const MARKERS = [
  'wrong on any capped ticket',
  '27 of the 30 agent entries',
  'Wrong by roughly 5x',
  '30.74',
  '32.4%',
  'inside the noise band',
  'DISPOSITION (2026-09-25)',
  'anchorSource',
  'had no observed anchor',
  '0.005%',
];
const MIN_CHARS = 7000;

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

  console.log(`${LABEL} = task id ${row.id}`);
  console.log(`  state: ${row.state} -> ${CLOSED} (closed; updateTask stamps completedAt)`);
  console.log(`  info:  ${before} -> ${info.length} chars`);
  console.log(`  source:  ${path.relative(path.join(__dirname, '..'), DOC)}`);
  console.log(`  markers: ${MARKERS.length}/${MARKERS.length} present`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  await taskModel.updateTask(row.id, { info, state: CLOSED });
  const back = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.id === row.id);
  const text = String((back && back.info) || '');
  const missingBack = MARKERS.filter((m) => !text.includes(m));
  console.log(`\n  read-back: state=${back.state} completedAt=${back.completedAt ? 'set' : 'NULL'} `
    + `info ${text.length} chars (wrote ${info.length})`);
  console.log(`  ${missingBack.length ? 'MISSING ' + missingBack.join(' | ') : 'all markers present'}`);
  if (missingBack.length) process.exit(1);
  if (Number(back.state) !== CLOSED) { console.error(`state is ${back.state}, expected ${CLOSED}`); process.exit(1); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
