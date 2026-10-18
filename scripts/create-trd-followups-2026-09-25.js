// scripts/create-trd-followups-2026-09-25.js — register the three follow-ups found while pursuing the
// anchor->fill drift on the owner's instruction.
//
//   TRD-ANC-1  the F20 re-anchor has never fired (30/30 shift=0) + the decisionId false-join trap
//   TRD-PNL-1  the NET P/L path is read every ~2.4s and thrown away
//   TRD-GEO-1  levelGeometry validates the geometry with a derivation that is wrong on capped tickets
//
// ★ TEXT COMES FROM `.md` FILES, NOT CONCATENATED JS STRINGS. The first draft of the TRD-FED-1 script died
// on an unescaped apostrophe inside a single-quoted literal — the same long-text-to-DB trap this repo has
// been bitten by before (a concatenated string once wrote 98 of ~2,500 chars to `Tasks.info`). Each task's
// text has a single source document, the length is checked BEFORE the write, and the markers are verified
// AFTER it.
//
// All three are registered together because they came out of ONE investigation and are meant to be worked
// as a set; each still carries its OWN label guard so a re-run cannot double-register.
//
// Schema traps (same as scripts/create-trd-ext1-task.js): `plannedStart` is NOT NULL with no defaults;
// `active` is COMPUTED (never insert it) and a raw SQL `GETDATE()` writes local wall-clock, 8h ahead of its
// `GETUTCDATE()` comparison -> active = 0. Writes go through `models/taskModel.createTask`.
//
// Usage:
//   node scripts/create-trd-followups-2026-09-25.js          # DRY RUN
//   node scripts/create-trd-followups-2026-09-25.js --yes    # writes
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;   // "Trading Agent"
const OPEN = 1;
const TODAY = new Date();

// ★ MARKERS ARE ASCII-ONLY SUBSTRINGS, taken from near DIFFERENT parts of each document, so a write that
// captured only the head fails on the later ones. The TRD-FED-1 run refused itself because a marker used
// an ASCII hyphen where the document had a Unicode minus (U+2212); these avoid non-ASCII entirely.
const TASKS = [
  {
    label: 'TRD-ANC-1',
    priority: 1,
    doc: 'docs/trd-anc-1-inert-reanchor-false-join-2026-09-25.md',
    name: 'TRD-ANC-1: Entry anchor — the F20 re-anchor has never fired (30/30 shift=0) because it compares the desk\'s tick to itself, and Trades.decisionId silently mis-joins to TradingEvents',
    markers: [
      '30 of 30',
      'shift: 0',
      'written into the fix for F20',
      'smoke_note',
      'FROZEN forward-validation candidate',
      'Observe first, enforce later',
    ],
  },
  {
    label: 'TRD-PNL-1',
    priority: 2,
    doc: 'docs/trd-pnl-1-net-pl-path-2026-09-25.md',
    name: 'TRD-PNL-1: Trade telemetry — record the NET P/L path (min / max / terminal) instead of overwriting one column at 2.4s',
    markers: [
      'is the maximum/minimum P/L RECORDED as a range',
      'ONE MUTABLE COLUMN',
      'mean interval 2.4s',
      '23 of the 39 rows carrying',
      'DEDUPE_WINDOW_MS',
      'net P/L path per open position',
    ],
  },
  {
    label: 'TRD-GEO-1',
    priority: 2,
    doc: 'docs/trd-geo-1-level-geometry-derivation-2026-09-25.md',
    name: 'TRD-GEO-1: Level geometry — anchored_off_fill is derived from the levels under test, so it is wrong on all 27 capped tickets',
    markers: [
      'wrong on any capped ticket',
      '27 of the 30 agent entries',
      'Wrong by roughly 5x',
      '30.74',
      '32.4%',
      'inside the noise band',
    ],
  },
];

const MIN_CHARS = 2500;

async function main() {
  const loaded = [];
  for (const t of TASKS) {
    const full = path.join(__dirname, '..', t.doc);
    if (!fs.existsSync(full)) {
      console.error(`REFUSING: source document not found for ${t.label}: ${full}`);
      process.exit(1);
    }
    const info = fs.readFileSync(full, 'utf8').trim();
    if (info.length < MIN_CHARS) {
      console.error(`REFUSING ${t.label}: INFO is only ${info.length} chars (min ${MIN_CHARS}). Nothing written.`);
      process.exit(1);
    }
    const missing = t.markers.filter((m) => !info.includes(m));
    if (missing.length) {
      console.error(`REFUSING ${t.label}: source document is missing ${missing.length} marker(s):`);
      for (const m of missing) console.error(`  ${m}`);
      process.exit(1);
    }
    loaded.push({ ...t, info });
  }

  console.log(`edict ${EDICT} — would write ${loaded.length} task(s):\n`);
  for (const t of loaded) {
    console.log(`  ${t.label}  priority ${t.priority}  ${String(t.info.length).padStart(5)} chars  `
      + `markers ${t.markers.length}/${t.markers.length}`);
    console.log(`    ${t.name}`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  const existing = await taskModel.getTasksByEdict(EDICT);
  const made = [];
  for (const t of loaded) {
    const dupes = existing.filter((x) => String(x.name || '').startsWith(t.label + ':'));
    if (dupes.length) {
      console.log(`\n${t.label}: ALREADY REGISTERED — refusing a second row behind the same label:`);
      for (const d of dupes) console.log(`  id ${d.id} state=${d.state} active=${d.active}`);
      continue;
    }
    await taskModel.createTask(t.name, TODAY, null, t.info, t.priority, OPEN, null, EDICT);
    const back = (await taskModel.getTasksByEdict(EDICT)).find((x) => x.name === t.name);
    if (!back) { console.error(`${t.label}: created, but the row was not found on read-back`); process.exit(1); }
    const text = String(back.info || '');
    const missing = t.markers.filter((m) => !text.includes(m));
    made.push({ label: t.label, id: back.id, active: back.active, wrote: t.info.length, got: text.length });
    console.log(`\n${t.label}: created as task id ${back.id} (active ${back.active})`);
    console.log(`  read-back ${text.length} chars (wrote ${t.info.length}) — `
      + `${missing.length ? 'MISSING ' + missing.join(' | ') : 'all markers present'}`);
    if (missing.length) process.exit(1);
  }

  console.log(`\nregistered ${made.length}/${loaded.length}: `
    + made.map((m) => `${m.label}=${m.id}`).join(' '));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
