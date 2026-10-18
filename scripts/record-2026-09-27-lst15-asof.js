// scripts/record-2026-09-27-lst15-asof.js — LST-15 (#1429): the cost basis gets an as-of date.
// Dry by default:  node scripts/record-2026-09-27-lst15-asof.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 cost-as-of##';
const ID = 1429;

const ADD = `

${MARK}
★★★ **THE COST BASIS NOW CARRIES AN AS-OF DATE, AND MEASURING IT REFUTED THE OBVIOUS IMPLEMENTATION.**

**FIRST, THE TWO DATES ARE DISTINCT AND THE RECORD PROVES IT.** This row warns that the sheet was valued
2026-07-27/28 and imported 2026-08-19, and that they must not be conflated. Measured on \`InventoryItems\`:

    dateAdded  : 2026-07-27 .. 2026-08-17   over 94 rows   <- the VALUATION vintage
    createdAt  : 2026-08-19 .. 2026-09-13                  <- the IMPORT

So \`dateAdded\` IS the valuation date and \`createdAt\` is not. ★ **AND THE VINTAGE IS WIDER THAN THIS ROW
STATES**: it is a **three-week range**, 07-27 to 08-17, not "07-27/28" — a per-part date is therefore not
recoverable from the range alone.

★★★ **WHY THERE IS NO BACK-FILL, WHICH IS THE IMPORTANT FINDING: \`ListingParts.partName\` IS NOT A REFERENCE
TO INVENTORY, IT IS FREE TEXT.** The obvious move is to join each part to the item it came from and take that
row's \`dateAdded\`. Measured:

    108 part rows,  6 matched by name (5.6%),  74 distinct unmatched names
    listing 11 (the SFF clearance this row is about):  0 of 8 parts matched

because the names are DESCRIPTIONS and COMBINATIONS — \`"180GB SSD + 500GB HDD"\` is two components in one
string; \`"SFF"\`, \`"DVD"\`, \`"16GB DDR3"\` name nothing in the stock sheet. **There is no key to join on, and a
name match would not prove the cost came from that row even where one exists. Back-filling from a 5.6% match
would put a confident, WRONG vintage on 94% of the sheet — the same defect as the one being fixed, one layer
deeper.** So \`costAsOf\` is NULL on every existing row, where NULL means exactly what it says.

⚠ **AND NULL MUST NOT BE READ AS "VALUED TODAY".** Stamping \`new Date()\` at write time would date a July
figure to today, which is worse than a blank. \`costAsOf\` is only ever set from a date the CALLER supplies,
because only the caller knows when the figure was valued; an invalid date is REJECTED rather than coerced (the
TRD-43 rule — never let a bad value reach the column and fail there).

**WHAT SHIPPED:**

  · **\`ListingParts.costAsOf DATE NULL\`** + a \`CostAsOf\` extended property carrying the reasoning and the
    no-backfill evidence (\`listings/sql/2026-09-27-cost-as-of.sql\`, idempotent).
  · **\`dbo.vListingCostVintage\`** — the listing's vintage, which is its **OLDEST part**, because **a margin is
    only as trustworthy as its STALEST input**. It returns \`partsWithNoVintage\` **alongside** the date and a
    \`costAsOfLabel\` of \`vintage_unknown\` rather than substituting one.
  · **\`store.listingCostVintage()\`** — the reader, exported.

★ **THE COUNT TRAVELLING WITH THE DATE IS THE POINT, NOT DECORATION.** Without it a caller cannot tell "all 8
parts are dated July" from "1 is dated and 7 are unknown", and the second case would print a confident vintage
for a basis that is mostly unknown.

★ **VERIFIED:** the column exists; **108 part rows, 0 with a vintage** (correct, and by design); the view
returns **15 listings, all \`vintage_unknown\`** with exact counts; listing 1 (the SFF clearance) reports **8
parts, 8 undated, S$105 total**, which reconciles with this row's own \`S$105 of parts on the July sheet\`.
\`eslint\` exit 0.

⚠ **WHAT IS NOT DONE, STATED PLAINLY RATHER THAN IMPLIED:**
  · **THE UI DOES NOT RENDER IT YET.** The acceptance criterion is *"every margin the Workbench prints carries
    the as-of date of the cost basis behind it"* — the DATA and the READER for that are in place, and the
    margin columns do not yet display the label. **The acceptance criterion is therefore NOT YET MET.**
  · **(b) THE REVALUATION PATH IS NOT BUILT** — "so the sheet can be marked to market on demand rather than
    only on import". \`costAsOf\` accepts a date from a caller, so the path can be written against it, but the
    act of stamping a new sheet vintage does not exist. **Until it does, no NEW part will acquire a date
    either**, so the field stays NULL in practice.
  · **THE FIVE FREE-TEXT \`InventoryItems.condition\` ROWS** are LST-7's, untouched here.
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
