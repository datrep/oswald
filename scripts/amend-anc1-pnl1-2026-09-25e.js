// scripts/amend-anc1-pnl1-2026-09-25c.js â€” sync TRD-ANC-1 and TRD-PNL-1 to their docs after the third pass.
//
// TRD-ANC-1: the documentation survey + the RULING (stay observe-only; pursue option (c) instead of the
//            post-fill amend), plus the cross-ref doc correction.
// TRD-PNL-1: the 12/31 discrepancy is DIAGNOSED â€” it was a defect in the analysis, not in the data.
//
// Same discipline as the other scripts: the `.md` is the single source, length AND all markers are checked
// BEFORE the write, and verified again after. MARKERS ARE ASCII-ONLY â€” a marker with an ASCII hyphen where
// the document has a Unicode minus matches nothing and refuses the run.
//
// Usage:
//   node scripts/amend-anc1-pnl1-2026-09-25c.js          # DRY RUN
//   node scripts/amend-anc1-pnl1-2026-09-25c.js --yes    # writes
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;
const MIN_CHARS = 3000;

const TASKS = [
  {
    label: 'TRD-ANC-1',
    doc: 'docs/trd-anc-1-inert-reanchor-false-join-2026-09-25.md',
    markers: [
      '30 of 30',
      'shift: 0',
      'written into the fix for F20',
      'smoke_note',
      'FROZEN forward-validation candidate',
      'ADDITIONAL FINDING, added 2026-09-25',
      'tautological',
      'THE DOCUMENTATION ALREADY RULED ON THE ENFORCE HALF',
      'stay OBSERVE-ONLY',
      'never automated',
      'THE ANCHOR-AGE MEASUREMENT',
      'OPTION (c) IS VALIDATED',
      'MY EARLIER INFERENCE WAS WRONG',
      'TICK_SLA_MS = 15',
      'seven-minute-old',
      'STRUCTURALLY DEAD',
      '0 available ticks, in 30 of 30 entries',
      'the mechanism has no input',
      'the threshold can be chosen from data afterwards',
      'anchors both',
    ],
  },
  {
    label: 'TRD-PNL-1',
    doc: 'docs/trd-pnl-1-net-pl-path-2026-09-25.md',
    markers: [
      'is the maximum/minimum P/L RECORDED as a range',
      'ONE MUTABLE COLUMN',
      'mean interval 2.4s',
      'DEDUPE_WINDOW_MS',
      'net P/L path per open position',
      'OUTCOME (2026-09-25)',
      'Forward-only',
      '12/31',
      'mixed P/L basis',
      'defect in the ANALYSIS',
      'venue_rate',
    ],
  },
];

async function main() {
  const loaded = [];
  for (const t of TASKS) {
    const full = path.join(__dirname, '..', t.doc);
    if (!fs.existsSync(full)) { console.error(`REFUSING: missing ${full}`); process.exit(1); }
    const info = fs.readFileSync(full, 'utf8').trim();
    if (info.length < MIN_CHARS) {
      console.error(`REFUSING ${t.label}: only ${info.length} chars (min ${MIN_CHARS}).`);
      process.exit(1);
    }
    const missing = t.markers.filter((m) => !info.includes(m));
    if (missing.length) {
      console.error(`REFUSING ${t.label}: missing ${missing.length} marker(s):`);
      for (const m of missing) console.error(`  ${m}`);
      process.exit(1);
    }
    loaded.push({ ...t, info });
  }

  console.log(`edict ${EDICT} â€” would amend ${loaded.length} task(s):\n`);
  for (const t of loaded) {
    console.log(`  ${t.label}  ${String(t.info.length).padStart(5)} chars  markers ${t.markers.length}/${t.markers.length}`);
  }
  if (!APPLY) { console.log('\nDRY RUN â€” pass --yes to write. No DB write performed.'); return; }

  const all = await taskModel.getTasksByEdict(EDICT);
  for (const t of loaded) {
    const rows = all.filter((x) => String(x.name || '').startsWith(t.label + ':'));
    if (rows.length !== 1) { console.error(`REFUSING: expected one ${t.label} row, found ${rows.length}`); process.exit(1); }
    const row = rows[0];
    const before = String(row.info || '').length;
    await taskModel.updateTask(row.id, { info: t.info });
    const back = (await taskModel.getTasksByEdict(EDICT)).find((x) => x.id === row.id);
    const text = String((back && back.info) || '');
    const missing = t.markers.filter((m) => !text.includes(m));
    console.log(`\n${t.label} id ${row.id}: info ${before} -> ${text.length} chars (state ${back.state})`);
    console.log(`  ${missing.length ? 'MISSING ' + missing.join(' | ') : 'all markers present'}`);
    if (missing.length) process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });


