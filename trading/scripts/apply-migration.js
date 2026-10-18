// trading/scripts/apply-migration.js — apply ONE sql/migrations file THROUGH THE APP'S OWN POOL.
//
// Why not sqlcmd: the app's connection is the authority on which server and which database are in use
// (shared/db, resolved from .env). A migration applied with sqlcmd against a guessed instance can report
// success and change nothing the desk can see — and this repo has two instance/port conventions in play
// (setup-sqlexpress-db.ps1 uses `localhost,1435`; .env says `localhost` + DB_PORT). Running the file over
// the pool the desk actually uses removes that whole class of "applied, but not where you looked".
//
// Idempotent by convention: every migration here guards its own DDL with IF COL_LENGTH / IF OBJECT_ID, so
// re-running is safe. It does NOT take a lock or record a schema-version row — this is the operational
// path, not a migration framework.
//
// Usage (from the repo root):
//   node trading/scripts/apply-migration.js sql/migrations/043_pricebars_source_interval.sql
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { getPool } = require('../../shared/db');

async function main() {
  const rel = process.argv[2];
  if (!rel) {
    console.error('usage: node trading/scripts/apply-migration.js <path-to.sql>');
    process.exit(2);
  }
  const file = path.isAbsolute(rel) ? rel : path.join(__dirname, '../..', rel);
  if (!fs.existsSync(file)) {
    console.error(`not found: ${file}`);
    process.exit(2);
  }
  // Split on GO — sqlcmd's batch separator, which T-SQL itself does not understand.
  const batches = fs.readFileSync(file, 'utf8')
    .split(/^\s*GO\s*$/gim)
    .map((s) => s.trim())
    .filter(Boolean);

  const pool = await getPool();
  console.log(`applying ${path.basename(file)} — ${batches.length} batch(es)`);
  for (const [i, b] of batches.entries()) {
    const r = await pool.request().batch(b);
    const affected = (r.rowsAffected || []).filter((n) => n || n === 0).join(', ');
    console.log(`  batch ${i + 1}: ok${affected ? ` (${affected} rows affected)` : ''}`);
  }
  console.log('done');
  await pool.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
