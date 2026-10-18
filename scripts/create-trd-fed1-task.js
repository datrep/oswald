// scripts/create-trd-fed1-task.js — register the Oil price-source staleness finding of 2026-09-24.
//
// Found while chasing the "equity curve doesn't make sense" report. The cliff itself turned out to be a
// REAL Oil move, correctly captured — but the investigation that disproved the defect found a different
// one: the desk's `yahoo_rest` Oil series sat ~2.3% away from the venue's own price for about ten
// minutes during that move, then re-converged. Registered under the owner rule that a novel
// repo-specific finding becomes a task, not a memory note.
//
// ★ THE TEXT COMES FROM A `.md` FILE, NOT FROM A CONCATENATED JS STRING. The first draft of this script
// built INFO by concatenating single-quoted literals and died on an unescaped apostrophe — the same
// long-text-to-DB trap this repo has already been bitten by (a concatenated string once wrote 98 of
// ~2,500 chars to `Tasks.info`). `docs/trd-fed-1-oil-feed-staleness-2026-09-25.md` is the single
// source, the length is checked BEFORE the write, and the markers are verified AFTER it.
//
// Same discipline as scripts/create-trd-ext1-task.js: writes through `models/taskModel.createTask`.
// Schema traps: `plannedStart` is NOT NULL with no defaults; `active` is COMPUTED (never insert it) and a
// raw SQL `GETDATE()` writes local wall-clock, 8h ahead of its `GETUTCDATE()` comparison -> active = 0.
//
// Usage:
//   node scripts/create-trd-fed1-task.js          # DRY RUN
//   node scripts/create-trd-fed1-task.js --yes    # writes
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;   // "Trading Agent"
const OPEN = 1;
const TODAY = new Date();

const LABEL = 'TRD-FED-1';
const NAME = 'TRD-FED-1: Price feed — Oil (yahoo_rest) lagged the venue by 2.3% for ~10 minutes during the 09-24 move, and the prompt is told "mid is normally a LIVE TICK"';

const DOC = path.join(__dirname, '../docs/trd-fed-1-oil-feed-staleness-2026-09-25.md');

// Below this the payload is presumed truncated, not short. The incident text is ~4.5k chars; the floor
// only has to be high enough that a partial write cannot pass.
const MIN_CHARS = 3000;
// Each marker is a fact that lives near a DIFFERENT part of the document, so a write that captured only
// the head fails on the later ones. ★ MARKERS ARE DELIBERATELY ASCII-ONLY SUBSTRINGS: the document uses
// a Unicode minus (U+2212) in its arithmetic, and a marker written with an ASCII hyphen silently
// matches nothing — which is how the first run of this script refused itself.
const MARKERS = [
  'What the cliff actually was',
  '1.44 points (',
  'spread -2.293%',
  'quant.js:287',
  'single-bucket spike',
  'suggestive, not established',
  'DETECTED and not LOGGED is still invisible',
];

async function main() {
  if (!fs.existsSync(DOC)) {
    console.error(`REFUSING: source document not found at ${DOC}`);
    process.exit(1);
  }
  const INFO = fs.readFileSync(DOC, 'utf8').trim();

  console.log(`edict ${EDICT} — would write:\n`);
  console.log(`  ${NAME}`);
  console.log(`  state ${OPEN} (open) · priority 2 · assignedToUserId null · ${INFO.length} chars of info\n`);
  console.log(`  source: ${path.relative(path.join(__dirname, '..'), DOC)}`);

  // Length and content are checked BEFORE the write, so a truncated document cannot reach the DB at all.
  if (INFO.length < MIN_CHARS) {
    console.error(`REFUSING: INFO is only ${INFO.length} chars (min ${MIN_CHARS}). Nothing written.`);
    process.exit(1);
  }
  const missingInSource = MARKERS.filter((m) => !INFO.includes(m));
  if (missingInSource.length) {
    console.error(`REFUSING: source document is missing ${missingInSource.length} marker(s):`);
    for (const m of missingInSource) console.error(`  ${m}`);
    process.exit(1);
  }
  console.log(`  markers: ${MARKERS.length}/${MARKERS.length} present in the source`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  const existing = (await taskModel.getTasksByEdict(EDICT))
    .filter((t) => String(t.name || '').startsWith(LABEL + ':') || String(t.name || '').startsWith(LABEL + ' '));
  if (existing.length) {
    console.log('ALREADY REGISTERED — refusing to insert a second row behind the same label:');
    for (const t of existing) console.log(`  id ${t.id} state=${t.state} active=${t.active}`);
    return;
  }

  await taskModel.createTask(NAME, TODAY, null, INFO, 2, OPEN, null, EDICT);
  const made = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.name === NAME);
  if (!made) { console.error('created, but the row was not found on read-back'); process.exit(1); }
  console.log(`created ${LABEL} as task id ${made.id} (sortOrder ${made.sortOrder}, active ${made.active})`);

  // Verify the text actually LANDED rather than trusting the write.
  const back = String(made.info || '');
  const missingBack = MARKERS.filter((m) => !back.includes(m));
  console.log(`  read-back: ${back.length} chars (wrote ${INFO.length}), `
    + `${missingBack.length ? 'MISSING ' + missingBack.join(' | ') : 'all markers present'}`);
  if (missingBack.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
