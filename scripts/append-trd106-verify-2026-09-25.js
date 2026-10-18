// scripts/append-trd106-verify-2026-09-25.js — record the TRD-106 verification on its own row.
//
// ★ APPEND, NOT REPLACE. This row carries 10,734 chars of prior measurement and is not rewritten.
//
// ★ GUARD SHAPE. I have NOT read this row's body, so instead of "must already contain X" (which would be a
// marker I guessed at) the guards are ones I can actually stand behind:
//   · the row must carry substantial text (>= 5000 chars) — a wrong row would fail this;
//   · the first 160 chars of the existing text are PRINTED so the operator can see it is the right row;
//   · the new section must NOT already be present (idempotency — a second append would duplicate it).
// That is weaker than a marker match, and it is NAMED as weaker rather than presented as equivalent.
//
// Usage:
//   node scripts/append-trd106-verify-2026-09-25.js          # DRY RUN
//   node scripts/append-trd106-verify-2026-09-25.js --yes    # writes
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const ID = 1357;
const MIN_EXISTING = 5000;
const NEW_MARK = '2026-09-25 - VERIFIED AGAINST THE LIVE BOOK';
const MUST_EXIST_AFTER = ['VERIFIED AGAINST THE LIVE BOOK', '33.3%', '0 (0.0%)', 'NOT a valid baseline', '66.7%'];

// Whitespace-normalised: these rows are hard-wrapped, so a marker spanning a line break would otherwise
// report MISSING. Collapsing runs of whitespace on both sides cannot cause a false positive.
const norm = (s) => String(s).replace(/\s+/g, ' ');
const has = (text, m) => norm(text).includes(norm(m));

const ADDITION = `
---------------------------------------------------------------------------
2026-09-25 - VERIFIED AGAINST THE LIVE BOOK. THE FIX LANDED, AND THE BASELINE REPRODUCES.
---------------------------------------------------------------------------
The finding this row records: the shortest trades could never have an excursion measured, so the net-edge
screen was blind exactly where the edge is thinnest. The capture change shipped 2026-09-20 (accountPoller
persists the positions read as PriceTicks with source='position_poll', so a path exists without a wake).

★ THE MEASURE USED HERE IS THE ROW'S OWN: \`mfePct\`/\`maePct\` NULL. That is a STORED COLUMN, so unlike a
tick-path count it CANNOT be destroyed by \`retention.tickDays\` pruning it - which makes it the only basis
on which the two eras can honestly be compared. See the caveat below; it is the reason this entry exists.

  era                               n    no mfePct    no maePct   held min (unmeasured)  held min (measured)
  PRE-FIX  (openAt <  2026-09-20)  45   15 (33.3%)   15          3.0                    118.0
  POST-FIX (openAt >= 2026-09-20)  25    0 (0.0%)     0          -                      110.0

  THE BASELINE REPRODUCES: this row records "15 of 44 (34%)". Re-measured today it is 15 of 45 (33.3%) -
  the same 15 rows, with one further trade closed since. The era split is therefore sound, not convenient.

★ AND THE BLIND SPOT THE ROW WAS WRITTEN ABOUT IS CLOSED, INCLUDING WHERE IT WAS WORST:
  PRE-FIX  short trades (<=30 min) n=21, with NO mfePct: 14 (66.7%)
  POST-FIX short trades (<=30 min) n= 6, with NO mfePct:  0 (0.0%)
  The pre-fix blind set is dominated by the fast strategies - #1044 4min, #1050 3min, #1051 3min, #1053
  3min, #1057 3min, #1059 5min, #1061 5min (Bitcoin), #14 7min (Gold), #21 2min (Sugar) - exactly the
  population the net-edge screen could not refuse BECAUSE it could not measure them.

  Where the extremes now come from: post-fix, mfeSource/maeSource are mid=11, close=6, mid/mid=6 - so the
  new position_poll ticks are FEEDING the metrics rather than being decorative.

★★ CAVEAT, RECORDED BECAUSE I NEARLY PUBLISHED THE OPPOSITE: a TICK-PATH count is NOT a valid baseline for
this defect. Tick retention is \`retention.tickDays = 7\`, so a pre-fix window reports "0 mids" today because
its ticks were PRUNED, not because no path ever existed. Measured that way the pre-fix era looks 75.6% blind
(34/45) against a recorded 34% - a figure produced by DELETION, which would have overstated the fix by more
than 2x. Any future audit of this defect needs the ARCHIVE (\`trading/archive/ticks\`, 42 gzipped JSONL
batches spanning 2026-09-14 .. 2026-09-21, written BEFORE the prune). Same class as TRD-92's note that the
2026-09-19 excursions could not be re-derived afterwards.

ONE RESIDUAL, too small to be its own row: 2 post-fix rows carry \`mfePct\` but NO \`mfeSource\`, so TRD-117's
provenance does not cover every measured row.

NO CODE CHANGE WAS MADE. This entry verifies a fix that shipped, and records the retention caveat that makes
the verification honest.
`;

async function main() {
  const tasks = await taskModel.getTasksByEdict(52);
  const row = tasks.find((t) => Number(t.id) === ID);
  if (!row) { console.error(`REFUSING: no task ${ID} in edict 52`); process.exit(1); }
  const current = String(row.info || '');

  if (has(current, NEW_MARK)) {
    console.error(`ALREADY APPLIED — task ${ID} already carries "${NEW_MARK}". Refusing a SECOND copy.`);
    process.exit(1);
  }
  if (current.length < MIN_EXISTING) {
    console.error(`REFUSING: task ${ID} carries only ${current.length} chars (min ${MIN_EXISTING}) — wrong row?`);
    process.exit(1);
  }

  const next = current.replace(/\s*$/, '') + '\n' + ADDITION;
  const previewMissing = MUST_EXIST_AFTER.filter((m) => !has(next, m));
  console.log(`TRD-106 (id ${ID})  state ${row.state}  priority ${row.priority}`);
  console.log(`  existing text begins: ${JSON.stringify(current.slice(0, 160))}`);
  console.log(`  info: ${current.length} -> ${next.length} chars (+${next.length - current.length})`);
  console.log(`  new-section markers checked: ${MUST_EXIST_AFTER.length - previewMissing.length}/${MUST_EXIST_AFTER.length} present`
    + (previewMissing.length ? '  MISSING: ' + previewMissing.join(' | ') : ''));
  if (previewMissing.length) { console.error('\nREFUSING: section is missing its own markers. Nothing written.'); process.exit(1); }
  if (!APPLY) { console.log('\nDRY RUN — pass --yes to write. No DB write performed.'); return; }

  await taskModel.updateTask(ID, { info: next });
  const back = (await taskModel.getTasksByEdict(52)).find((t) => Number(t.id) === ID);
  const text = String((back && back.info) || '');
  const missNew = MUST_EXIST_AFTER.filter((m) => !has(text, m));
  console.log(`\n  read-back: ${text.length} chars, state ${back.state}`);
  console.log(`  new section: ${missNew.length ? 'MISSING ' + missNew.join(' | ') : 'all markers present'}`);
  if (missNew.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
