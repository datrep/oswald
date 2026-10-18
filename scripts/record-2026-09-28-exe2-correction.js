// scripts/record-2026-09-28-exe2-correction.js — TRD-EXE-2 (#1455): the provenance claim was WRONG.
// Verifies the retraction against the code and the registry before writing it.
//
// NOTE ON STYLE: the note below uses 'single quotes' for code spans and contains NO backticks. An earlier
// draft used backticks inside this template literal and broke the file twice, because a raw backtick
// TERMINATES the literal. That is a repeat of a known trap in this repo — escape them or do not use them.
//
// Dry by default:  node scripts/record-2026-09-28-exe2-correction.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const ROOT = path.join(__dirname, '..');
const ID = 1455;
const MARK = '##2026-09-28 exe2-correction##';

const NOTE = `

${MARK}
★★★ CORRECTION: THIS ROW'S CENTRAL CLAIM IS WRONG. THE FLOORS *WERE* READ FROM THE VENUE. I RETRACT IT.

WHAT I CLAIMED (2026-09-28, earlier the same day):
  "Every venue minimum comes from a THIRD-PARTY page — every dbo.Instruments.sourceUrl is a
   finance.yahoo.com / cmegroup.com / theice.com / bloomberg.com / bitadata.com URL, so the row READS as
   venue metadata but is not."
  "...and the prompt header claiming 'read from the venue's own Info sidebar' — a FALSE PROVENANCE CLAIM
   printed to every chair, every wake."

WHY IT WAS WRONG — ONE LINE I HAD NOT READ. trading/plus500/instrumentProbe.js:258 sets:
    referenceUrl: sidebar.querySelector('[data-testid="DetailsSidebar.instrument-info-link.external-link"]').href
THE EXTERNAL LINK IS THE VENUE'S OWN INFO-SIDEBAR LINK. The venue's Info panel links out to a reference page for
the underlying — which is exactly why a Gold row carries a CME contract-spec URL and an SGX row carries a Yahoo
quote page. instrumentSpec.js:368 then maps referenceUrl -> sourceUrl, so sourceUrl records THE LINK THE VENUE
ITSELF SHOWED, not wherever the number came from. The number and the link arrived in the same sidebar read.

AND THE NUMBER ITSELF IS A VENUE READ — instrumentProbe.js:234:
    unitAmount: sPick('sidebar.rates-and-values.column-0.value'),
    unitKind:   sPick('sidebar.rates-and-values.column-0.sub-value'),
That is the venue's own 3-column stat box, read at capture time alongside marketStateAtCapture ('open'/'closed',
from the venue's closed banner), nextSessionText and leverageRaw — all sidebar fields. All 41 rows carry BOTH a
venue session string and a venue market state, which an import would not produce; the seven traded symbols were
captured 2026-09-22 09:21–09:26 SGT in one pass, the option chain on 2026-09-14.
=> So I attributed a FABRICATED provenance to a TRUE one, and I told the owner the chairs were being printed a
false claim. They were not. The prompt header "read from the venue's own Info sidebar" is ACCURATE.

⚠ HOW I GOT IT WRONG, because the mechanism matters more than the apology: I had a field whose VALUE was a
third-party URL and reasoned from the value to the provenance, WITHOUT reading the one line that produces the
field. sourceUrl was the only provenance-shaped column in the table, so I treated it as the provenance column.
A FIELD NAMED LIKE PROVENANCE IS NOT PROVENANCE; THE ASSIGNMENT IS. Same family as reading column-0 as a minimum
because the comment above it says "minimum".

★ WHAT SURVIVES, AND IT IS A REAL DEFECT — BUT A DIFFERENT ONE: THE NUMBER'S *MEANING* IS ASSERTED, NOT MEASURED.
- unitAmount is read BY COLUMN POSITION (column-0; column-1 is leverage, column-2 the spread). The comment above
  it (instrumentProbe.js:230) ASSERTS "unitAmount is a MINIMUM trade size in venue units, NOT a contract
  multiplier" — and the same file, a few lines earlier, notes that OTHER fields read their LABEL from the DOM
  ("the LABEL comes with the value instead of being assumed from column position"). So the ONE field the desk
  enforces as a hard VETO is the field identified by position rather than by its own label.
- AND THE VENUE ITSELF HAS FILLED BELOW IT. Trades #1106 — SGX buy, size 10 Shares, filled at 22.647, position id
  1888436082 — against a recorded floor of 20 Shares (Instruments #27, unitAmount 20, unitKind Shares, captured
  2026-09-22T01:21:24Z). The submit event is order_attempt #105118, whose attempts[0] reads
  { attempt: 1, phase: "filled", ms: 23360, ok: true } — a full fill of the size that was sent.
  ⚠ THE PATH MATTERS AND JSON_VALUE(payload,'$.ok') IS NULL: ok lives INSIDE the attempts ARRAY, so quoting $.ok
  would make this evidence unreproducible for the next reader — the same trap that hid a VETO census earlier
  today. Both readings of the contradiction are live: (i) column-0 is not a minimum at all, so the floor is
  meaningless for every symbol; or (ii) it IS the venue's stated minimum and the venue did not enforce it.
  EITHER WAY THE DESK'S VETO IS STRICTER THAN THE VENUE'S OWN BEHAVIOUR, on the single symbol where it binds —
  18 SGX refusals in 2h24m, and SGX is the only one of seven symbols whose floor exceeds the 0.07% dial.
- THE REST OF THIS ROW STILL STANDS: the 18 venue_minimum refusals (all SGX), TRD-RSK-4's 2.34x, and the reverted
  acceptVenueFloor clamp all rest on that SGX number. Only the "no venue provenance" premise is struck.

OWNER DECISION SOUGHT — I AM NOT DECIDING THIS ONE, BECAUSE BOTH ANSWERS ARE DEFENSIBLE POLICIES:
  (a) RESPECT THE VENUE'S STATED MINIMUM: keep the hard veto, and SGX is simply out of reach at its current stop.
      That is TRD-RSK-4's finding, and it was correctly derived.
  (b) DEFER TO THE VENUE'S BEHAVIOUR: demote the floor from a VETO to a REPORT (venue_minimum_unproven), which is
      the doctrine this module ALREADY applies to an unknown minimum — "refusing every entry until a human
      browses twenty instruments would be a bigger intervention than the defect". Refusing is IRREVERSIBLE (the
      opportunity is gone); allowing is RECOVERABLE (the venue rejects and the desk records order_rejected).
I HAVE CHANGED NOTHING IN THE CODE FOR THIS. The next measurement that resolves it is ONE live capture: read the
stat box's own label for column-0 (the DOM element carrying the text the venue actually uses for it) and store it
beside the value. Once the label is recorded, the veto can be gated on it corroborating "minimum" and the question
closes itself. It needs one probe against the live page, WHICH I DID NOT RUN while the desk holds the browser and
two positions are open.

⚠ AND ONE THING THIS ROW SHOULD NOT HAVE SAID AT ALL: I recorded the prompt's provenance header as a fix to make.
It is not — the header is TRUE, so there is nothing to fix there. Removing an existing, ACCURATE claim would have
been the actual damage.`;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  console.log('\n=== 1. the line I had not read: sourceUrl IS the venue sidebar link ===');
  const probe = src('trading/plus500/instrumentProbe.js');
  if (!/referenceUrl:[\s\S]{0,220}DetailsSidebar\.instrument-info-link\.external-link/.test(probe))
    await fail('probe does not set referenceUrl from the Info-sidebar external link — the retraction would be unfounded');
  console.log('  \u2714 referenceUrl comes from DetailsSidebar.instrument-info-link.external-link');
  if (!/unitAmount: sPick\('sidebar\.rates-and-values\.column-0\.value'\)/.test(probe))
    await fail('unitAmount is not read from the rates-and-values stat box');
  console.log('  \u2714 unitAmount comes from sidebar.rates-and-values.column-0.value (a VENUE read)');
  const spec = src('trading/plus500/instrumentSpec.js');
  if (!/sourceUrl: r\.referenceUrl/.test(spec)) await fail('toRow does not map referenceUrl -> sourceUrl');
  console.log('  \u2714 instrumentSpec maps referenceUrl -> sourceUrl, so the URL travels WITH the sidebar read');

  console.log('\n=== 2. the rows are genuine captures (venue fields, not an import) ===');
  for (const r of await q(`SELECT id, symbol, instrumentClass, unitAmount, unitKind, capturedAt, marketStateAtCapture, nextSessionText
      FROM dbo.Instruments WHERE userId = 1 AND symbol IN ('SGX','Gold','Silver') AND instrumentClass='spot' ORDER BY symbol`))
    console.log(`  #${r.id} ${String(r.symbol).padEnd(7)}${String(r.instrumentClass).padEnd(6)} unit=${String(r.unitAmount).padEnd(7)}${String(r.unitKind || '').padEnd(13)}` +
      `state=${String(r.marketStateAtCapture).padEnd(7)}session=${String(r.nextSessionText || '').slice(0, 16)}`);
  const cap = await q(`SELECT COUNT(*) AS n FROM dbo.Instruments WHERE userId = 1 AND nextSessionText IS NOT NULL AND marketStateAtCapture IS NOT NULL`);
  console.log('  rows carrying BOTH a venue session string and a venue market state: ' + cap[0].n);
  if (cap[0].n < 10) await fail('too few rows carry venue sidebar fields — an import would not produce these');

  console.log('\n=== 3. the contradiction this row is now about ===');
  const sgx = (await q(`SELECT id, unitAmount, unitKind, sourceUrl, capturedAt FROM dbo.Instruments
      WHERE userId = 1 AND symbol = 'SGX' AND instrumentClass = 'spot'`))[0];
  console.log(`  registry #${sgx.id}: floor ${sgx.unitAmount} ${sgx.unitKind} (captured ${sgx.capturedAt.toISOString()})`);
  console.log(`  its sourceUrl is the venue's OWN reference link: ${sgx.sourceUrl}`);
  const t = (await q(`SELECT id, symbol, direction, size, units, openPrice, status FROM Trades WHERE id = 1106`))[0];
  if (!t) await fail('#1106 is missing — the measured contradiction is gone');
  console.log(`  Trades #${t.id}: SGX ${t.direction} size=${t.size} ${t.units} @${t.openPrice} status=${t.status}`);
  if (Number(t.size) >= Number(sgx.unitAmount))
    await fail(`#1106 is size ${t.size} against a floor of ${sgx.unitAmount} — there is NO contradiction to record`);
  console.log(`  \u2714 the venue FILLED ${t.size} against a floor of ${sgx.unitAmount}: the veto is stricter than the venue`);

  const oa = await q(`SELECT payload FROM TradingEvents WHERE id = 105118`);
  if (!oa.length) await fail('order_attempt #105118 is missing');
  const att = (JSON.parse(oa[0].payload).attempts || [])[0] || {};
  console.log(`  the submit that filled it: order_attempt #105118 attempts[0] = ${JSON.stringify(att)}`);
  const flat = (await q(`SELECT JSON_VALUE(payload,'$.ok') AS v FROM TradingEvents WHERE id=105118`))[0].v;
  console.log(`  JSON_VALUE(payload,'$.ok') = ${flat}  (the field is INSIDE the attempts array — the record says so)`);
  if (att.phase !== 'filled' || att.ok !== true) await fail('#105118 did not record a full fill — the evidence is not what the record says');
  console.log('  \u2714 a full fill of size 10 was recorded by the desk itself');

  console.log('\n=== 4. venue_minimum matches (LIKE-based — NOT the refusal count) ===');
  // ⚠ Reported as a LIKE count ONLY. This is the documented false-positive population: the string also appears
  // in gate NOTES of refusals fired on other grounds, so it OVERSTATES. The authoritative figure was measured
  // separately (18, all SGX) and is what the note above quotes.
  const ref = await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='decision' AND payload LIKE '%"venue_minimum"%' AND createdAt >= '2026-09-28'`);
  console.log(`  rows matching LIKE: ${ref[0].n}  <- do NOT read as the refusal count`);

  console.log('\n=== 5. the record ===');
  const dup = await q(`SELECT id FROM Tasks WHERE id = ${ID} AND info LIKE '%${MARK}%'`);
  if (dup.length) { console.log(`  #${ID} marker present - nothing to do.`); await pool.close(); return; }
  const cur = (await q(`SELECT state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  #${ID} state=${cur.state} info=${cur.len} -> ${Number(cur.len) + NOTE.length}`);
  if (!YES) { console.log('  DRY RUN - not written.'); await pool.close(); return; }
  await pool.request().input('t', NOTE).query(`UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @t WHERE id = ${ID}`);
  const b = (await q(`SELECT LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id = ${ID}`))[0];
  console.log(`  \u2714 #${ID} appended -> ${b.len} chars`);
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
