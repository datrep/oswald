// scripts/record-2026-09-29-exe1-item1-verified.js
//
// TRD-EXE-1 (#1454): two corrections to this row's own text, both from the journal rather than from
// inference.
//   (1) Item 1 is NOT deferred — the fix landed 2026-09-28 and has FIRED. The row says otherwise.
//   (2) Item 2 is reframed: the ADOPT half already exists and works. What is missing is that adoption
//       does not CANCEL the in-flight close. Filed separately as TRD-EXE-8.
//
// DRY RUN by default. Pass --yes to write.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const EM = '\u2014', ARROW = '\u2192', STAR = '\u2605', WARN = '\u26A0', CHECK = '\u2705';

const MARKER = 'exe1-item1-verified';
const ADDENDUM = `

##2026-09-29 ${MARKER}## ITEM 1 IS NOT OPEN, AND THIS ROW SAID IT WAS. Read from the journal, not inferred.

${WARN} CORRECTION. The block above says item 1 (make the venue authoritative on its own session) is
"deferred, because the fix direction is subtle". **The fix landed on 2026-09-28**, in
'trading/agent/executor.js', as the guard that blocks an entry with 'reason: "venue_session_unconfirmed"'.
It is not deferred and it is not awaiting a decision ${EM} this row was simply never updated, and a row
that understates its own progress is the same defect family as a field that contradicts its prose.

${STAR} AND IT HAS FIRED ${EM} 15 TIMES, which is the part that could only come from the journal:
    15 'order_blocked' events with 'reason="venue_session_unconfirmed"'
    from 2026-09-28T07:14:54.106Z to 2026-09-28T08:32:18.510Z
    Arabica Coffee x13, Sugar x2 ${EM} every one 'venueSaysOpen: null'
    detail: "the venue's session for Arabica Coffee is UNKNOWN while the desk holds sessions for
             3 other symbol(s)" (later 4)
${ARROW} it fires in exactly the case the guard was written for: the feed knows sessions for the symbols
the desk ALREADY HOLDS (its source is 'OPositionsList') and is silent on the one it is deciding about, so
"unknown" is refused rather than rounded up to "open". The root cause written into the code is confirmed
by the events it produces.

${WARN} THE RESIDUAL, NAMED RATHER THAN HIDDEN: **the last firing was 2026-09-28T08:32:18Z, and there have
been ZERO in the ~30 hours since**, while the desk kept entering (Oil 11:33:55Z, Silver 11:46:34Z, Bitcoin
15:04:43Z on 2026-09-29). That silence is NOT evidence the guard is dead ${EM} the guard is gated on
'feedUsable' (the feed attached, not silent, non-empty), so when the bridge is degraded the guard stands
down rather than refusing everything. The consequence is worth stating plainly: **the guard's silence
carries no information about the venue.** An instrument could be shut and get an entry attempt refused by
nothing, simply because the feed was not usable at that instant. That is the intended asymmetry (a dead
bridge must not refuse every order) and it is also the hole that remains on item 1.

${STAR} ITEM 2 IS REFRAMED: THE ADOPT HALF ALREADY EXISTS, AND IT WORKS. This row treats "CANCEL or ADOPT"
as one unbuilt thing. Only the CANCEL half is missing:
   2026-09-29T14:30:11.793Z  'reconciliation' #128737 source='venue-close-sync'
       checked 1, **healed 1**, netPnl -5.85, **stillUnresolved 0**
   and 5 of the 7 forced reconciles on this desk end 'stillUnresolved: 0'
${ARROW} when the venue closes a position the desk still believes is open, the desk DOES adopt the
venue's close, with provenance ('closePriceSource' venue_rate, 'closeAtSource' venue_ui_minute) and the
venue's own close reason. Building "adopt" is not the work. **The work is that adopting does not CANCEL
the close already in flight.**

${WARN} FILED AS TRD-EXE-8 (#1478), because it is a defect in its own right and not a sub-item:
   * a close that fails against a position the venue ALREADY CLOSED is recorded as 'order_rejected';
   * 'order_rejected' is the circuit breaker's input ('maybeTripBreaker' counts raw events in a rolling
     30 min, with NO 'errorClass' filter) and self-health's too;
   * 'state_stale' closes are **7 of the 12 'order_rejected' rows the desk has EVER written** (58%), and
     the classifier's own documentation says this class is "NOT a bridge failure";
   * **10 trades that did close at the venue still carry a 'rejectReason'**, oldest #22 ${EM} the row the
     code itself calls the "Bitcoin #22 incident".
   ${CHECK} The INERT half is landed and pinned: the close catch now re-reads the row and skips the
   'rejectReason' write when the row is already terminal, and annotates the journal event instead. The
   event KIND is deliberately untouched ${EM} that is the breaker half, and the breaker is a risk control.
   ${WARN} The breaker half is NOT claimed to have tripped: the worst rolling 30-minute window in the whole
   journal is **2 of the required 5**. It is latent, and the row says so.
   ${WARN} What item 2 still needs, and cannot be done unattended: a venue-side CANCEL (a NEW WRITE PATH)
   plus an event kind for "a human cancelled this at the venue". Still blocked on the order-row testid.

${CHECK} THE QUEUED-ORDER QUESTION IS ANSWERED: **nothing is queued.** 'Trades' holds 0 'unconfirmed' rows
(closed 108 / rejected 15 / failed 7 / open 2 at 2026-09-29T15:07Z), so no venue order is sitting in the
book, and the order-row testid therefore remains unobservable. The two live routes to it are unchanged: the
owner reading the Orders tab directly, or the landed diagnostic capturing it at the next closed-market
submit.

${WARN} A JOURNAL-NAVIGATION TRAP WORTH RECORDING, because it cost three wrong probes in one session:
   * 'order_attempt' nests its outcome at '$.attempts[0].ok' / '$.attempts[0].errorClass' ${EM} NOT '$.ok'.
     A probe keying '$.ok' reports 'ok=null' for every attempt and reads as "no result recorded".
   * 'position_read_mode' is NOT an event kind; it is an 'action' inside 'kind="telemetry"'.
   * the close-sync kinds are 'trade_closed' and 'reconciliation', not 'close_sync'/'venue_close'.
${ARROW} the fix is to CENSUS the kinds before reading them. Prose that outruns the field is the exact
defect this workstream exists about, and a probe that guesses a key is that defect in miniature.

${CHECK} STILL OPEN ON THIS ROW, RESTATED: item 1 ${EM} fix landed and firing, residual named above
(feed-gated silence); item 2 ${EM} adopt works, CANCEL outstanding and filed as TRD-EXE-8; item 3 ${EM}
done; item 4 classification ${EM} still blocked on the venue's order-row testid, still refusing to guess it.
`;

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== TRD-EXE-1 #1454: item-1 verification + item-2 reframe ===\n');

  // 1. The guard fired, and the row's "deferred" claim is falsified by the events themselves.
  const fired = await q(`SELECT COUNT(*) AS n, MIN(createdAt) AS first, MAX(createdAt) AS last
      FROM TradingEvents WHERE kind='order_blocked' AND JSON_VALUE(payload,'$.reason')='venue_session_unconfirmed'`);
  const n = Number(fired[0].n);
  if (n < 15) throw new Error(`only ${n} venue_session_unconfirmed blocks; the addendum claims 15`);
  const first = new Date(fired[0].first), last = new Date(fired[0].last);
  if (last >= new Date('2026-09-29T00:00:00Z')) throw new Error(`the guard fired on ${last.toISOString()} — the "quiet for 30h" residual is wrong`);
  console.log(`  ${CHECK} ${n} blocks, ${first.toISOString()} .. ${last.toISOString()} (quiet since)`);

  const symbols = await q(`SELECT JSON_VALUE(payload,'$.symbol') AS s, COUNT(*) AS n FROM TradingEvents
      WHERE kind='order_blocked' AND JSON_VALUE(payload,'$.reason')='venue_session_unconfirmed'
      GROUP BY JSON_VALUE(payload,'$.symbol') ORDER BY n DESC`);
  console.log(`      by symbol: ${symbols.map((r) => `${r.s}=${r.n}`).join(', ')}`);

  const since = Number((await q(`SELECT COUNT(*) AS n FROM TradingEvents
      WHERE kind='order_blocked' AND JSON_VALUE(payload,'$.reason')='venue_session_unconfirmed'
        AND createdAt >= '2026-09-29T00:00:00Z'`))[0].n);
  if (since !== 0) throw new Error(`${since} firings today — the residual paragraph is wrong`);
  console.log(`  ${CHECK} 0 firings since 2026-09-29T00:00Z — the silence residual holds`);

  // 2. The guard is still IN the source under test, so "fix landed" is a fact and not a memory.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'trading', 'agent', 'executor.js'), 'utf8');
  if (!src.includes('venue_session_unconfirmed')) throw new Error('the executor no longer contains the venue_session_unconfirmed guard');
  if (!/const feedUsable = !!\(feedStatus/.test(src)) throw new Error('the feedUsable gate is gone — the "silence carries no information" paragraph would be wrong');
  console.log(`  ${CHECK} the guard and its feedUsable gate are both present in trading/agent/executor.js`);

  // 3. The ADOPT half works — cite the real reconciliation rather than asserting it.
  const rec = (await q(`SELECT id, createdAt, payload FROM TradingEvents
      WHERE kind='reconciliation' AND JSON_VALUE(payload,'$.source')='venue-close-sync'
      ORDER BY id DESC`))[0];
  if (!rec) throw new Error('no venue-close-sync reconciliation found — the "adopt already works" claim has no instance');
  const rp = JSON.parse(rec.payload);
  if (Number(rp.stillUnresolved) !== 0) throw new Error(`the cited reconciliation has stillUnresolved=${rp.stillUnresolved}`);
  console.log(`  ${CHECK} reconciliation #${rec.id} ${new Date(rec.createdAt).toISOString()} source=${rp.source} checked=${rp.checked} healed=${rp.healed} stillUnresolved=${rp.stillUnresolved}`);

  // 4. TRD-EXE-8 must exist, or the cross-reference is dangling.
  const exe8 = (await q(`SELECT id FROM dbo.Tasks WHERE name LIKE 'TRD-EXE-8:%'`))[0];
  if (!exe8) throw new Error('TRD-EXE-8 has not been filed yet — file it FIRST so the cross-reference resolves');
  console.log(`  ${CHECK} TRD-EXE-8 is #${exe8.id}`);

  const existing = (await q(`SELECT CAST(info AS NVARCHAR(MAX)) AS info FROM dbo.Tasks WHERE id = 1454`))[0].info || '';
  if (existing.includes(MARKER)) { console.log(`\n  ${CHECK} already recorded; not appending twice`); await pool.close(); return; }

  const before = Number((await q(`SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id = 1454`))[0].n);
  console.log(`\n  task 1454 info: ${before} chars ${ARROW} ${before + ADDENDUM.length} chars (+${ADDENDUM.length})`);
  if (ADDENDUM.includes('\u0060')) throw new Error('the addendum contains a backtick — it would break the template literal it is pasted from');
  console.log(`  ${CHECK} no backticks in the addendum`);

  if (!YES) { console.log(`\nDRY RUN ${EM} nothing written. Re-run with --yes to append.\n`); await pool.close(); return; }

  await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = 1454`);
  const after = (await q(`SELECT LEN(CAST(info AS NVARCHAR(MAX))) AS n FROM dbo.Tasks WHERE id = 1454`))[0].n;
  console.log(`  ${CHECK} appended; task 1454 is now ${after} chars`);
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(1); });
