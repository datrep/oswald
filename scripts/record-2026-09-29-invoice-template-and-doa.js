// scripts/record-2026-09-29-invoice-template-and-doa.js
//
//   LST-19  the only invoice template in the repo promises the BUILD warranty on service work
//   LST-20  a pulled part needs its own DOA rule tied to the supplier window; the standard says 14 days
//
// Both found 2026-09-29 while drafting the first real invoice on file (INV-2026-0001, the VivoBook
// S14 Flip keyboard job) — so both are documentation defects the invoice forced into the open.
//
// Schema discipline (same as record-2026-09-27-listing-and-scaling-sets.js): plannedStart is NOT NULL and
// must be a JS Date so `active` computes to 1; `active` is COMPUTED and never named in an INSERT; state 1
// = the open band; sortOrder is PER EDICT; idempotency is guarded by a marker in `info`, because
// Tasks.name has no uniqueness check.
//
// Usage (repo root):
//   node scripts/record-2026-09-29-invoice-template-and-doa.js          # DRY RUN
//   node scripts/record-2026-09-29-invoice-template-and-doa.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-29 invoice+doa##';
const EDICT = 51;        // "Listing Workbench" — already carries the terms/docs family (LST-11, LST-18)
const OPEN = 1;
const PRIORITY = 2;
const E = '\u2014';

const ROWS = [
{
  name: `LST-19: Terms ${E} the only invoice template in the repo promises six months parts + labour, which is the build regime`,
  info:
`${MARK}
FOUND 2026-09-29 while drafting the first real invoice on file — INV-2026-0001, the VivoBook S14 Flip
keyboard job (legal/quotes/quote-100-arsyad-sponge.md).

THE DEFECT: legal/templates/invoice.md is the ONLY invoice template in the repo, and its warranty line reads

  "Warranty: used components 6 months parts + labour | new components 14-day DOA then manufacturer
   warranty | build labour 6 months. Optional 12-month extension available."

That is the BUILD regime. Issued against a service job it would grant SIX MONTHS OF PARTS AND LABOUR on a
pulled laptop keyboard bought from Taobao with a 7-day supplier window - an open-ended warranty on the
cheapest component of the job, with the most expensive part of the job (1.5-2 hours of strip-down labour,
S$65 at the band) riding behind it.

★ THE RULE ALREADY EXISTS AND THE TEMPLATE CONTRADICTS IT. legal/templates/commercial-terms.md states the
split plainly: "Labour / assembly: 6 months on the build as delivered ... Later service work carries 30
days." So this is not a missing rule. It is a template that never caught up, and it has been sitting in
legal/templates/ as the starting point for every invoice.

★ WHY IT MATTERS MORE THAN A STALE LINE IN A TEMPLATE. carousell-framing-standard.md line 366 sets the
house consistency rule: the owner may change any figure or promise, but "every artifact that depends on it
must be updated in the same motion (rate card -> quotes -> invoices -> warranty -> listings)". A template
that contradicts the terms makes that rule unsatisfiable - the propagation has nowhere consistent to land.

★ SAME FAMILY AS A PARKED FINDING. The rate card's warranty section is headed "Warranty claims - ON PCS I
BUILT, covered faults only". That heading is the tell: the entire warranty vocabulary in this repo is
build-scoped, and the service line has been borrowing it. LST-19 is the invoice half of that; the rate card
half is still parked.

DELIVERABLE: split into legal/templates/invoice-build.md and legal/templates/invoice-service.md (or one
template with two explicit, unskippable warranty blocks), the service version carrying:
  - 30 days workmanship on the labour;
  - supplied parts as pass-through, citing the DOA BASIS from LST-20 rather than restating a number;
  - no labour cover and no return-shipping cover on separately supplied parts;
  - testing limited to power-on and detection.

⚠ ALSO NOTED, SO IT IS NOT LOST: invoice numbering has no convention. INV-2026-0001 was proposed as the
first invoice on file and needs confirming or replacing. This is a one-line decision, not a task.

ACCEPTANCE: an invoice cannot be produced without choosing the build or service warranty basis, and the
service version cites LST-20's DOA basis instead of hard-coding a number.`
},
{
  name: `LST-20: Terms ${E} a pulled part needs its own DOA rule tied to the supplier window, and the standard says 14 days`,
  info:
`${MARK}
FOUND 2026-09-29, reconciling the invoice against the terms.

THE STANDARD: legal/templates/commercial-terms.md gives ONE rule for separately supplied parts -
"14-day DOA only", then the manufacturer's warranty applies where the manufacturer offers one, with "No
labour cover and no return-shipping cover" and testing limited to power-on and detection.

WHAT WAS ACTUALLY QUOTED: the VivoBook job on file was quoted at FOUR days. That is what the customer was
told in chat on 2026-09-24 10:13 AM ("its 30 days workmanship + 4 days DOA for the part") and what the
invoice keeps. So the file and the standard disagree, and nobody had noticed.

★★ THE FOUR DAYS ARE CORRECT AND THE STANDARD IS WHAT IS WRONG. The part is a PULLED / SALVAGE assembly
bought on Taobao (order 5127800653025006400: "拆机C壳键盘 无背光 银色" - pulled C-shell keyboard, no
backlight, silver). Its only protections are SEVEN-DAY windows: 极速退款, 7天无理由退货, 7天价保. A 14-day DOA
promise therefore sits entirely OUTSIDE what can be recovered from the supplier, so every day past day 7 is
funded by the seller with no recourse at all. The 14-day rule silently assumes a MANUFACTURER standing
behind the part - which is precisely what a pulled unit does not have.

★★ AND THE EXPOSURE IS NOT THE PART PRICE. Measured on the job in question: the part carries ~S$26
(¥139.52 at 1 CNY = S$0.1888) and the labour S$65. A DOA claim does not return a S$26 part - it triggers a
REDO, because the fix is a full strip-down in which "virtually every internal component is mounted directly
to the top case". So the real cost of an over-long DOA promise here is ~S$26 PLUS 1.5-2 hours of labour,
i.e. roughly 3.5x the part. A DOA rule written as if it were a parts-only exposure under-prices by design.

THE TERMS NEED AT LEAST THREE BASES, NOT ONE:
  1. NEW part with a manufacturer warranty -> 14-day DOA, then pass-through. (Today's rule, correct for this
     case only.)
  2. PULLED / SALVAGE part with a supplier return window -> DOA WITHIN THE SUPPLIER WINDOW LESS TRANSIT,
     typically 4-7 days. No pass-through, because there is nothing to pass through.
  3. OWNER'S OWN LABOUR -> 30 days, unchanged.

DELIVERABLE: state the three bases in commercial-terms.md; tie basis 2 explicitly to the supplier's return
window rather than to a fixed number; and make the quote and invoice documents CITE the basis instead of
restating a period, so the number cannot drift from the window again.

ACCEPTANCE: every quoted DOA period traces to a named basis, and no basis exceeds what the named supplier
will actually honour.`
}
];

(async () => {
  const pool = await getPool();

  const done = await pool.request().input('m', `%${MARK}%`)
    .query(`SELECT COUNT(*) AS n FROM Tasks WHERE info LIKE @m`);
  if (Number(done.recordset[0].n)) {
    console.log(`⚠ marker already present (${done.recordset[0].n} row) — nothing to do.`);
    await pool.close();
    return;
  }

  const s = await pool.request().input('e', EDICT)
    .query(`SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks WHERE edictId = @e`);
  let sort = Number(s.recordset[0].m) + 1;

  console.log(`edict ${EDICT} — max sortOrder ${s.recordset[0].m}, writing from ${sort}\n`);
  for (const r of ROWS) {
    console.log(`  [${sort}] ${r.name.slice(0, 82)}  (info ${r.info.length} chars)`);
    sort += 1;
  }

  if (!YES) { console.log('\nDRY RUN — pass --yes to write. No DB write performed.'); await pool.close(); return; }

  sort = Number(s.recordset[0].m) + 1;
  const ids = [];
  for (const r of ROWS) {
    const ins = await pool.request()
      .input('name', r.name).input('info', r.info)
      .input('plannedStart', new Date())
      .input('sortOrder', sort).input('edictId', EDICT)
      .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
              OUTPUT INSERTED.id AS id
              VALUES (@name, @info, @plannedStart, ${PRIORITY}, ${OPEN}, @edictId, @sortOrder, SYSUTCDATETIME())`);
    ids.push(ins.recordset[0].id);
    sort += 1;
  }

  const back = await pool.request().query(
    `SELECT id, sortOrder, state, active, LEN(CAST(info AS nvarchar(max))) AS info_len, name
     FROM Tasks WHERE id IN (${ids.join(',')}) ORDER BY sortOrder`);
  console.log('\n--- read-back');
  for (const r of back.recordset)
    console.log(`  #${r.id} sort=${r.sortOrder} state=${r.state} active=${r.active} info=${r.info_len}  ${String(r.name).slice(0, 70)}`);
  const bad = await pool.request().query(
    `SELECT COUNT(*) AS n FROM Tasks WHERE id IN (${ids.join(',')})
       AND (name LIKE N'%' + NCHAR(226) + N'%' OR info LIKE N'%' + NCHAR(226) + N'%')`);
  const dash = await pool.request().query(
    `SELECT COUNT(*) AS n FROM Tasks WHERE id IN (${ids.join(',')}) AND name LIKE N'%' + NCHAR(8212) + N'%'`);
  console.log(`  mojibake: ${bad.recordset[0].n} row(s) · real em dashes: ${dash.recordset[0].n}/${ids.length}`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
