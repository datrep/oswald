// scripts/task-label-hygiene.js — detect (and repair) duplicate TRD label prefixes in the register.
//
// WHY: `Tasks.name` has NO uniqueness constraint — only `id` does. A task label is the ONLY citation handle
// this repo uses (docs, pre-registrations, code comments and task bodies all cite `TRD-n`), so two open rows
// behind one label make the citation unresolvable. Fourth occurrence: TRD-36, TRD-EVD-1, TRD-118, TRD-119.
//
// ★★ THE TRAP THAT REFUTES THE OBVIOUS FIX: a repeated prefix is NOT automatically a defect.
//   `TRD-12` appears 11 times (ids 200-210: Learning / Analytics / Risk / Backtest / Orders / Data / Connector /
//   Budget / Strategy / Nav). That IS the house convention for a numbered SET split by domain — the convention
//   says a function name of 4+ letters goes in the DOMAIN, not as its own segment. A unique index (or a
//   `COUNT(*) > 1` check) would therefore FAIL THE EXISTING REGISTER. Repetition is only a defect when it was
//   not intended, and no constraint can express intent — so this tool reports, and an explicit, documented
//   allowlist carries the known-good exception.
//
// Usage (from the repo root):
//   node scripts/task-label-hygiene.js           # REPORT — exits 1 on any unexpected repeat
//   node scripts/task-label-hygiene.js --fix     # repair the known TRD-118 / TRD-119 collisions
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getPool, sql } = require('../shared/db');
// The label contract has exactly one home — the same module `models/taskModel.createTask` warns from.
const { labelOf } = require('../shared/taskLabels');

// Known-good repeats. Each entry MUST say why it is legitimate, and it must name the ids, so the exception is
// VISIBLE rather than folkloric.
//
// ★ THREE OF THESE FOUR WERE INVISIBLE UNTIL 2026-09-24, AND THAT IS WHY THE ALLOWLIST MATTERS. This script
// originally queried `WHERE name LIKE 'TRD-%'` and its regex matched `TRD-` only, so the `FS-1`, `MOD-1` and
// `MOD-2` sets were never reported as repeats at all — their intent lived nowhere but the register itself. The
// net is now every label family (see shared/taskLabels.js), which immediately surfaced all three. All three are
// CLOSED and all three are the same convention: a numbered set split by domain.
const ALLOWED_REPEATS = {
  'TRD-12': 'the TRD-12 phase set, deliberately split by domain across ids 200-210 (edict 52; 10 closed + id 210 open)',
  'FS-1': 'the FS-1 fileserver set, deliberately split by domain across ids 41-46 (edict 18; all 6 closed)',
  'MOD-1': 'the MOD-1 module set, deliberately split by domain across ids 75-80, 87-92, 104-110 (edicts 20 + 21; all 19 closed) — one set spanning TWO policies, which is why it reads as 19 rows',
  'MOD-2': 'the MOD-2 module set, deliberately split by domain across ids 81, 82, 93, 94, 111, 112 (edicts 20 + 21; all 6 closed) — the follow-up rows of the same two-policy pattern',
};

// The newcomer yields (the TRD-EVD-1 -> TRD-EVD-2 precedent: the row that arrived second is renamed).
const RENAMES = [
  { id: 1387, from: 'TRD-118', to: 'TRD-LRN-1' },
  { id: 1388, from: 'TRD-119', to: 'TRD-LRN-2' },
];

const FIX = process.argv.includes('--fix');

async function main() {
  const pool = await getPool();
  const r = await pool.request().query(`
    SELECT id, edictId, name, state FROM Tasks WHERE name IS NOT NULL ORDER BY id
  `);

  const byLabel = new Map();
  let labelled = 0;
  for (const t of r.recordset) {
    const label = labelOf(t.name);
    if (!label) continue;
    labelled++;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(t);
  }

  const repeats = [...byLabel.entries()].filter(([, v]) => v.length > 1).sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`labelled rows : ${labelled}`);
  console.log(`distinct labels   : ${byLabel.size}`);
  console.log(`repeated prefixes : ${repeats.length}\n`);

  const unexpected = [];
  for (const [label, list] of repeats) {
    const allowed = ALLOWED_REPEATS[label];
    console.log(`${allowed ? 'OK    ' : 'DEFECT'}  ${label}  x${list.length}${allowed ? `  (allowlist: ${allowed})` : ''}`);
    for (const t of list) {
      console.log(`          id ${String(t.id).padStart(5)} state=${t.state} edict=${t.edictId}  ${t.name.slice(0, 110)}`);
    }
    if (!allowed) unexpected.push(label);
  }

  for (const label of Object.keys(ALLOWED_REPEATS)) {
    if (!byLabel.has(label)) console.log(`\nWARN: allowlist entry ${label} is no longer present — remove it.`);
  }

  if (!unexpected.length) {
    console.log('\nNo unexpected label repeats.');
    return 0;
  }

  console.log(`\nUNEXPECTED repeats: ${unexpected.join(', ')}`);

  if (!FIX) {
    console.log('Re-run with --fix to apply the recorded renames.');
    return 1;
  }

  console.log('\n--- applying renames (newcomer yields) ---');
  for (const { id, from, to } of RENAMES) {
    const cur = await pool.request().input('id', sql.Int, id).query('SELECT id, name FROM Tasks WHERE id = @id');
    if (!cur.recordset.length) { console.log(`  id ${id}: NOT FOUND — skipped`); continue; }
    const name = cur.recordset[0].name;
    const label = labelOf(name);
    if (label === to) { console.log(`  id ${id}: already ${to} — skipped`); continue; }
    if (label !== from) { console.log(`  id ${id}: label is ${label}, expected ${from} — SKIPPED (refusing to guess)`); continue; }
    const renamed = to + name.slice(from.length);
    // Guard against inventing a NEW collision.
    const clash = await pool.request().input('n', sql.NVarChar, renamed).query('SELECT id FROM Tasks WHERE name = @n');
    if (clash.recordset.length) { console.log(`  id ${id}: target name already used by id ${clash.recordset[0].id} — SKIPPED`); continue; }
    await pool.request()
      .input('id', sql.Int, id)
      .input('n', sql.NVarChar, renamed)
      .query('UPDATE Tasks SET name = @n WHERE id = @id');
    console.log(`  id ${id}: ${from} -> ${to}`);
  }
  console.log('\nRe-run without --fix to confirm.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => { console.error(e); process.exit(1); });
