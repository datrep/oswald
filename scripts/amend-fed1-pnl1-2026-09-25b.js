// scripts/amend-fed1-pnl1-2026-09-25b.js — sync TRD-FED-1 and TRD-PNL-1 to their docs after the second pass.
//
// TRD-FED-1: acceptance item 1 DISCHARGED — the cross-source guard EXISTS (`quant.js pickTick`), so the
//            finding is downgraded from a prompt-path defect to a feed-quality observation.
// TRD-PNL-1: items 1-3 done, item 4 RESOLVED (TradingEvents has no retention -> cadence 60s), item 5
//            RESOLVED (backfill is impossible: the reconstruction fails on 12/31 rows).
//
// Same discipline as the other registration scripts: the `.md` is the single source, length AND all markers
// are checked BEFORE the write, and verified again after. MARKERS ARE ASCII-ONLY — a marker written with an
// ASCII hyphen where the document has a Unicode minus matches nothing and refuses the run, which is how the
// first TRD-FED-1 run caught itself.
//
// Usage:
//   node scripts/amend-fed1-pnl1-2026-09-25b.js          # DRY RUN
//   node scripts/amend-fed1-pnl1-2026-09-25b.js --yes    # writes
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
    label: 'TRD-FED-1',
    doc: 'docs/trd-fed-1-oil-feed-staleness-2026-09-25.md',
    markers: [
      'What the cliff actually was',
      '1.44 points (',
      'spread -2.293%',
      'quant.js:287',
      'DETECTED and not LOGGED is still invisible',
      'acceptance item 1 DISCHARGED',
      'VENUE OF RECORD WINS',
      'SUBSTITUTE VENUE IS USED ONLY',
      'I overstated this',
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
      '19 / 31',
      '12 / 31',
      'mixed P/L basis',
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

  console.log(`edict ${EDICT} — would amend ${loaded.length} task(s):\n`);
  for (const t of loaded) {
    console.log(`  ${t.label}  ${String(t.info.length).padStart(5)} chars  markers ${t.markers.length}/${t.markers.length}`);
  }
  if (!APPLY) { console.log('\nDRY RUN — pass --yes to write. No DB write performed.'); return; }

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
