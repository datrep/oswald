// scripts/record-2026-09-27-autopilot-postmortem.js
//
//   Registers FIVE new tasks on edict 52 "Trading Agent" (sortOrder 163..167) from the
//   post-mortem of the unattended 2026-09-25 session + the 2026-09-27 crash, and appends
//   measured addenda to TWO existing rows (#1418 TRD-RSK-2, #1421 TRD-CAP-1).
//
// ★ SCHEMA TRAPS (same family as record-2026-09-27-listing-and-scaling-sets.js):
//   1. Tasks.plannedStart is NOT NULL with no default -> must be named.
//   2. Tasks.active is COMPUTED -> must NEVER be named in an INSERT.
//      Pass a JS Date, not GETDATE(): the driver writes it as UTC wall-clock, so active = 1.
//   3. sortOrder is PER EDICT. Edict 52 max was 162 when this was written.
//   4. Tasks.name has NO uniqueness check. Idempotency is guarded on MARK inside info.
//   5. Tasks.name is nvarchar(510) = 255 CHARACTERS.
//
// Usage (repo root):
//   node scripts/record-2026-09-27-autopilot-postmortem.js          # DRY RUN
//   node scripts/record-2026-09-27-autopilot-postmortem.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 autopilot postmortem##';

const EDICT = 52;
const OPEN = 1;
const PRIORITY = 2;
const E = '\u2014';   // em dash

const rows = [
  {
    label: 'TRD-SUP-1',
    name: `TRD-SUP-1: Supervisor ${E} the crash-exit is deliberate, but the recovery that policy depends on reports instead of restarting, so "genuinely broken" resolves to "down until a human reads Telegram"`,
    info: `${MARK}
MEASURED 2026-09-27 (desk down 12:11:13.539Z -> 12:21:23.301Z, ~10 min, and it would have been permanent).

WHAT HAPPENED. trading/server.err.log ends with a sessionFeed re-attach attempt followed by SEVEN
unhandled rejections:

    [trading.browser] attached to existing Chrome on :9224
    [trading.sessionFeed] silent for 11m and NOT attached - re-attaching
    [crash] unhandledRejection: Error: Frame has been detached.
      at CRPage._sessionForFrame / _eventBelongsToStaleFrame
         / _onLifecycleEvent / _onFrameRequestedNavigation   (playwright-core)

trading/crash/exit.json  -> {"at":"2026-09-27T12:11:13.539Z","event":"exit","pid":17352,
                             "uptimeSec":1147,"rssMb":269,"node":"v26.2.0","code":1}
trading/crash/heartbeat.json -> frozen at 12:11:06.899Z, pid 17352, uptimeSec 1140

★ THE EXIT IS CORRECT AND INTENDED. crash.js documents the policy verbatim: exceptions must NOT kill
the desk, because the rarest resource is sample size - "we log, we page, we count - and we only exit
if the errors are RECURRING (more than 5 in 10 minutes), which means the process is genuinely broken
rather than unlucky." 7 errors in 10 minutes is exactly the designed exit condition.

★ THE DEFECT IS THE OTHER HALF. crash.js states the requirement plainly: "A watchdog that shares fate
with the thing it watches is not a watchdog." So the design requires an OUT-OF-PROCESS supervisor to
act on exit.json. That supervisor exists and runs:

    scheduled task OswaldTradingSupervisor   State=Ready   LastRun 12:15:15Z
    trading/crash/supervisor-state.json -> {"downSince":"2026-09-27T12:11:06.899Z",
        "lastAlertAt":"2026-09-27T12:15:01.787Z","lastState":"down","lastRunAt":"2026-09-27T12:15:01.787Z"}

It DETECTED the outage in under four minutes and WROTE lastState:"down". It did not restart, and by
design it will not: supervise.js says -

    "WHY NO AUTO-RESTART BY DEFAULT. Restarting a trading process unattended can double-run the
     executor against a live book... Reporting is safe; restarting is a policy choice.
     Pass --restart to opt in."

Both halves are individually defensible. Composed, they mean: THE DESK'S OWN ESCALATION PATH ENDS IN
A NOTIFICATION. The failure mode the design labels "genuinely broken" is therefore the one failure
mode with no recovery - and it lands on a 24/7 autonomous desk whose operator may be asleep.

CONFIRMED NOT THE BROWSER: port 9224 stayed LISTENING throughout (Chrome was alive). The feed bridge
mechanism failed, not the browser.

NOT A HYPOTHETICAL. Compare TRD-40 (#1281, "Failures must be audible - the desk was down 9h
silently"). That task made the outage VISIBLE. This one is the step after visibility: the alert
fired, was read by nothing, and the desk stayed down. Audibility without authority is still an outage.

DECISION REQUIRED (a policy choice, which is why this is an open task and not a patch):
  (a) run the supervisor with --restart plus a single-instance lock (a PID/lockfile + a pre-flight
      healthz probe) so a restart cannot double-run the executor; or
  (b) keep report-only and accept that a crash-exit parks the desk until a human acts - but then say
      so in the dashboard, because right now the scheduled task LOOKS like auto-recovery.

★ SIDE FINDING, same crash: the trigger was the Plus500 page going stale (sessionFeed "silent for
11m"), which is the same bridge-staleness family as TRD-47 (#1289). Frames detaching is a symptom of
the bridge tab being navigated/replaced underneath the feed, not of the DB.`,
  },

  {
    label: 'TRD-PHN-1',
    name: `TRD-PHN-1: Position oversight ${E} 150 reviews across 12.5 hours of a position the venue had already closed, and not one of them reported it missing`,
    info: `${MARK}
MEASURED 2026-09-25 -> 2026-09-27. This is the reason no exit fired on Friday, and it has nothing to
do with the price feed.

THE FACTS.
  - Gold short #1095 was closed AT THE VENUE at 2026-09-25T08:31:00.000Z ("Loss call").
  - The desk did not learn this until 2026-09-27T08:38:38Z - FORTY-EIGHT HOURS LATER.
  - Between 08:32:24Z and 20:59:33Z on 09-25 the review loop wrote 150 position_review events.
    Every one of them named Gold and trade 1095. Every one was an LLM call (model deepseek-flash,
    ~368 tokens, authority "decider", authoritySource "strategy:survgold").
    NOT ONE mentioned missing_on_venue. Not one mentioned phantom.
    The strings "%missing_on_venue%" and "%phantom%" match 0 of those 150 rows.

WHAT THE REVIEWS SAID. They read as healthy management of a live position, e.g.
  "price 4272 sits below sma50 4312, sma200 4363 and ema20 4308, so the downtrend premise holds.
   Stop at 4285 is 13pts away and TP 4244 is 28pts below; a -1.19 float is n..."

So for 12.5 hours the desk simulated a float, checked a stop and a target, and paid for an LLM opinion
on a position that had already been closed at the venue.

★ WHY IT COULD NOT SEE. The wake's own text names the split: "positions open, no proposal - committee
not convened (position oversight runs in the review loop)". The review loop reasons over the DESK'S
BOOK and the bar/tick series. Comparing the book against the VENUE is a different code path - the
venue-close sync - which ran on 09-27 and is what finally healed it:

  08:38:32  phantom_fill  {"tradeId":1095,"symbol":"Gold","direction":"missing_on_venue"}
  08:38:38  trade_closed  {closeReason:"Loss call", netPnl:-3.97, closePriceSource:"venue_rate",
                           closeAtSource:"venue_ui_minute", venuePositionId:1888158136,
                           venueClosedAt:"2026-09-25T08:31:00.000Z"}
  08:38:38  reconciliation {source:"venue-close-sync", checked:1, healed:1, stillUnresolved:0}
  08:38:38  autopsy        {holdingMinutes:281, mfePct:0.3338, maePct:-0.3212,
                           slippagePct:-0.3979, diagnosis.ticksInWindow:1065,
                           windowEndUncertaintySec:60}

★ CONSEQUENCE. The desk held NO exposure from 08:31Z on 09-25, so this did not risk money that day.
It risked the two days after: the book said "1 position open" the whole time, which silently docks
maxPositions, feeds the correlation veto (Silver was refused on "correlation 0.7761 with open position
Gold"), and makes every downstream metric - open risk, exposure, the position count in every prompt -
wrong. TRD-44 (#1286) and TRD-48 (#1290) are the same family: rows that are closed somewhere else and
still read as open here.

WHAT TO MEASURE. The venue-close sync interval vs the review-loop interval. A 48-hour reconciliation
lag against a 150-times-per-day review cadence is not a tuning miss, it is a missing join.

★ THE GENERAL LESSON, which is why this is recorded rather than just fixed: "position oversight is
running" and "position oversight is correct" are different claims, and the desk reported the first
150 times as though it were the second.`,
  },

  {
    label: 'TRD-DB-1',
    name: `TRD-DB-1: Data ${E} the Friday session was DATABASE-bound, not signal-bound: 44 of 56 wakes died on a 60-second SQL request timeout, and the feed collapse shares its 07:20Z timestamp`,
    info: `${MARK}
MEASURED 2026-09-25, 08:00Z -> 21:00Z (market OPEN, 12.5 h unattended). 56 wakes:

    failedStep="bars", error "Timeout: Request failed to complete in 60000ms"   44
    failedStep="deliberate", "step exceeded its 300000ms deadline"               1
    "deliberation declined"          (committee met and said no)                 5
    "positions open, no proposal - committee not convened"                       2
    "SESSION_LOCK - plus500 calendar (Fri 21:00-Sun 21:00 UTC)"                  2
    "deliberation approved"          (ONE wake, two stream rows)                 2

  => 45 of 56 wakes died on a TIMEOUT. 44 of those were `bars`.

The 95 error events that day are the same story: where=bars_build code=ETIMEOUT, repeatedly -
08:05:13, 08:23:09, 08:39:56, 08:52:36, 09:11:22, 10:14:41, 10:28:09, 10:44:18, 11:02:47, 11:16:32,
11:29:24, 11:45:50, 12:03:19, 12:20:29, 12:34:30, 12:50:20, 13:02:49 - plus where=position_review
ETIMEOUT (08:06:16) and where=review_loop "operation timed out for an unknown reason" (09:54:29,
12:30:24).

★ THIS REFUTES AN EARLIER READING OF THE SAME SESSION. The first pass concluded "the Plus500 feed died,
so `bars` had nothing to build". The error text says otherwise: the failing component is the
DATABASE, reporting a 60-second request timeout. `bars` was firing the alarm, not causing it.

★ THE UNRESOLVED QUESTION, and it is the highest-value unknown in this whole investigation. The tick
writers and the stalls occupy the SAME window:
    PriceTicks last position_poll         2026-09-25T07:27:04Z
    PriceTicks last plus500_frontend      2026-09-25T07:20:47Z
    yahoo_rest / okx_rest / binance_rest  continue normally to 2026-09-25T20:45:23Z
    bars_build ETIMEOUTs start            2026-09-25T08:05:13Z
    bars_built (maintenance) resumes      2026-09-25T09:25:58Z, again 15:01, 16:15, 20:43
So: did a machine/SQL-level stall kill the write path (making the feed look dead), or did a dead
feed poison a query hot enough to hit the 60 s client timeout? The 22-ticks-per-hour residue from
09:00Z, and whole missing hours, are read by TRD-CAP-1 (#1421) as a feed failure. Both readings are
consistent with the current evidence and THEY IMPLY DIFFERENT FIXES - a DB/index/config fix versus a
bridge watchdog.

WHAT TO MEASURE (the discriminating evidence, none of which has been looked at yet):
  1. SQL Server errorlog + wait stats for the 07:20-07:40Z window on 09-25.
  2. Whether the tick inserters and bars_build draw from the same pool/connection/requestTimeout.
  3. Which query inside the bars step actually ran 60 s (mssql logs no statement text by default).
  4. DB_Oswald AUTO_CLOSE, the subject of TRD-54 (#1296) - 13 full cold recoveries already logged.

★ RELATES TO, BUT IS DISTINCT FROM: TRD-BAR-1 (#1420) recorded the 60 s timeout and removed its
FATALITY; TRD-CAP-1 (#1421) recorded the feed collapse. Neither asks WHY THE DATABASE STALLED, and
that is the question that decides the fix. Do not close either of those on this task's evidence.`,
  },

  {
    label: 'TRD-HLT-1',
    name: `TRD-HLT-1: Health ${E} the desk's own F20 floor check reported bad on 19 consecutive checks across 21 hours, and nothing changed`,
    info: `${MARK}
MEASURED 2026-09-25. self_health runs roughly every 30 minutes. On 09-25 it wrote 40 events, of which
19 carried a check with status "bad" - and it was ALWAYS the same check, with the same detail:

    field_levels  1/50 POSITION(S) BELOW THE DECLARED FLOOR (F20): #1046 realised R:R 0.22
                  against a floor of 0.75

First bad: 2026-09-25T00:24:40Z.  Last bad: 2026-09-25T20:54:57Z. That is 19 consecutive runs
going bad, spanning 20.5 hours of a 21-hour session. The check was never fixed and never acted on.

★ THE COMPOUNDING DETAIL: the same payloads report 1 bad / 4-10 warns, so the health surface was
flapping between "bad" and "warn" all day. It was never quiet, and it was never green.

★ WHY THIS IS NOT JUST "A TRADE WENT WRONG". #1046 realised an R:R of 0.22 against a declared floor of
0.75 - the trade kept less than a third of the reward its own plan promised. This is the SAME defect
family as TRD-TP-1 (#1412, "capping the stop silently moved the target from 1.5R to ~2.0R") and
TRD-RSK-2 (#1418), and it is the same 0.22-vs-0.75 gap the post-mortem measured independently in the
27-trade window (far-target band expectancy -0.247R vs +0.260R for the tight band). The desk
diagnosed its own central problem, in plain language, 19 times, and no change followed.

Compare TRD-40 (#1281, "Failures must be audible - the desk was down 9h silently"). Audibility is
solved. This task is about the next step: a `bad` that persists for 21 hours is not a monitor, it is
a log line with a colour. Something must consume it - a halt, a Telegram page, or an explicit
"acknowledged, accepted, here is why" that the next check reads back.

★ WHAT TO DECIDE. Is `field_levels` advisory-by-design (then it belongs in telemetry, not in the bad
band) or is it a gate (then a bad must actually halt or page)? Right now it is the worst of both: loud
enough to be visible in every health sample, powerless enough to change nothing.`,
  },

  {
    label: 'TRD-WAK-2',
    name: `TRD-WAK-2: Wake pipeline ${E} the fatal-wake path is still reachable after TRD-BAR-1, because providers and the deadline path still throw`,
    info: `${MARK}
MEASURED 2026-09-27 against trading/agent/wakePipeline.js and confirmed against the 09-25 event log.

TRD-BAR-1 (#1420) fixed the specific wound: the `bars` step now try/catches, logs
log.error(userId,'bars_build',e), records barsError = {message, code, at, note} and returns
{skipped:'bars_failed', error} instead of rethrowing. That is correct and it is not in question here.

★ WHAT IT LEFT BEHIND. Inside the same wake:
  - `step()` still does `throw e` for every error that is not a deadline error.
  - doProviders still rethrows.
  - The deadline flag (`e.deadline`) is never set for a SQL `requestTimeout`, so a DB stall is not
    classified as a deadline case and takes the fatal branch.
The 09-25 log demonstrates the consequence directly:

    failedStep="deliberate"
    error: step 'deliberate' exceeded its 300000ms deadline

One wake died THERE, with the same sweeping ergonomics as the 44 `bars` deaths: no exits evaluated,
no position review, the whole wake abandoned. A degraded database is exactly the condition that
produces one fatal step after another, which is why guarding one of six steps is not the same as
making the wake survive a bad database.

★ THE PRINCIPLE FROM THE MODULE'S OWN COMMENT, applied one level up. The TRD-BAR-1 comment argues
that a step failure should degrade the wake, not kill it, because "it is the most FREQUENT sampler of
a database that stalls". That argument is about the database, not about the `bars` step, and it
applies to every step that touches the database.

★ WHAT TO DO. Either (a) make the wake's outer loop step-agnostic: any step failing records its own
failure and the wake still runs whatever remains safe, so position oversight cannot be lost to an
entry-evaluation error; or (b) classify requestTimeout / ETIMEOUT as a deadline-class error so the
existing deadline path applies. (a) is the honest generalisation of the TRD-BAR-1 fix; (b) is the
one-line version.

★ RELATED: TRD-WAK-1 (#1419) is about wakes that record an EMPTY reason (455 of 1,849 = 25%), so this
family already has a telemetry gap; this task is the control-flow half of the same story.`,
  },
];

const appends = [
  {
    id: 1418,
    label: 'TRD-RSK-2',
    add: `
${MARK}
--- ADDENDUM 2026-09-27: the 28x skew, measured in a live approval -------------------------------

The 09-25 09:26:25 Arabica Coffee approval carries the sizing story inline, so the skew is visible
without inference:

  sizeCalc: {"equity":4115.27,"riskPct":2,"atr":0.4003,"baseSize":102.8046,"runInFactor":0.5,
             "strategyFactor":1,"cappedAtPct":80,"finalSize":3.5982,
             "venueFloor":{"ok":true,"reason":"above_venue_minimum","minUnits":0.5},
             "reasons":["0.3% cap clears Arabica Coffee's 0.1756% round trip by 1.71x",
                        "take-profit pulled in 5% of its own distance (owner setting)...",
                        "run-in factor 0.5 ...",
                        "size capped at 80% equity",
                        "size capped at 0.07% risk/trade (implied 0.240% of equity)"]}

riskPct reads 2. The binding cap is settings.risk.maxRiskPerTradePct = 0.07. That is a 28.6x
discrepancy between the risk number the approval quotes and the risk number that was applied, and
both appear in the SAME payload - the object says 2, its own reasons list says 0.07.

Same class as TRD-LLM-2 (#1413, "the chair is asked to size a trade it has never been told the equity
for"): the artifact an approver reads is not the artifact the executor used. The reasons list is
honest; the headline field is not.

ALSO CONFIRMED: "0.3% cap clears Arabica Coffee's 0.1756% round trip by 1.71x" shows the cost-ceiling
arithmetic firing correctly, against maxAdverseCostMultiple 1.5. Against Silver the same gate refused
at "venue cost 0.1936% = 65% of R" with the ceiling set to 0.65.`,
  },
  {
    id: 1421,
    label: 'TRD-CAP-1',
    add: `
${MARK}
--- ADDENDUM 2026-09-27: the collapse now has exact times, and a co-timed DATABASE stall -----------

The feed's own last writes, from PriceTicks grouped by source:

    position_poll        last 2026-09-25T07:27:04Z
    plus500_frontend     last 2026-09-25T07:20:47Z
    yahoo_rest   / okx_rest / binance_rest   continue normally to 2026-09-25T20:45:23Z

Ticks per hour on 09-25: 00:00Z 651 | 01:00 503 | 02:00 348 | 03:00 254 | 04:00 486 | 05:00 384 |
06:00 424 | 07:00 192 | 08:00 MISSING ENTIRELY | 09:00 22 | (10:00-14:00 missing) | 15:00 22 |
16:00 22 | 20:00 22.  The 15-minute bars stop at exactly 07:15Z.

★ NEW CO-TIMED EVIDENCE, recorded here because it changes what this task might mean. In the same
window the desk began dying on 60-second SQL request timeouts - first at 08:05:13Z, 17 more times
through 13:02:49Z - with position_review and review_loop timing out too. Full taxonomy is on
TRD-DB-1 (newly created 2026-09-27).

So the feed collapse and a database stall START WITHIN ~40 MINUTES OF EACH OTHER, and the evidence in
hand does not say which came first. Read CAP-1 as "the feed stopped", not as "the feed failed
independently" - the DB-1 task exists to settle the direction of causation.

★ THE DECISIVE DATAPOINT FOR THIS TASK, unchanged: an approval DID get through at 09:26:25Z and was
refused by the feed itself -

    order_blocked {"symbol":"Arabica Coffee","direction":"buy","size":3.5982,"reason":"stale_price",
      "detail":"Arabica Coffee was priced from a tick 125m old - over the 15m not-tradable line
                (quant.TICK_SLA_MS)","priceAgeSec":7512,"limitMin":15,
      "note":"an entry is a decision about the NEXT move - the desk will not make it on a price it
                cannot see (F17)"}

That is the correct refusal, and it is also the proof that the instrument which "should have fired"
could not have: the gate that stops the desk trading blind is the same gate that makes a dead feed
indistinguishable from a quiet market.`,
  },
];

async function main() {
  const pool = await getPool();
  const maxSort = await pool.request()
    .input('e', EDICT)
    .query('SELECT ISNULL(MAX(sortOrder), -1) AS m FROM Tasks WHERE edictId = @e');
  let sort = maxSort.recordset[0].m;
  console.log(`edict ${EDICT} max sortOrder = ${sort}`);

  console.log(`\n=== ${YES ? 'WRITE' : 'DRY RUN'}: ${rows.length} new rows, ${appends.length} appends ===`);
  for (const r of rows) {
    sort += 1;
    const existing = await pool.request()
      .input('m', `%${MARK}%`)
      .input('l', `%${r.label}:%`)
      .query(`SELECT id FROM Tasks WHERE edictId = ${EDICT} AND info LIKE @m AND name LIKE @l`);
    if (existing.recordset.length) {
      console.log(`  SKIP  ${r.label} - already present as #${existing.recordset[0].id}`);
      continue;
    }
    console.log(`  ADD   ${r.label}  sort=${sort}  nameLen=${r.name.length}  infoLen=${r.info.length}`);
    console.log(`        ${r.name}`);
    if (YES) {
      const ins = await pool.request()
        .input('name', r.name)
        .input('info', r.info)
        .input('plannedStart', new Date())
        .input('sortOrder', sort)
        .input('edictId', EDICT)
        .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
                OUTPUT INSERTED.id
                VALUES (@name, @info, @plannedStart, ${PRIORITY}, ${OPEN}, @edictId, @sortOrder, SYSUTCDATETIME())`);
      console.log(`        -> #${ins.recordset[0].id}`);
    }
  }

  for (const a of appends) {
    const cur = await pool.request().input('id', a.id)
      .query('SELECT LEN(CAST(info AS nvarchar(max))) AS n, info FROM Tasks WHERE id = @id');
    if (!cur.recordset.length) { console.log(`  MISS  append target #${a.id} not found`); continue; }
    const body = cur.recordset[0].info || '';
    if (body.includes(MARK)) { console.log(`  SKIP  #${a.id} ${a.label} - addendum already present`); continue; }
    const before = cur.recordset[0].n;
    console.log(`  APPEND #${a.id} ${a.label}: ${before} -> ${before + a.add.length} chars`);
    if (YES) {
      await pool.request().input('id', a.id).input('add', a.add)
        .query('UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @add WHERE id = @id');
    }
  }

  console.log('\n--- verify ---');
  const v = await pool.request().query(
    `SELECT id, sortOrder, state, priority, active, LEN(CAST(info AS nvarchar(max))) AS ilen, LEFT(name, 96) AS name
     FROM Tasks WHERE edictId = ${EDICT} AND id >= 1423 ORDER BY sortOrder`);
  for (const r of v.recordset) {
    console.log(`  #${r.id} sort=${r.sortOrder} state=${r.state} pri=${r.priority} active=${r.active} info=${r.ilen}  ${r.name}`);
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
