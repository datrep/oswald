// scripts/record-2026-09-28-exe1-retry-guard.js — TRD-EXE-1 acceptance item 3 is implemented.
// Verifies the guard is present AND on the policy path before appending to #1454.
// Dry by default:  node scripts/record-2026-09-28-exe1-retry-guard.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-28 exe1-retry-guard##';
const ID = 1454;
const ROOT = path.join(__dirname, '..');

const NOTE = `

${MARK}
★ **ACCEPTANCE ITEM 3 IS IMPLEMENTED AND LIVE: ONE UNRESOLVED SUBMIT PER SYMBOL.** The amplifier is disarmed.

WHAT LANDED
- **\`trading/agent/unconfirmed.js\`** gains two PURE exports, so the rule is testable without touching the
  venue: **\`pendingFor(rows, symbol)\`** (which unconfirmed submit, if any, blocks a new one) and
  **\`ageMinutes(row)\`** (the age named in the refusal). Both are deliberately careful: an absent or unreadable
  SYMBOL returns null and therefore blocks NOTHING — a guard that fails closed on a missing field can stop the
  whole desk on one malformed row, which is worse than the outcome it prevents — and an unreadable TIMESTAMP
  returns null rather than 0. \`Number(null)\` is 0, the epoch, i.e. ~29 million minutes, which the same rule
  would report as "29M minutes past a 30-minute TTL". A number that does not mean what it says is the defect
  class this module already exists to avoid.
- **\`trading/agent/executor.js\`, in \`openTrade\` after the closed-session guard and BEFORE \`connector.placeOrder\`.**
  The ordering is the whole control: a guard placed after the submit would refuse nothing and read as if it had.
  It refuses with \`{ placed: false, blocked: true, reason: 'unconfirmed_pending', blockingTradeId, ageMin }\`.
  **\`blocked: true\` is load-bearing** — \`selfHealth\`'s drift check counts "approved entries that never filled"
  via \`e.placed === false && !e.blocked\`, so without it a WORKING guard would report as a broken desk (the
  TRD-43 asymmetry). For the same reason it logs \`order_blocked\`, not \`order_rejected\`: the circuit breaker and
  the self-health rejection counter both read the latter, and a policy refusal must feed neither.
- **IT DOES NOT RESOLVE THE ROW ITSELF, ON PURPOSE.** Resolution is reconcile's job, and this runs inside a wake
  that already holds the venue lock (\`keepOpen: true\`), so a nested mirror cycle would contend for the page it
  is holding. The refusal is therefore bounded by the mirror cadence (~60 s) and the AGE travels with it, so a
  symbol stuck past its TTL is VISIBLE: the past-TTL note says outright that a symbol stuck here means the cycle
  is not running. That is the difference between a bounded refusal and a dead control.
- **\`test/unconfirmed-retry-guard.test.js\` — 14 tests.** Behavioural for both pure rules (symbol scoping and
  case/whitespace folding, cross-symbol non-blocking, the null-symbol and null-timestamp cases, the zero-age
  case), and STRUCTURAL for the wiring because requiring the executor attaches to the desk's LIVE Chrome: the
  guard sits inside \`openTrade\` after the session check and before \`placeOrder\`; the rule is NOT re-implemented
  inline (the block must not contain \`toLowerCase()\` or \`new Date(\`); the refusal is on the policy path
  (\`blocked: true\`, \`order_blocked\`, no \`order_rejected\`, no \`maybeTripBreaker\`); and the guard does not nest a
  \`mirrorPoller\` cycle. One cross-file pin: \`selfHealth\` must KEEP the \`!e.blocked\` condition.
- **Suite 1,592 / 1,591 pass / 0 fail / 1 skipped** (was 1,578). \`eslint\` exit 0 on all three files (one
  pre-existing \`no-unused-vars\` warning at executor.js:461, not from this change). Desk restarted
  (pid 42728, healthz ok, Chrome attached) — the module is held in memory, so the guard is inert until a restart.

WHAT IT CHANGES, STATED AS A BOUND AND NOT A PREDICTION
- The guarantee is: **at most one unresolved submit per symbol at any instant.** On 2026-09-28 that burst was
  **7 submits (Arabica 4 / Sugar 3) in 100 minutes**; wherever a prior row was still unconfirmed, every later one
  would have been refused. So the loop is bounded by the number of symbols rather than by how long the desk's
  own bookkeeping stays quiet — and each refused submit is one fewer unmanaged venue order that a human has to
  find and cancel by hand.
- ⚠ **It does NOT reduce that bound to zero**, and it must not be read as fixing the class. The FIRST submit for
  a symbol still goes out, still comes back \`ambiguous\`, and is still unmanaged until reconcile runs. Items 1, 2
  and 4 below are what close that.

★★ MEASURED CONSEQUENCE, AND IT IS THE PREDICTED ONE — THE DESK RECORDED A HUMAN CANCELLATION AS A FAILURE.
Both rows expired at **2026-09-28T05:42:28.990Z**: \`order_unconfirmed_expired\` with
\`"no venue position matched it within the window — concluded failed, not rejected"\`, \`ttlMin 30\`,
\`venuePositions 3\`. \`Trades\` **#1104** and **#1105** now read \`status='failed'\` with
\`rejectReason "position row did not appear after submit (order may have failed)"\` and note
\`"unconfirmed expired after 30m with no matching venue position"\`.
**The owner cancelled those orders at the venue by hand, and the desk's record of it is a FAILED ORDER whose
stated cause is that no position ever appeared — which is true and still not what happened.** Nothing was
falsified to tidy this up (an honest wrong record beats a clean false one), and the desk is still not able to
say "a human resolved this". That is item 2, and it now has a concrete instance on the record.

⚠ STILL OPEN ON THIS ROW (items 1, 2, 4 — 3 is done)
1. **Distinguish "no position because the market is CLOSED" from "no position because the order FAILED".** The
   closed-session guard did not fire for any of the seven (\`order_blocked\` had zero events), so
   \`sessionClosed(getSession(symbol))\` disagreed with the venue for Arabica and Sugar while the venue had them
   shut. The guard is correct; its INPUT was wrong, so the fix is to make the venue the authority on its own
   session — not another guard.
2. **An \`unconfirmed\` submit must be CANCELLED or ADOPTED within a bounded window — never
   expired-and-abandoned.** This needs a venue-side cancel against the ORDER BOOK and an event kind for "a human
   cancelled this at the venue". Today's #1104/#1105 are the fixture.
4. **The submit check must look at the venue's ORDERS list, not only \`PositionRow.\` testids.**
   \`webtrader.js:1229\` decides success inside \`.positions-orders\`, a container named for the fact that it holds
   BOTH — and the \`PositionRow.\` anchor cannot match a queued ORDER. Collect EVERY new row there and CLASSIFY.
   ⚠ Item 4 is what makes item 3's refusals *informed* rather than blanket: until the desk can SEE a queued
   order, "unconfirmed" is still the only state a queued order can be recorded in.
⚠ **Item 3 is a stopgap with a real cost, and it is worth naming: while a symbol is pending, a legitimate
re-entry into that symbol is refused.** With reconcile resolving each row within ~60 s, the exposure window is
small; if reconcile ever stops running, this guard turns into a desk that will not enter, and the past-TTL
message is the only thing that would say so.`
;

(async () => {
  const pool = await getPool();
  const q = (s) => pool.request().query(s).then((r) => r.recordset);
  const fail = async (m) => { console.error('\n*** REFUSING TO WRITE: ' + m); await pool.close(); process.exit(1); };
  const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  console.log('\n=== 1. the guard EXISTS and is on the POLICY path ===');
  const exec = code('trading/agent/executor.js');
  const start = exec.indexOf('const pending = await store.getUnconfirmedTrades(userId)');
  const end = exec.indexOf('const open = await store.getOpenTrades(userId);', start);
  if (!(start > -1 && end > start)) await fail('the guard block is not present in executor.js');
  const block = exec.slice(start, end);
  const fn = exec.indexOf('async function openTrade');
  const send = exec.indexOf('connector.placeOrder(', fn);
  console.log('  block found; placeOrder at offset ' + send + ', guard at ' + start);
  if (!(start < send)) await fail('the guard is NOT before placeOrder — it would refuse nothing');
  if (!/placed: false, blocked: true, reason: 'unconfirmed_pending'/.test(block)) await fail('the return is not a blocked policy refusal');
  if (!/logEvent\(userId, 'order_blocked'/.test(block)) await fail('it does not log order_blocked');
  if (/order_rejected/.test(block)) await fail('it logs order_rejected — that feeds the breaker');
  if (/maybeTripBreaker/.test(block)) await fail('it can trip the circuit breaker');

  console.log('\n=== 2. the rule lives in the PURE module, and is not duplicated ===');
  const unconf = require('../trading/agent/unconfirmed');
  if (typeof unconf.pendingFor !== 'function') await fail('pendingFor is not exported');
  if (typeof unconf.ageMinutes !== 'function') await fail('ageMinutes is not exported');
  console.log('  pendingFor + ageMinutes exported; TTL=' + unconf.UNCONFIRMED_TTL_MIN);
  if (!/pendingFor\(pending, symbol\)/.test(block)) await fail('the executor does not use pendingFor');
  if (/toLowerCase\(\)/.test(block)) await fail('the symbol comparison is duplicated inline');
  // Spot-check the two rules the tests pin, here as well, so the record cannot claim more than the module does.
  if (unconf.pendingFor([{ id: 1, symbol: 'Sugar' }], 'Gold') !== null) await fail('pendingFor blocks across symbols');
  if (unconf.pendingFor([{ id: 1, symbol: 'Sugar' }], null) !== null) await fail('pendingFor blocks everything on a null symbol');
  if (unconf.ageMinutes({ id: 1, openAt: null }) !== null) await fail('ageMinutes reports the epoch for a missing time');
  console.log('  \u2714 cross-symbol null, null-symbol null, missing-timestamp null');

  console.log('\n=== 3. the test file is present ===');
  const tf = 'test/unconfirmed-retry-guard.test.js';
  if (!fs.existsSync(path.join(ROOT, tf))) await fail(tf + ' is missing');
  const n = (code(tf).match(/^test\(/gm) || []).length;
  console.log('  ' + tf + ' — ' + n + ' test() calls');
  if (n < 14) await fail('expected at least 14 tests');

  console.log('\n=== 4. the measured consequence: a human cancellation recorded as a failure ===');
  for (const r of await q(`SELECT id, symbol, status, rejectReason, note FROM Trades WHERE id IN (1104,1105) ORDER BY id`)) {
    console.log('  #' + r.id + ' ' + r.symbol + ' status=' + r.status);
    console.log('      reject="' + String(r.rejectReason || '').slice(0, 60) + '"');
    console.log('      note  ="' + String(r.note || '').slice(0, 70) + '"');
    if (r.status !== 'failed') await fail(`#${r.id} is ${r.status}, not failed — the expiry did not happen as expected`);
    if (!/expired after/.test(String(r.note || ''))) await fail(`#${r.id} does not carry the expiry note`);
  }
  const exp = await q(`SELECT id, createdAt, payload FROM TradingEvents WHERE kind='order_unconfirmed_expired' AND payload LIKE '%"tradeId":1104%'`);
  if (!exp.length) await fail('no order_unconfirmed_expired event for #1104');
  console.log('  expiry event present at ' + exp[0].createdAt.toISOString());
  const claimed = /no venue position matched it within the window/.test(String(exp[0].payload));
  console.log('  the desk concluded: ' + (claimed ? '"no venue position matched it" (it never knew a human cancelled)' : 'UNEXPECTED wording'));
  if (!claimed) await fail('the expiry wording is not the one this record quotes');

  console.log('\n=== 5. nothing is pending right now, so the guard is untested live ===');
  const pend = await q(`SELECT COUNT(*) AS n FROM Trades WHERE status='unconfirmed'`);
  console.log('  unconfirmed rows: ' + pend[0].n + '  (the guard has nothing to refuse until the next ambiguous submit)');

  console.log('\n=== the record ===');
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
