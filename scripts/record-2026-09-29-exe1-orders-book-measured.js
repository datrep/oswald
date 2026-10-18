// scripts/record-2026-09-29-exe1-orders-book-measured.js
//
// TRD-EXE-1 (#1454): the order book was MEASURED for the first time. The result is a NEGATIVE that now has a
// CAUSE, which is a different thing from the guess it replaces. Appends the finding to task #1454.
//
// DRY RUN by default. Pass --yes to write.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const EM = '\u2014', ARROW = '\u2192', STAR = '\u2605', WARN = '\u26A0', CHECK = '\u2705';

const ADDENDUM = `

##2026-09-29 exe1-orders-book-measured## THE VENUE ORDER BOOK WAS MEASURED. IT RENDERS NOTHING, AND NOW WE
KNOW WHY ${EM} which is different from the guess it replaces.

${STAR} WHAT WAS BUILT, AND WHY IT HAD TO RUN IN THE SERVICE. Item 4's classification half and item 2's
cancel/adopt both need the order row's testid prefix, and nothing in this repo had ever seen it. A new READ-ONLY
route measures it: 'POST /api/trading/orders/book-probe' ${ARROW} 'webtrader.readOrderBookShape(page)'.
${WARN} It is a route and NOT a CLI script on purpose: 'pageLock' is IN-PROCESS mutual exclusion ("every desk
flow lives in the service process"), so a standalone script cannot coordinate with a ticket and would navigate
the shared tab out from under one ${EM} the exact race that killed order 6289 mid set-limits. Caller:
'trading/scripts/order-book-probe.js'. No click exists anywhere in this path, so it cannot cancel or modify an
order at the venue.

${WARN}${WARN} THE MEASUREMENT: '/open-orders' DOES NOT RENDER AN ORDER LIST IN THIS SESSION.
    url            https://app.plus500.com/open-orders   (navigated, confirmed by location.href)
    body innerText 1 character
    html length    2,803,215 chars
    shadow-root    404 chars
    testids        31 ${EM} ALL chrome: AccountStatus(12) Sidebar(4) NavigationBar(3)
                   InactivityTimer(2) notification-center(5) TradeLayout(1) More ToggleBalance
                   WalkThrough Dialog
    ROW-LIKE       []      (no <Prefix>.<id> element of any kind)
    ORDER-ish      []      (no testid anywhere on the page contains "order")
    a "Privacy Preference Center" consent dialog is PRESENT, plus WalkThrough and InactivityTimer
  ${ARROW} **the testid prefix is still UNOBSERVED, and that is still the correct state**: guessing it could
  label a POSITION a queued order, making the desk believe a fill had NOT happened when it had. What changed is
  that the blocker now has a CAUSE rather than being an unknown.

${CHECK} AND IT IS NOT DESK-WIDE BLINDNESS ${EM} checked rather than assumed, because "the venue did not render"
and "the desk is blind" have the same shape from one probe. At **11:11:06Z**, AFTER the probe parked the tab
back on /open-positions, the desk recorded 'position_read_mode mode=rows_on_page url=/open-positions sawDom=true
rows=2' and a live 'account' sample (equity 4033.99). So the desk reads its own page correctly and the blank
render is specific to a route the desk has NEVER visited.

${WARN} THE FIRST VERSION OF THIS MEASUREMENT WAS WRONG AND IS WORTH KEEPING AS A DEFECT SHAPE. The mount check
was 'document.querySelectorAll("[data-testid]").length > 0', so a page whose only testids were
'InactivityTimer'/'WalkThrough'/'Dialog' and whose body was EMPTY was reported as 'mounted:true, no rows' ${EM}
which reads as "the venue has no orders". It does not mean that. ${ARROW} 'readOrderBookShape' now waits for
CONTENT (body > 300 chars or > 8 testids) and reports 'contentState' as one of content / overlay_or_shell_only /
shell_only / nothing_rendered, so the three cases can never be collapsed again. Same defect family as the prose-
vs-field rows: the record said something the measurement could not support.

${WARN} STILL OPEN ON THIS ROW, RESTATED AGAINST THE NEW EVIDENCE:
  - item 4 (classification): blocked, and now blocked on a KNOWN cause. Next honest step is to make the venue
    render the order list ${EM} e.g. confirm whether /open-orders needs the consent dialog accepted, or whether
    queued orders appear somewhere the desk already visits. Do NOT write the classifier against a guessed prefix.
  - item 2 (cancel/adopt): likewise blocked on the same cause. It also needs a venue-side cancel, which is a NEW
    WRITE PATH and must be written deliberately against a real testid.
  - item 1 (venue authoritative on its own session): unaffected by this measurement, still open.
  - item 3: still done.
`;

(async () => {
  const pool = await getPool();
  const row = (await pool.request().query('SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id = 1454')).recordset[0];
  if (!row) { console.error('task 1454 not found'); process.exit(1); }
  const existing = (await pool.request().query('SELECT CAST(info AS NVARCHAR(MAX)) AS info FROM dbo.Tasks WHERE id = 1454')).recordset[0].info || '';
  if (existing.includes('exe1-orders-book-measured')) {
    console.log(`${CHECK} already recorded; not appending twice`);
    await pool.close();
    process.exit(0);
  }
  // ⚠ Number() IS NOT DECORATION: mssql hands LEN() back as a STRING here, so a bare `+` concatenated and
  // this line first reported "17094 chars -> 170943835 chars". A wrong number in a dry-run report is exactly
  // the prose-vs-field defect this workstream exists about, so the cast is the fix and not a tidy-up.
  const before = Number(row.n);
  console.log(`task 1454 info: ${before} chars -> ${before + ADDENDUM.length} chars (+${ADDENDUM.length})`);
  console.log(`addendum contains backticks: ${ADDENDUM.includes('\u0060')}`);
  if (!YES) {
    console.log(`\nDRY RUN ${EM} nothing written. Re-run with --yes to append.\n`);
    console.log(ADDENDUM.slice(0, 1200));
    await pool.close();
    process.exit(0);
  }
  await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = 1454`);
  const after = (await pool.request().query('SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id = 1454')).recordset[0];
  console.log(`${CHECK} appended; task 1454 is now ${after.n} chars`);
  await pool.close();
})().catch((e) => { console.error(`${WARN} ${e.message}`); process.exit(1); });
