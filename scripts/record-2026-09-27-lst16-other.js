// scripts/record-2026-09-27-lst16-other.js — LST-16 (#1430): Listings.other is now rendered.
// Dry by default:  node scripts/record-2026-09-27-lst16-other.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 lst16-other-rendered##';
const ID = 1430;

const ADD = `

${MARK}
★★★ **DONE: \`Listings.other\` IS NOW RENDERED, AND THE DEFECT WAS EXACTLY AS THIS ROW DESCRIBED IT — the field
was already written by the service and displayed nowhere.** Verified before changing anything:

    store.js:75    .input('other', sql.NVarChar(sql.MAX), data.other ?? null)
    store.js:105   INSERT INTO Listings (..., other, ...) VALUES (..., @other, ...)
    store.js:127   UPDATE Listings SET ..., other=@other, ...
    routes.js:43   other: S(b.other)          <- on the SHARED body mapper, so read AND write
    app.v2.js      'other' appeared ONLY as a PART_TYPE value and a fallback string

**So the read path and the write path were both complete and the UI was the only missing link** — which is why
this was cheap. Measured: **0 of 15 Listings rows carry an \`other\` value**, including the six sold, so the field
had never once carried the adjustment it was imported for.

**WHAT SHIPPED** (\`listings/public/js/app.v2.js\`, \`listings/public/css/main.css\`):

  · **a field in the listing form** — \`Other — adjustment / reason for the price\`, placed after Notes, with the
    row's own worked case as its placeholder text. Until now the one field that could explain a deliberate loss
    was the one that could not be typed into.
  · **\`saveListing\` sends \`other\`** on both create and update.
  · **an \`adj\` marker on the NET figure** wherever \`other\` is set, with the reason itself in the \`title\`
    attribute — low-contrast, one hover away, no extra column. This is the part that answers the row's actual
    complaint: a clearance at a deliberate loss was *"indistinguishable from a pricing error"*, and the marker is
    what distinguishes them.

★★★ **AND AN ADJACENT DEFECT WAS FOUND WHILE READING — THE LISTINGS SEARCH BOX EMPTIED THE TABLE.**
\`searchText(kind, r)\` had cases for \`inventory\`, \`prices\`, \`ledger\` and \`comps\` **and none for \`listings\`**, so
it returned \`''\` — and \`''.includes(q)\` is **false for every non-empty query**, while \`applySearchSort\` filters
on exactly that. Typing one character into the Listings search box therefore hid every row. It is the *same
shape* as the categories right beside it, which were handled; \`listings\` was simply never written, and a search
that silently returns nothing **looks like "no matches" rather than like a bug** — which is why it survived.
Fixed by adding the case (listingNo, title, condition, status, notes, other), so \`other\` is now searchable too.

★ **VERIFIED, AND THE LIMIT OF THE VERIFICATION IS STATED RATHER THAN GLOSSED:**
  · the page is served **from disk**, so the change is live on refresh with no service restart — confirmed by
    fetching it: \`/js/app.v2.js\` (46,671 bytes) contains \`f-other\`, the \`listings\` search case and \`adj-mark\`;
    \`/css/main.css\` is served 200 and carries the \`.adj-mark\` rule.
  · \`node --check listings/public/js/app.v2.js\` → **exit 0**, so the file parses and a syntax error cannot have
    broken the whole tab.
  · the data path was confirmed by reading all four call sites above rather than by a write test.
  ⚠ **NOT CLICK-TESTED IN THE BROWSER, AND THE REASON IS A RULE RATHER THAN AN OVERSIGHT.** The Workbench is
  behind a sign-in, and this repo's own \`docs/UI_REVIEW.md\` §"Session-hygiene appendix" records that an
  accessibility snapshot of a shared page **returns the password field's value in plaintext** — *"masking is
  visual only, so any DOM/a11y reader sees credentials typed into a shared page."* Typing credentials to satisfy a
  test would create the exact exposure that note exists to warn about. **The render therefore needs one human
  glance on the Listings tab**; the structure is confirmed, the pixels are not.

⚠ **A STALE NUMBER IN THIS TASK, FLAGGED RATHER THAN REPEATED: the worked case is recorded as the SFF at
\`S$98\` against \`S$105\` of parts, a S$7 loss. Listing #11 now reads **S$125** — the price has moved since
this row was written (2026-09-27), so the S$98/S$7 figures describe a moment that has passed. The DEFECT was
unaffected by that (there was nowhere to record the reason at any price), but a reader re-deriving the loss from
this row would get the wrong number.
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
