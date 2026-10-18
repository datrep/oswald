// scripts/record-2026-09-29-pp-Q7.js
//
// Records Q7 ANSWERED on TRD-RSK-10 (#1467): the venue REFUSES at the margin limit, corroborated by the desk's own
// record — and the consequence that L2's blocker MOVES from "what does the venue do" to "can the desk believe what
// the venue told it" (TRD-EXE-1 / #1454).
//
// The gates re-derive the evidence rather than restating it: if the refusal row or the ambiguity counts have
// changed, this refuses to write.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');

const ROOT = path.join(__dirname, '..');
const DOC = 'trading/docs/purchasing-power-design-2026-09-29.md';
const TASK_ID = 1467;
const MARKER = '##2026-09-29 Q7 ANSWERED VENUE REFUSES##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';
const SEC = '\u00A7';

const ADDENDUM = `
${MARKER} Q7 ANSWERED: THE VENUE *REFUSES*. AND THAT MOVES L2's BLOCKER RATHER THAN CLEARING IT.##

${STAR} THE ANSWER, from the owner: "an order can't be placed when it goes above the available funds." Of the three
possibilities ${SEC}2.3 posed ${EM} refuse, reduce, or accept-then-call ${EM} it is **REFUSE**, which is the BENIGN one.
The venue does not let the desk over-commit and then act later; it declines the order.

${STAR} AND IT IS CORROBORATED BY THE DESK's OWN RECORD, not merely accepted on report. 'Trades' id **1049**:
Bitcoin buy, 'status=rejected', 'origin=manual', and
**'rejectReason = "order rejected by venue: Insufficient Funds"'** (2026-09-18 07:20:17 SGT). ${SEC}6 insisted Q7 be
*measured* rather than decided; a 'rejectReason' written from the venue's own message IS the desk measuring it.
**Q7 is closed as ANSWERED**, with its provenance stated: an owner report plus one recorded instance.

${WARN}${WARN} **BUT THAT INSTANCE WAS A *MANUAL* ORDER ('origin = manual'), AND THAT IS THE ENTIRE REMAINING
PROBLEM.** It establishes the VENUE's behaviour. It does NOT establish that **this desk's automated submit path
recognises a refusal**, because the desk has never submitted an order refused for funds. **So Q7 answers the
question that was asked and simultaneously MOVES the blocker instead of removing it.**

${STAR} WHAT THE DESK's SUBMIT PATH ACTUALLY DOES, measured over every non-closed trade and every order event:
  ${ARROW} a clean venue refusal ('Insufficient Funds') ................................... **1**
  ${ARROW} AMBIGUOUS: "position row did not appear after submit (order may have failed)" ... **9** 'Trades' rows
  ${ARROW} 'order_unconfirmed' events with that same "may have failed" wording ............. 7
  ${ARROW} 'order_unconfirmed_expired' ${EM} submitted, never confirmed OR denied, then given up on ... **7**
  ${ARROW} 'order_blocked' (venue_session_unconfirmed 15, stale_price 12, unconfirmed_pending 4) ..... 31
  ${ARROW} 'order_rejected' for other causes (closed session, no ticket, timeouts, missing position) .. 9
  ${ARROW} **THE DESK's DOMINANT SUBMIT-TIME OUTCOME IS NOT A REFUSAL. IT IS "WE DO NOT KNOW"** ${EM} 9 ambiguous
    rows and 7 orders that expired unresolved, against **1** clean refusal it could name. That is TRD-EXE-1 (#1454)
    exactly ("submits the desk records as FAILED are sitting in the venue ORDER"), which is OPEN at priority 1.

${STAR}${STAR} **CONSEQUENCE: TRD-EXE-1 IS NOW A PRECONDITION ON L2, NOT A SIBLING OF IT.** L2 raises the caps so
the margin guard becomes the ONLY binding control (${SEC}6.1), which means orders are MEANT to be limited at the
venue's margin. The venue refusing them is safe **only if the desk records the refusal AS a refusal.** Today it cannot
reliably distinguish *refused* from *maybe submitted* ${EM} and a raise that makes refusals routine would feed that
ambiguity MORE often, not less. **The old framing ("L2 waits on Q7") was right about the ORDERING and wrong about the
REASON: L2 does not wait on the venue's behaviour, which is now known, but on the desk's ability to BELIEVE WHAT THE
VENUE TOLD IT.**

${STAR} L2's STATUS therefore changes from "blocked on Q7" to **two named conditions, NEITHER of which is a
decision**:
  1. **The ${SEC}6.1 re-derivation.** Measured in ${SEC}13.10: the live ceiling is **0.494x** the printed one on
     Arabica Coffee and **0.905x** on Sugar, while SGX matches. Only **3 of 7** symbols are observable in the L4 era,
     so the table must be re-derived from live stops once the other four have decisions.
  2. **TRD-EXE-1 (#1454)** ${EM} the confirmation path, above.

${WARN} **AND THE ANSWER UNBLOCKS *MEASURING*, NOT *SHIPPING*.** Applying the package is still a simultaneous
risk-posture change ('maxEquityPerPositionPct' 80 to 500, 'exposureCapPct' 100 to 500, 'dailyLossHaltPct' 3 to 6.0)
and remains the owner's to authorise. What changed is that the REASON L2 was parked is no longer a mystery about the
venue ${EM} it is two conditions that can be worked.

${ARROW} Still unresolved and NOT answered by Q7: the L5 halt form ('k x P' with k in 1..3 versus Q6's flat 6.0),
which ships WITH L2.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== Q7 ANSWERED — recording gates ===\n');

  console.log('1. the report');
  const doc = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
  const i10 = doc.indexOf('### 13.10 '), i11 = doc.indexOf('### 13.11 ');
  if (i11 < 0) await fail('the report is missing 13.11');
  if (i11 < i10) await fail('13.11 must come after 13.10');
  if (!/Q7 IS ANSWERED/.test(doc)) await fail('the report must state Q7 is answered');
  if (!/TRD-EXE-1 IS NOW A PRECONDITION ON L2/.test(doc)) await fail('the report must state the shifted dependency');
  console.log(`  ${CHECK} 13.11 present and in order; the shifted dependency is stated`);

  console.log('\n2. THE EVIDENCE, RE-DERIVED (a recorded fact must survive a re-measure)');
  const t = (await q(`SELECT id, symbol, status, origin, rejectReason FROM Trades WHERE id = 1049`))[0];
  if (!t) await fail('Trades #1049 is gone — the corroborating instance no longer exists, so the claim cannot be recorded');
  if (!/Insufficient Funds/i.test(String(t.rejectReason))) await fail(`#1049 rejectReason is ${JSON.stringify(t.rejectReason)}, not an insufficient-funds refusal`);
  if (String(t.origin) !== 'manual') await fail(`#1049 origin is ${t.origin} — if it is no longer manual, the "auto path untested" caveat is wrong`);
  console.log(`  ${CHECK} Trades #1049: ${t.symbol} ${t.status}, origin=${t.origin}, reason="${t.rejectReason}"`);

  console.log('\n3. THE POPULATION, re-derived');
  const clean = (await q(`SELECT COUNT(*) AS n FROM Trades WHERE rejectReason LIKE '%Insufficient Funds%'`))[0].n;
  const ambiguous = (await q(`SELECT COUNT(*) AS n FROM Trades WHERE rejectReason LIKE '%did not appear after submit%'`))[0].n;
  const expired = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind = 'order_unconfirmed_expired'`))[0].n;
  if (clean !== 1) await fail(`clean venue refusals measured ${clean}, block claims 1`);
  if (ambiguous !== 9) await fail(`ambiguous rows measured ${ambiguous}, block claims 9`);
  if (expired !== 7) await fail(`expired unconfirmed measured ${expired}, block claims 7`);
  if (ambiguous <= clean) await fail('the ambiguity no longer dominates the refusal — the central claim is wrong');
  console.log(`  ${CHECK} 1 clean refusal vs ${ambiguous} ambiguous vs ${expired} expired unresolved — ambiguity dominates`);

  console.log('\n4. L2 still has NOT shipped — proven from the live settings');
  const risk = (await store.getSettings(1)).risk || {};
  if (Number(risk.maxEquityPerPositionPct) === 500) await fail('maxEquityPerPositionPct is 500 — L2 SHIPPED, the block is wrong');
  if (Number(risk.exposureCapPct) === 500) await fail('exposureCapPct is 500 — L2 SHIPPED, the block is wrong');
  console.log(`  ${CHECK} live caps are still ${risk.maxEquityPerPositionPct}/${risk.exposureCapPct}; L2 did not ship`);

  console.log('\n5. the row and its marker');
  const r = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!r) await fail(`row ${TASK_ID} does not exist`);
  const n = (r.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(r.info || '').length} chars, this marker ${n}x`);

  if (!YES) {
    console.log(n === 0
      ? `\n  would append ${ADDENDUM.length} chars. DRY RUN ${EM} not written.`
      : `\n  block already present. DRY RUN ${EM} not written.`);
    await pool.close();
    return;
  }
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log(`  ${CHECK} block appended`);
  } else console.log('  block already present.');

  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(after.info || '').includes('MOVES L2')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
