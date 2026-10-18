// scripts/rename-2026-09-30-rsk14.js — corrects TRD-RSK-14's TITLE, which asserts "25% charged vs 20% modelled".
// That reads as "the registry is wrong". The measurement says the registry is right and the guard is missing a
// currency, so the title is as falsified as the body was. Gated: the new name must fit dbo.Tasks.name (255 chars),
// the row must still be open, and the body must already carry the corrected diagnosis.
// DRY RUN by default (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const NAME = 'TRD-RSK-14: Risk - the L3 margin guard applies the venue RATE to a notional in the INSTRUMENT currency while the venue withholds margin in the ACCOUNT currency, so its 80% ceiling is 102.5% of what the venue really withholds';

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;
  const r = (await q(`SELECT id, state, name, CAST(info AS NVARCHAR(MAX)) AS info FROM dbo.Tasks WHERE name LIKE '%RSK-14%'`))[0];
  if (!r) throw new Error('TRD-RSK-14 not found');
  if (Number(r.state) === 3) throw new Error('the row is archived — a title correction on a closed row is churn');
  if (!String(r.info).includes('THE REGISTRY\'S RATE IS RIGHT')) throw new Error('the body does not carry the corrected diagnosis — fix the body first');
  if (NAME.length > 255) throw new Error(`the new name is ${NAME.length} chars and dbo.Tasks.name holds 255`);
  if (NAME.includes('\u0060') || NAME.includes("'")) throw new Error('the name must contain no backtick and no single quote');
  console.log(`  before (${r.name.length} chars): ${r.name}`);
  console.log(`  after  (${NAME.length} chars): ${NAME}`);
  if (!YES) { console.log('\nDRY RUN — nothing written.\n'); await pool.close(); return; }
  await pool.request().query(`UPDATE dbo.Tasks SET name = N'${NAME}' WHERE id = ${r.id}`);
  const after = (await q(`SELECT name FROM dbo.Tasks WHERE id = ${r.id}`))[0].name;
  if (after !== NAME) throw new Error('the read-back does not match — the write did not land');
  console.log(`  ✅ #${r.id} retitled and read back`);
  await pool.close();
})().catch((e) => { console.error(`\n\u26A0 ${e.message}\n`); process.exit(1); });
