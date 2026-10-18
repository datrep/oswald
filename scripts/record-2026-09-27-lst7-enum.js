// scripts/record-2026-09-27-lst7-enum.js — LST-7 (#1395): the condition enum is now enforced.
// Dry by default:  node scripts/record-2026-09-27-lst7-enum.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 condition-enum-enforced##';
const ID = 1395;

const ADD = `

${MARK}
★★★ **THE ENUM IS NOW ENFORCED SERVER-SIDE, AND MEASURING IT CORRECTED WHERE THE VIOLATION ACTUALLY LIVES.**
This row audited \`Listings\` and found it clean after the 2026-09-24 normalisation — **14 rows of
\`Used – working\`, 1 NULL, and NO row stored as \`New\`.** Confirmed again here. **But the same field on
\`InventoryItems\` carries five rows that are not enum values at all:**

    "dusty , unknown working"   x3
    "dusty."                    x1
    "quite a bit of rust"       x1
    (and 89 rows NULL)

**Those are OBSERVATIONS typed into a field that means a chosen value** — which is this row's own third point
("any string can be written") in its purest form, and it was on a table the row did not audit. \`Unknown\` is a
valid enum value those five should carry. The data correction is a SEPARATE step (see the residual below); this
append records the VALIDATOR that stops a sixth.

**THE ENUM, READ FROM \`Lookups\` WHERE IT ACTUALLY LIVES** (key \`condition\`, 4 values):

    "New"                cp: 78 101 119
    "Used – working"     cp: 85 115 101 100 32 8211 32 119 111 114 107 105 110 103
    "For parts"          cp: 70 111 114 32 112 97 114 116 115
    "Unknown"            cp: 85 110 107 110 111 119 110

★★ **\`8211\` IS AN EN DASH (U+2013), NOT AN ASCII HYPHEN — and that single code point is the whole reason this
check is worth having.** This row records the field having carried two spellings of the same value until
normalised. A validator that helpfully turned the en dash into a hyphen would produce a string that is NOT in
the list, and before this change it would have been written anyway.

**WHAT SHIPPED** (\`listings/store.js\`, \`listings/routes.js\`):

  · **\`store.lookupValues(listKey)\`** — the allowed values for one key, read from \`Lookups\` and returned
    EXACTLY as stored, **exported so validation and any future UI read ONE source.** A hardcoded array in the
    route would be a second copy of the enum that drifts the first time the owner edits the Lookups table —
    which is editable from the UI by design.
  · **\`lookupViolation(listKey, value, label)\`** in \`routes.js\`, called on POST and PUT \`/listings\`, returning
    a **400 that names every allowed value verbatim** so a caller can copy one.

★★ **THREE RULES, EACH ONE A WAY THIS GOES WRONG:**

  1. **NULL AND EMPTY ARE ALLOWED.** "Not yet decided" is a real state — 89 \`InventoryItems\` rows and 1
     \`Listings\` row are legitimately NULL — and a validator that refused NULL would force a FABRICATED value.
     This row already made that call correctly when it left listingNo 12 NULL *"where the condition is genuinely
     unknown and writing a value would fabricate a fact."*
  2. **AN EMPTY OR UNKNOWN LOOKUP FAILS OPEN.** With no enum to enforce, refusing every write would take the
     Workbench down rather than protect it.
  3. **EXACT MATCH, EN DASH INCLUDED.** No case folding, no dash folding. The error names the alternatives.

★ **VERIFIED, against the REAL rows rather than invented ones** — \`temp/lst7-test.js\` runs the same rule the
route runs against the same \`Lookups\` table: **all checks pass.** NULL/empty/\`New\`/\`For parts\`/\`Unknown\`/the
stored en-dash value are **accepted**; the three actual free-text strings are **refused**; the ASCII-hyphen twin
of the en-dash value is **refused** and confirmed to be a genuinely different string; an unknown key **fails
open**; and the message is confirmed to list every allowed value.

⚠ **STILL OPEN HERE, AND THREE OF THE FOUR ARE OWNER DECISIONS RATHER THAN CODE:**
  · **(a)** should NULL mean "not-yet-decided" or be filled — unchanged, and the 89 NULL \`InventoryItems\` rows
    make it a bigger question than the single \`Listings\` row this row was written about.
  · **(b)** what a barebone should carry — unchanged. Note \`For parts\` is an allowed value **that nothing in
    the database uses**, which is itself worth a decision.
  · **(c)** the LITERAL form ("a used machine cannot be stored as New at all") is **not implementable as
    written**: the Workbench holds no field saying a machine is used, so it cannot infer it. What IS enforceable
    is the mechanical half — that only enum values can be stored — and that is now in place.
  · **(d)** flagging a listing whose stored condition disagrees with the machine age — unchanged, and it is the
    one that would actually catch "New on a used machine" since a listing's parts name the hardware. Needs a
    part→era notion that does not exist yet.
  · **AND THE DATA IS NOT CORRECTED**: the five \`InventoryItems\` rows still hold free text. The validator stops
    the SIXTH; it does not clean the five. Recorded so the fix is not mistaken for the correction.
`;

(async () => {
  const pool = await getPool();
  const cur = await pool.request().query(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  if (!cur.recordset.length) { console.error(`#${ID} not found`); process.exit(1); }
  const c = cur.recordset[0];
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%'`);
  console.log(`#${ID} state=${c.state} info=${c.len}${dup.recordset.length ? '  [marker present]' : ` -> ${Number(c.len) + ADD.length}`}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  if (dup.recordset.length) { console.log('marker present — nothing to do.'); await pool.close(); return; }
  await pool.request().input('t', ADD).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const back = await pool.request().query(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`);
  console.log(`✔ #${ID} appended -> ${back.recordset[0].len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
