// scripts/record-2026-09-29-exe8-close-race.js
//
// Files TRD-EXE-8: the CLOSE path records "the position was already closed at the venue" as an ORDER
// REJECTION, at all three layers (event kind, trade row, breaker input) — which is precisely TRD-52's
// error, fixed on the OPEN path and left standing on the CLOSE path.
//
// The gates RE-DERIVE every number from the database, so the row cannot be filed against a count that
// has since moved. Counts that grow are gated as invariants (>=, and the majority claim) rather than as
// equalities; the exact values are reported so the row text can be checked against them.
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const WARN = '\u26A0', STAR = '\u2605', EM = '\u2014', CHECK = '\u2705', ARROW = '\u2192';

const MARKER = '##2026-09-29 exe8 close-path rejection##';
const INFO = `${MARKER} THE CLOSE PATH RECORDS "THE VENUE ALREADY CLOSED IT" AS AN ORDER REJECTION.##

${STAR} THE DEFECT IN ONE LINE. 'closeTrade' reads the trade row ONCE at the top and refuses unless
'status === "open"' ${EM} but the close it then authorises can occupy the bridge for a minute or more. A
venue-side stop adopted by 'venue-close-sync' INSIDE that window is invisible to the in-flight attempt,
which then reports 'state_stale' ("open position not found for X") and records it as a REJECTION. So the
desk spends an event that means "I wanted to exit and could not" on a case where it exited fine.

${STAR} THE INSTANCE, measured. 'Trades' **#1130** (Silver sell 9.8339, origin=agent, strategyId=survcsilver):
    11:46:34.633Z  trade_opened, positionId 1888764676, fill ok=true (47,939 ms)
    14:19:00.000Z  the VENUE closed it ${EM} closeReason "Loss call", "stop-loss hit at the venue"
    14:23:09.840Z  order_rejected #128671: the desk's own close attempt dies as 'other',
                   "close: bridge busy (capture) ${EM} lock wait exceeded for ticket"
    14:30:05.276Z  phantom_fill #128732 ${EM} '{tradeId:1130, direction:"missing_on_venue"}'
    14:30:11.793Z  trade_closed #128736 via 'venue-close-sync': status='closed',
                   closePriceSource='venue_rate', closeAtSource='venue_ui_minute', netPnl -5.85
    14:30:11.793Z  reconciliation #128737: checked 1, healed 1, **stillUnresolved 0**
    14:31:47.430Z  order_attempt #128746 ok=false errorClass=state_stale (ms 49,910)
    14:31:47.430Z  order_rejected #128747 "close: open position not found for Silver sell"
    14:31:47.433Z  position_review #128748 still treating Silver as OPEN ("Price 61.255 is within
                   0.02 of the 61.2748 turtle stop")
${ARROW} **96 SECONDS AFTER THE DESK ITSELF HAD CLOSED THE TRADE AND REPORTED THE RECONCILIATION CLEAN,
it fired another close at it.** The row now carries 'status=closed' AND
'rejectReason="open position not found for Silver sell"' ${EM} two contradictory machine-readable claims
in one row.

${WARN} THE GUARD IS NOT MISSING ${EM} that is what makes this subtle. 'closeTrade' DOES re-read and DOES
refuse a non-open row. The only live caller of 'connector.closeOrder' is 'executor.js:475', inside that
function. So the guard PASSED: the row was open when the attempt began and closed when it failed. This is
a CHECK-THEN-ACT RACE, not an absent check. The bridge congestion that makes the window wide is the same
congestion the sibling rejection at 14:23:09 names ("lock wait exceeded for ticket").

${WARN} IT IS NOT A ONE-OFF ${EM} 9 days, 7 instances, 4 instruments, and **10 trades that DID close at
the venue still carry a 'rejectReason'** (the oldest is #22, the row the code itself calls the
"Bitcoin #22 incident"). Every 'order_rejected' with
'errorClass=state_stale' in the journal:
    #41332  2026-09-21 00:40:47Z  Gold   "open position not found for Gold sell"
    #62356  2026-09-22 17:53:38Z  Gold   "open position not found for Gold sell"
    #68541  2026-09-23 05:03:49Z  Oil    "open position not found for Oil sell"
    #92334  2026-09-25 01:15:35Z  Gold   "open position not found for Gold sell"
    #105269 2026-09-28 05:22:39Z  Gold   "open position not found for Gold sell"
    #125729 2026-09-29 09:10:17Z  Sugar  "open position not found for Sugar sell"
    #128747 2026-09-29 14:31:47Z  Silver "open position not found for Silver sell"
**All 7 are 'intent=close'.** And the desk has written only 12 'order_rejected' rows in its ENTIRE
journal ${EM} so **58% of every order rejection the desk has ever recorded is this one non-failure class.**
The classifier's own documentation already says what it is: "The desk tried to CLOSE something the venue
no longer has ... This is NOT a bridge failure: retrying re-fails, and the correct response is
reconciliation." The desk agrees it is not a failure and then spends it as one anyway.

${STAR} THE THREE LAYERS, ALL STILL WRONG ON THE CLOSE PATH. 'trading/agent/unconfirmed.js' names the four
layers that rounded TRD-52's "I do not know" down to "it did not happen": the event kind, the Trades row,
'maybeTripBreaker', and self-health. TRD-52 fixed the OPEN path. The CLOSE path still does all four:
    1. event kind      'order_rejected' ${EM} 7 rows above
    2. trade row       'rejectReason' stamped on the trade
    3. breaker         'maybeTripBreaker' counts RAW 'order_rejected' in a rolling 30 min
                       ('CB_WINDOW_MIN' 30, 'CB_MAX_REJECTS' 5) with **NO errorClass filter**
    4. self-health     'selfHealth.js:348' counts 'order_rejected' the same way
${ARROW} a close that SUCCEEDED via the venue counts against the desk's error budget exactly as a real
execution failure does. The asymmetry is the whole point: the OPEN path was deliberately split so an
unknown outcome could not soft-kill the desk, and the CLOSE path was not.

${WARN} WHAT IS **NOT** CLAIMED. The breaker half is LATENT: measured over the whole journal, the worst
rolling 30-minute window of 'order_rejected' is **2 of the required 5**, and the worst window counting only
'state_stale' closes is **1**. **It has never tripped, and this row does not claim it has.** What is real
is the shape: 'order_rejected' is the breaker's input, the close path feeds it a class the desk has itself
documented as not-a-failure, and the triggering condition (bridge congestion) is the same condition that
widens the race window.

${CHECK} THE INERT HALF IS DONE AND PINNED. 'executor.js' now re-reads the row in the close catch and
SKIPS the 'rejectReason' write when the row is already terminal, because 'rejectReason' means "this order
was rejected" and this one was not. Nothing becomes unobservable: the journal keeps the event either way,
now annotated with 'alreadyResolved' and 'rowStatus'. The existing 'order_rejected' KIND is deliberately
unchanged ${EM} re-kinding it would remove events from the breaker's input, which is a risk-control
decision and not one to fold into an inert fix. Pinned by
'test/reconcile-on-ambiguous-open.test.js': the fresh read, the conditional write, the surviving
'order_rejected' kind, and the annotation.

${WARN} THE OPEN QUESTION, FOR THE OWNER (not decided here): should a close-path 'state_stale' feed
'order_rejected' at all? TRD-52's answer for the open path was NO ${EM} it became 'order_unconfirmed'. The
close-path analogue is a non-failure that has already been resolved (the position IS closed), so it is not
even "unconfirmed". Options: (a) leave it and accept the breaker exposure; (b) give it its own kind, as
TRD-52 did, which removes it from the breaker and self-health; (c) keep the kind but exclude
'errorClass=state_stale' at the two counting sites. All three are risk-control decisions.

SUGGESTED FIRST STEP (not implemented): re-check 'status' immediately BEFORE 'connector.closeOrder', so the
doomed venue navigation is skipped rather than reported ${EM} the guard exists and is simply evaluated too
early to cover the window it authorises.`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== TRD-EXE-8: the close-path rejection — filing gates ===\n');

  // 1. The instance. These are fixed properties of a row that has already happened.
  const t = (await q(`SELECT id, symbol, status, closeAt, closePriceSource, closeAtSource, rejectReason, updatedAt
      FROM Trades WHERE id = 1130`))[0];
  if (!t) throw new Error('Trades #1130 is gone — the instance cannot be cited');
  const bad = [];
  if (t.status !== 'closed') bad.push(`status is ${t.status}, not closed`);
  if (t.closePriceSource !== 'venue_rate') bad.push(`closePriceSource is ${t.closePriceSource}, not venue_rate`);
  if (t.closeAtSource !== 'venue_ui_minute') bad.push(`closeAtSource is ${t.closeAtSource}, not venue_ui_minute`);
  if (!/open position not found/i.test(String(t.rejectReason))) bad.push(`rejectReason is ${JSON.stringify(t.rejectReason)}`);
  // The contradiction is the point: the REJECTION was written AFTER the close it contradicts.
  if (!(new Date(t.updatedAt) > new Date(t.closeAt))) bad.push('updatedAt is not after closeAt — the "rejectReason written after the close" claim is gone');
  if (bad.length) throw new Error('Trades #1130 no longer shows the shape this row is filed against: ' + bad.join('; '));
  console.log(`  ${CHECK} #1130 ${t.symbol} status=${t.status} src=${t.closePriceSource}/${t.closeAtSource}`);
  console.log(`      closed at ${new Date(t.closeAt).toISOString()} but rejectReason written ${new Date(t.updatedAt).toISOString()}`);
  console.log(`      rejectReason="${t.rejectReason}"`);

  // 2. The population. Counts grow, so gate the INVARIANTS and report the values.
  const total = Number((await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='order_rejected'`))[0].n);
  const stale = Number((await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind='order_rejected'
      AND JSON_VALUE(payload,'$.errorClass')='state_stale' AND JSON_VALUE(payload,'$.intent')='close'`))[0].n);
  if (total < 12) throw new Error(`order_rejected total is ${total}; the row claims 12 — re-measure`);
  if (stale < 7) throw new Error(`state_stale close rejections are ${stale}; the row claims 7 — re-measure`);
  if (!(stale * 2 > total)) throw new Error(`state_stale closes are ${stale} of ${total} — the MAJORITY claim no longer holds`);
  console.log(`  ${CHECK} order_rejected total=${total}; state_stale closes=${stale} (${Math.round((stale / total) * 100)}% — majority holds)`);

  // 3. The rows that ended CLOSED yet carry a rejection.
  const contradictory = Number((await q(`SELECT COUNT(*) AS n FROM Trades WHERE rejectReason IS NOT NULL AND status='closed'`))[0].n);
  if (contradictory < 10) throw new Error(`only ${contradictory} closed rows carry a rejectReason; the row claims 10`);
  const oldest = (await q(`SELECT TOP 1 id, symbol, rejectReason FROM Trades WHERE rejectReason IS NOT NULL AND status='closed' ORDER BY id`))[0];
  console.log(`  ${CHECK} ${contradictory} rows are status='closed' WITH a rejectReason; oldest is #${oldest.id} ${oldest.symbol}`);
  console.log(`      ("${String(oldest.rejectReason).slice(0, 60)}")`);

  // 4. The breaker exposure — gated as NEVER TRIPPED, because that is the honest claim.
  const worst = (await q(`SELECT TOP 1 a.createdAt AS winStart,
        (SELECT COUNT(*) FROM TradingEvents b WHERE b.kind='order_rejected'
          AND b.createdAt >= a.createdAt AND b.createdAt < DATEADD(MINUTE,30,a.createdAt)) AS n
      FROM TradingEvents a WHERE a.kind='order_rejected' ORDER BY n DESC`))[0];
  const worstN = Number(worst ? worst.n : 0);
  if (worstN >= 5) throw new Error(`the worst 30-min window is ${worstN} — the breaker HAS tripped, so the "latent only" claim in this row is now wrong`);
  console.log(`  ${CHECK} worst rolling 30-min order_rejected window = ${worstN} of 5 ${EM} never tripped, as the row states`);

  // 5. The inert fix must still be in place, or the CHECK mark in the row text is a lie.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'executor.js'), 'utf8');
  if (!/const alreadyResolved = rowStatusAtFailure != null && rowStatusAtFailure !== 'open'/.test(src))
    throw new Error('the executor no longer makes the rejectReason write conditional — the row would claim a fix that is gone');
  if (!/if \(!alreadyResolved\) \{/.test(src))
    throw new Error('the conditional rejectReason write is missing');
  console.log(`  ${CHECK} the inert fix is present in trading/agent/executor.js`);

  const exists = (await q(`SELECT id FROM dbo.Tasks WHERE info LIKE '%${MARKER}%'`))[0];
  const nextSort = (await q(`SELECT ISNULL(MAX(sortOrder),0) + 1 AS n FROM dbo.Tasks WHERE edictId = 52`))[0].n;
  if (exists) { console.log(`\n  already filed as #${exists.id} — nothing to do`); await pool.close(); return; }
  console.log(`\n  would file a new edict-52 task (sortOrder ${nextSort})`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written. Re-run with --yes to file.\n`); await pool.close(); return; }

  await pool.request().query(`INSERT INTO dbo.Tasks (name, createdAt, plannedStart, info, priority, state, edictId, sortOrder)
    VALUES (N'TRD-EXE-8: Executor - the CLOSE path records "the position was already closed at the venue" as an ORDER REJECTION: 7 of the desk 12 order_rejected rows are this non-failure, and 10 closed trades carry a rejectReason',
      GETUTCDATE(), GETUTCDATE(), N'${INFO.replace(/'/g, "''")}', 2, 1, 52, ${nextSort})`);
  const made = (await q(`SELECT TOP 1 id, LEN(info) AS n FROM dbo.Tasks WHERE info LIKE '%${MARKER}%' ORDER BY id DESC`))[0];
  console.log(`  ${CHECK} filed as #${made.id}, ${made.n} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
