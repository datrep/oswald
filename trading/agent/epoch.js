// trading/agent/epoch.js â€” WHEN EACH PIECE OF THE DESK LANDED, AND WHAT THAT MAKES OLD DATA UNABLE TO PROVE.
//
// âš âš  WHY THIS EXISTS, AND IT IS NOT BOOKKEEPING. Over one session, pre-policy data produced THREE wrong answers â€”
// the last of which was written into a report as a conclusion:
//   Â· a wake census read one field of three and called 237 self-describing wakes "empty";
//   Â· a target-anchor study reported ONE mean over 57 trades spanning two different stop regimes;
//   Â· a Step-0 measurement concluded "the approved entries were negative, so the weak link is upstream of the
//     gate" â€” on a sample that was **83% pre-policy**, where the current week's approved entries are the OPPOSITE
//     sign. The owner had already ruled on this three times: *"dont trust previous data. they are before the new
//     policies are implemented."*
//
// The failure was never that old data existed. It was that a measurement **silently** included it and reported one
// number. Deleting the old data does not fix that (it removes the baseline that lets a reader tell policy from era)
// â€” so this module makes the boundary **impossible to cross by accident and impossible to cross silently**:
//
//   Â· `FEATURES` is the timeline as DATA, every entry citing the task row that records it, so it can be checked
//     rather than believed;
//   Â· `annotate({ since, until })` returns the window PLUS every boundary it spans and what that costs, so a
//     caller that renders only the numbers is not the only option;
//   Â· `sqlEpochJoin()` gives the same fact to a RAW SQL reader, which is the path an agent actually takes â€” an
//     annotation that lives only in a comment is invisible to `SELECT AVG(...)`.
//
// âš  AND THE STALENESS DIRECTION MATTERS: this file ages. A feature added without an entry here is a boundary a
// reader will cross blind. THE GUARD THAT CATCHES IT IS `agent/changeAudit.js` + `scripts/check-epoch-coverage.js`,
// run as step 4 of the AGENTS.md protocol: it reports any policy settings write, any `trading/**` file mtime and any
// `sql/migrations/**` mtime after the declared freeze, and the protocol is not complete while one is unaccounted for.
//
// THIS PARAGRAPH USED TO NAME `assertRegistryCoverage` AND CALL IT FROM `test/epoch-registry.test.js`. That function
// never existed: it was a comment describing a check, and the test it named cannot fail on a missing boundary because
// it never looks for one. Measured 2026-10-02, the registry sat untouched from 2026-09-27 while SIX behaviour changes
// landed after it. A documented safeguard that was never built is worse than an absent one, because it is the reason
// nobody looked. It is not coming back: the job is done by `changeAudit.unaccounted`, from three datable sources
// rather than from `Tasks.completedAt` (218 trading rows share one completedAt - a board action, not a landing date).
'use strict';

// â˜… THE POLICY EPOCH. The Monday the current policy set began. Every artifact that reports a window cites this
// value rather than re-deriving "this week", which is a moving target.
const EPOCH = '2026-09-21';

// â˜…â˜… POLICY FREEZE (owner decision, 2026-10-02) â€” THE WINDOW THE DESK STOPS CHANGING SO N CAN ACCUMULATE.
//
// WHY THIS IS A RECORDED VALUE AND NOT AN INTENTION. Measured on 2026-10-02: the desk takes ~10-12 trades/day and
// had SEVEN behaviour boundaries in 14 days â€” one every ~2 days â€” so a "clean era" is ~2 days â‰ˆ 20-25 trades, and
// EVERY change resets the clock. A study scoped by this registry collapsed to **n=1** for the regime actually in
// force. No policy question on this desk can be answered from its own forward record until the change rate falls
// below the rate at which N accumulates. That is arithmetic, not opinion.
//
// âš  SO THE FREEZE IS CHECKABLE, NOT ASPIRATIONAL â€” and an unverified freeze would be the same defect one level up.
// `changeAudit.unaccounted({ freeze })` reports ANY policy settings write or ANY change under `trading/**` after
// this date, and `trading/scripts/check-epoch-coverage.js` runs it. A window that silently contains a change is
// exactly the contamination this module exists to prevent.
const POLICY_FREEZE = {
  // âš  A TIMESTAMP, NOT A DATE, AND THE FIRST RUN OF THE GUARD IS WHY. With a date, the comparison is "after
  // 2026-10-02T00:00Z" â€” which counted the SAME DAY's setup work as a breach, including the EXE-14 arming at
  // 01:23:38Z that the freeze exists to protect. A window with a midnight start flags its own author. The window
  // opens when the desk is actually left alone, so it opens at a stated time.
  //
  // â˜… RE-DECLARED 2026-10-02T05:00:00Z â€” AND THE PROTOCOL WORKED EXACTLY AS WRITTEN. The 03:00Z window was broken
  // by ONE owner-approved change (`bundle-stable-first`, the stable-first prompt reorder); the guard reported it
  // as a freeze_breach with its sanctioned fix ("register the change and restart the window, or revert"), and that
  // is what this is: the change is registered above and the window restarts here. The 03:00-05:00Z fragment is
  // transitional (nâ‰ˆ2) and must not be pooled with anything.
  //
  // â˜… RE-DECLARED AGAIN 2026-10-02T06:20:00Z â€” the SECOND cost of the day, paid the same way. One owner-approved
  // recovery fix (`health-repair-fallback`, the A1 repair fallback for a tab parked off the trade route) broke the
  // 05:00Z window; register + restart, exactly as the guard's fix line says. The 05:00-06:20Z fragment must not be
  // pooled â€” it contains the day's second UI Fallback Pause lockout (05:35â†’06:2xZ), which is not desk behaviour.
  //
  // â˜… RE-DECLARED A THIRD TIME 2026-10-02T07:05:00Z â€” and this time the guard caught something REAL, not a
  // deliberate change. Its first live finding was an account-poller baseline FLASH at 06:54Z, seconds after the
  // 06:53:25Z resume: one `#accountStatus` strip read returned the real-money account's level (22.28) and the
  // switch detector â€” which trusts a SINGLE read â€” re-based `day_start` and BOTH equity baselines to it; six
  // seconds later it re-based back. No kill-tier interaction and no persisted equity-curve sample (both verified);
  // the mechanism is written up in docs/incident-2026-10-02-ui-fallback-pause.md Â§6 and filed as TRD-RSK-17
  // (#1503). NO decision input was deliberately changed â€” the window is restarted because a window containing a
  // 6-second baseline flash must not be pooled, and the poller CONFIRMATION FIX IS NOT LANDED under this freeze.
  //
  // â˜… RE-DECLARED A FOURTH TIME 2026-10-02T07:25:00Z â€” the release of the crisis soft kill, plus the fix the
  // guard's catch called for. The owner's dashboard SOFT KILL (set 06:17:45Z during the second lockout) was
  // released at 07:08:51Z via POST /trading/kill {tier:'off'}; the guard reported the kill.tier write as a
  // freeze_breach â€” exactly as designed â€” and this restart is the sanctioned fix. Landed in the same window:
  // `account-switch-confirmation` (TRD-RSK-17, #1503), the confirmation gate for the 06:54Z flash, deployed
  // by desk restart. The 07:05-07:25Z fragment must not be pooled: the kill was on until 07:08:51Z and the
  // fix was deployed mid-fragment.
  //
  // â˜… RE-DECLARED A FIFTH TIME 2026-10-02T07:33:00Z â€” for the #1499 venue-close fill derivation (deployed by
  // desk restart), and for a RECORD CORRECTION rather than a live change: the owner's EXE-13 "go" found the
  // key ALREADY SPENT â€” `risk.entryDriftFactor` was set to 1.083 at 2026-10-01T00:30:55Z (settings_write
  // #152809) and every decision since 01:17:37Z sized with it, while the plan described the capability as
  // "built INERT". The switch is registered above with its TRUE date; no settings write landed today. The
  // 07:25-07:33Z fragment is transitional and must not be pooled: it contains no trades.
  //
  // â˜… RE-DECLARED A SIXTH TIME 2026-10-02T08:00:00Z â€” the two small fixes, deployed together: `whitepaper-force-
  // refresh` (#1502: Generate now / black-swan can finally REWRITE a current-period tier) and `capture-
  // evaluate-timeout` (#1504: a wedged capture fails NAMED in 90 s instead of holding pageLock forever).
  // ALSO folded in, tooling only: the guard's settings-write scan is now scoped to userId=1 â€” measured at
  // 07:54Z the `npm test` SMOKE suite wrote its fixture policy keys as test user 42 against this DB and lit the
  // frozen window with breaches the desk never made. âš  The 07:33-08:00Z fragment contains the desk's FIRST
  // entry of the day after the lockouts (#1209 Sugar, 07:52:50Z) â€” it must NOT be pooled.
  //
  // â˜… RE-DECLARED A TWELFTH TIME 2026-10-17T19:20:00Z â€” THE CONTINUITY MERGE (laptop hand-off bundle,
  // owner-directed return-to-service work). Five behaviour-neutral changes + five new read-only files
  // (registered above as `continuity-merge-2026-10-18`): the three capture-only env flags (UNSET on the
  // desk â€” every gated path returns before doing anything), bringToFront bounded to 3 s, the Polygon
  // Yahoo id correction (old id 404 â€” nothing was computed from it), `expenses` dashboard registration,
  // and the recorder/keepalive/watchdog scripts (not scheduled on the desk; docs/10-ARCHITECTURE-NOTES.md
  // carries the ADRs). No policy key, no decision input, no scope change â€” era clock untouched by
  // construction. Desk restarted 18:52:43Z to load the code (pid change only). The 10-08 to 10-17 span
  // contains the seven-day outage (desk off, 0 TradingEvents) and must not be pooled; post-T2 accounting
  // resumes from this instant.
  //
  // â˜… RE-DECLARED A THIRTEENTH TIME 2026-10-17T19:06:00Z â€” THE MIRROR CYCLE DEADLINES (owner-directed,
  // same return-to-service pass): the mirror poller's four venue awaits are now bounded (45/20/20/30 s),
  // so a hung evaluate can no longer hold the shared bridge lock indefinitely and starve ticket flows
  // (recurring `bridge busy (mirror)` â€” 28 hits in one weekend). Registered as `mirror-cycle-deadline`.
  // Read-only beside the desk: no policy key, no decision input, no scope change; era clock untouched.
  //
  // â˜… RE-DECLARED A FOURTEENTH TIME 2026-10-17T20:05:00Z â€” THE WATCHLIST QUOTE FAST PATH (owner-directed,
  // "start on 1"): the dynamic capture reads quotes in ONE watchlist-table read (burst moved to table
  // re-reads; quotes banked before the chart sweep), and the chart half is now deadline-bounded per symbol
  // and rotated least-recently-charted-first (5 per wake). Registered above as `watchlist-quote-fast-path`.
  // Same venue/source for prices; no policy key, no scope change â€” era clock untouched; the desk restarted
  // to load it (pid change only).
  // â˜… RE-DECLARED A FIFTEENTH TIME 2026-10-17T20:20:00Z â€” the pin repair for the fast path (same night,
  // same owner directive): two source pins went red against the restructured captureDynamic and both
  // findings were real (dead chartIdentity/chartMerge accumulation removed; the chartMissing pin generalised
  // to its binding invariant). Registered as `watchlist-fast-path-pin-repair`. NO behaviour change â€” same
  // prices, same sources, no settings write â€” the desk restart loads an identical-behaviour build.
  // â˜… RE-DECLARED A SIXTEENTH TIME 2026-10-17T20:50:00Z â€” night-shift improvements while the venue is closed:
  // `desk-singleton-guard` (boot refuses when another desk already serves /healthz; named bind failures) and
  // `capture-rotation-backoff` (a closed venue stops costing 40 s of tab time per wake). No decision input,
  // no settings write; the desk restart below loads both.
  // RE-DECLARED A SEVENTEENTH TIME 2026-10-18T08:15:00Z - CRYPTO 24/7 SESSIONS (owner: "dont gate. any 24/7
  // stocks are available to be used"): a 24/7 instrument is no longer closed by the stock-CFD weekend
  // calendar while the venue feed is silent (an explicit venue close still wins; the class is curated in
  // trading/lib/instrumentClass.js). Registered as `crypto-24-7-sessions`. No threshold, strategy or
  // instrument-set change; weekend DATA is excluded from modification analyses per the same instruction.
  // BOUNDARY MOVED 2026-10-18T11:42:00Z - the crypto-24-7-sessions edits landed AFTER the 08:15Z instant
  // that had been declared for them (the deploy and its live proof came later), so the guard correctly saw
  // three unaccounted files. Same registered feature, boundary moved past the edits; no policy key, no
  // threshold, no instrument-set change.
  // RE-DECLARED 2026-10-18T12:10:00Z - WEEKEND SESSION CLASS (owner: separate class, same era): migration 050
  // adds Trades.sessionClass and store.createTrade stamps it at entry; the era is NOT re-anchored.
  // Registered as `weekend-session-class`. Provenance only; no decision input changes.
  // RE-DECLARED 2026-10-18T15:45:00Z - TRD-TRL-12b, the engage verification anchored to the trade entry.
  // Registered as `trail-engage-entry-anchored-verify`; the engage flag stays FALSE (inert at deploy).
  // RE-DECLARED 2026-10-18T16:30:00Z - SOYBEANS ENTRY PAUSE (owner: pause entries for now). A scope write
  // (symbolScope.Soybeans = []), journal #269255; registered as `pru-soybeans-pause`. Reversible; re-entry
  // needs its own registered change after the external review.
  // RE-DECLARED 2026-10-18T19:11:00Z - geometry-grid cutoff derived from the data + atrStopMultiple wired
  // (registrations above). 19:20Z was a PLACEHOLDER written before the work finished; this is the real
  // completion instant, and it is still strictly after the last file write in this window. Nothing a
  // decision reads changed: the harness writes nothing, and atrMultiple is 2, so every stop is unchanged.
  // RE-DECLARED 2026-10-18T19:20:30Z - PRE-REGISTERED STOP-WIDTH TEST, the instant it went live: the settings
  // write is journal #271364 at 19:18:10Z (atrStopMultiple 2 -> 4, maxAdversePct 1.5 -> 2.5). The venue is
  // closed until 21:00Z, so no trade can fall between the write and this boundary - the era split is identical
  // to the 19:40Z placeholder, but this one can be audited now instead of being left pending.
  // RE-DECLARED 2026-10-18T22:20:00Z - the risk-unit AUDITOR now reads the same stop multiple as the sizer
  // (registration above). Read-only self-health contract; no sizing path touched.
  // RE-DECLARED 2026-10-19T22:06:00Z - TRAIL ARMED (lock075_t15). Settings write journal #288318 at 22:02:12Z;
  // the 22:02-22:06 gap was verified to contain zero trades, so no ticket is mis-attributed across the boundary.
  // RE-DECLARED 2026-10-19T23:10:00Z - the engage loop samples on time (registration above). No policy value
  // changed; the bridge gate moved from the sample to the commit.
  // RE-DECLARED 2026-10-20T08:25:00Z - the trail COUNT is calibrated from a read-back instead of assumed from the
  // measured table, and a refused engage is parked instead of retried every minute (registrations above). No
  // dial moves: lockR 0.75, trailR 0.15, the venue-window and wrong-side refusals and the 2% verify band are all
  // untouched. The desk was FLAT for the whole edit window (two open tickets, #1335 Ethereum and #1343 Gold, both
  // below the +0.75R lock), so nothing falls between the write and this boundary.
  // RE-DECLARED 2026-10-20T21:01:00Z - the LLM client now passes the reasoning controls the API has always
  // documented (registration above). Owner-approved, and BEHAVIOUR-NEUTRAL BY DEFAULT: both options default to
  // undefined, so the request body is unchanged for every existing caller. Nominal boundary, protocol applied
  // unconditionally because trading/** changed. One trail engagement is on record before this instant (#1345 Oil,
  // 14:23Z, committed_unverified with the stop lock placed) and its exit is unaffected.
  // RE-DECLARED 2026-10-21T21:20:00Z - the chart interval is now DECLARED and requested instead of inherited, and
  // sub-hourly chart reads are stored instead of being 60:1 aggregated away (registrations above:
  // `chart-interval-declared`, `chart-fine-bar-storage`). Owner-approved ("we can wire all four", interval default
  // 1 minute). âš  THE DESK IS NOT FLAT ACROSS THIS WINDOW â€” one position is open (opened 2026-10-21T19:33:58Z) â€” so
  // this boundary is stated rather than claimed clean, and it is safe to state BECAUSE NEITHER CHANGE TOUCHES A
  // DECISION: the strategy still reads the same 1h series, built by the same rollup, from the same venue. What
  // changes is the provenance of the rows and whether finer bars survive the write. Protocol applied
  // unconditionally, as always, because trading/** changed.
  // RE-DECLARED 2026-10-23T14:20:00Z â€” `trail-require-path-fixed` (registration above). A one-level wrong require
  // threw inside the trail-calibration branch for three days, after the desk had typed the stop into the venue
  // ticket and before Update was pressed. 43 "Cannot find module" failures measured. The fix restores the
  // behaviour the 2026-10-20 registration intended; the window is restarted because three days of a silently dead
  // exit rule must not be pooled with a window where it ran.
  // RE-DECLARED 2026-10-23T14:45:00Z â€” `black-swan-single-source-and-repeat-fire` (registration above). The
  // detector fired 29 times on a yahoo-only gap that the venue contradicted by 13 points, announced a crash that
  // did not happen, and claimed a white-paper regeneration the budget cap had blocked. Alerting and content path
  // only; no decision input reads it. Window restarted because the alert log inside it cannot date a refresh.
  // RE-DECLARED 2026-10-24T05:25:00Z â€” `exit-geometry-target-and-lock` (registration above). THE FIRST BOUNDARY
  // THAT MOVES THE EXIT GEOMETRY ITSELF: the declared target goes 1.5R -> 3.0R and the trail engage goes
  // lock .75/trail .15 -> lock 1.50/trail .35. Owner-approved on the weekend, before the open, explicitly to
  // avoid disturbing the week's sample. Every prior boundary was provenance or alerting; this one changes what
  // every ticket carries, so the window before it and the window after it are NOT poolable and the boundary is
  // stated at a time, not a date.
  // RE-DECLARED 2026-10-25T15:50:00Z â€” `calendar-sync-scheduled` (registration above). `agent/calendar` was
  // built in September with no scheduled caller, so the import only ran when a UI button was pressed and the
  // table still held two rows from 2026-09-15/16. Purely additive content: it restores context the chairs were
  // supposed to receive and had not for five and a half weeks. No gate, no threshold, no decision input â€” a
  // `macro` row is `scheduledEvents` context, never an entry lock (sessions.js, revised 2026-09-15).
  // RE-DECLARED 2026-10-25T18:10:00Z â€” three registrations above, all owner-decided on the same message:
  // `account-reset-ledger` (the era boundary becomes a recorded fact), `venue-pnl-withheld` (the column that sums
  // can no longer produce an answer 20x the account's real movement), and `exit-target-offset-zeroed` (the live
  // target moves 2.82R -> 3.00R). âš  THE THIRD ONE IS A REAL GEOMETRY CHANGE and the other two are record-keeping;
  // they share a boundary because they were decided together, not because they are alike. The window before this
  // instant carries 2.82R tickets and a summable venue P&L; the window after carries 3.00R and a clean ledger.
  // RE-DECLARED 2026-10-25T19:15:00Z â€” `news-time-range-destroyed-dates` (registration above). The news feed was
  // inserting ZERO for days and every stored item was undated; the cause was the `time_range` parameter we were
  // sending, which narrows the query to engines that implement time filtering â€” and the only one here never dates
  // its results. Content-only lane: no risk, sizing, stop or entry input reads it.
  // RE-DECLARED 2026-10-26T01:15:00Z â€” `econ-calendar-capture` (registration above). A new write-only ledger plus
  // the sweep that fills it. No consumer, so no decision input moves; the boundary is restated because trading/**
  // changed and the protocol is unconditional. NOTE THE DATE: the machine clock is 2026-10-26T01:04Z while the
  // operator's working day is the 26th, so this boundary and the entry above carry UTC days either side of the
  // change â€” deliberate, and the reason `at` is a timestamp rather than a date.
  // RE-DECLARED 2026-10-26T16:30:00Z â€” `pause-latch-truthfulness` (registration above), and the first change
  // accompanied by the architural guard rather than only a registry row: `test/architecture-conformance.test.js`
  // now fails the build if the latch gains a second writer, if a per-instrument fact is re-derived outside
  // `instruments.js`, or if a new append-only ledger is added without a dedupe hash. See
  // `docs/adr/ARCHITECTURE-DECISIONS.md` (ADR-0002) and `AGENTS.md`. No decision input changed; window restarted
  // because trading/** changed and because the pause-duration semantics in the record changed with it.
  // RE-DECLARED 2026-10-26T21:25:00Z â€” `doc-drift-corrections` (registration above). Comments and tests only; no
  // dial, gate or level moves. âš  The window is restarted because `trading/**` changed, and because the entry publishes
  // a finding rather than fixing it: eleven runtime citations still name deleted `temp/` scripts, so the provenance of
  // several live policy numbers is now a claim whose producer is gone. That is recorded, ratcheted, and NOT resolved
  // here.
  // RE-DECLARED 2026-10-26T23:44:00Z â€” `boundary-audit-sees-schema` + `constraint-reconcile-boot-catchup`
  // (both registered above). Neither touches a dial, gate or level: a reporting source and a read-only timer.
  // âš  The window is restarted anyway, for the reason this file has always given â€” `trading/**` changed â€” and
  // because the two entries ENCODE A DEFECT rather than merely a change: a migration landed across the previous
  // boundary without the guard being able to name it. A window whose own audit could not see one class of change
  // is not a window worth pooling.
  // RE-DECLARED 2026-10-26T23:54:00Z â€” `pool-sql-handle-guard`. The window opened at 23:44Z and was broken four
  // minutes later by the fix for a defect in one of the entries that opened it: the boot catch-up's throttle could
  // not read its own event log, swallowed the reason, and would have run on every boot for ever while reporting a
  // plausible cause. Registered, fixed, and restarted exactly as the guard's fix line says. No dial, gate or level.
  // RE-DECLARED 2026-10-26T23:57:00Z â€” `supersession-retires-a-candidate`. Found while writing the dating plan: the
  // resolver would have made every corrective version a permanent block. No dial, gate or level moved; the window
  // restarts because `trading/**` changed.
  // RE-DECLARED 2026-10-27T00:09:00Z â€” `assessability-floor-from-epochs`. New optional parameter and a new pure
  // module; nothing consumes the resolver, no dial, gate or level moved. Window restarts because trading/** changed.
  // RE-DECLARED 2026-10-27T13:26:00Z â€” `fx-per-pair-generalisation`. No dial, gate or level moves and no derived
  // value changes today (no instrument currency is recorded, so the basis is `assumed_default`); the window restarts
  // because trading/** changed and because the shape of the FX result did.
  // RE-DECLARED 2026-10-27T13:36:00Z — `unit-amount-label-captured`. A provenance column and the selector that
  // fills it; no dial, gate or level. Window restarts because trading/** changed.
  // RE-DECLARED 2026-10-27T13:38:00Z — `ownership-registry-gap-closed`. A classification table plus the two
  // documents that must agree with it. No dial, gate or level.
  // RE-DECLARED 2026-10-27T13:42:00Z — `constraints-dated-bounded-era`. A data backfill plus its script; no dial,
  // gate or level, and nothing reads the resolver yet. Window restarts because trading/** changed.
  // RE-DECLARED 2026-10-27T14:17:00Z — `smoke-runs-on-a-live-desk` + `audit-skips-dot-directories`. A config
  // override, a test harness and which files the audit reads. No dial, gate or level moves.
  // RE-DECLARED 2026-10-27T14:35:00Z — `constraint-audit-consumer`. A read-only reporter, no timer wired, no dial,
  // gate or level. Window restarts because trading/** changed.
  // RE-DECLARED 2026-10-27T14:59:00Z — `scoped-assessment-and-entry-instant`. A second assessment function, a
  // consumer switch, and a corrected instant. No dial, gate or level; `assessSubject` untouched.
  // RE-DECLARED 2026-10-27T15:07:00Z — `constraint-audit-window-and-timer`. A reporter's population, its cap
  // reporting and its schedule. No dial, gate or level.
  // RE-DECLARED 2026-10-27T15:40:00Z — `analyses-notes-writer-guard`. A write-side dedupe guard plus migration 054.
  // No dial, gate or level; the table has no consumer.
  // RE-DECLARED 2026-10-27T17:50:00Z — `registry-refresh-and-cost-age`. The refresh set, its success criterion, and a
  // staleness clause in the chair prompt. NOTE THIS ONE MOVES CHAIR INPUT, see its `invalidates`.
  // RE-DECLARED 2026-10-27T19:40:00Z — `record-truth-batch`. Comments, plus one output key removed from a
  // verification script. No dial, gate, level, prompt or record shape.
  // NOTE ON THE VALUE: first written as 19:45:00Z, which was an over-estimate of when the edits would land. The last
  // edit was 19:38, so the window opens at 19:40. Recorded because a boundary that drifts by guesswork stops being a
  // boundary — if this ever has to move again, the reason must be a change, not an estimate.
  // RE-DECLARED 2026-10-27T19:47:00Z — `probe-verdict-truthful-ok`. What `ok` means on two authenticated routes and
  // one CLI. No dial, gate, level, prompt, schedule or record shape.
  // RE-DECLARED 2026-10-27T20:46:00Z — `cost-basis-one-number`. What the chair is told a round trip costs, plus the
  // check that keeps the curated table honest. MOVES CHAIR INPUT, see `invalidates`.
  // RE-DECLARED 2026-10-27T21:06:30Z — `titles-not-rederivable`. A comment recording a measurement; no code path
  // changes. ⚠ THE RESIDUAL IT NAMES IS OPEN: 5 of 40 weekly captures hold an instrument page.
  // RE-DECLARED 2026-10-27T21:19:00Z — `trade-venue-instrument-id`. A nullable column and an optional argument; no
  // existing row or verdict changes.
  // RE-DECLARED 2026-10-27T21:26:00Z — `trade-instrument-id-from-chart`. One extra read per order and one more field on
  // the fill and the row. No dial, gate, level, prompt or schedule.
  at: '2026-10-27T21:26:00Z',
  note: 'The owner froze the policy set so a forward sample can accumulate under ONE rule set. Any change after '
      + 'this instant invalidates the window that follows it â€” including changes that look like improvements, '
      + 'which is the whole difficulty: every one of the seven boundaries above looked like an improvement. '
      + 'Re-declared SIX TIMES on 2026-10-02: (1) at 05:00Z for `bundle-stable-first`; (2) at 06:20Z for '
      + '`health-repair-fallback`, the owner-approved A1 recovery fix; (3) at 07:05Z after the guard\u2019s first '
      + 'LIVE catch â€” a transient account-poller baseline flash (TRD-RSK-17), not a deliberate change; (4) at '
      + '07:25Z for the crisis-kill release plus `account-switch-confirmation`, the fix that answers the catch; '
      + '(5) at 07:33Z for `venue-close-fill-derivation` plus the EXE-13 record correction (key live since 10-01); '
      + '(6) at 08:00Z for `whitepaper-force-refresh` + `capture-evaluate-timeout`. '
      + 'One registered change costs one window restart, paid deliberately while the era is hours old instead of '
      + 'weeks. '
      + 'â˜… RE-DECLARED A SEVENTH TIME 2026-10-08T00:52:00Z â€” THE PLANNED LIFT, NOT A BREACH: the #1506 re-take ran '
      + '(profit rule re-verified at n=140+: fragility unchanged â€” the sign still flips on removing #1093 â€” so it '
      + 'stays NOT adopted) and the owner-directed T2 bundle executed at the boundary 2026-10-08T00:45:50.735Z '
      + '(registered above as `t2-freeze-lift-bundle`; one window carries four writes: PRU-1 scope x4 + EXI-1c floor '
      + '+ chair shape (b) + era re-anchor). The 10-02â†’10-08 window is CLOSED (that era: 62 closed trades â€” '
      + 'measured, done, not pooled with anything). The post-T2 era opens here; the guard now audits from this instant. '
      + 'â˜… RE-DECLARED AN EIGHTH TIME 2026-10-08T01:24:40Z â€” THE T2.5 FORENSICS WINDOW, executed deliberately: the '
      + 'T2.5 abort (00:52Z, venue read-back guard refused a Silver trail pre-write) was forensically answered with '
      + 'READ-ONLY instrumentation (`trail-probe-ticket-state`: optional stopPrice/size ticket-state inputs + counts '
      + 'override on the existing curve probe) and a measured DATA CORRECTION (`silver-pip-offset-remeasure`: offset '
      + '0.052â†’0.078, pip 0.001 and both clamps reconfirmed across six sweeps). Deploys 01:14Z/01:16Z (pid 50864); '
      + 'the automation\u2019s own config flip (enable 01:20:07Z â†’ revert 01:22:37Z reads) rides the same window, as '
      + 'the protocol\u2019s Â§AUTOMATION states. T2.5 verification then PASSED on #1288 Silver (placed:true, not '
      + 'degraded). The 00:52â†’01:23Z fragment (~31 min, effectively no closes) is a forensics fragment and must not '
      + 'be pooled; the post-T2 era accounting continues from this instant. '
      + 'â˜… RE-DECLARED A NINTH TIME 2026-10-08T01:54:26Z â€” THE OWNER-AUTHORISED STAGED BUILD (option 2, build-only): '
      + 'TRD-TRL-9/10/11 landed and deployed 01:53:33Z (pid 55796) with EVERY behaviour switch FALSE (engageOnTouch '
      + 'enabled:false; trail stays OFF; the new route is read-only `commit:false` only). The shadow monitor and '
      + 'pip sampler run read-only beside the desk. The 01:24â†’01:54Z fragment (~30 min) contains the staged build\u2019s '
      + 'landing and must not be pooled; the first live engage remains deliberately HELD for the owner walkthrough. '
      + 'The post-T2 era accounting continues from this instant. '
      + 'â˜… RE-DECLARED A TENTH TIME 2026-10-08T05:28:19Z â€” THE TRD-PRU-3 READ-ONLY CANDIDATE SCREEN (owner ask: a '
      + 'winners-profile intake that touches nothing). Navigation-only route `POST /orders/instrument-screen-probe` '
      + 'deployed 05:27:35Z (pid 25228); no ticket, no order, no settings write, no decision input â€” the live scope '
      + 'and era clock are untouched by construction. The 01:54â†’05:28Z fragment contains the staged-build telemetry '
      + 'window and must not be pooled; the post-T2 era accounting continues from this instant. '
      + 'â˜… RE-DECLARED AN ELEVENTH TIME 2026-10-08T05:31:16Z â€” TRD-PRU-3b, the per-symbol chart backfill read '
      + '(`POST /orders/instrument-bars-probe`, focus-only; series + interval-verdict fields), deployed 05:30:14Z '
      + '(pid 21076) for the candidate-profile study. Read-only again: no decision input, no scope change, era '
      + 'clock untouched. The 05:28â†’05:31Z fragment is a 3-minute deploy gap and must not be pooled. '
      + 'â˜… RE-DECLARED A TWELFTH TIME 2026-10-17T19:20:00Z â€” THE CONTINUITY MERGE (laptop hand-off bundle, '
      + 'owner-directed return-to-service): five behaviour-neutral changes (three env-gated capture-only paths, '
      + 'ALL UNSET on the desk; bringToFront bounded to 3 s; Polygon Yahoo id POL-USDâ†’POL28321-USD, old id 404; '
      + '`expenses` registered in config/servers.json) plus five new read-only recorder/watchdog files (none '
      + 'scheduled on the desk) and docs/10-ARCHITECTURE-NOTES.md. No policy key, no decision input, no scope '
      + 'change â€” era clock untouched by construction; the desk restarted 18:52:43Z to load the code. The '
      + '10-08â†’10-17 span contains the seven-day outage (desk off, 0 TradingEvents) and must not be pooled; '
      + 'post-T2 accounting resumes from this instant. '
      + 'â˜… RE-DECLARED A THIRTEENTH TIME 2026-10-17T19:06:00Z â€” MIRROR CYCLE DEADLINES (owner-directed): the '
      + 'mirror poller\'s venue awaits are bounded (45/20/20/30 s) so a hung evaluate cannot hold the shared '
      + 'bridge lock indefinitely and starve ticket flows (recurring `bridge busy (mirror)`). Read-only beside '
      + 'the desk; no policy key, decision input or scope change; era clock untouched. '
      + 'â˜… RE-DECLARED A FOURTEENTH TIME 2026-10-17T20:05:00Z â€” WATCHLIST QUOTE FAST PATH + CHART ROTATION '
      + '(owner-directed): quotes now read in one watchlist-table read (burst moved to table re-reads, banked '
      + 'before the chart sweep); charts are deadline-bounded per symbol (12 s) and rotated '
      + 'least-recently-charted-first, 5 per wake (~20-30 min per symbol â€” far inside BAR_FRESH_MS 4 h; each visit reads the '
      + 'full series, so no bar gaps). Same venue/source for prices; no policy key, no scope change.',
};

// âš  EVERY ENTRY INVALIDATES SOMETHING. An entry that says only "we shipped X" is a changelog; the `invalidates`
// field is the part a reader needs, because it says what a number computed from earlier rows CANNOT mean.
//
// `landedAt` is the date the behaviour changed, not the date the row was filed â€” where those differ, the row's own
// closure note is the source. `row` is the task id, so the claim is checkable in `Tasks`.
const FEATURES = [
  {
    id: 'stop-cap',
    landedAt: '2026-09-19',
    row: null, // TRD-98 / TRD-102 predate the rows this session worked; the code carries the dates.
    title: 'The venue stop is CAPPED, and the size is computed against the capped distance',
    invalidates: 'Trades before this carry UNcapped geometry: their `stopPrice` is the declared 2xATR, so a reward:risk computed from them describes a stop the venue never received. TRD-102 also changed the SIZE against the capped distance, so per-trade risk before and after this date are different quantities.',
  },
  {
    id: 'policy-epoch',
    landedAt: EPOCH,
    row: null,
    title: 'The current policy set begins',
    invalidates: 'Everything before it is a different regime. This is the boundary the owner has ruled on three times; a measurement spanning it reports a mean of two systems.',
  },
  {
    id: 'scope-fix',
    landedAt: '2026-09-25',
    row: 1368, // TRD-116
    title: 'Scope and `enabled` agree; six explicitly EMPTY scope lists were the real blocker',
    invalidates: 'Per-symbol activity before this date is a scope artefact, not evidence about the strategy: several instruments could not fire at all, so "that symbol never traded" says nothing about its edge.',
  },
  {
    id: 'replicas',
    landedAt: '2026-09-25',
    row: 1410, // TRD-COV-1
    title: 'Ten replicas of the two survivors across five instruments',
    invalidates: 'Before this, only `survgold` and `survoil` existed. Any claim about the other instruments has NO live history before this date, and a replica is not a claim that the strategy works there.',
  },
  {
    id: 'tp-offset',
    landedAt: '2026-09-25',
    row: 1412, // TRD-TP-1
    title: 'The venue take-profit is pulled in by 5% of its own distance',
    invalidates: 'Trades before this had an un-offset target, so their fill/near-miss behaviour is not comparable â€” and the offset was later shown to make expectancy slightly WORSE once the target anchor is corrected.',
  },
  {
    id: 'chart-interval',
    landedAt: '2026-09-25',
    row: 1408, // TRD-GRD-6
    title: 'The chart interval is MEASURED beside the layout claim, and sub-1h reads roll up to 1h',
    invalidates: 'Before this, the `timeframe` and `sourceIntervalSec` labels on `PriceBars` rows written from the chart are not trustworthy â€” the tab decided them, and a 15m tab wrote 15m rows while the only structure venue read 1h and received nothing.',
  },
  {
    id: 'chair-persona',
    landedAt: '2026-09-25',
    row: 1416, // TRD-DEL-1
    title: 'The resolved chair persona is reported (`personaSource`) and shown in the panel',
    invalidates: 'Before this, chair votes have no `personaSource`, and the panel rendered every seat as "seat default" â€” so a reader cannot tell a configured seat from an inherited one in older decisions.',
  },
  {
    id: 'chair-gets-account',
    landedAt: '2026-09-25',
    row: 1413, // TRD-LLM-2
    title: 'The bundle carries the account strip and the risk parameters',
    invalidates: 'Before this, a chair was never told equity, available funds or any risk parameter, and the sizing line stated a formula that did not bind. Earlier chair reasoning about size was therefore about rules it could not see.',
  },
  {
    id: 'chair-sees-panel',
    landedAt: '2026-09-25',
    row: 1414, // TRD-LLM-3
    title: 'The quant panel votes are shown to the seats as facts with their bases',
    invalidates: 'Before this, a seat voted without the panel while the RECORD held both â€” so an older decision read by a human shows a panel the seat never saw.',
  },
  {
    id: 'one-wake-one-event',
    landedAt: '2026-09-27',
    row: 1419, // TRD-WAK-1 / WAK-2
    title: 'A wake writes ONE event (the aggregator stopped writing its own)',
    invalidates: 'âš  ANY EVENT COUNT OVER A RANGE COVERING THIS DATE IS DOUBLED FOR THE EARLIER PART: 815 of 1,426 wakes wrote a duplicate pair, one wrote five. A count that clusters by the second is safe; a raw `COUNT(*)` is not.',
  },
  {
    id: 'veto-codes',
    landedAt: '2026-09-27',
    row: 1418, // TRD-RSK-2
    title: 'The risk gate emits machine-readable `vetoCodes` beside the prose',
    invalidates: 'Before this, a refusal carries prose ONLY, so `vetoCodes` is null and the cause has to be read out of a sentence â€” which is how the cost ceiling was once named for a correlation veto.',
  },
  {
    id: 'bars-non-fatal',
    landedAt: '2026-09-27',
    row: 1420, // TRD-BAR-1
    title: 'A failed bars/tick-retention step no longer aborts the wake, and records `barsError`',
    invalidates: 'Before this, any wake whose `failedStep` is `bars` evaluated NO exits and NO position review: it is a LOST WAKE, not a wake with a failed step. Open-position oversight counts over such a range are understated.',
  },
  {
    id: 'binding-clamp-disclosed',
    landedAt: '2026-09-27',
    row: 1413,
    title: 'The bundle names the risk dial that ACTUALLY binds, and every refusal rule',
    invalidates: 'Between 2026-09-25 and this correction the prompt stated `size = equity x riskPerTradePct% / stop` while `maxRiskPerTradePct` (0.07%) always overrode it â€” so chair reasoning in that window is about a rule 28x larger than the one in force.',
  },
  {
    id: 'pre-epoch-pruned',
    landedAt: '2026-09-27',
    row: 1422, // TRD-DAT-1
    title: 'Pre-epoch telemetry archived and removed from the live tables',
    invalidates: '`TradingEvents`, `ShadowSignals`, `QuarantinedTicks` and `TradingAlerts` have NO rows before 2026-09-21. A historical count from those tables now reads zero rather than "small" â€” the archives are in `trading/archive/pruned/`.',
  },
  // âš âš  THE REGISTRY WAS ELEVEN DAYS STALE, AND IT WAS STALE EXACTLY WHERE IT COSTS THE MOST: SIZING.
  //
  // Every entry below landed after the previous newest entry (2026-09-27) and NOT ONE was registered, so a study
  // scoped by this file still pooled four different sizing rules and reported one number. The R-multiple study that
  // produced "the desk is roughly break-even at -0.042R/trade" did exactly that.
  //
  // âš  AND WHY NOTHING CAUGHT IT: this file's own header named a guard â€” "`assertRegistryCoverage` ... fails when a
  // task row that CLOSED carries a landing date newer than the newest entry" â€” **and that guard DOES NOT EXIST.**
  // It is a comment. `test/epoch-registry.test.js` cannot fail on a missing boundary because it never looks for
  // one. A documented safeguard that was never built is worse than an absent one: it is the reason nobody looked.
  // (A check is now possible: ~10 sizing/risk task rows closed on 2026-09-30 alone.)
  {
    id: 'sizing-venue-step',
    landedAt: '2026-09-30',
    row: 1463, // TRD-EXE-3, completedAt 2026-09-30
    title: 'The size is SNAPPED to the venue\u2019s tradable increment, and a recovery stops adopting the desk\u2019s own queued order',
    invalidates: 'Per-trade size before and after this date are DIFFERENT QUANTITIES. The desk submitted unsnapped sizes and the venue snapped them (measured 11.9862 -> 15, +25.1%), so a realised risk or an R-multiple computed from earlier rows describes a position the desk did not size. TRD-EXE-4 rides the same date: the adoption path used to adopt the desk\u2019s own order as a stranger.',
  },
  {
    id: 'tp-offset-6',
    landedAt: '2026-09-30',
    row: 1412, // TRD-TP-1 (the row for the offset); the 5%->6% move is settings_write #141101
    title: 'The take-profit offset moved 5% -> 6% of its own distance',
    invalidates: 'THREE DIFFERENT TARGETS sat inside one week: none before 2026-09-25, 5% from 09-25, and 6% from 2026-09-30T10:29:08Z (settings_write #141101). âš  The `tp-offset` entry above still says 5% and is now WRONG about the live value â€” a registered feature whose parameter drifted is a boundary a reader crosses while believing the entry describes today.',
  },
  {
    id: 'pointvalue-notional',
    landedAt: '2026-10-01',
    row: null, // no task row was filed for the sweep
    title: 'NOTIONAL includes the instrument\u2019s pointValue, so a cents-quoted contract is no longer 100x over-stated',
    invalidates: 'The per-position notional cap, the exposure budget and the margin guard were all computed WITHOUT pointValue. Soybeans quotes in cents (pointValue 0.01), so its notional was 100x too large: the 35% cap bound at 0.69 instead of ~89, fell under the venue minimum, and the desk refused every entry â€” while reporting the arithmetic error as a VENUE FACT ("the minimum is ~487% of equity"). A size or a CAP REFUSAL from earlier rows is an artefact of a missing factor, not a statement about the instrument.',
  },
  {
    id: 'size-contract-scale',
    landedAt: '2026-10-02',
    row: null, // TRD-EXE-19 has NO task row
    title: 'The SIZE derivation applies the contract scale (fx x pointValue), not just price x distance',
    invalidates: '\u26a0\u26a0 THIS IS THE RISK UNIT ITSELF. Before it, a size was derived as `(equity x risk%) / stopDistance` with NO contract scale, so a cents-quoted instrument sized ~77x TOO SMALL (measured A/B: 0.7228 -> 75.0000 bushels, venueFloor `below_venue_minimum` -> `above_venue_minimum`). **Any R-multiple, realised-risk or expectancy pooled across this date averages two DIFFERENT DEFINITIONS OF ONE R.** This is the boundary the profit-rule study crossed.',
  },
  {
    id: 'fill-anchored-stop',
    landedAt: '2026-10-02',
    row: null, // TRD-EXE-14, armed by settings_write #171284 at 2026-10-02T01:23:38Z
    title: 'The exit-level anchor moves to the FILL (EXE-14) for every non-frozen strategy',
    invalidates: 'From this date a non-frozen entry\u2019s stop and target are SHIFTED to the venue fill, so realised R:R equals the declared one by construction rather than by luck (measured before: #1151 and #1125 each carried a realised R:R of 0.652 against a declared 1.5). A realised-R:R distribution pooled across this boundary mixes two exit geometries. FROZEN strategies (`survgold`/`survoil`, TRD-29) are HELD and deliberately do not change.',
  },
  {
    id: 'instrument-reach',
    landedAt: '2026-10-01',
    row: null,
    title: 'Instrument category mapping completed, so a symbol is reached by its CATEGORY page and not only by the search fallback',
    invalidates: 'Before this, a symbol with no `SYMBOL_CATEGORY` entry could ONLY be reached by the search fallback, whose click is an UNSCOPED `document.querySelector(\'.button-buy\')` on a page carrying 22 of them (measured 2026-10-02). Four Natural Gas attempts on 2026-10-01 failed as `order ticket did not open` for this reason, not for any market reason â€” so per-symbol activity before this date is a REACH artefact and says nothing about the instrument. âš  The date is the session in which the mapping was deployed; the first VERIFIED reach is 2026-10-02.',
  },
  {
    id: 'bundle-stable-first',
    landedAt: '2026-10-02',
    row: null, // owner-approved S1 (docs/llm-cache-attribution-and-stable-first-2026-10-02.md); no task row â€” registered at deploy, after the guard flagged the freeze
    title: 'The chair bundle is reordered STABLE-FIRST: byte-stable sections precede every per-wake value',
    invalidates: 'âš  ORDER-ONLY â€” not one byte of content was changed, but the seats read the same facts in a different sequence, and reordering is NOT provably behaviour-neutral (TRD-78 says so explicitly). What it invalidates is the CACHE comparison: the measured cross-wake reusable prefix grew from ~171 to ~3,029 tokens (mean over 15 consecutive wakes), so a cache-miss or prompt-order number pooled across this date mixes two orders. Registered together with the window restart below, per the guard protocol (register AND restart, or revert).',
  },
  {
    id: 'health-repair-fallback',
    landedAt: '2026-10-02',
    row: null, // owner-approved recovery fix after the day's second A1 lockout; no task row â€” registered with the window restart per the guard protocol
    title: 'The A1 selector-health check can recover a shared tab parked OFF the trade route: the repair falls back to a direct category navigation',
    invalidates: 'âš  RECOVERY-PATH ONLY â€” no decision input changed (sizing, gates and prompts are untouched). What it invalidates is the FAILURE record: before this date the one-shot repair (`gotoPage(page,\'trade\')`) navigated to a URL the SPA redirects back to the remembered trade route, so a tab parked on a table-less page (the mirror parks on `/open-positions`; probes park there by design) made the repair a NO-OP and the desk could latch the UI Fallback Pause with no human action available â€” two lockouts happened on 2026-10-02 itself (02:55â†’04:12Z, healed by an unidentified navigation; 05:35Zâ†’cleared only by this fix). A capture-failure window after those dates is NOT evidence of a market or venue condition. Registered together with the window restart below, per the guard protocol.',
  },
  {
    id: 'account-switch-confirmation',
    landedAt: '2026-10-02',
    row: 1503, // TRD-RSK-17 â€” the guard's first live catch (06:54Z baseline flash); owner-approved fix, landed with the window restart per the guard protocol
    title: 'An account switch must persist across consecutive strip reads before it can re-base anything; a single wild read becomes account_flash telemetry',
    invalidates: 'âš  TELEMETRY/BASELINE HANDLING ONLY â€” no decision rule changed, but before this date ONE wild `#accountStatus` read could re-base `day_start` and BOTH equity baselines (measured 06:54:02Z: a 6-second latch to the real-money account level 22.28, self-corrected 06:54:08Z). An account_switch row before this date cannot be assumed to have persisted across reads, and a resolved unconfirmed read is now logged as `account_flash` (from/to/heldMs). Registered together with the window restart below, per the guard protocol.',
  },
  {
    id: 'entry-drift-sizing',
    landedAt: '2026-10-01',
    row: null, // TRD-EXE-13 has no task row; the switch is an owner key (P3, application-plan-2026-10-01)
    title: 'Sizing models the measured ENTRY drift (risk.entryDriftFactor = 1.083): sizes run ~8% smaller than the dial alone implies',
    invalidates: 'âš  POSTURE CHANGE â€” registered 2026-10-02 against a RECORD CORRECTION: the plan describes EXE-13 as "built INERT by default" and "switching it on is one key", but the key was ALREADY SPENT at 2026-10-01T00:30:55Z (settings_write #152809, null -> 1.083) and every decision since 01:17:37Z carries the drift term in its sizeCalc (measured on #1208: expectedLossDistance 28.5843 = stop 20.225 x 1.305 x 1.083). So sizes since 10-01 00:30Z are ~8% smaller than the review assumed, compounding with stopSlippageFactor 1.305; any size or risk-per-trade number pooled across that instant mixes two sizings. No code changed on 10-02: this entry corrects the REGISTRY, not the desk.',
  },
  {
    id: 'venue-close-fill-derivation',
    landedAt: '2026-10-02',
    row: 1499, // TRD-PNL-6 residual
    title: 'A venue close derives its FILL across currencies from the stamped fx rate nearest the close (the refusal is retired)',
    invalidates: 'âš  RECORDING ONLY â€” no decision input. Venue closes now store a converted `closeFillPrice` where the currencies differ and a stamped rate exists (`fxAtClose`: nearest sample AT OR BEFORE the close); before this date such rows stored NULL. A slippage/exit-quality number pooled across this date mixes derived fills with NULLs. Validation on the venue own worked row: #1148 derives 61.204978 against the close rate 61.205 at fx 1.2865.',
  },
  {
    id: 'whitepaper-force-refresh',
    landedAt: '2026-10-02',
    row: 1502, // TRD-WP-1
    title: 'White-paper force path: Generate now and the black-swan path can REWRITE a current-period tier (force bypasses the period gate; the auto wake path stays throttled)',
    invalidates: 'âš  CONTENT PATH â€” no decision input VALUES change, but a paper written after this date may have been REWRITTEN inside its period (manual button or black swan), so `period` no longer implies "unchanged since period start". The chairs read these papers in the bundle, so a forced rewrite moves bundle bytes mid-era.',
  },
  {
    id: 'capture-evaluate-timeout',
    landedAt: '2026-10-02',
    row: 1504, // TRD-EXE-16
    title: 'A capture that cannot return fails NAMED in 90 s (capture_timeout) and discards the wedged page, instead of holding pageLock forever on a half-dead CDP session',
    invalidates: 'âš  FAILURE-MODE ONLY â€” captures that used to hang silently now fail counted and self-discard the page. Capture-duration and latch statistics pooled across this date mix the two behaviours; the measured pre-fix hangs were ~8-9 minutes each (reproduced twice).',
  },
  {
    id: 'bridge-park',
    landedAt: '2026-10-03',
    row: null,
    title: 'Operator PARK control: one switch stops every browser-facing loop (scheduled/alert/manual wakes, capture cold-start, mirror cycle, account strip poller, sessionFeed re-attach)',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key (`bridge.*` is outside the guard regex). Landed INSIDE the frozen window with the owner\'s explicit authorisation (2026-10-03), treated as the same class as wake-Pause and the bridge latches. All gates are dormant when unparked (byte-identical behaviour); a PARKED window contains no wakes, no bridge reads and no loop telemetry â€” do not pool a parked window with a live one. The sessionFeed fix also landed here: the silence watch re-attaches ONLY when Chrome is alive; chrome-off/parked are reported states and are no longer â€œrepairedâ€ by launching Chrome (the measured 10-03 auto-restore).',
  },
  {
    id: 'watchdog-login-render',
    landedAt: '2026-10-03',
    row: null,
    title: 'Watchdog login check reads render-independent account evidence (li[automation] cells / strong labels) and waits for the SPA to settle before any death verdict â€” the false "plus500 signed out" pages ended',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the same 2026-10-03 authorization as the park build. The change makes the PAGER MORE TRUTHFUL; trading behaviour is untouched. False `watchdog_login_death` rows before this date were render-timing artifacts of the shared tab (the SPA shell boots for ~2-3 s after every mirror navigation), NOT session events â€” do not read them as logins lost. See docs/incident-2026-10-03-false-login-death.md.',
  },
  {
    id: 'news-aggregator-s1',
    landedAt: '2026-10-03',
    row: null, // open-work 4.19 (TRD-NEW-1 build)
    title: 'News aggregator S1+S2: hourly watchlist-news fetch into NewsItems via the owner\'s SearXNG, plus the deterministic digest endpoint, dashboard panel and content-free toast â€” write-only, NO consumer (nothing reaches a chair; S3 separately gated)',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the owner\'s explicit direction (2026-10-03 "do 3.14 first"). Writes `news_digest` telemetry + `NewsItems` rows only; chairs, budgets, wakes untouched (the `news` budget consumer was ADDED, inert, cap 60,000/day â€” spend begins only with the future classification step). Absence of `news_digest` before this date is "not built yet", not "a quiet feed" â€” the module records NAMED failure reasons per the F1 dead-feed rule (`searxng_unreachable` / `searxng_format_not_allowed` / `searxng_bad_json` / `no_items`). First live cycle 2026-10-03 13:34Z: 10 queries, 12 items, 0 failures. S2 (digest + panel + toast) shipped the same night; the panel carries "not shown to the AI" and nothing here is chair-facing.',
  },
  {
    id: 'hrefmap-guard-and-watchlist-park',
    landedAt: '2026-10-03',
    row: null, // open-work 4.11 + 4.12
    title: 'Two shared-tab hygiene fixes: the hrefMap guard compares CONTENT (no more timestamp-only settings_write churn) and POST /watchlist/open parks the tab back on /open-positions in its finally',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the owner\'s explicit approval (2026-10-03: "11 and 12"). (a) `bridge.hrefMap.at` now means "when the map last CHANGED" â€” journal rows before this date include ~76% timestamp-only noise (313/410 settings_write rows in the 72 h to 10-03); do not read the earlier churn as real changes, and do not read the drop as "less activity". (b) /watchlist/open no longer leaves the shared tab on the opened instrument â€” every consumer already assumed the /open-positions resting state. Strict live acceptance (no settings_write churn \u2265 30 min; tab-URL read) rides the first watched session after the weekend close.',
  },
  {
    id: 'volume-null-and-close-source',
    landedAt: '2026-10-03',
    row: null, // open-work 4.6 (absence fix) + 4.22 (close provenance)
    title: 'Volume absence is published as ABSENT end-to-end (NULL, never the 0 sentinel: capture seeds NULL, the interval rollup sums only when every component is known, the bars UI shows \u2014), and every executor close stamps its caller (`closeSource`: wake:<promptId> / review / api / sweep:kill / pairs:<id>) on the trade row and both close events',
    invalidates: 'âš  TWO CLASSES, both operator-scope â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the owner\'s explicit direction (2026-10-03: "complete 4.6" + "expand 4.22"). (a) CONTENT SEMANTICS: bars/tick `volume` written from this date is NULL when the feed omits it (previously 0) â€” a pooled pre/post volume or volume-derived statistic mixes real zeros with absences; interval rollups before this date could publish a partial sum as if complete. obv\'s all-constant guard was already live since 09-23. (b) TELEMETRY ONLY: `Trades.closeSource` (migration 046) â€” rows closed before this date carry NULL by design; the trade note stays byte-identical (`executor close`), so nothing downstream of notes changes. The completeness pin (test/close-provenance.test.js) makes a future 7th caller that forgets `source:` fail the suite.',
  },
  {
    id: 'premium-analyses-ledger',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 P0)
    title: 'Plus500 Premium-analyses collection ledger (TRD-PRM-1 P0): write-only tables AnalysesNotes + AnalysisLevels, append-only, first rows loaded from the owner screenshots â€” NO consumer, nothing chair-visible, nothing acts on it',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Write-only collection for a FUTURE pre-registered study (level/calendar confluence; brief: trading/docs/premium-analyses-integration-brief-2026-10-04.md). LOOKAHEAD RULE: any study may only use levels captured strictly BEFORE the trade it judges. Until the study passes AND a separate pre-registration approves a use, no desk component may read the ledger.',
  },
  {
    id: 'premium-analyses-capture',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 P1)
    title: 'Premium-analyses capture (TRD-PRM-1 P1): daily sweep of the Plus500 analyses pages into the write-only ledger from the desk\'s own logged-in Chrome â€” tryAcquire(\'analyses\') skip-class lock, park-in-finally, regex parse with NAMED failures; NO consumer, nothing chair-visible',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. The capture READS the analyses pages and writes AnalysesNotes/AnalysisLevels only (same class as the P0 ledger seed and news S1). Landed INSIDE the frozen window under the owner\'s direction (2026-10-04). The study clock starts at this ship; the study itself (brief Rev 2 Â§2 P3) remains gated on its own n.',
  },
  {
    id: 'premium-analyses-nav',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 P1 nav fix)
    title: 'Premium-analyses NAVIGATION fix (TRD-PRM-1 P1): the analyses arrive through the trade page\'s InstrumentInsights entry (per-row `InstrumentRow.<id>.Button.Insights`, client-side-only routes â€” hard loads of /insights-instruments/* bounce); the v0-v1.2 route guesses (public /action/inter/marketanalysis language-select page; LI-vs-anchor dispatch) are retired; a blocking platform dialog is dismissed before interacting',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Before this date the capture\'s navigation could not reach the analyses at all (named failures only; one junk no_levels row id 3 remains, append-only). Discovery notes: the insights entry is `a#InsightsNav[data-testid=NavigationBar.Button.InsightsNav.Open]` INSIDE its LI; real pointer events required (synthetic events on the LI are no-ops); `.offsetParent` is NULL for fixed-position elements. Nothing reads the ledger.',
  },
  {
    id: 'premium-analyses-vision',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 vision extension, owner-directed)
    title: 'Premium-analyses VISION lane (TRD-PRM-1 extension, owner-directed 2026-10-04): per-view screenshot fed to the LLM (DeepSeek vision verified live HTTP 200) for chart/annotation extraction, stored as its OWN append-only source (`capture-vision`) with model + promptVersion stamped; deterministic regex parse stays the PRIMARY evidence; own budget consumer `analyses-vision`',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. The vision lane is NON-DETERMINISTIC evidence (LLM extraction) kept separate from the deterministic text lane and from the founding owner-screenshot rows; the pre-registered study (brief Rev 2 Â§2 P3) may only consume it via a further dated pre-registration. Cost: 1 vision call per view (~1.1k prompt tokens measured on a downscaled test image); capped by the `analyses-vision` budget consumer.',
  },
  {
    id: 'bridge-no-last-tab-close',
    landedAt: '2026-10-05',
    row: 1511, // TRD-BRG-1 â€” the Chrome churn / sign-out loop
    title: 'Wedged-capture recovery recycles the bridge tab by SWAP instead of closing Chrome\'s last tab (TRD-BRG-1 #1511): fresh tab FIRST, then close the wedged one; a 17-exit desk-caused Chrome churn loop is retired',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Bridge lifecycle only. TRD-EXE-16\'s timeout path called page.close() on the SHARED bridge tab, which is normally Chrome\'s ONLY tab â€” so every wedged capture sweep EXITED Chrome cleanly (no crash dump, no WER event), dropping the bridge for every consumer and risking the venue session: measured 2026-10-05, 17 desk-caused exits across two bursts (wakes ~10 min â†’ sweep â†’ wedged page.evaluate â†’ 90 s timeout â†’ close â†’ exit). Now: fresh tab first (raced 8 s), close second, never the last tab; if the swap cannot start, close NOTHING. Trading behaviour untouched; pooling may continue.',
  },
  {
    id: 'mirror-nav-reduction',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Bridge navigation-traffic reduction (TRD-BRG-1 #1511, soft-nav scout): the mirror parks ONLY when off-park (was a full page load every 60 s cycle â‰ˆ 1,400/day) and the venue-alerts mirror is cadence-throttled to 1-in-5 cycles (~5 min); real park navigations are logged (`mirror_park_nav`)',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Bridge lifecycle only. Measured context 2026-10-05: the desk was performing well over 100 full page loads/hour against Plus500 (mirror 2/cycle + wake captures + a ~90 s unexplained tradeâ†’cryptoâ†’park burst under investigation). Soft navigation (in-app route change) was scouted and is NOT available for standard routes â€” crafted AND real anchor clicks, pushState/popstate and menu clicks all produce hard document loads (temp/soft-nav-test*.js); REDUCTION, not soft-nav, is the session-safety lever. Venue-alert mirroring freshness is now ~5 min (was ~60 s); the desk\'s own 15 s crossing watch is unaffected.',
  },
  {
    id: 'venue-ui-testid-detection',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Venue-UI alignment (TRD-BRG-1 #1511): nav detection via NavigationBar TESTIDS (the 2026-10 UI renders icon buttons with no label text â€” text-only checks failed on every route), the demo guard READS the current page first (was goto(\'/trade\') on every call â‰ˆ1,000 navigations/day from the mirror read path â€” the actual ~90 s burst source), and the park prefers the app\'s own nav button (SOFT client-side route change â€” the operator finding that anchors/menu-text click hard-load while NavigationBar.Button.openPositionsNav does not)',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Detection/navigation plumbing only. Measured 2026-10-05: the literal string \'Open Positions\' is ABSENT from innerText even on the rich trade page while 18 NavigationBar testids are present; the parked /open-positions minimal render (213-char innerText) carries NavigationBarÃ—18 + MoreMenu.Item.switchdemorealÃ—2 (textContent \'Switch to Real Money\'), so assertDemo passes in place and the new gate passes from the parked route â€” no repair-navigations, no pause latch. Trading behaviour untouched.',
  },
  {
    id: 'spread-latency-telemetry',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Spread + latency telemetry (owner-approved "additive", corroboration follow-up to the three external reports): Trades gains spreadSignalPct / signalTickAgeSec (desk tick bid/ask nearest the decision), spreadSubmitPct / spreadSubmitSource (the venue ticket\'s own Buy/Sell read inside placeOrder â€” NO navigation), signalToFillSec (decisionâ†’fill seconds; the audit\'s 31.1 s avg, 132 s max made a row fact) and anchorAgeSec (TRD-ANC-1 anchor age at submit, previously event-only)',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Every column NULLable, no backfill (old rows stay NULL = unknown), writes best-effort on existing INSERTs; the placement of these columns means "before 2026-10-05T13:45Z the spread/latency split is unmeasured on the row", not that behaviour changed. Deliberately NOT changed: stop/target/trail/tolerance â€” the policy freeze (#1506) stands.',
  },
  {
    id: 'bridge-state-live-ui',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Live bridge state machine (owner ask: "a live (semi interactive) state machine, fitted inside the trading agent, not a html report"): the machine as DATA (trading/plus500/bridgeStateGraph.js â€” states/transitions/causes/windows) drawn by ONE shared renderer (trading/public/js/bridge-machine.js), mounted in the dashboard Health-area card (compact) and /bridge-state.html (full interactive: node/edge story panels, transition timeline, live signals table); the observer exports bridge-state-graph.json from the module and records STRUCTURED transitions ({at,fromState,state,cause})',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. UI/observability only. âš  THE PICTURE IS PINNED TO THE CODE: test/bridge-state-graph.test.js (17 pins) drives the reducer with one fixture per arrow and asserts destination state + cause â€” an edge that lies fails the suite; the two cannot drift. v0 limitations recorded: the observer\'s `attached` signal can flap for one 10 s sample around a DESK restart (seen live 14:23:57Z, self-recovered by 14:24:17Z via WEDGEDâ†’NAVIGATINGâ†’RESTING) â€” a display transient, not a desk event.',
  },
  {
    id: 'bridge-state-change-stream',
    landedAt: '2026-10-06',
    row: 1511,
    title: 'Change-driven bridge-state stream (owner: "change 5 s ping to \'when it changes state\'"): same-origin SSE `/bridge-state-stream` on the desk pushes the full state on connect + on every state|category|cause CHANGE (fs.watch on the observer\'s bridge-state.json, 300 ms debounce, fingerprint-gated) + a 5-minute snapshot refresh + a 25 s comment keepalive; both machine mounts and the /bridge-state.html diagnostics table ride ONE connection per page; a 30 s poll exists ONLY as a fallback when the stream is unavailable',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input changes, no epoch reset, no policy key. UI plumbing only. Replaces a 5 s poll across two views (~1.4k requests/hr idle) with push-on-change; payload exposure equals the static bridge-state.json it mirrors; modifier-only churn (e.g. feedSilentForMs ticking) does NOT push a state event.',
  },
  {
    id: 'supervise-auto-restart-policy',
    landedAt: '2026-10-06',
    row: 1511,
    title: 'Supervisor auto-restart, ACTUALLY ENFORCED and narrowed (follow-up to the 2026-10-05 silent desk death 13:08â†’13:45Z): `--restart` previously changed only the alert TEXT â€” restartTrading() was never called (an inert control that reported itself ENABLED). New: trading/scripts/supervise-policy.js (pure; 8 pins) + real invocation in supervise.js; the scheduled task passes --restart; restart ONLY when the desk is PROVABLY GONE (state down + crash-guard heartbeat pid dead), NEVER for hung/wedged (killing a live desk can strand an order), 10-minute backoff; "held" reasons are stated in the alert',
    invalidates: 'âš  OPERATOR-SCOPE â€” no policy keys, no era reset; supervision plumbing only. Behaviour change confined to the failure path: a desk that has PROVABLY vanished is now restarted within ~5 min instead of waiting for a human (the 10-05 outage cost 37 min); a live-but-sick desk still pages instead. First scheduled run with the new wrapper: 2026-10-06 00:25Z, result 0.',
  },
  {
    id: 'desk-mirror-ui',
    landedAt: '2026-10-06',
    row: 1511,
    title: 'Desk mirror UI (owner: "creating the dynamic UI mirror to the plus500 desk"): trading/scripts/mirror-export.js (read-only DB exporter, 4 s, detached) â†’ trading/public/desk-mirror.json â†’ trading/public/desk-mirror.html (live open positions with P&L/stops, account strip, last-24h closes + realized total, recent fills WITH the new spread/latency telemetry, era counter); dashboard Health-card link; the page fetches only while its tab is visible',
    invalidates: 'âš  OPERATOR-SCOPE â€” no decision inputs, no epoch reset, no policy key. Payload is the same public class as bridge-state.json; the page is a renderer over a public JSON. Nothing writes to the desk or the venue.',
  },
  {
    id: 't2-freeze-lift-bundle',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'T2 freeze-lift bundle (owner decision C executed; boundary 2026-10-08T00:45:50.735Z): (1) PRU-1 scope-only prune â€” symbolScope SGX/Sugar/Bitcoin/"Arabica Coffee" -> [] (journal #237651 changed:4); (2) TRD-EXI-1c near-stop cut floor 0.30 -> 0.20 (journal #237653 + code defaults exitPolicy.js/store.js; Sec 3.3 window started); (3) chair leaves the entry path â€” owner shape (b), deliberation.chairs: [] (journal #237654; chairsResolved derived-empties; risk gate + exits untouched); (4) era re-anchor at the first write + watchers re-armed',
    invalidates: 'âš  THE ERA BOUNDARY â€” the first sanctioned policy change after the 2026-10-02 freeze; opens the post-T2 era at 2026-10-08T00:45:50.735Z (n=30 clock restarts; earlier eras must NOT be pooled across it). FOUR WRITES RIDE ONE WINDOW â€” per-change attribution is LOST unless a change gets its own era (accepted deliberately; PRU-1 n>=60 kill rule and EXI-1c Sec 3.3 clock â€” first 25 permitted cuts OR 30 trading days â€” both run on this window; chair watched via entry-mix + attribution counts). Tests 1/2 restart at this boundary (dated revisions: pre-registration-2026-10-01 + PRU-1 Sec 8 + EXI-1c). The trail (TRD-TRL-2 / lock075_t15 candidate) is deliberately NOT bundled â€” its own T2.5 watched verification (automation armed) gates it. The #1506 re-take verdict: profit rule stays NOT adopted (fragility unchanged) â€” no profit-rule change rides this boundary.',
  },
  {
    id: 'trail-probe-ticket-state',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'TRD-TRL-8 read-only probe instrumentation (T2.5 abort forensics, 2026-10-08T00:49Z Silver read-back 0.65 vs 1.26): `probeTrailCurve` gains OPTIONAL ticket-state inputs â€” `stopPrice` (CloseAtLoss card engaged via toggleLimit + fillRate) and `size` (amount via the native setter) â€” plus a `counts` override on POST /orders/trail-curve-probe; the repro runner gains `counts= / stop= / size= / label=` args. Purpose: reproduce the ONE state variable every clean sweep lacked (the engaged stop card) and quantify Silver offset drift (measured 0.052 on 09-30 vs ~0.074 today, pip 0.001 confirmed both directions)',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision inputs change, no epoch reset, no policy key; the T2 era boundary stays 2026-10-08T00:45:50.735Z. The probe WRITES NOTHING: every input feeds `#trade-button`, which it never presses â€” nothing on this venue arms until that click, the same safety argument as the count itself.',
  },
  {
    id: 'silver-pip-offset-remeasure',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'Silver PIP_UNITS offset data correction (TRD-TRL-8 forensics): offset 0.052 -> 0.078, measuredAt 2026-10-08; pip 0.001 and both clamp ends (floor 45 / ceiling 37,850) reconfirmed unchanged across four read-only sweeps (buy+sell, n=8 rows). The 09-30 offset missed by ~2% at the T2.5 abort count â€” inside the landing band but outside the 2% verify band, i.e. straight into the fail-safe; the trail itself stays OFF and remains gated on its own T2.5 watched verification',
    invalidates: 'âš  OPERATOR-SCOPE â€” a measured NUMBER in an OFF feature\'s table, not a policy key: while the trail is disabled no live decision input changes. If/ when the trail re-enables this row becomes a real input and must not be pooled with the pre-correction paper studies (lock075_t15 etc. were measured with the 09-30 row). No epoch reset.',
  },
  {
    id: 'trd-trl-9-engage-staged',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'TRD-TRL-9/10/11 STAGED trail-promotion build (owner green light: option 2, build-only; first live engage held for the walkthrough): (a) `webtrader.setPositionTrail` â€” the post-entry trail engage through the Edit -> Set Limits card, commit-gated, with a fully read-only mode (`commit:false`) + route `POST /orders/edit-trail-probe` as its verification vehicle; (b) `agent/trailEngage.js` â€” the lock075_t15 touch decider (per-trade peak watermark; explicit missed-window and venue-minimum refusals) + a 60 s flag-gated loop in server.js; (c) settings seed `risk.trailingStop.engageOnTouch { enabled:false, lockR:0.75, trailR:0.15 }`; (d) forward SHADOW monitor `temp/shadow-exit-watch.js` â€” lock075_t15 vs the live build over live 1h bars (adv-first, scale-guarded), one `shadow_exit` event + TG line per finalized trade; (e) pip sampler `temp/pip-sampler-watch.js` â€” periodic read-only Silver sell sweeps recording price + ticket bid/ask + offset (the offset-vs-price hypothesis test)',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: every behaviour-changing switch ships FALSE. `engageOnTouch.enabled:false` at deploy; `trailingStop.enabled` stays false; `setPositionTrail` is reachable only in `commit:false` mode (the probe route) until the walkthrough. The shadow monitor and pip sampler are READ-ONLY (SELECTs; sweep probes on UNSUBMITTED tickets; their own event kinds `shadow_exit`/`trail_engage_*`); they change no decision input and must not be read as the promotion itself. Promotion requires, at the walkthrough: (i) the read-only edit-card verification passed on a live position, (ii) shadow deltas accumulating in the right direction, (iii) the fresh-n evidence re-read on current data.',
  },
  {
    id: 'trd-pru-3-candidate-screen',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'TRD-PRU-3 READ-ONLY candidate screen (owner ask 2026-10-08: "a separate set of new instruments that has the same type as the winners, like another test case... since it not touching current, the timer wont reset"): route `POST /orders/instrument-screen-probe` + `webtrader.probeInstrumentPages` â€” CATEGORY-PAGE NAVIGATION ONLY, reads every instrument row own buy/sell, computes spread + spread% per instrument; runner temp/instrument-screen.js; PLUS `probeInstrumentBars` (TRD-PRU-3b: per-symbol chart backfill, series + interval-verdict fields, focus-only) via `POST /orders/instrument-bars-probe` â€” feeds the winners-profile intake: screen -> cost screen -> historical backfill + profile study -> paper evidence before ANY scope change.',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: navigation-only probe (no ticket, no order, no settings write); the live trading scope, all decision inputs and the era clock are untouched by construction. Any future LIVE promotion of a candidate symbol is its OWN pre-registered change with its own boundary â€” this entry does not cover that.',
  },
  {
    id: 'continuity-merge-2026-10-18',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'CONTINUITY MERGE from the laptop hand-off bundle (owner-directed return-to-service): five merged changes â€” (1) trading/server.js TRADING_CAPTURE_ONLY early-return (data-collection mode: skips every agent loop; 240 s capture deadline + in-flight guard + stage logging); (2) trading/plus500/browser.js#newPage() authoritative sever (TRADING_PLUS500_DISABLED â€” every navigable page flows through newPage, so one refusal severs all goto/reload/bringToFront sites) plus bringToFront() bounded to 3 s (the unbounded await stalled EVERY capture with no result and no error); (3) trading/plus500/capture.js TRADING_CAPTURE_SKIP_HEALTH bypass of the selector-health gate (read-only mode only); (4) trading/agent/providers.js Polygon Yahoo id POL-USD -> POL28321-USD (old id 404, re-verified live on the desk 2026-10-18: POL28321-USD 200, POL-USD 404); (5) config/servers.json registers `expenses` (it was found dead and unregistered â€” the dashboard starts children on boot but does NOT respawn a child that dies mid-run). Plus five NEW files: trading/scripts/record-instruments.js, record-plus500-ticks.js (no-navigation DOM tick reader), record-plus500-details.js (instrument-details cycler + session keep-alive), plus500-keepalive.js (Trade -> Open Positions -> Trade soft nav), Ensure-Services.ps1 (start-only service watchdog) â€” NONE scheduled on the desk; docs/10-ARCHITECTURE-NOTES.md carries the ADR rationale (navigation is the risk; page.evaluate has no timeout; sever at the choke point).',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: every behaviour-changing switch ships INERT (the three env flags are unset on the desk; the capture-only block returns before any loop starts; assertEnabled() passes; the SKIP_HEALTH branch is false). The bringToFront bound and the Polygon id fix are operational/data corrections with no decision input (the old id 404d, so no number was ever computed from it). No settings write, no scope change, no era reset â€” the T2 era boundary (2026-10-08T00:45:50.735Z) stands. âš  The seven-day outage span (10-09 -> 10-16; desk off, 0 TradingEvents) precedes this entry and must not be pooled.',
  },
  {
    id: 'mirror-cycle-deadline',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'MIRROR CYCLE DEADLINES (owner: "you can fix that, it is the weekend"): every venue await in the mirror poller now races a hard deadline â€” positions 45 s, closed-positions 20 s, alerts 20 s, park 30 s (MIRROR_DEADLINES_MS + withDeadline in trading/agent/mirrorPoller.js). Root cause: the mirror holds the SHARED pageLock for its whole cycle and ONE hung page.evaluate (Playwright has no default timeout) held it indefinitely â€” measured as recurring `bridge busy (mirror) â€” lock wait exceeded for ticket` (28 hits since the 10-17 restart; caller: the candidate-capture lane POST /orders/instrument-bars-probe with a 240 s ticket wait, the touch-probe lane waits 120 s). Worst-case mirror hold is now ~115 s, under every ticket waiter; the finally still releases the lock on timeout and the failure is named in the event stream.',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: no decision input, no settings write, no scope change â€” the mirror is read-only beside the desk and the T2 era boundary stands. âš  Behaviour note: when a bound trips, that cycle\'s reads are incomplete (named error in the log) and the NEXT cycle retries; a trip can briefly DELAY a mirrored venue close but never corrupt one (the ledger reconciles on the next successful read). Freeze window restarted after this deploy.',
  },
  {
    id: 'watchlist-quote-fast-path',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'WATCHLIST QUOTE FAST PATH (owner: "start on 1. watchlist name is analysis"; ADR-1 applied): the dynamic capture no longer searches per instrument for QUOTES â€” captureDynamic reads the venue watchlist table ONCE (webtrader.readInstrumentTable; /trade/watchlists--86806649 persisted as bridge.watchlistUrl) with the tick burst moved from per-symbol ticket re-reads to table re-reads (3 reads â‰ˆ 4.5 s total vs â‰ˆ 45 s), and quotes are BANKED BEFORE the chart sweep so a slow venue can never time-out the wake prices. CHART-BAR COVERAGE IS UNCHANGED: every watchlist symbol chart is still read on every dynamic capture via captureBySearch({chartsOnly}) with a focus-miss guard; symbols the table does not carry fall through to the legacy search path ({only}); the universe sweep keeps its unchanged triggers and its recoveries are banked too. Root cause measured: 10 symbols Ã— (search+select 2-4 s + burst 3.6-5 s + chart 2-4 s + jitter) = 7-15 s/symbol > the 90 s budget â†’ named capture_timeout + tab swap on nearly every wake. Pins: test/watchlist-quotes.test.js (4).',
    invalidates: 'âš  OPERATOR-SCOPE with a BEHAVIOUR NOTE: same prices from the same source (venue frontend, source=plus500_frontend, venue of record) and the same per-wake chart coverage â€” but a quote is now the watchlist row sell/buy at table-read time (three samples per wake, as before) instead of a ticket sample taken mid-search. Bar freshness semantics unchanged (every symbol chart still read each wake; quant BAR_FRESH_MS=4h untouched). bridge.watchlistUrl is account-specific data, not a policy key. No settings write, no scope change, no era reset.',
  },
  {
    id: 'watchlist-fast-path-pin-repair',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'WATCHLIST FAST PATH PIN REPAIR (same change window, same owner directive): the two source pins in test/capture-chart-bars.test.js went red against the restructured captureDynamic and BOTH findings were real â€” (1) mergeChart still accumulated chartIdentity/chartMerge, fields captureBySearch logs at the point of measurement and captureDynamic never returns, so the accumulation was DEAD CODE; removed. (2) The chartMissing pin asserted one literal destructure line; captureDynamic now declares its own accumulator, so the pin was GENERALISED to the invariant it was written for â€” every scope that MENTIONS chartMissing must BIND it (destructure OR declaration), the ReferenceError-at-capture-time guard intact. No behaviour change: the verified live capture (captured 30 ticks, missing 0, watchlist_quote_source goto 1441 / wait 4594 / burst 2980 ms) exercised this path before and after the cleanup. Pins: 17/17 across capture-chart-bars + watchlist-quotes.',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: dead-code removal plus a test-pin generalisation; no decision input, no settings write, no scope change; same prices, same sources, era clock untouched. Desk restarted to load the identical-behaviour build.',
  },
  {
    id: 'desk-singleton-guard',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'DESK SINGLETON GUARD (night shift, 2026-10-18): the desk REFUSES to boot when another desk already answers /healthz on 127.0.0.1:8115, and a bind failure is logged NAMED instead of dying anonymously. Measured failure this exists for: TWO trading\\server.js processes were alive at once â€” Windows let both bind :8114 because they had chosen different interfaces (one 127.0.0.1, one 0.0.0.0) â€” so EVERY POST /capture reached the STALE build while restarts reported "started pid N, healthz ok"; roughly forty minutes of this session was spent measuring code that was not running. Bind success is not the test (that is what silently passed twice): the health endpoint is, because only a desk serves /healthz and its listener is always loopback. Trading/lib/singleton.js#probeExistingDesk requires 200 + body ok, so a foreign listener on the port cannot block a legitimate boot. New pins: test/desk-singleton.test.js (4).',
    invalidates: 'âš  OPERATOR-SCOPE â€” NOT a policy boundary: boot-time guard only; no decision input, no settings write, no scope change. Inert whenever no other desk is serving (probe answers not-alive and boot proceeds exactly as before). Era clock untouched.',
  },
  {
    id: 'capture-rotation-backoff',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'CHART ROTATION BACKOFF for a closed venue (night shift, 2026-10-18): after 2 consecutive rotations that complete but bank ZERO bars, the next 2 wakes skip the rotation and the 3rd tries again â€” so a weekend venue stops costing up to 40 s of shared-tab budget per wake (measured weekend capture 61.3 s vs ~15-20 s without rotation) and a venue REOPEN is still picked up within ~20 min (quant BAR_FRESH_MS = 4 h). Telemetry stays signal-only: the zero-bank event now carries zeroStreak + skipNextWakes, and a rotation that banks bars after a streak logs `chart_rotation resumed` once, so the weekend-to-Monday transition is visible instead of inferred. Backoff state is module memory (resets on restart â€” a restart simply tries once).',
    invalidates: 'âš  OPERATOR-SCOPE with a BEHAVIOUR NOTE: chart-bar coverage is unchanged while the venue serves bars (rotation runs exactly as before and clears the streak on the first banking run); ONLY a venue that banks nothing is backed off, and bars are supplementary (structure venue, 4 h SLA) â€” no quote ever depends on a chart visit. No settings write, no scope change, era clock untouched.',
  },
  {
    id: 'crypto-24-7-sessions',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'CRYPTO 24/7 SESSIONS (owner: "dont gate. any 24/7 stocks are available to be used"): sessionState no longer closes a 24/7 instrument with the STOCK-CFD weekend calendar. Measured failure: the venue feed was SILENT (sessionFeed.get() null for every symbol while the shared tab sat on the watchlist page), so the calendar decided, and every weekend wake skipped as market_closed while the venue traded crypto - trade #1319 Ethereum was closed by the VENUE take-profit for +S$22.98 during one of those skipped wakes. The bypass is scoped: it applies ONLY to the calendar step, only while the venue is silent, and ONLY to the curated class in trading/lib/instrumentClass.js (Bitcoin, Ethereum). The venue still outranks the class (explicit isTraded=false closes); halts still close on non-weekend days; the stock observation lock is untouched for stocks. Wake aggregation therefore reads open when crypto is open, so entries are possible for in-scope crypto (Ethereum) while Bitcoin remains scope-pruned.',
    invalidates: 'SCOPE NOTE: this changes WHEN the desk may act (weekend crypto management is now possible) without changing the instrument set, any strategy, or any threshold. Per owner instruction (2026-10-18) weekend-generated DATA must be excluded from any MODIFICATION analysis (studies, pre-reg decisions, retunes) - trading decisions on live weekend quotes are allowed; weekend data used to justify a rule change is not. Era clock: boundary recorded; owner to confirm whether the era re-anchors (weekend trades form a new class of sample).',
  },
  {
    id: 'weekend-session-class',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'WEEKEND SESSION CLASS (owner: "pooling, it is a separate class, we can separate it, while still being in the same era"): every trade is stamped with the session class of its ENTRY - weekend vs weekday - at the ONE write choke point (store.createTrade -> trading/lib/sessionClass.js), so any study can split cohorts with one GROUP BY while the era is NOT re-anchored. Migration 050 adds Trades.sessionClass NVARCHAR(24) NULL and backfills deterministically from openAt (325 rows: 324 weekday, 1 weekend - a rejected Sunday Gold attempt). The column is deliberately NOT updatable, so a close can never re-stamp a trade into another cohort. 5 pins, including a 7-day agreement sweep against agent/sessions#calendarState using the implication pair that treats the Friday observation lock as WEEKDAY time, which is what it is.',
    invalidates: 'OPERATOR-SCOPE with a DATA NOTE: provenance/additive column only - no decision input, no threshold, no strategy, no instrument set. The era clock is NOT re-anchored (owner decision 2026-10-18): weekend crypto trades pool inside the same era and are separated by sessionClass where a question needs it. Weekend DATA remains excluded from modification analyses per PRU-3 section 9.',
  },
  {
    id: 'trail-engage-entry-anchored-verify',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'TRD-TRL-12b - THE ENGAGE VERIFICATION NOW ANCHORS TO THE TRADE ENTRY (owner: "promote the trail"): the Edit card percent is anchored to the ENTRY price, measured live in five readings on 2026-10-08 - its readDistance = |entry - (price + D_venue)|, i.e. |D - excursion| when favourable and D + excursion when adverse, never plain D. setPositionTrail passed the CURRENT price as `entry`, so the pre-commit check compared the wrong quantity against D and would have refused every engage more than a rounding band from break-even (`trail_not_verified_before_commit`) - the exact reason promotion was held on 10-08. The function now takes the entry rate from the TRADE ROW, REFUSES with `entry_rate_unknown` when it has none, computes the distance with it, and records `entryUsed` in the reading. Pins: test/trail-engage-verify.test.js (5) - including an arithmetic pin that reproduces the old defect (a favourable sell reads |entry - level| = 8 where D = 2).',
    invalidates: 'INERT AT DEPLOY: `risk.trailingStop.engageOnTouch.enabled` stays FALSE and `trailingStop.enabled` stays false - the fixed verification is reachable only in commit:false mode (the read-only probe route) until the watched engage. No decision input, no threshold, no scope change. This is the gate the trail promotion was waiting on, not the promotion itself.',
  },
  {
    id: 'pru-soybeans-pause',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'SOYBEANS ENTRY PAUSE (owner: "pause entries, for now"): strategies.symbolScope.Soybeans = [] - PRU-1 shape, a scope write and nothing else. Evidence: 1 win in 9 closed trades, mean R -0.597, PF 0.15, net -23.99 SGD; both replicas lose (variant -11.28, control -9.36) so this is the shared signal, not a variant bug; round-trip cost 0.20-0.31R against stops of 0.29-0.47 pct of price; 5 of 9 never reached +0.3R and 2 reached ~1R then lost; fills 13-28 s with one -0.466 pct slippage. Journal #269255 records before ["survasoybeans","survcsoybeans"] -> after []. A detailed investigation brief for an external reviewer lives at trading/docs/soybeans-review-brief-2026-10-18.md; the pause is reversible and re-entry needs its own registered change.',
    invalidates: 'SCOPE CHANGE, DECLARED: one symbol removed from the tradable set. No strategy, threshold, sizing or exit changed; the OPEN Soybeans position (if any) is untouched - the review loop still manages positions, this gates NEW ENTRIES only. Instrument set changed, so trades opened after this boundary are not poolable with the same set as before it for per-symbol questions - noted for the era tracker as a MAJOR boundary.',
  },
  {
    id: 'geometry-grid-cutoff-derived',
    landedAt: '2026-10-18',
    row: 1412,
    title: 'REPRO HARNESS COULD NOT SEE ITS OWN DATA: geometry-grid.js defaulted --until to a hard-coded 2026-09-28T12:00:00Z, so running it on 2026-10-18 reported "229 filled trades; 0 usable" with every skip reading "only -25996m of path" - a NEGATIVE horizon, because the default cutoff predates every recent entry. With a cutoff near the newest trade the same command returns 11 usable trades at a median 10 s tick gap. Fixed: the cutoff now defaults to the newest entry in the data (floored to the minute; still a FIXED timestamp and still printed, so the reproducibility the original comment protects is unchanged), and an empty sample prints its skip reasons by tally and exits 2 instead of presenting a blank table as a result.',
    invalidates: 'NOTHING BEHAVIOURAL. trading/scripts/repro/geometry-grid.js writes no settings, no events and no bars (read-only by construction, stated in its header); it only reads Trades, TradingEvents and PriceTicks. No decision path imports it. Registered because every trading/** change is registered, not because a decision changed.',
  },
  {
    id: 'atr-stop-multiple-wired',
    landedAt: '2026-10-18',
    row: 1418,
    title: 'A DEAD DIAL ON THE LARGEST LEVER: risk.atrStopMultiple has been in TradingSettings.risk (value 2) since the schema and risk.js hard-coded 2 * atrV, so the setting did nothing while looking exactly like the dial that decides stop width. Measured 2026-10-19 over 17,868 historical breakouts: mean net R improves monotonically with stop width (-0.105 at 2xATR, -0.061 at 3x, -0.043 at 4x, -0.021 at 6x, -0.017 at 8x) because cost-in-R = spread% / stop% is the one term widening shrinks. Wired: atrMultiple = Number(risk.atrStopMultiple) > 0 ? value : 2, used by the stop, the widening reason string AND baseSize (which had its own literal 2xATR). Pins added in test/atr-stop-multiple-wiring.test.js; the baseSize pin in test/risk-size-contract-scale.test.js was generalised from a literal to the rule it actually asserts.',
    invalidates: 'NOTHING AT THE CURRENT VALUE. atrStopMultiple is 2, so atrMultiple * atrV is byte-identical to the 2 * atrV it replaces and no stop moves. It becomes a behaviour change the moment the setting is written to a different value, and THAT write is its own registered decision with its own boundary - this entry only makes the dial real.',
  },
  {
    id: 'stop-width-4x-atr',
    landedAt: '2026-10-19',
    row: 1418,
    title: 'PRE-REGISTERED STOP-WIDTH TEST (owner: "pre-registered stop-width test OK"). A settings write of the PAIR {risk.atrStopMultiple 2 -> 4, risk.maxAdversePct 1.5 -> 2.5}. Evidence: 17,868 Donchian breakouts on yahoo 1h over two years give mean net R -0.105 at 2xATR, -0.061 at 3x, -0.043 at 4x, -0.021 at 6x, -0.017 at 8x; the mechanism is arithmetic - cost-in-R = spread% / stop%, and the spread is the only term that does not scale with the stop. The desk own harness on real venue tick paths (10 trades, median 10 s gaps) ranks every geometry negative with the best cell at ~3xATR (-0.104R) and the narrowest at -1.664R. The CAP is part of the change on purpose: at 1.5% of price it binds at 2xATR for Oil and 3x for Silver and Ethereum, so writing the multiple alone would leave three of four live instruments pinned at the cap and the geometry would silently become the CAP (TRD-96/101/102 class). At 2.5% the cap is inert at 4x for every live instrument (worst Oil 2.18%). Full gates, kill rule, power honesty and rollback: trading/docs/stop-width-prereg-2026-10-19.md, written BEFORE the write.',
    invalidates: 'BEHAVIOUR CHANGE, DECLARED, AND IT SPLITS THE SAMPLE. Stops are ~2x wider in price terms, so trades opened after this boundary are not poolable with the 2xATR era for any per-trade expectancy question - the era tracker takes a MAJOR boundary. Position RISK is unchanged (size = risk / stop distance, so a wider stop buys smaller size and less margin) and the target stays 1.41R of the PLACED stop, so the reward:risk in R does not move; what moves is cost-in-R (should roughly halve) and the time-to-target in price terms. No strategy parameter is touched: the frozen survivors keep params: [] and atrStopMultiple is a risk-layer dial, not a strategy param. Kill rule and rollback are pre-registered in the doc; reverting is two settings keys and its own boundary.',
  },
  {
    id: 'risk-unit-auditor-reads-dial',
    landedAt: '2026-10-18',
    row: 1418,
    title: 'THE AUDITOR HELD A STALE CONSTANT AND CALLED A CORRECT CHANGE A DRIFT. risk.atrStopMultiple was wired into risk.js minutes earlier (2 -> 4 at 19:18:10Z, journal #271364). The self-health contract field_risk_unit kept its own default of 2, so the first sizing event afterwards went BAD: "sizing arithmetic drifted: baseSize 2.022 vs 4.044 from (equity x riskPct) / (atr x 2 x scale 1.55)". The size was correct - exactly half, because the stop doubled. Fixed: the multiple now TRAVELS WITH THE ROW - risk.js writes `atrMultiple` into `sizeCalc` and each decision is audited against the geometry it was actually sized by (rows predating the field fall back to 2, which is what they were sized at). Reading the CURRENT setting instead would have been wrong in one era whichever way it read: it calls a correct new ticket drift, and it would call every historical 2x row drift after the move. Pins: test/risk-unit-auditor-multiple.test.js (5) - a 4x row wins over a caller-supplied multiple, a legacy 2x row still audits clean after the setting moved, and real drift is still caught in both eras.',
    invalidates: 'NOTHING BEHAVIOURAL. This is a READ-ONLY self-health contract: it recomputes numbers for a report and writes no settings, no sizes and no levels. It changes which verdict the health card shows, not what the desk does. Registered because every trading/** change is registered; the sizing path itself was not touched by this fix.',
  },
  {
    id: 'trail-engage-armed',
    landedAt: '2026-10-19',
    row: 1485,
    title: 'TRAIL ARMED (owner: "pre register and arm. lets see it live soon, to see if theory is correct"). One settings key: risk.trailingStop.engageOnTouch.enabled = true -> lock075_t15 (on touch of +0.75R move the stop to the lock and trail 0.15R behind the peak). Evidence, 90 instruments / 174,961 bars / 17,922 breakouts, both intra-bar orderings: the engage trail is the BEST exit in every geometry tested and the ONLY rule positive in both orderings anywhere in the study - stop 4xATR cap 24: -0.011 / -0.034 vs stop-only -0.044 and fixed target -0.052; stop 4xATR cap 72: +0.010 / -0.025; old 2xATR geometry: +0.032 / +0.011. Worth +0.041R per trade against the fixed 1.41R target the desk actually runs. Every fromStart trail was ordering-UNSTABLE (0.5R: -0.027 vs -0.104) and was rejected for that reason. Gates and frozen baselines (mean gross R -0.109, mean give-back 0.707R, mean hold 277 min) in trading/docs/trail-decision-2026-10-19.md, written BEFORE the arming.',
    invalidates: 'EXIT BEHAVIOUR CHANGE, DECLARED, MAJOR BOUNDARY. From this instant a position that touches +0.75R gets a venue-side lock at that level and a 0.15R trail, so the exit is decided by the venue rather than only by the desk signal. Rows opened after this boundary are not poolable with earlier eras for any exit or give-back question. NOTHING ELSE MOVES: entries, stop width, sizing and the target are untouched, and risk.trailingStop.enabled (the separate place-a-trail-at-entry feature, distanceMultiple 1) stays FALSE. The trail is placed by the engage loop calling setPositionTrail(commit:true) directly, which does not consult that flag (trailEngage.js:99-119).',
  },
  {
    id: 'trail-engage-samples-on-time',
    landedAt: '2026-10-19',
    row: 1485,
    title: 'THE ARMED TRAIL WAS STARVED BY ITS OWN GATE. trailEngage.js early-returned unless the bridge was RESTING/OPERATIONAL and no wake was running, so the loop SAMPLED only while the desk was idle. Measured on the first armed engage (Silver #1336, the only position to cross the lock all night): the excursion sat ON the +0.75R lock for three minutes, crossing above it four times (0.745 -> 0.782 -> 0.747 -> 0.759), and the loop sampled once - a single missed_window at 22:13:04 - while the bridge reported RESTING only from 22:55:40Z. A 60-phase sweep over the same tick series says the engage condition is reachable in 88% of phases overall and 100% for that trade, so the policy was never too tight: the sampler was not running. Fixed: the decision half now runs every 60 s regardless of bridge state (it reads PriceTicks and nothing else), and the bridge/wake gate moved to immediately before setPositionTrail as the pure commitGate() - which records trail_engage_blocked with the reason and RETRIES next tick while the lock still holds. missed_window still refuses a lock that would land on the wrong side of the market, so retrying cannot invent a bad fill. Pins: test/trail-engage-commit-gate.test.js (6).',
    invalidates: 'SAMPLING BEHAVIOUR ONLY, AND IT IS THE PRECONDITION FOR THE TRAIL TEST. No policy value changes: lockR 0.75, trailR 0.15, the lock logic and the wrong-side refusal are untouched. What changes is WHEN the loop looks and WHEN it is allowed to write: it now samples through navigations and wakes, and a blocked commit is retried rather than dropped. That makes the armed trail measurable - the only trades it could previously engage on were ones whose excursion happened to coexist with an idle bridge, which is a selection effect against quiet markets. It also means MORE venue writes are possible (one per engaged position, at most once), which is why it is registered rather than slipped in.',
  },
  {
    id: 'trail-count-calibration',
    landedAt: '2026-10-20',
    row: 1485,
    title: 'THE COUNT IS NOT A DISTANCE, SO MEASURE THE TICKET INSTEAD OF ASSUMING ITS OFFSET. With the sampler fixed, the first armed engage finally reached the venue: Gold (symbol 6) 01:33Z, peak 1.3943R, lockLevel 4133.238, trailDistance 3.8364, pips 305 - and then 61 refusals of trail_not_verified_before_commit over two hours (plus 1 row_not_found). The card read fieldRaw 305 with a distance of 3.216 against the 3.84 intended, 16% NARROW against a 2% band, so the write was refused every time. The fitted table says Gold offset 0.79 (measured 2026-09-30); this ticket behaved like 0.166. The table own note says the offset cause is UNIDENTIFIED - which is exactly why the table says asking for 800 arrives at ~927 (16% WIDE) on another day: the offset moves, and a new constant would go stale the same way. Fixed: the control is AFFINE, so ONE read-back at a known count identifies it (observed = pip x count + offset), and a pipsForTarget count that does not land is corrected ONCE by round((target - observed) / pip) and re-typed, then re-read and re-verified before anything commits. calibrateCount() is pure and REFUSES rather than clamps: a correction outside the venue window, a non-positive count, or an unmeasured read is a refusal. If the second write does not land - and the file records that a second write to this control does not always land - the OLD refusal is unchanged, so the pass can only convert a refusal into a verified placement, never an unverified commit. Pins: test/trail-calibrate-count.test.js (5), including the live Gold case (305 -> 367, predicted 3.836 against a 3.8364 target).',
    invalidates: 'NOTHING IN THE POLICY SET. No dial, no level, no sizing and no exit rule moves: this only makes the trail write reach the distance the trail decision already asked for. The wrong-side and venue-window refusals are untouched, and a calibrated commit still requires a read-back inside the same verifyTolerancePct band. Registered anyway because it is the change that lets the armed policy actually place, so the trail-era sample starts HERE - trades whose trail engages before this boundary used the stale offset and were refused.',
  },
  {
    id: 'trail-engage-retry-park',
    landedAt: '2026-10-20',
    row: 1485,
    title: 'A REFUSED WRITE IS NOT RETRIED EVERY MINUTE. The 61 refusals above each logged a FULL trail_engage_failed event - the decision, the whole card, the read-back - one per tick for 108 minutes, which is how a correct refusal turns into 122 KB of noise that buries everything else in the stream. Skip-class refusals (missed_window, unstateable) were already deduped by skipLogged; fail-class was not. Fixed in trailEngage.js: a refused engage parks that trade for 5 minutes and a successful one parks it for 60 - the trail distance does not depend on the peak, so rewriting the same card every minute is pure risk with no upside. THE DECISION STILL RUNS EVERY TICK while parked, because d.peakFavR is the touch watermark and a later touch judged against a stale peak would be a wrong decision, not just a missing one.',
    invalidates: 'EVENT VOLUME ONLY. No decision, no write and no level changes. The parking is in-memory, so a restart re-arms the attempt immediately, which is the correct behaviour for a transient bridge failure and the wrong one for nothing.',
  },
  {
    id: 'llm-reasoning-controls',
    landedAt: '2026-10-20',
    row: 9536,
    title: 'THE CLIENT SENT NEITHER REASONING SWITCH FOR EIGHT WEEKS. deepseek.js carried a September comment reading "BOTH are THINKING models", which was true when it was written and became misleading when the API documented both controls: thinking {type: enabled|disabled} and reasoning_effort (none|low|high|max, where none DISABLES thinking and the default is high; minimal maps to low, medium/xhigh to high). The client sent neither, so every review, chair vote, pulse, autopsy and whitepaper call ran on the server default with no way to ask for anything else, and the ledger could not tell a call that thought for 3k tokens from one that did not. Fixed: both are passed through, the four documented efforts are validated and the aliases resolved, and an unrecognised value is DROPPED rather than thrown - a typo must not take the chair offline. The llm_call row now carries reasoningTokens (completion_tokens_details.reasoning_tokens), the effort that actually ran and thinkingDisabled, so cost and latency are attributable per consumer. promptChars also learned to count an image block as the provider image ceiling instead of stringifying it to [object Object], which is what a vision call would otherwise have recorded. Owner-approved, and it is the precondition for the entry/exit image experiments, which need effort as a variable. Pins: test/deepseek-reasoning-controls.test.js (6).',
    invalidates: 'NOTHING, BY CONSTRUCTION, AND THAT IS THE POINT OF THE SHAPE. Both new options default to undefined, so the request body is byte-identical to the pre-change version until a caller asks for something: no caller was changed, so no decision, review or vote sees a different model, a different reasoning mode or a different cap. The hazard being avoided is a client that silently switched every decision to non-thinking to save tokens - that would have been a policy change wearing a refactor clothes, and it would have made the desk incomparable to every era before it. The boundary below is therefore nominal for behaviour; it exists because trading/** changed and the protocol is unconditional.',
  },
  {
    id: 'chart-interval-declared',
    landedAt: '2026-10-21',
    row: null,
    title: 'THE CHART INTERVAL WAS WHATEVER THE LAST NAVIGATION LEFT IT ON, AND THE DATABASE PROVED IT. '
      + '`TradingSettings.chart` now declares the interval the venue chart should be on (default 60s, owner-chosen), '
      + 'and the capture REQUESTS it before reading. The request is a click on the venue\'s own resolutions menu â€” '
      + 'never `stx.setPeriodicity`, which the 2026-09-25 header established is a LABEL-CHANGER here (no dataCallback, '
      + 'no quoteDriver, reload branch unreachable, failure reported only to the console), so driving it would write '
      + 'rows labelled 1h, built from another interval, self-certifying the wanted provenance. The click is a REQUEST '
      + 'AND IS NEVER TRUSTED: `readChartIntervalState` re-measures the series\' own bar spacing and `ok` is that '
      + 'measurement, not the click\'s return value. Measured motive, over 2026-09-20..10-22: the single stored \'1h\' '
      + 'series was built from 60s (981 rows), 300s (988), 600s (2,010), 900s (703) and native 3600s (58 rows), plus '
      + '1,246 rows with no declared source â€” 1% native, 21% unknown. `maxMasterDataSize` was read live and is 0 '
      + '(unlimited) with `maxDataSetSize` 20,000 and no streamLoader/quoteFeed/loadMore, so the ~1,000 bars per read '
      + 'is the VENUE\'S DELIVERY, not a cap the desk can raise; the buffer grows while the tab stays on one interval.',
    invalidates: 'NOTHING IN THE DECISION PATH. It cannot: the strategy reads the 1h series from PriceBars, and this '
      + 'change alters which interval the ROWS ARE BUILT FROM, not which rows are read. âš  IT IS NOT INERT HOWEVER â€” '
      + 'a failed request leaves the chart where it was and the rows carry the interval they were actually built '
      + 'from, exactly as before; the change is that the miss is now RECORDED (`chartIntervalSet` on the capture '
      + 'result) instead of being discovered a sweep later by reading sourceIntervalSec. Deliberately NOT '
      + 'fail-closed: refusing to bank bars because the venue would not change interval would take the structure '
      + 'venue dark for a policy miss, which is a worse failure than the one being fixed. The falsification guard '
      + 'is unchanged and still refuses to write when the layout claim and the measured spacing disagree.',
  },
  {
    id: 'chart-fine-bar-storage',
    landedAt: '2026-10-21',
    row: null,
    title: 'SUB-HOURLY CHART READS WERE DISCARDED AT WRITE TIME. `TF_MAP` sent 900 to \'15m\' and FELL THROUGH to '
      + '\'1h\' for 60 and 300, so a 1-minute chart was 60:1 aggregated into 1h rows and 59 of every 60 bars were '
      + 'destroyed, leaving only `merge.histogram` counts. This adds `1m` to `BAR_TIMEFRAMES`/`TIMEFRAME_SECONDS` '
      + '(no migration: PriceBars.timeframe carries no check constraint, verified) and maps 60 -> \'1m\' and '
      + '300 -> \'5m\', with BUCKET_MS and the upsertAggBars ladder extended at both ends. The 1h series is then built '
      + 'by the EXISTING rollup (`bucketMs < 3600000` already fires), which is the same path 15m reads have used '
      + 'since 2026-09-25. This is the mapping TRD-GRD-5 deliberately left untouched; it is changed here as its own '
      + 'decision, not as a side effect.',
    invalidates: 'NOTHING IN THE DECISION PATH, AND IT CANNOT BE OTHERWISE: the 1h series is a ROLLUP of the fine '
      + 'series (open=first, close=last, high=MAX, low=MIN â€” `upsertAggBars`), so an hour built from 1m bars has the '
      + 'same OHLC as one built natively. What changes is ADDITIVE: 1m and 5m rows now exist, so intrabar structure '
      + 'survives to be measured later. âš  THE ONE THING TO WATCH ON THE FIRST SWEEP is that the rollup is the ONLY '
      + 'path feeding the 1h structure series while the chart is pinned fine; `chartRollup` on the capture result is '
      + 'the counter, and a sweep reporting 0 while writing 1m rows is the regression to look for. âš  AND THE '
      + 'COMPLETENESS INVARIANT IS NOW VISIBLE: a fully-sampled hour is 60 source bars at 1m and 12 at 5m, so a '
      + 'bucket count below that is a recorder gap â€” the desk\'s own tick-derived 1h series was measured at 11.9% '
      + 'flat/low-volume hours, which is sampler idle time rather than fabricated data.',
  },
  {
    id: 'trail-require-path-fixed',
    landedAt: '2026-10-23',
    row: null,
    title: 'THE TRAIL ENGAGE HAS BEEN DEAD FOR THREE DAYS ON A ONE-LEVEL WRONG REQUIRE. `webtrader.js` called '
      + '`require(\'../../agent/trailingStop\')`; from `trading/plus500/` that resolves to `oswald/agent/trailingStop`, '
      + 'which does not exist â€” the module is `trading/agent/trailingStop`. The call sat INSIDE the calibration branch '
      + 'added on 2026-10-20, so it threw only when a trail engagement was actually attempted, and it threw AFTER the '
      + 'desk had typed the stop into the venue ticket and BEFORE `Update` was pressed: `committed:false`, `after:null`, '
      + 'and the client reverted the field. That is the owner\'s "it set the revised values, and then hard reset" â€” a '
      + 'bug in our code wearing the venue\'s clothes. Measured: 43 `trail_engage_failed` rows carrying '
      + '"Cannot find module" between 2026-10-20 and 2026-10-23 (6, 22, 15 by day), against 0 before the change.',
    invalidates: 'THE PREVIOUS TRAIL ENGAGEMENTS UNDER THE CALIBRATED PATH DO NOT EXIST. Every engagement attempted '
      + 'since 2026-10-20 died at the require, so any analysis that reads "trail engaged" counts over that window is '
      + 'reading the pre-calibration path or nothing at all. âš  THIS IS A DEFECT FIX, NOT A POLICY CHANGE: the fixed '
      + 'code calls the same `calibrateCount` with the same arguments, so the behaviour after the fix is what the '
      + '2026-10-20 registration intended. It is registered because trading/** changed and the protocol is '
      + 'unconditional â€” and because a window containing three days of a silently dead exit rule must not be pooled '
      + 'with one where the rule ran. âš  THE RESTART IS PART OF THE FIX: the running process still has the broken '
      + 'require loaded and will keep failing until it is restarted.',
  },
  {
    id: 'black-swan-single-source-and-repeat-fire',
    landedAt: '2026-10-23',
    row: null,
    title: 'A BLACK SWAN WAS ANNOUNCED 29 TIMES FOR A MOVE THAT NEVER HAPPENED, AND EACH ONE LIED ABOUT THE PAPERS. '
      + '`detectBlackSwan` compared the last two UTC days from YAHOO 1h alone. Measured on Natural Gas, day-on-day: '
      + 'yahoo +10.02%, the venue\'s own series -2.98%, its chart series -3.05% â€” and yahoo and the venue were already '
      + '13% apart on 2026-10-22 itself. A 10% threshold sitting on a 13%-adrift series fires on nothing, and the '
      + 'detector had NO MEMORY: it re-derived the same static comparison every wake, so it fired 29 times between '
      + '11:00Z and 14:38Z, one every 7.8 minutes. Each firing forced all three tiers, and the Telegram said "White '
      + 'papers regenerated" unconditionally â€” while the budget cap had blocked every attempt after 11:10Z, so 25 of '
      + 'those messages described a regeneration that did not occur, and 83 `whitepaper_*: budget_cap` error rows '
      + 'were written between them.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” this is an ALERTING and CONTENT-REFRESH path, and no risk, sizing, '
      + 'stop or entry input reads it. âš  THE ONE THING IT DOES INVALIDATE IS ANY READING OF THE WHITE-PAPER RECORD: a '
      + 'paper whose period timestamp falls in this window may have been forcibly rewritten mid-period, and the '
      + '"regenerated" claim in the alert log was false for most of it, so those messages cannot be used to date a '
      + 'refresh. âš  AND IT CORRECTS THE COST PICTURE RATHER THAN THE COST: AI spend was never runaway â€” the budget '
      + 'cap held it to 4 papers (Â¥0.03) â€” the damage was 83 error rows, 29 false alerts and a bar read of 12,000 rows '
      + 'per symbol per wake for a comparison of two numbers (now 400, ~16 days). What changed: the gap is measured '
      + 'per venue and reduced by MEDIAN, two venues disagreeing beyond the threshold are UNMEASURABLE rather than an '
      + 'alarm, one alert per symbol per gap-day, and the message states how many tiers were actually written.',
  },
  {
    id: 'exit-geometry-target-and-lock',
    landedAt: '2026-10-24',
    row: null,
    title: 'THE TARGET MOVES 1.5R -> 3.0R AND THE TRAIL ENGAGE MOVES lock .75/trail .15 -> lock 1.50/trail .35 â€” the '
      + 'first change in this registry that alters the EXIT GEOMETRY every ticket carries. `exitLevels.LEVEL_RR` was a '
      + 'literal 1.5, so the ratio was not settable at all: this adds `risk.takeProfitRR` (default 1.5, i.e. unchanged '
      + 'for anyone who does not move it) resolved by `exitLevels.resolveTakeProfitRR` and read by BOTH the builder '
      + '(`entryLevels`, now carrying `takeProfitRR` on its result) and the audit contract that measures it '
      + '(`fieldContracts.venueLevelGeometry`, whose `field_levels` label and F20 floor were hard-coded to `LEVEL_RR` '
      + 'and would otherwise have reported every correct 3.0R ticket as a violation). It is paired with '
      + '`takeProfitAnchor: \'placed\'` so the ticket carries exactly the configured ratio instead of the cap-scaled one.',
    invalidates: 'THE EXIT GEOMETRY OF EVERY TICKET ON BOTH SIDES OF THIS INSTANT, AND NOTHING ELSE. The entry rule, '
      + 'the stop distance, the size calculation and the venue are untouched â€” sizing divides by the STOP, so R is '
      + 'unchanged and every historic R remains comparable across the boundary. What is NOT comparable is anything '
      + 'that reads the target: touch rate, payoff ratio, win rate, MFE-relative-to-target, and the trail engage (it '
      + 'now arms at 1.50R instead of 0.75R, so a trade that touches 0.75R and returns books ZERO where the old rule '
      + 'booked +0.75R). âš  AND `takeProfitOffsetPct: 6` SURVIVES THIS CHANGE, so the target the venue receives is '
      + '**2.82R**, not 3.0R â€” the same dial that made the old 1.5R declaration land at a measured 1.41R '
      + '(1.5 x 0.94 = 1.41 exactly, which is why the replay baseline was set at 1.41). It is not zeroed here '
      + 'because it is an owner dial, not a default; at `takeProfitAnchor: placed` the measurement already in this '
      + 'repo says the offset is a patch for the wrong dial (it moves expectancy from +0.1607R to +0.1259R at '
      + 'k=1.5), so zeroing it would carry the target to a round 3.00R â€” STATED, NOT TAKEN. '
      + 'âš  THE EVIDENCE IS A REPLAY, NOT THE DESK: `temp/trail-grid.js` on 5,359 Donchian breakouts, '
      + 'bracket mean +0.031R at 1.41R -> +0.055R at 2.0R -> +0.075R at 3.0R, paired vs the bracket z 3.3/4.1 before '
      + 'the clustering correction (ICC 0.24 at symbol-week, so roughly z 1.8/2.3 after it), both time halves '
      + 'positive. âš  THE WIDE-TRAIL RESULT THAT PRECEDED THIS DID NOT REPLICATE and is withdrawn: dropping the target '
      + 'entirely and letting a wide trail run measured +0.364R on 261 real entries but +0.003R (z 0.22) on the full '
      + 'pool, flipping sign between halves. âš  TWO SECOND-ORDER EFFECTS, NAMED: the F20 floor '
      + '(`minRealisedRrPct: 50`) is a percentage of the DECLARED ratio, so it rises from 0.75R to 1.5R in absolute '
      + 'terms and may flag tickets it previously passed; and the desk\'s wake-driven review can close a position '
      + 'before a 3R target is reachable, which this replay assumes away.',
  },
  {
    id: 'calendar-sync-scheduled',
    landedAt: '2026-10-25',
    row: null,
    title: 'THE ECONOMIC CALENDAR WAS CORRECT AND NEVER RAN. `agent/calendar.importCalendar` had NO scheduled '
      + 'caller â€” it was reachable only from a manual UI button and one route, so nothing ran it on a cadence. '
      + 'Measured 2026-10-25: `CorporateEvents` held **2 rows, both 2026-09-15/16**, i.e. five and a half weeks '
      + 'of nothing, and the next FOMC meeting (2026-10-27/28) was absent from the table entirely. This adds '
      + '`calendar.syncScheduled`, a 30-minute boot timer that self-throttles to `settings.calendar.intervalHours` '
      + '(12h) using its own `calendar_sync` event as the clock â€” the `newsAggregator` convention, so the schedule '
      + 'survives restarts and downtime with no timer in memory â€” plus settings defaults `{enabled, intervalHours, '
      + 'daysAhead}`.',
    invalidates: 'NOTHING IN THE DECISION PATH, AND THE DISTINCTION MUST NOT BE MISREAD. `sessions.js` was '
      + 'deliberately revised on 2026-09-15 so that a `macro` row is CONTEXT handed to the chairs as '
      + '`scheduledEvents`, not an entry lock â€” the `no_entry` state that briefly existed was removed because it '
      + 'vetoed a whole FOMC day on a claim nobody had measured. So the five-week gap did NOT leave the desk '
      + 'trading unlocked through FOMC days; it left the chairs being told nothing about an approaching meeting. '
      + 'What changes is the freshness of that context, and it is ADDITIVE: no gate, no threshold, no sizing or '
      + 'stop input. âš  TWO SECOND-ORDER EFFECTS, NAMED: (a) a prompt that now carries `scheduledEvents` is not '
      + 'byte-comparable with one that did not, so prompt-cache hit rate may dip on FOMC days â€” the pre-existing '
      + 'trade-off, not a new cost source; (b) `importCalendar` DELETES and rewrites the source rows inside its '
      + 'window on every successful run, so a silently re-worded federalreserve.gov page that parses to ZERO '
      + 'meetings would empty the window rather than fail. That is why every attempt writes a `calendar_sync` event '
      + 'carrying `ok` and the error text: a sync that writes nothing on failure is the silent-dead-feed class this '
      + 'repo has already paid for twice.',
  },
  {
    id: 'account-reset-ledger',
    landedAt: '2026-10-25',
    row: null,
    title: 'THE DEMO ACCOUNT WAS RESET TO 4,000 AND NOTHING RECORDED IT. Owner, 2026-10-26: "the ledger should log '
      + 'an account reset, along with the current number of account." Measured: `EquitySnapshots` went 2,632.98 at '
      + '2026-10-16T12:06:10Z to exactly 4,000 at 12:21:54Z, a +51.92% single-sample jump, and that step was the ONLY '
      + 'trace of the boundary. Reconstructing it by eye produced two wrong readings in a row â€” a "+$45 over two '
      + 'weeks" averaged across two account lives, and a "post-reset" window that swallowed two pre-reset option '
      + 'closes because the boundary was a guessed timestamp. This adds `agent/accountResets`: one `account_reset` '
      + 'event IS the era boundary (the `news_digest` / `calendar_sync` convention), carrying `balanceBefore`, '
      + '`balanceAfter`, the jump percent and the `snapshotId` it dedupes on; `currentEra(userId)` derives the era '
      + 'from that event, so no settings write is involved and recording a reset cannot itself breach the freeze.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” this is a record, and it reads no risk, sizing, stop or entry '
      + 'input. âš  WHAT IT DOES INVALIDATE IS EVERY AGGREGATE THAT SPANS 2026-10-16T12:21:54Z, which is the point: '
      + 'trades before that instant belong to a different account life and must not be pooled with trades after it. '
      + 'âš  AND THE DETECTOR IS DELIBERATELY ONE-SIDED: an upward jump cannot be trading, so it is a reset with high '
      + 'confidence, while a DOWNWARD reset is indistinguishable from a large loss â€” the -22% sample on the same day '
      + 'was the options losses, not a reset, and a rule loose enough to catch a reset-down would have called those '
      + 'losses one. A downward reset has to be stated by hand; the detector will not invent it. âš  FIRST RUN FAILED '
      + 'AND IS FIXED HERE: `TOP (800)` put the scan window AFTER 2026-10-16 (3,956 demo samples exist, 1,095 '
      + 'post-reset), so it reported "found 0" on the very reset it was built to find. The scan is now bounded by '
      + 'TIME (60 days), because a row cap defines a window that shrinks as the desk gets busier.',
  },
  {
    id: 'venue-pnl-withheld',
    landedAt: '2026-10-25',
    row: null,
    title: 'THE LEDGER REPORTED A -1,120.97 LOSS THE AGENT NEVER MADE. Owner, 2026-10-26: "venue rows are not on '
      + 'your jurisdiction, in fact, there should be nothing that resulted in -1.1k from the agent, which is what is '
      + 'shown." `origin=\'venue\'` rows are positions MIRRORED from the account that the desk never opened, so '
      + '`openPrice` is the price at mirror time and not the true entry â€” the difference is however long the position '
      + 'lived before we noticed it. Measured: 12 closed venue rows summed to **+91.82** lifetime and **-1,120.97** '
      + 'inside the post-reset window, while the account itself moved **+55.69**. `venueClose.js` now stores '
      + '`grossPnl: null` for `origin=\'venue\'` and appends the reason to `note`; the venue\'s own figure still '
      + 'rides on the `trade_closed` event payload as `netPnl`, so the fact is withheld rather than lost. The 12 '
      + 'historical rows were nulled by `temp/ledger-migrate-2026-10-26.js`.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” no decision reads `grossPnl`. âš  IT INVALIDATES ANY PERFORMANCE '
      + 'TOTAL THAT INCLUDED VENUE ROWS. Withheld at the WRITE PATH rather than filtered in reports, because a '
      + 'report filter is a convention every future query can forget while a null column cannot be mis-summed. '
      + 'âš  AND `origin` NOW HAS TO BE READ, NOT ASSUMED: `agent` is the strategy, `manual` and `venue` are the '
      + 'owner\'s own (confirmed 2026-10-26: "mine"). The reconciliation that holds is agent-only post-reset: 64 '
      + 'closes, sum +55.35, against an equity move of +55.69 â€” a 0.68 gap that is fees, funding and rounding.',
  },
  {
    id: 'exit-target-offset-zeroed',
    landedAt: '2026-10-25',
    row: null,
    title: '`takeProfitOffsetPct` 6 -> 0, so the target the venue receives is the 3.00R the setting names. Owner '
      + 'delegated the call ("hmm... your choice to make"). The offset was added because capping the stop used to '
      + 'PUSH THE TARGET OUT; under `takeProfitAnchor: \'placed\'` â€” which this desk has used since before 2026-10-24 '
      + 'â€” every ticket already carries the declared ratio, and `exitLevels.js` measures the offset there as a '
      + 'DEGRADATION (expectancy +0.1607R -> +0.1259R at k=1.5). It is a patch for a dial that no longer exists. THE '
      + 'EVIDENCE FOR ZEROING RATHER THAN LEAVING IT: 1.5 x 0.94 = 1.41 exactly, which is where the "measured 1.41R '
      + 'target" in every earlier analysis came from â€” the offset was never a policy, it was arithmetic nobody had '
      + 'written down. Zeroing makes the record say what the desk does: 3.00R, not 2.82R.',
    invalidates: 'THE REALISED TARGET OF EVERY TICKET AFTER THIS INSTANT, from 2.82R to 3.00R (+6.4% of R). Small '
      + 'in R, but it is a geometry change and is registered as one. The entry rule, stop distance, sizing and venue '
      + 'are untouched â€” sizing divides by the STOP, so R is unchanged and historic R stays comparable. âš  THE '
      + 'REPLAY BARELY DISTINGUISHES THEM: `temp/trail-grid.js` on 5,359 breakouts gives +0.038R (z 10.25) for '
      + 'tp 3.0 + lock 1.5/.35 against +0.037R (z 10.21) for tp 2.82 â€” the change is made for RECORD CLARITY, not '
      + 'because the sweep prefers it. âš  AND THE SHADOW ARM WAS RENAMED WITH IT: `live_tp282_lock15_t35` -> '
      + '`live_tp300_lock15_t35`. Renaming rather than re-pointing, so rows recorded under the old arm keep their '
      + 'meaning.',
  },
  {
    id: 'news-time-range-destroyed-dates',
    landedAt: '2026-10-25',
    row: null,
    title: 'THE REQUEST FOR FRESH NEWS WAS WHAT MADE IT UNDATABLE. `settings.news.timeRange` defaulted to `\'day\'`, '
      + 'and every stored `NewsItems` row carried a NULL `publishedAt` â€” 824 of 824. The cause was not the parser '
      + '(which reads `publishedDate` and deliberately refuses to invent one) but the PARAMETER: on SearXNG, '
      + '`time_range` does not merely filter for recency, it RESTRICTS THE QUERY TO ENGINES THAT IMPLEMENT TIME '
      + 'FILTERING, and on the owner\'s instance the only such engine is `bing news`, which never emits a date. '
      + 'Measured 2026-10-26 with one query: `categories=news` -> 30 results / **21 dated** (bing news + duckduckgo '
      + 'news + wikinews); `categories=news&time_range=day` -> 10 results / **0 dated** (bing news only). The '
      + 'dates were available the whole time, one engine away. DEFAULT IS NOW `null`, and the recency bound moves '
      + 'LOCAL: `maxAgeHours: 48` rejects an item whose OWN date is older than that, which also makes the discard '
      + 'count (`tooOld`) reportable â€” something a silent engine-side filter never was.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” S1 is write-only by design and has no consumer, so no chair '
      + 'prompt, no risk gate and no sizing input reads this lane. âš  WHAT IT INVALIDATES IS THE BELIEF THAT THE FEED '
      + 'WAS HEALTHY BECAUSE THE LOOP WAS RUNNING: 316 `news_digest` events fired hourly while inserting nothing, '
      + 'and the dead-feed discipline correctly named `searxng_unreachable` â€” so the record was honest the whole '
      + 'time, it was the default that was wrong. âš  AND AN ITEM WITH NO DATE IS STILL KEPT: the horizon rejects '
      + 'only a row that STATES a date it fails, because dropping undated rows would quietly remove `bing news` from '
      + 'the feed entirely â€” the same dead-feed-reads-as-quiet failure in a new coat. âš  FIRST RUN AFTER THE CHANGE '
      + 'ALSO CAUGHT A RESOLVER BUG: `String(n.timeRange ?? DEFAULTS.timeRange)` yields the four-character string '
      + '`"null"`, sent as `time_range=null`, HTTP 400, reported as `searxng_unreachable` â€” a config typo wearing a '
      + 'network fault\'s clothes. Verified after the fix: 10 queries, 71 fetched, **67 inserted**, 74 too-old, 0 '
      + 'failures.',
  },
  {
    id: 'econ-calendar-capture',
    landedAt: '2026-10-25',
    row: null,
    title: 'THE DOW JONES ECONOMIC CALENDAR IS NOW CAPTURED INTO A LEDGER â€” time-of-day, an impact grade and the '
      + 'actual/forecast/previous triad, none of which `CorporateEvents` can hold. That table stores one DATE column '
      + 'and is read by `sessions.js` to build the chairs\' `scheduledEvents` context; widening it to carry a calendar '
      + 'the session guard must not read is how one table starts meaning two things. Hence `CalendarEvents` (migration '
      + '051, applied 2026-10-26) and `plus500/calendarCapture`. THE SCHEMA IS COPIED FROM THE LIVE PAGE, not invented: '
      + 'Time | Expected Impact | Event | Actual | Forecast | Previous | Related Instruments, grouped under relative '
      + 'day headers, two tabs, Data by DOW JONES.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” a write-only ledger with NO consumer, the same operator-scope as '
      + 'the premium-analyses ledger. No chair prompt, no risk gate, no sizing or stop input reads it. âš  THREE THINGS '
      + 'THE PAGE DOING THE RENDERING TAUGHT, each of which would have produced a silently wrong table: (1) THE DOTS '
      + 'DO NOT COUNT THE GRADE â€” an `impact-low` row carries THREE `.circle-impact` spans, so counting them rates '
      + 'every event high; the grade is the class and the `aria-label`, and a disagreement between those two is '
      + 'recorded rather than resolved. (2) THE TIME IS BROWSER-LOCAL WITH NO MARKER â€” 08:00 on the page is 00:00Z '
      + 'here, so `tzOffsetMin` is captured per row and `resolveEventAt` is pure and tested. (3) FUTURE DAYS ARE '
      + 'HEADED `DD/MM/YYYY`, not a month name, and the first capture stored 212 of 257 rows as undated for want of '
      + 'that format; the parser knows all four forms and an unreadable label stores NULL with a named status rather '
      + 'than a guess. âš  AND THE NAVIGATION IS A MENU PATH, NOT A URL: `/action/inter/economiccalendar` returns 200 '
      + 'and then bounces to /open-positions, the same client-side-only-route class the analyses capture documented. '
      + 'âš  ONE SHARED TAB ONLY (owner: a second Plus500 tab makes the venue sign one of them out) â€” which is the '
      + 'probable cause of the 20:39Z sign-out and the 4h45m entry block earlier the same day.',
  },
  {
    id: 'pause-latch-truthfulness',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE LATCHED PAUSE RECORDED ITS LAST FAILURE AS ITS START TIME, SO THE HEALTH PANEL COULD NEVER LOOK '
      + 'ALARMING. `plus500/health.js` rewrote `bridge.pausedAt` to now on EVERY failed poll â€” the settings journal '
      + 'shows **12 writes in 4 days against 2 changes of `bridge.paused` itself**, each write\'s `before` being the '
      + 'previous timestamp: 15:13:11 -> 15:21:09 -> 15:29:28 -> 20:39:42. `selfHealth` prints '
      + '`pauseAgeLabel(b.pausedAt)`, so the age it displayed was "time since the last failure" and the desk could '
      + 'sit behind a latched pause for hours while the panel showed minutes. Measured 2026-10-25: latched from '
      + '15:13 to 21:14 â€” 5h55m, 7 entries refused â€” after ONE alert at the transition. This splits the two facts '
      + '(`pausedSince` set once on the transition, `lastFailAt` every failure, `pausedAt` kept equal to '
      + '`pausedSince` so existing readers become correct unchanged), clears all four fields on `resume()`, and '
      + 're-pages a held pause after `REALERT_AFTER_MS` (1h). The verdict is extracted PURE as `pauseAlertVerdict`.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” the pause itself blocks entries exactly as before, and no risk, '
      + 'sizing, stop or entry input reads these fields. âš  WHAT IT INVALIDATES IS ANY READING OF PAUSE DURATION FROM '
      + 'THE RECORD BEFORE THIS CHANGE: every `ui_fallback_pause` row written before it carries a `pausedAt` that '
      + 'means "last failure", not "start", so an age computed from those rows understates the outage. The rows '
      + 'themselves are kept â€” the two facts are now separable in the payload. âš  AND THE ALERT RULE CHANGED: '
      + 'transition-only was deliberate (noise is a real failure mode) and is now "transition, plus once per hour '
      + 'while held". That is still not per-poll, and it is the difference between a receipt and a notification.',
  },
  {
    id: 'measurement-unit-and-population-guard',
    landedAt: '2026-10-26',
    row: null,
    title: 'A MEASUREMENT NOW HAS TO SAY WHAT IT IS, OVER WHICH ROWS, AND FROM HOW MANY â€” because three numbers in '
      + 'this repo were computed correctly and reported as something else. `agent/measurement.js` makes a number a '
      + 'RECORD (`quantity`, `unit`, `population`, `n`, `window`, `value`) and refuses the two comparisons that '
      + 'produced every bad number: (1) UNIT â€” a ROUND TRIP was put against a SPREAD-ONLY figure and its ratio '
      + 'published as a 6.76x error in the spread, when the ratio was the flat 0.05 slippage term ('
      + '`roundTripBpsFromCfg` is `2 x (spread + slip) x 100`, and its own comment states the decomposition); '
      + '(2) POPULATION â€” Gold\u2019s p75 half-spread over 14 days is 0.0563 and the venue\u2019s own ticket label at '
      + 'submit is 0.0098, both `half_spread_pct_per_side`, both correct, 5.72x apart, because one includes '
      + 'overnight widening and the other is read when the desk trades. `compare()` requires unit AND population '
      + 'to match; `agreesWith()` is the separate, named operation for the cross-population tolerance test, and it '
      + 'returns both population names so the two cannot be confused. Conversion is explicit and marks the result '
      + '`derivedFrom`. An ABSENCE cannot be converted or divided, because `Number(null) === 0` is the most '
      + 'permissive cost this codebase can express.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” a pure module with no consumer beyond its own tests; no risk, '
      + 'sizing, stop, spread, funding or entry input reads it, so no forward measurement changes meaning. '
      + 'âš  WHAT IT DOES INVALIDATE IS EVERY COST COMPARISON PUBLISHED BEFORE IT, and specifically the '
      + '2026-10-27 report that the static cost basis overcharges by 1.4x-6.6x: that finding is RETRACTED, not '
      + 'superseded. The corrected figures are that the curated spreads agree with the venue\u2019s ticket labels '
      + '(Gold 0.0097 vs 0.0098, Oil 0.0364 vs 0.0401, Ethereum 0.1251 vs 0.1250, Silver 0.0468 vs 0.0634 â€” ratio '
      + '0.74, inside the 0.7-1.4 agreement band), and that the unmeasured term is the flat '
      + '`CALIBRATED_SLIP_PCT = 0.05`, which is 84% of Gold\u2019s modelled round-trip budget. âš  SILVER WAS '
      + 'PROPOSED FOR A 0.0468 -> 0.0715 RAISE AND IS **NOT** CHANGED: 0.0715 came from a tick median computed '
      + 'without the venue and source filters `spreadDerivation` already requires (84,734 of 120,000 sampled tick '
      + 'rows were from non-quote sources), so it measured a different population rather than a bigger spread.',
  },
  {
    id: 'settings-scope-ownership',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE SETTINGS OWNERSHIP RULE WAS PROSE AND IS NOW CHECKABLE. `AGENTS.md` Â§2 and ADR-0001 state that '
      + 'operator-owned keys (`risk.*`, `watchlist.symbols`, `deliberation.*`) are never written by the machine and '
      + 'machine-owned keys (`bridge.*`, `kill.initialEquity`, `watchlist.universe`, `watchlist.candidates`) never '
      + 'edited by hand â€” but nothing could test it, so the evidence lived only in 27 individual journal diffs. '
      + '`store/ownership.js` is a pure longest-prefix classifier (`watchlist.symbols` and `watchlist.universe` have '
      + 'DIFFERENT owners, so first-match-wins would collapse them), and `saveSettings` now records the touched '
      + 'namespaces as `scope` on every `settings_write` event. IT DOES NOT REFUSE A WRITE: a classification question '
      + 'must not fail a live save, which is the same trade `reportDeadScopeWrite` already declined.',
    invalidates: 'NOTHING IN THE DECISION PATH â€” an additive field on an existing event and a pure module; no '
      + 'settings value changes, so no read of any dial moves. âš  IT DOES MAKE ONE PRE-EXISTING DEFECT VISIBLE AS A '
      + 'CATEGORY: `agent/discoverer.js` writes `watchlist.symbols`, which is OPERATOR-owned, from an automated loop '
      + '(`violations({ by: \'machine\' })` reports it). That write is NOT changed here â€” it is recorded as a known '
      + 'entry so it is a decision rather than an accident. âš  AND THE VOLUME IS THE FINDING, not any single row: '
      + '`bridge.consecutiveFails` written **22 times in 4 days** against 2 actual changes of `bridge.paused` is what '
      + 'a machine-owned runtime key looks like when it is written per-poll instead of per-transition.',
  },
  {
    id: 'watchlist-co-ownership',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE OWNERSHIP RULE MOVED FROM THE KEY TO THE ENTRY, AND A MACHINE WRITE NOW DECLARES ITSELF. The '
      + 'registry declared `watchlist.symbols` wholly OPERATOR-owned, which is wrong by construction: it is ONE array '
      + 'carrying the operator\u2019s manual picks AND the discoverer\u2019s `source: ai` picks, and '
      + '`agent/discoverer.js` rewrites it every cycle while preserving every manual entry verbatim. A path-level '
      + 'classifier therefore flagged a legitimate write on every run \u2014 a violation count that cries wolf is '
      + 'worse than none, because a reader learns to skip it. `store/ownership.symbolsViolation` compares the array BY '
      + 'SYMBOL NAME and lets a machine write add, change or drop AI entries only; ORDER IS NOT OWNERSHIP, because '
      + '`final = [...manual, ...ai]` reorders on every run. `saveSettings` now takes `{ by }` and records '
      + '`settings_scope_violation` as its OWN event kind \u2014 still without refusing.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a classifier, an event and the `by` argument; no settings value '
      + 'and no dial changes. \u26a0 IT DOES INVALIDATE the earlier handoff claim that `discoverer` was trespassing: '
      + 'the CLASSIFICATION was wrong, not the writer. \u26a0 AND THE GUARD CAUGHT ITS OWN AUTHOR: the first version '
      + 'of the TRD-114 seeder put raw SQL in `agent/instruments.js`, which `test/venue-cost-basis.test.js` forbids, '
      + 'and the suite failed until the query moved to `store/fills.js`.',
  },
  {
    id: 'bridge-write-churn',
    landedAt: '2026-10-26',
    row: null,
    title: 'A FAILURE STREAK NO LONGER COSTS A SETTINGS WRITE. The journal recorded `bridge.consecutiveFails` written '
      + '**22 times in 4 days** against **2** actual changes of `bridge.paused** \u2014 each one a MERGE, a journal '
      + 'row and a dead-scope scan, to record an integer consumed only to test `>= MAX_FAILS` (3). The streak now lives '
      + 'in process and the persisted value is a checkpoint: `shouldPersistBridge` (pure, tested) moves it on a LATCH '
      + 'transition, on a re-alert (or the retry page repeats every poll), on the first failure, on the recovery to '
      + 'zero, and once per `MAX_FAILS` during a long outage. A 20-failure outage writes at most 9 rows instead of 20.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 the latch threshold, its arithmetic and `paused` itself are '
      + 'unchanged, and every consumer reads the same fields. \u26a0 THE TRADE, STATED: a restart mid-streak loses at '
      + 'most `MAX_FAILS - 1` unpersisted failures, so the desk needs up to two more bad polls to latch. The LATCH IS '
      + 'ALWAYS PERSISTED \u2014 only the intermediate count is at risk \u2014 and restarts here are rare and '
      + 'operator-driven.',
  },
  {
    id: 'measured-slippage-basis',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE SLIPPAGE TERM IS MEASURABLE AND THE MEASUREMENT SAYS IT IS ~ZERO. `CALIBRATED_SLIP_PCT = 0.05` was '
      + 'charged per side on every symbol, self-described as a placeholder, and is **84% of Gold\u2019s modelled '
      + 'round-trip budget** (10.00 bps of 11.94). Over 120 days of real entries the desk\u2019s `slippagePct` is '
      + '**0.88-0.98x the venue\u2019s own HALF-spread** (Gold 0.0100/0.0097, Silver 0.0600/0.0592, Ethereum '
      + '0.1100/0.1250, Sugar 0.0700/0.0718): `decisionPrice` is a MID and the fill lands at the TOUCH, so the '
      + 'movement the placeholder charges for is the spread crossing the spread term ALREADY charges for. '
      + '`agent/slipDerivation` computes the residual BEYOND the touch, floors it at zero (a negative cost is the most '
      + 'permissive budget this codebase can express, and the raw median is kept so the zeroing stays visible), and '
      + 'refuses any symbol below 20 fills BY NAME. `store/fills.js` owns the query; `costCfgFor` labels every run '
      + '`derived_fill_telemetry` or `calibrated_placeholder`, with its `slippageSample`.',
    invalidates: '\u26a0\u26a0 NOTHING YET, BECAUSE IT IS SWITCHED OFF \u2014 and that is the point. Applying the '
      + 'residual collapses Gold\u2019s modelled round trip from **11.94 bps to 1.94 bps** (Silver 19.36 -> 9.36, '
      + 'Oil 17.28 -> 7.28, Ethereum 35.02 -> 25.02), and that number feeds FOUR gates at once: venue admission, the '
      + 'net-edge screen, the stop cap and `maxCostShareOfR`. A 6.2x loosening of four gates is an OWNER decision, so '
      + 'it is `risk.costBasis.useMeasuredSlippage` (default **false**); until it is set the placeholder stands and '
      + 'every run says `calibrated_placeholder`. \u26a0 THIS IS THE SAME TERM THAT WAS PUBLISHED WRONG ON '
      + '2026-10-27: a round trip was compared against a spread and the difference was called a 6.76x spread error '
      + '\u2014 the difference WAS this placeholder. Reproducible with `temp/slippage-provenance.js`; the comparison '
      + 'guard is `agent/measurement.js`.',
  },
  {
    id: 'news-undated-engine-dropped',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE ENGINE THAT SUPPLIED EVERY UNDATED ROW IS EXCLUDED BY NAME, AND THE EXCLUSION IS COUNTED. Measured '
      + 'over the whole `NewsItems` corpus: `bing news` **474 rows / 474 undated (100%)**, `yahoo news` 79 / 0, '
      + '`duckduckgo news` 77 / 0. One engine supplied 75% of the volume and every undated row \u2014 so "79 of 94 '
      + 'recent rows undated" was entirely its doing, and the feed is now 100% dated by construction. `denyEngines` is a '
      + 'declared list (an empty list restores the previous behaviour exactly) applied as a POST-FILTER on the '
      + 'response, NOT as a searxng engine-selection parameter: a wrong selection returns NOTHING, which is '
      + 'indistinguishable from a quiet world \u2014 the failure `newsAggregator` exists to prevent. `deniedEngine` is '
      + 'reported separately from `dropped` and `tooOld`, because "we chose not to take this engine" is a third fact.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 the news lane is content-only; no risk, sizing, stop or entry '
      + 'input reads it. \u26a0 IT DOES INVALIDATE VOLUME COMPARISONS ACROSS THE BOUNDARY: the feed drops from ~630 '
      + 'stored rows to the ~156 that carry a date, so "news items per day" is not comparable either side of this '
      + 'point. That is the intended trade \u2014 a row with no date cannot be ordered against an observation, which is '
      + 'the only thing the ledger is for.',
  },
  {
    id: 'daily-instrument-refresh',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE CONTRACT-SPEC FACTS ARE NOW REFRESHED ON A TIMER, FOR FUNDING AND MINIMUM SIZE ONLY. `Instruments` is '
      + 'the only lane for `fundingBuyPct`/`fundingSellPct`/`unitAmount`, and it was fed only by a manual UI probe: '
      + 'measured 2026-10-27, 44 rows across 24 symbols with the newest at **2026-10-01, 26 days stale**. That reaches '
      + 'the LIVE path through `carryPctFor`, which prices overnight carry on held positions. '
      + '`plus500/instrumentRefresh` runs `instrumentProbe.run({scan: 6})` once per day inside 02:00-04:59Z and only '
      + 'when the last successful run is more than 23h old; `shouldRun` is pure and tested (72 hourly ticks yield 2-4 '
      + 'runs, never 72).',
    invalidates: 'NOTHING DIRECTLY \u2014 it refreshes facts that were ALREADY being read, from 26 days stale to 1 '
      + 'day. \u26a0 THE LIVE EFFECT IS ON CARRY, NOT ON SIGNALS: `costFactLines` (the chairs\u2019 bundle) and '
      + '`carryPctFor` change value the first time a rate has moved at the venue, and a funding rate is a COST on a '
      + 'multi-night hold, so a changed rate changes the modelled carry of positions held after it. \u26a0 AND IT IS '
      + 'NOT FOR THE SPREAD: the probe was nearly scheduled to restore `InstrumentQuotes`, which was ALSO 26 days '
      + 'stale, but the spread is measured better from `spreadSubmitPct`/`spreadSignalPct` (agreeing within 3%). '
      + 'Scheduling it for quotes would have taken the `ticket` lock \u2014 which orders wait up to 240s on \u2014 to '
      + 're-learn a fact already known.',
  },
  {
    id: 'doc-drift-corrections',
    landedAt: '2026-10-26',
    row: null,
    title: 'THREE DOCUMENTS WERE WRONG INSIDE ONE SESSION, SO THE RULE BECAME CHECKABLE. `AGENTS.md` still said '
      + '`watchlist.symbols` was operator-owned and "never written by the machine" four hours after '
      + '`store/ownership.js` began classifying it CO-OWNED BY ENTRY to match what `agent/discoverer.js` actually '
      + 'does; `trading/store.js` cited `temp/trail-grid.js` as the producer of the 5,359-breakout sweep still quoted '
      + 'as a basis for `takeProfitRR`, and that script does not exist; and the session handoff asserted that '
      + '`InstrumentQuotes` gated per-symbol work, which propagated into a plan before it was disproved. `AGENTS.md` '
      + 'gains \u00a78: CODE IS AUTHORITATIVE FOR BEHAVIOUR, DOCS FOR INTENT, AND WHERE THEY DISAGREE THE DOC IS THE '
      + 'BUG. `test/ownership-doc-sync.test.js` makes the ownership paragraph checkable in both directions.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 comments and tests only; no dial, gate, level or settings value '
      + 'changes. \u26a0 IT DOES PUBLISH A FINDING: eleven citations in RUNTIME code point at `temp/` scripts that no '
      + 'longer exist, including `agent/spreadDerivation.js` citing the harness that allegedly reproduced the curated '
      + 'spread table 7/7 and `agent/stopPolicy.js` citing both sweep scripts behind the stop-cap and cost-share '
      + 'numbers. Those figures are now claims whose producer is gone. They are RATCHETED, not fixed \u2014 the list '
      + 'can only shrink, and each entry needs either a re-derivation or a plain statement that the producer is lost. '
      + '\\u26a0 The first version of that check scanned every `trading/**/*.js` and reported 25 hits, most of which '
      + 'were output filenames rather than citations: the guard was measuring the wrong thing, and narrowing it to '
      + 'runtime code is the correction.',
  },
  {
    id: 'external-constraint-resolver',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE EXTERNAL CONSTRAINT LEDGER HAS A RESOLVER. `trading/agent/constraints.js` answers one question â€” given '
      + 'the stored versions of a constraint and an instant, which version applied, and did we know it then â€” and '
      + 'returns three outcomes: `satisfied`, `breached`, `unassessable`. Migration 052 created the table; this is the '
      + 'pure reader over it. THE THIRD OUTCOME IS THE POINT: missing, undatable or unrecoverable evidence lands in '
      + '`unassessable`, never in `satisfied`, because a clean pass from absent history is the one failure a report is '
      + 'most likely to produce by accident.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a pure module with no consumer yet; no gate, dial, level or '
      + 'settings value reads it. \u26a0 THREE RULES IT ENCODES THAT A FUTURE READER IS MOST LIKELY TO \"FIX\" INTO '
      + 'BUGS: (1) AN UNKNOWN `effectiveFrom` IS A CANDIDATE AND NEVER IN FORCE \u2014 assuming it applied would '
      + 'invent history, and omitting it would silently produce a pass, so a candidate on a subject forces that '
      + 'subject\u2019s assessment to `unassessable` and NAMES the blocking row; (2) THE TWO CLOCKS ARE SEPARATE \u2014 '
      + '`inForce` uses the window and answers \"did we honour what applied\", `knownAt` uses `recordedAt` and answers '
      + '\"why did we behave that way\", and a version in force but learned later is reported as `lateDiscovery` '
      + 'rather than hidden; (3) A NUMERIC LIMIT WITHOUT A STATED DIRECTION IS `unassessable` \u2014 the row stores a '
      + 'value and a unit and deliberately not intent, because guessing whether a limit is a floor or a ceiling would '
      + 'manufacture a verdict.',
  },
  {
    id: 'constraint-ledger-append-path',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE CONSTRAINT LEDGER HAS A WRITE PATH, AND ITS NO-OVERLAP RULE IS ACTUALLY ENFORCED. Migration 052 '
      + 'cannot express \"two versions of one key may not describe the same instant\", so `store/constraints.js` does '
      + 'it inside a transaction with the key\u2019s rows locked (`UPDLOCK, HOLDLOCK`). Without the lock two concurrent '
      + 'appends each read \"no overlap\" and both insert, which is exactly how a resolver ends up with two answers '
      + 'for one instant and no tie-break. `vw_ConstraintOverlaps` is the audit of that guard. The module is '
      + 'APPEND-ONLY BY CONSTRUCTION: no update path, no delete path, so a correction can only ever be a new row with '
      + '`supersedesId`. Pure validation (`constraints.validateVersion`) mirrors the SQL CHECK and adds what SQL '
      + 'cannot say \u2014 notably that a `confirmed` row REQUIRES `evidenceArtifactRef`, because a confirmed '
      + 'constraint with no retained artefact cannot support a verdict and must not be able to exist as confirmed.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a write path with no caller beyond its own verification; no '
      + 'gate, dial, level or settings value reads it. \u26a0 TWO THINGS IT DOES ESTABLISH: (1) `recordedAt` is '
      + 'DEFAULTED BY THE DATABASE (`SYSUTCDATETIME`), never by the API process clock, because it records when the '
      + 'DESK learned \u2014 a backfill of something captured earlier must be able to state that explicitly; '
      + '(2) AN ABUTTING WINDOW IS NOT AN OVERLAP. `[Jan, Feb)` followed by `[Feb, Mar)` is two versions, and the '
      + 'half-open convention is what makes a successor expressible at all \u2014 a reader who \"fixes\" the guard to '
      + '`<=` would make every supersession impossible. Verified end to end against the real table by '
      + '`temp/verify-052-append.js` (14 checks, probe rows deleted in a `finally`).',
  },
  {
    id: 'constraint-bootstrap',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE CONSTRAINT LEDGER HAS ITS FIRST 51 ROWS, ALL DELIBERATELY UNDATED. `agent/constraintBootstrap.js` + '
      + '`scripts/bootstrap-constraints.js` capture five venue terms per traded instrument (minimum trade size, initial '
      + 'margin, funding buy/sell, funding time) plus ONE venue-wide prohibition, from the `Instruments` snapshot the '
      + 'desk already holds. EVERY ROW IS `effectiveFrom = null` BECAUSE THAT IS THE TRUTH: `Instruments` UPSERTS in '
      + 'place, so it cannot say when a term took effect. Every row is therefore a CANDIDATE the resolver never treats '
      + 'as in force, and that is the correct starting state rather than a defect to be papered over.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 51 rows in a table no gate, dial or level reads. \u26a0 FOUR '
      + 'RULES THE CAPTURE ENFORCES, EACH MEASURED RATHER THAN ASSUMED: (1) LEVERAGE IS NOT CAPTURED AT ALL \u2014 '
      + '`leverageRaw` and `initialMarginPct` are ONE fact (1/5=20%, 1/10=10%, and the venue\u2019s 60% renders as '
      + '1:1.67), so storing both would be two producers of one fact that disagree in the third case; (2) KEYS ARE '
      + 'PER-INSTRUMENT (`plus500.<venueInstrumentId>.<field>`) because both the unique index and the overlap rule are '
      + 'per key \u2014 a shared key would collide the moment either instrument is dated; (3) A NEGATIVE FUNDING RATE '
      + 'SURVIVES \u2014 it is a cost, not an absence; (4) NO ARTEFACT IS WRITTEN WHEN NOTHING NEW WOULD BE CAPTURED, '
      + 'because an evidence store full of unreferenced files stops being evidence. \u26a0 AND A REFINEMENT TO '
      + '`assessSubject`: recording margin and funding would have made EVERY trade permanently `unassessable`, since '
      + 'no trade observation covers them. Constraints outside the caller\u2019s `checks` list are now reported as '
      + '`informational` \u2014 listed, visible, excluded from the verdict \u2014 rather than silently forcing a verdict '
      + 'nobody can read.',
  },
  {
    id: 'constraint-reconciliation',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE LEDGER IS RECONCILED AGAINST THE REGISTRY WEEKLY, AND THE FIRST RUN SAYS 50 OF 51 ASSERTIONS STILL '
      + 'MATCH. `agent/constraintReconcile.js` compares every assertion to the current `Instruments` snapshot and logs '
      + '`constraint_reconcile`. READ-ONLY: it never writes a constraint, so a detector cannot become a producer. '
      + 'âš  IT IS ALSO THE ONLY MECHANISM THAT CAN PRODUCE A DATED PAIR â€” a constraint cannot be dated from nothing, '
      + 'and comparing two observations is how a change becomes visible at all. That is why it precedes the dating '
      + 'work rather than competing with it.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a weekly read-only report; no gate, dial or level reads it. '
      + '\u26a0\u26a0 IT EXPOSES A MODELLING GAP THAT MUST BE CLOSED BEFORE ANY DATE IS EVER WRITTEN: a change '
      + 'detected between captures happened SOMEWHERE in that interval. `effectiveFrom = <now>` would assert an '
      + 'instant we do not know; another undated candidate records no progress. The honest representation is a BOUNDED '
      + 'interval, and `ConstraintVersions` has nowhere to put one. So the finding is named (`datedChange: false`) and '
      + 'the dating question stays OPEN \u2014 that is a schema decision for the owner, not a guess for a timer. '
      + '\u26a0 TWO LABELLING DEFECTS IT FOUND IN ITSELF: a legitimate VENUE-WIDE key (`plus500.single_tab`) was '
      + 'reported as `unparsable_key` because the parser only accepted three segments \u2014 a valid row rendered as a '
      + 'broken one, which sends a reader to inspect data when the parser was the bug; and funding time is stored in '
      + 'UTC minutes while the venue label is LOCAL (`5:00 AM` -> 1260, not 300), so comparing a locally-parsed value '
      + 'against a stored one would report a permanent 16-hour phantom drift.',
  },
  {
    id: 'bounded-effective-start',
    landedAt: '2026-10-26',
    row: null,
    title: 'A CONSTRAINT START CAN NOW BE BOUNDED RATHER THAN GUESSED. Migration 053 adds `effectiveFromNotBefore` / '
      + '`effectiveFromNotAfter`, so an observation-derived change can be recorded as \"the true start lies somewhere in '
      + 'this interval\" instead of as a fabricated exact date or as no progress at all. The resolver gains a FOURTH '
      + 'state, `uncertain`: before the interval the version cannot have started (NOT_IN_FORCE), at or after its end it '
      + 'had certainly started (IN_FORCE), and INSIDE it neither answer is available. The value over a bare candidate '
      + 'is that the unassessable window SHRINKS to the interval rather than extending to the end of time.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a nullable column pair and a resolver state; no gate, dial or '
      + 'level reads them. \u26a0 THREE RULES: (1) EXACT AND BOUNDED ARE MUTUALLY EXCLUSIVE \u2014 carrying both is '
      + 'not more information, it is two answers to one question, and the row is refused; (2) THE OVERLAP GUARD USES '
      + 'THE EARLIEST POSSIBLE START, which makes a collision MORE likely \u2014 admitting uncertainty must never make '
      + 'the guard more permissive; (3) `uncertain` is NOT `candidate` and is reported separately, because a candidate '
      + 'has no date and an uncertain row has a range the instant falls inside. \u26a0 AND A CHECK WAS DELETED FROM '
      + '053 BEFORE IT SHIPPED: the first draft required a row to carry a bound, and every branch of it reduced to a '
      + 'tautology because the no-bound state is legitimate \u2014 a CHECK that cannot fail reads as a guard in review '
      + 'and enforces nothing. \u26a0 UNTIL 053 IS APPLIED, EVERY READ FAILS LOUDLY with `Invalid column name` \u2014 '
      + 'deliberate: the alternative is a store that silently omits the columns and reconciles against nothing.',
  },
  {
    id: 'boundary-audit-sees-schema',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE BOUNDARY AUDIT CAN NOW SEE A SCHEMA CHANGE, AND IT COULD NOT BEFORE. `changeAudit` reasons from '
      + 'settings writes and `trading/**` mtimes; `sql/migrations/**` was invisible to both. Measured 2026-10-26: '
      + 'migrations 052 and 053 were APPLIED to the live database across a declared freeze boundary and '
      + '`check-epoch-coverage.js` printed "nothing unaccounted for after 2026-10-26T22:31:00Z" \u2014 true of its '
      + 'two sources, wrong about the system, because DDL is applied in SSMS and touches no settings row and no file '
      + 'under `trading/`. A third ADVISORY source now names them.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a reporting source; no gate, dial or level reads it. '
      + '\u26a0\u26a0 THE NEW SOURCE HAS A LIMIT THAT TRAVELS WITH EVERY FINDING IT MAKES: an mtime is when the file '
      + 'was WRITTEN, not when the DDL was APPLIED. A migration authored in September and run today is still '
      + 'invisible to all three sources. So schema changes are ADVISORY and are never asserted as boundaries \u2014 '
      + 'the finding carries "written, not applied" in its own `note`, because an absent statement reads as a clean '
      + 'result and that is precisely how 052/053 passed. \u26a0 INSIDE A FREEZE IT IS STILL A BREACH: the window '
      + 'admits no exceptions by source. \u26a0 AND THE ALTERNATIVE WAS REJECTED ON PURPOSE: a boot probe recording '
      + 'first-seen markers would date the APPLICATION, but its marker list is a second producer of the migration '
      + 'list that drifts \u2014 the exact defect it is meant to catch.',
  },
  {
    id: 'constraint-reconcile-boot-catchup',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE CONSTRAINT RECONCILE NOW RUNS AT BOOT AS WELL AS WEEKLY, THROTTLED TO SIX HOURS. Weekly-only meant '
      + 'the first automatic run after any restart was seven days away, and silence from a detector is '
      + 'indistinguishable from agreement: a reconcile that had broken \u2014 a failed read, a renamed source field '
      + '\u2014 looked exactly like 51 constraints matching for a week. `shouldRunOnBoot` is pure and the boot entry '
      + 'point is `runOnBoot`.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 read-only; it never writes a constraint, so a detector cannot '
      + 'become a producer, and it catches its own failures. \u26a0 THE THROTTLE IS NOT TIDINESS: every run appends a '
      + '`constraint_reconcile` event and the desk has a crash guard that restarts dead children, so an unthrottled '
      + 'boot run turns a restart loop into event spam \u2014 which is how a useful signal becomes a row nobody reads. '
      + '\u26a0 IT FAILS OPEN ON AN UNREADABLE LAST-RUN AND CLOSED ON AN UNREADABLE CLOCK, deliberately: a corrupt '
      + 'timestamp must not suppress the check, but a broken clock is not evidence of staleness. \u26a0 THE WINDOW IS '
      + 'RESTARTED for the ordinary reason: `trading/**` changed. No dial, gate or level moved.',
  },
  {
    id: 'pool-sql-handle-guard',
    landedAt: '2026-10-26',
    row: null,
    title: 'THE POOL OWNS THE SQL TYPE HANDLES, AND THAT IS NOW MECHANICAL. `trading/agent/waker.js` has documented '
      + 'since it was found the hard way that `require(\'mssql\')` from under `trading/` resolves to '
      + '`trading/node_modules/mssql` \u2014 a DIFFERENT instance from the pool\'s \u2014 so its type classes fail. A new '
      + '`lastRunAt()` walked into it anyway, threw on every call, and its own `catch` swallowed the error, so the '
      + 'boot log reported `never_reconciled` beside three events that EXISTED. The guard, Invariant D in '
      + '`test/architecture-conformance.test.js`, now fails the build if any library file under `trading/` takes its '
      + 'own handle.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a test invariant plus a read-only diagnostic. \u26a0\u26a0 THE '
      + 'DEFECT WAS NOT THE THROW, IT WAS THE SILENCE: a swallowed read error produced a PLAUSIBLE reason '
      + '(`never_reconciled`), so the throttle opened, the run happened, and nothing looked broken. Fail-open is the '
      + 'right behaviour here \u2014 a corrupt log must not suppress the check \u2014 but it must not be quiet about '
      + 'WHY it failed, which is AGENTS.md \u00a77 applied to the guard\'s own plumbing. \u26a0 The window is restarted '
      + 'because the fix landed after it opened, within minutes of the entry it repairs.',
  },
  {
    id: 'supersession-retires-a-candidate',
    landedAt: '2026-10-26',
    row: null,
    title: 'A CORRECTED CONSTRAINT NOW STOPS BLOCKING ASSESSMENTS. `resolveSubject` read every row and retired '
      + 'none, so appending a correction left the WRONG row live as an undated `candidate` beside the new one \u2014 '
      + 'and a single candidate is enough to make every affected assessment UNASSESSABLE. The correction looked like '
      + 'it had worked (the value was there, the overlap guard stayed quiet) while the ledger went on refusing to '
      + 'answer for ever, and that refusal reads as caution rather than as a bug. `supersededIds` now retires any row '
      + 'another row names.',
    invalidates: 'NOTHING IN THE DECISION PATH by itself \u2014 it changes which rows the resolver will CONSIDER, and '
      + 'nothing consumes the resolver yet. \u26a0\u26a0 TWO MECHANISMS, DELIBERATELY KEPT APART: `supersedesId` means '
      + '\'the row I point at was WRONG\' and retires it at every instant; `effectiveTo` means \'the period ENDED\' and '
      + 'leaves the row readable inside its own window. Conflating them would either make history unreadable or leave '
      + 'a known-false row applying. \u26a0 AND THE BELIEF VIEW IS UNAFFECTED ON PURPOSE: `knownAt` still returns the '
      + 'superseded row before the correction was recorded, because the desk really did believe it then \u2014 '
      + 'answering that question with the correction would be a fiction. \u26a0 A row with no id is never retired, and a '
      + 'reference to an id not present retires nothing, so a dangling pointer cannot silently empty the ledger.',
  },
  {
    id: 'assessability-floor-from-epochs',
    landedAt: '2026-10-27',
    row: null,
    title: 'A CONSTRAINT CAN NOW BE REFUSED AS "TOO EARLY TO JUDGE", WITH THE DATE DERIVED FROM THE EPOCH '
      + 'REGISTRY. `agent/assessability.js` maps a constraint FIELD to the epoch that made it measurable '
      + '(`minimum_trade_size` -> `size-contract-scale`, 2026-10-02) and cites IDS ONLY; the date is looked up. '
      + '`assessSubject` takes `floors` and answers `before_assessability_floor` instead of running the comparison.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a new optional parameter on a resolver nothing consumes yet. '
      + '\u26a0\u26a0 TWO DATES, AND CONFLATING THEM IS THE WHOLE DEFECT: `effectiveFrom` is when the WORLD changed; '
      + 'the floor is when THIS DESK became able to see it. `minimum_trade_size` before 2026-10-02 could not be '
      + 'honoured or checked at all \u2014 the desk\'s own missing contract scale refused every entry and it recorded '
      + 'that as a venue fact ("the minimum is ~487% of equity"). An audit dated earlier measures the bug, not the '
      + 'venue. \u26a0 A NEW `assessableFrom` COLUMN WAS REJECTED: 50 constraint rows carrying one epoch\'s date is 50 '
      + 'copies of one fact that `epoch.js` already owns, and they drift. \u26a0 THE COMPARISON IS NEVER RUN BEFORE '
      + 'THE FLOOR \u2014 running it and discarding the result would still leave a BREACHED a caller could surface. '
      + '\u26a0 AND ONE REGISTRY GAP IS NOW NAMED RATHER THAN HIDDEN: `initial_margin_pct` has NO floor because the '
      + 'account-currency factor in `risk.js` has NO epoch \u2014 measured 2026-10-27, no FEATURES entry mentions '
      + 'currency, fx, sgd or margin at all.',
  },
  {
    id: 'fx-per-pair-generalisation',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE FX DERIVATION IS PER-PAIR AND REFUSES TO BLEND. `agent/fxRate.js` derives SGD per ONE UNIT of the '
      + 'instrument\'s quote currency, so its plausibility band and its value gate are properties of the PAIR \u2014 and '
      + 'both were USD/SGD\'s, applied to every pair. Worse, `deriveRate` took every pair into ONE median without '
      + 'grouping, so a single EUR position among USD ones would have blended ~1.29 with ~1.50 into a number that '
      + 'still PASSED the band. It now groups, and refuses `mixed_currencies` by name.',
    invalidates: 'NOTHING IN THE DECISION PATH CHANGES TODAY \u2014 no instrument currency is recorded, so every '
      + 'result carries `basis: \'assumed_default\'` and the same value as before. What changes is what happens when '
      + 'one is recorded. \u26a0\u26a0 THE OWNER\'S CASE: a French or German stock quotes in EUR, so its rate is '
      + 'SGD-per-EUR and NOTHING about USD/SGD\'s 1.10-1.55 band applies \u2014 it would have refused correct rates as '
      + 'implausible, or accepted wrong ones inside a widened band. \u26a0 IT FAILS CLOSED: a currency with no '
      + '`PAIR_PARAMS` entry is REFUSED by name rather than handed USD\'s parameters, because assuming EUR/SGD trades '
      + 'like USD/SGD is the same defect `accountCurrency.js` documents. Adding a currency is now a deliberate act '
      + 'with a stated band. \u26a0 THE ASSUMPTION IS VISIBLE: `basis` is `recorded_currency`, `caller_supplied` or '
      + '`assumed_default`, and `unrecordedSamples` counts the samples that could not be attributed \u2014 an assumed '
      + 'currency and a known one must never look alike. \u26a0 `usdMove`/`usdMoveMin` RENAMED to `move`/`moveMin`: the '
      + 'quantity is a move in the INSTRUMENT\'s currency, and the old name was a unit claim the code could not keep. '
      + '\u26a0 THE QUOTE CURRENCY IS RESOLVED THROUGH `instruments.js` (`quoteCurrencyOf`), not looked up in the '
      + 'poller \u2014 invariant A caught the first attempt, correctly.',
  },
  {
    id: 'unit-amount-label-captured',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE VENUE\'S OWN NAME FOR COLUMN-0 IS NOW READ, ONE SELECTOR AWAY FROM WHERE IT ALWAYS SAT. '
      + 'Migration 045 added `Instruments.unitAmountLabel` for exactly this and it was NULL on 44 of 44 rows, because '
      + 'the lookup matched a `listItems` entry whose VALUE equalled the stat box \u2014 a route that cannot fire, since '
      + 'the venue does not repeat the number in its labelled pair list. Measured live: '
      + '`sidebar.rates-and-values.column-0.label` reads "Unit amount" on Gold, Soybeans and Silver.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a nullable provenance column; no gate, veto or level reads it. '
      + '\u26a0\u26a0 WHAT THE WORD SETTLES, WHICH IS THE POINT OF RECORDING IT: the desk calls this field a MINIMUM '
      + 'TRADE SIZE and the VENUE calls it a UNIT AMOUNT. Those are different claims. Without their word on the row, '
      + 'the ledger\'s `minimum_trade_size` reads as a term the venue uses rather than as OUR interpretation of a field '
      + 'they never named that way. \u26a0 AND IT CORRECTS AN EARLIER FINDING OF MINE: `unitKind` was reported as a '
      + 'desk-authored enum with no venue provenance. It is read from `column-0.sub-value` directly, so "Troy Ounces" '
      + 'and "Bushels" ARE the venue\'s words and the ledger\'s `valueUnit` was never lacking provenance. What was '
      + 'missing was the FIELD\'s name, not the unit\'s. \u26a0 POPULATION IS NOT DONE: `Instruments` is written only by '
      + 'the scheduled refresh inside 02:00-04:59Z, so the 44 rows stay NULL until that window. Deliberately not '
      + 'backfilled out of hours \u2014 the window exists to keep a refresh from meeting a live session.',
  },
  {
    id: 'ownership-registry-gap-closed',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE OWNERSHIP REGISTRY IS NO LONGER NARROWER THAN THE DECISION IT ENFORCES. ADR-0001 classifies '
      + '`budget.*` as operator-owned and `discovery.*` as machine-owned; `ownership.RULES` contained NEITHER, so a '
      + 'machine write to either was classified `shared` and raised nothing. Both are now in `RULES`, and `AGENTS.md` '
      + '\u00a72 names them because the doc-sync test checks both directions.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a classification table; nothing reads it to gate an action, and '
      + '`saveSettings` still REPORTS a crossing rather than refusing the write, which is unchanged. '
      + '\u26a0\u26a0 THE DIRECTION OF THE ERROR MATTERS: a registry narrower than its decision is wrong in the QUIET '
      + 'way \u2014 every crossing still looks accounted for, and the absence reads as clean. Measured behaviourally '
      + 'after the change: `ownerOf` returns operator for `budget.dailyUsd` and machine for `discovery.enabled`, and '
      + 'a machine write to `budget.dailyUsd` now produces a violation naming the owner. \u26a0 IT COULD NOT BE '
      + 'PATCHED QUIETLY: adding the paths forced `AGENTS.md` \u00a72 and ADR-0001 to change in the same commit, which '
      + 'is the coupling the ADR recorded as the reason to wait rather than the obstacle to route around.',
  },
  {
    id: 'constraints-dated-bounded-era',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE LEDGER CAN FINALLY ANSWER: 50 BOOTSTRAPPED CONSTRAINTS ARE DATED WITH A BOUNDED START, AND '
      + '`plus500.single_tab` IS DELIBERATELY LEFT UNDATED. `trading/scripts/date-constraints.js` supersedes each '
      + 'undated capture with the same fact plus the window `[2026-09-19, 2026-10-26)`. Before it, every row was a '
      + 'CANDIDATE and one candidate makes every assessment `unassessable` \u2014 the ledger held the facts and could '
      + 'say nothing about them.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 nothing reads the resolver yet; no dial, gate or level moved. '
      + '\u26a0\u26a0 IT DOES NOT INVENT A START DATE. `effectiveFrom = <guess>` would assert an instant no evidence '
      + 'supports, which is what this table exists to refuse; the start is BOUNDED instead, so the three instants '
      + 'answer differently \u2014 measured after the change on `plus500.11.minimum_trade_size`: 2026-09-01 nothing in '
      + 'force, 2026-10-01 UNCERTAIN, 2026-10-27 IN FORCE and SATISFIED. \u26a0 THE ORIGINAL ROW IS SUPERSEDED, NOT '
      + 'EDITED: the undated capture was a correct record of what was observed, and supersession is what stops it '
      + 'blocking for ever (Phase 3a). Ledger 51 \u2192 101 rows, 0 overlaps, reconcile still `match` 50/51. '
      + '\u26a0 `single_tab` STAYS UNDATED ON PURPOSE: the venue did not change on 2026-10-26, we LEARNED about it '
      + 'by watching a second tab get signed out \u2014 bounding it would put our learning date into the world\'s record. '
      + '\u26a0 AND A SCRIPT BUG WORTH KEEPING: the first version exited non-zero on a clean run because it counted '
      + 'the declared exception as a leftover candidate \u2014 a check that could not tell "finished" from "broken", '
      + 'in the script written to avoid exactly that.',
  },
  {
    id: 'smoke-runs-on-a-live-desk',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE SMOKE SUITE IS RUNNABLE AGAIN, AND IT HAD NOT BEEN FOR AS LONG AS THE SINGLETON GUARD EXISTED. '
      + '`server.js` refuses to boot when something answers /healthz on its port (`desk-singleton-guard`), the port '
      + 'was hard-coded 8115 \u2014 the LIVE desk \u2014 and `smoke.js` overrode only `TRADING_PORT`. So every `npm test` '
      + 'died with exit 3 having tested nothing. `TRADING_HEALTH_PORT` is now overridable and the smoke child takes its '
      + 'own free port, so the guard still asks its question and correctly gets "no".',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a config override and a test harness. No dial, gate or level. '
      + '\u26a0 THE GUARD ITSELF IS UNCHANGED AND NOT BYPASSED: there is no `if (smoke) skip`, so nothing can be left '
      + 'set that quietly disables a safety check. \u26a0 AND IT WAS NEVER PART OF THE PROTOCOL, WHICH IS WHY NOBODY '
      + 'NOTICED: step 5 is `test:unit`, which is DB-free and desk-free, so the suite that actually boots a second '
      + 'server was never invoked. Measured after the fix: 136 + 9 + 98 = 243 checks green with the desk running. '
      + '\u26a0 TWO HARNESS DEFECTS FOUND BY RUNNING IT: `scripts/smoke-test.js` used `stdio: \'ignore\'`, so a boot '
      + 'failure reported a port and the word FATAL and threw the child\'s output away (it now prints the tail or says "no '
      + 'output at all"); and the first run failed at an 8s readiness window that the second passed, so the gate is '
      + 'FLAKY \u2014 recorded, not yet widened.',
  },
  {
    id: 'audit-skips-dot-directories',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE FREEZE AUDIT NO LONGER REPORTS BROWSER CHURN AS A CHANGE OF BEHAVIOUR. The `trading/**` mtime walk '
      + 'excluded `.chrome-profile` BY NAME, and when a second profile appeared the audit reported '
      + '`trading/.librewolf-profile/prefs.js` as a freeze breach on 2026-10-27 \u2014 a file the browser rewrites, not '
      + 'desk code. Dot-directories are now skipped as a CLASS, matching how `test/architecture-conformance.test.js` '
      + 'already walks.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 which files an audit READS; it cannot change a verdict about the '
      + 'desk. \u26a0\u26a0 THE FAILURE MODE THIS CLOSES IS THE ONE THE FILE ALREADY ARGUES AGAINST: a guard that is red on '
      + 'the normal case is a guard nobody keeps, and a reader who sees a breach every browser launch learns to skip '
      + 'the whole section \u2014 including the real boundary beside it. Naming instances one at a time is how that '
      + 'happens: `.chrome-profile` was handled and `.librewolf-profile` was not.',
  },
  {
    id: 'constraint-audit-consumer',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE LEDGER HAS A CONSUMER, AND ITS FIRST ANSWER IS `unassessable` NAMING `plus500.single_tab`. '
      + '`agent/constraintAudit.js` assesses closed trades against the constraints in force at the trade\'s own instant: '
      + '`minimum_trade_size` is checked (its observation is the trade\'s `size`), everything else is recorded as '
      + '`informational`. It runs AFTER THE FACT, read-only, because there is no choke point for trade closure.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a read-only reporter with NO TIMER WIRED, so it does not yet '
      + 'run on its own. \u26a0\u26a0 WHY IT RUNS AFTER THE FACT: `closeTrade` is defined TWICE (`executor.js:870` live, '
      + '`paper.js:104` paper) and called from ten sites; the only shared write, `store.updateTrade`, is used 8x by '
      + 'the executor and ZERO times by paper. A close-time hook would have SKIPPED EVERY PAPER CLOSE, producing no '
      + 'assessment \u2014 indistinguishable from "no breach", in the feature built to prevent exactly that. '
      + '\u26a0 THE COST IS NAMED: it can REPORT a breach, never prevent one. \u26a0\u26a0 AND THE FIRST REAL RUN FOUND A '
      + 'REAL BLOCKER, NOT A BUG: every closed trade returns `unassessable` because `plus500.single_tab` is an '
      + 'UNDATED venue-wide PROHIBITION, so it is a candidate for every subject and a candidate blocks any clean pass. '
      + 'That is the room working. I TRIED TO MAKE IT GO AWAY by filtering out-of-scope blockers with `checks` and '
      + '`test/constraints.test.js:177` refused it \u2014 correctly, because the verdict is PER SUBJECT and `satisfied` '
      + 'would then read as a clean trade while the margin stayed unknown. The fix belongs to the LEDGER (date the row), '
      + 'not to the verdict.',
  },
  {
    id: 'scoped-assessment-and-entry-instant',
    landedAt: '2026-10-27',
    row: null,
    title: 'A NARROWER CLAIM WITH ITS OWN NAME: `assessScoped` answers "did this subject honour THESE keys?" and '
      + 'lists everything else in `notJudged` with its reasons. `assessSubject` is UNCHANGED and still blocks a '
      + 'whole-subject verdict on any unknown. `constraintAudit` now judges at ENTRY time (`filledAt`, else `openAt`) '
      + 'and carries `RULES_VERSION`.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a second assessment function and a consumer; no dial, gate or '
      + 'level. \u26a0\u26a0 WHY TWO FUNCTIONS: the whole-subject verdict answers for the WHOLE subject, so `satisfied` '
      + 'is a claim about every applicable constraint and an unknown one must block it (pinned by '
      + '`test/constraints.test.js:177`). A trade audit cannot make that claim \u2014 it has an observation for '
      + '`minimum_trade_size` and nothing for a venue-wide prohibition, which is violated by an ACTION no trade row '
      + 'records. Asked the subject question it answers `unassessable` for ever, correctly and uselessly. '
      + '\u26a0 THE RULE THAT KEEPS IT HONEST: a REQUESTED key that is itself undated or uncertain comes back '
      + 'UNASSESSABLE, never `notJudged` \u2014 moving it would let a scoped check look clean by reclassifying the '
      + 'thing it was asked about. \u26a0\u26a0 THE INSTANT WAS WRONG AND IS NOW ENTRY: v1 judged at `closeAt`, which '
      + 'could compare a September entry against an October minimum. `RULES_VERSION` 1 records that; the 200 rows it '
      + 'wrote are superseded by version in the dedupe key rather than deleted (TradingEvents is append-only, §4). '
      + '\u26a0 MEASURED AFTER THE FIX: 26 satisfied (exactly the 26 trades after the bounded window), 171 '
      + 'unassessable with a named reason, 3 `instrument_unknown` \u2014 all three are OPTION contracts whose venue '
      + 'names never appear in `Instruments`, a gap in the instrument map rather than in the ledger.',
  },
  {
    id: 'constraint-audit-window-and-timer',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE ASSESSMENT PASS NOW COVERS ITS WHOLE WINDOW AND SAYS WHEN IT DOES NOT, AND IT RUNS HOURLY. '
      + '`runOnce` fetched `TOP 200 ... ORDER BY closeAt DESC` and called that the window; measured, 247 trades had '
      + 'closed in 30 days, so 47 were NEVER ASSESSED and nothing in the output said so. The population is now the '
      + 'WINDOW, and a row cap only withholds with `truncated` + `remaining` stated. Timer: boot + hourly.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a read-only reporter and its schedule; no dial, gate or level. '
      + '\u26a0\u26a0 IT WAS THE SAME DEFECT `store.EVENT_QUERY_CAP` ALREADY DOCUMENTS \u2014 "a caller asking for more '
      + 'silently received less and could not tell a TOTAL from a FLOOR" \u2014 rebuilt one file over, and it took '
      + 'counting the population to see it. A row cap standing in for a time window is the confusion that hid it: they '
      + 'answer different questions. \u26a0 MEASURED AFTER THE FIX: `total 247, processed 247, truncated false, '
      + 'remaining 0`; the 47 abandoned trades were picked up and `withoutV2` went to 0. \u26a0\u2605 NO THROTTLE ON '
      + 'THE TIMER, UNLIKE THE RECONCILE, AND FOR A STRUCTURAL REASON RATHER THAN CONFIDENCE: a run with nothing new '
      + 'appends NO EVENT (it returns `nothing_new`), so a crash loop costs three queries per boot. The reconcile needs '
      + '`shouldRunOnBoot` because it appends a census event every run whether or not anything changed.',
  },
  {
    id: 'analyses-notes-writer-guard',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE LAST CAPTURE LEDGER THAT NEVER HAD ITS GUARD NOW HAS ONE. `AnalysesNotes` owed a writer-owned hash + '
      + '`NOT EXISTS` per `AGENTS.md` \u00a74 and had neither \u2014 a plain `INSERT ... VALUES` from '
      + '`store.insertAnalysesNote`, with no check in `plus500/analysesCapture.js`. Measured 2026-10-27 over every row '
      + 'ever written (2026-10-03T16:39Z \u2192 2026-10-26T07:06Z): **163 rows over 34 distinct titles**. Migration 054 '
      + 'adds `rowHash` plus a FILTERED unique index; the store now hashes the observation and suppresses a repeat.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 a write-side guard on a table with no consumer; no dial, gate or '
      + 'level reads `AnalysesNotes`. \u26a0\u26a0 IT WAS FOUND BY FIXING THE TEST THAT WAS SUPPOSED TO CATCH IT, NOT '
      + 'BY READING THE CODE. `test/architecture-conformance.test.js` had a `continue` for "writer lives elsewhere" '
      + 'AND named the CALLER as the writer, so invariant C had been silently checking ONE of the three tables it '
      + 'claimed; the same file\'s comment stripper deleted 223 lines of `calendarCapture.js` \u2014 a URL glob inside '
      + 'a STRING opened a block comment \u2014 so `CalendarEvents` was never checked either. \u00a74 stated the rule, '
      + 'nothing enforced it, and the doc was the only thing holding it. \u26a0 THE FILTER IS THE LOAD-BEARING DETAIL: '
      + 'SQL Server treats NULLs as equal for uniqueness, so a plain index would have collided on the 163 legacy rows '
      + '\u2014 and the obvious fix, deleting the duplicates, would have broken \u00a74 to enforce \u00a74. No existing '
      + 'row is touched and there is deliberately no backfill. \u26a0 FILTERED INDEXES ALSO REQUIRE SET OPTIONS ON '
      + 'EVERY SESSION THAT WRITES, not only the one that creates: the first apply failed Msg 1934 with '
      + 'QUOTED_IDENTIFIER OFF. Hence the verification is behavioural \u2014 `trading/scripts/verify-054-rowhash.js` '
      + 'runs through the APP pool and gets 1 row from two identical inserts, 2601 when the guard is bypassed, and 0 '
      + 'rows left behind. \u26a0 AND IT MAKES THE CHROME VISIBLE RATHER THAN FIXED: 93 of the 163 rows are page '
      + 'headlines (80 \u00d7 "Your gateway to in-depth analysis and weekly trends.", 13 \u00d7 "Breaking down the '
      + 'week ahead"), which is a TITLE-EXTRACTION failure in the weekly view. Deduplication suppresses the repeats, '
      + 'so it will no longer announce itself \u2014 the parser fix is separate work.',
  },
  {
    id: 'registry-refresh-and-cost-age',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE REGISTRY REFRESH NOW REFRESHES THE BOOK, AND A ZERO-ROW RUN IS NO LONGER A SUCCESS. '
      + '`instrumentRefresh` ran `instrumentProbe.run({ scan: 6 })`, which clicks rows on whatever route the shared tab '
      + 'is on \u2014 parked on `/open-positions` per \u00a73 \u2014 so the ONE run it has ever made reported '
      + '`ok: true, rowsOnPage: 0, scanned: 0` against a registry whose newest row was 2026-10-01. It now refreshes the '
      + 'BOOK (open positions, then watchlist), names `nothing_refreshed` when it captured nothing, and the prompt '
      + 'discloses a spec older than 168h. Analyses titles are ranked rather than first-matched.',
    invalidates: '\u26a0\u26a0 THIS ONE DOES MOVE CHAIR INPUT, unlike everything else this session. `costFactLines` gains '
      + 'a clause on every symbol whose registry row is older than 168h \u2014 which today is EVERY symbol \u2014 so a '
      + 'chair voting after this boundary reads a different prompt from one voting before it. That is the point: '
      + '27-day-old funding and leverage were being presented as live. NO DIAL, GATE OR LEVEL MOVES: `checkSize` '
      + 'vetoes on the same numbers, `carryPctFor` is untouched, and the refresh still runs once a day inside '
      + '02:00-04:59Z holding the `ticket` lock at most six times. \u26a0\u26a0 THE FALSE SUCCESS WAS THE WORSE HALF: '
      + '`ok` was `!error && !!out`, and `lastRunAt` filters on `ok=\'true\'`, so a probe that read NOTHING reset its '
      + 'own 23h throttle \u2014 it suppressed its retry while the registry stayed frozen and reported health. That is '
      + 'the `sizing-venue-step` warning ("THE REGISTRY WAS ELEVEN DAYS STALE") recurring, and the first time the '
      + 'guard existed and lied rather than simply being absent. \u26a0 `captured` WAS ALWAYS NULL: '
      + '`captureFromObservation` returns `instruments`, and the event read a field that has never existed \u2014 a key '
      + 'that looked like a measurement and was permanently blank. \u26a0 THE TITLE FIX IS NOT COSMETIC: `title` is the '
      + 'only identity an append-only analyses ledger has, and 80 of 163 rows carried the site tagline (58 instrument '
      + 'rows over 45 DISTINCT analyses). \u26a0 AND RANKING ALONE WAS NOT ENOUGH \u2014 the first version of that fix '
      + 'failed its own test, because with no strong marker the tagline is still first; the weak tier now also prefers '
      + 'a line that does not read as prose. \u26a0 STILL OPEN BY DESIGN: a symbol the desk holds but whose venue row '
      + 'cannot be found (SHEIN, Soybean Oil, 4 expired option contracts) stays `instrument_unknown` \u2014 those trades '
      + 'are closed, the plain ones predate the registry, and options are keyed by `venueInstrumentId` which `Trades` '
      + 'does not record.',
  },
  {
    id: 'record-truth-batch',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE RECORD STOPPED DESCRIBING THINGS THAT ARE NOT THERE. `epoch.js`\'s header named '
      + '`assertRegistryCoverage` and called it from `test/epoch-registry.test.js`; the function has never existed and '
      + 'that test cannot fail on a missing boundary, so the claim was a comment wearing a function name. The header now '
      + 'names the guard that DOES run (`changeAudit.unaccounted` + `scripts/check-epoch-coverage.js`), and the two '
      + 'files that quoted the stale claim now say "used to" rather than repeating it in the present tense. '
      + '`scripts/verify-054-rowhash.js` printed `sessionOptions: null` \u2014 the last trace of an assertion replaced by '
      + 'a comment \u2014 and `risk.js`\'s `venueFloor.capturedAt` now says in place why it stays.',
    invalidates: 'NOTHING \u2014 no dial, gate, level, prompt, schedule or record shape moves. Every edit is a comment '
      + 'except one key removed from a verification script\'s output, and that key was always null. '
      + '\u26a0 IT IS REGISTERED ANYWAY, AND THE REASON IS STRUCTURAL RATHER THAN CEREMONIAL: `changeAudit` keys on FILE '
      + 'MTIMES, and an mtime cannot tell a comment edit from a behaviour edit. A registry that registered only '
      + 'behavioural changes would need the audit to make that distinction, which it cannot do \u2014 so "register '
      + 'everything, including that nothing moved" is the only policy that does not reopen the gap this file exists to '
      + 'close. \u26a0 THE ONE ITEM THAT IS LEFT OPEN ON PURPOSE: `venueFloor.capturedAt` is still read by nothing. It was '
      + 'NOT deleted, because a later audit has to be able to ask how old a minimum was when the desk sized against it, '
      + 'and the registry by then holds a newer row. Deleting the only provenance so the "zero reads" count looks clean '
      + 'would be tidying that destroys evidence \u2014 the age is judged where it is acted on, at `costFactLines`, past '
      + '168h.',
  },
  {
    id: 'probe-verdict-truthful-ok',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE PROBE STOPPED SAYING ok: true WHEN IT READ NOTHING. Both branches of `instrumentProbe.run()` emitted '
      + 'the LITERAL `ok: true` \u2014 a chain scan that found no rows and clicked nothing, and a single probe that '
      + 'landed on a page with no instrument table at all. Measured 2026-10-27: the one scheduled refresh reported '
      + '`ok:true, rowsOnPage:0, scanned:0`. The verdict is now the pure module `plus500/probeVerdict.js`, with '
      + 'DIFFERENT criteria per path, and `scripts/instrument-probe.js` exits 3 when nothing was observed.',
    invalidates: 'NOTHING IN THE DECISION PATH \u2014 no dial, gate, level, prompt, schedule or record shape. `ok` is a '
      + 'top-level field of two authenticated HTTP responses and of the `temp/phase0-observations/*.json` artifacts '
      + 'those runs write; historical files keep their old value and are not rewritten. \u26a0\u26a0 NO CONSUMER READ '
      + '`ok` BEFORE THIS CHANGE, AND THAT IS WHY IT SURVIVED: the dashboard gates on `tableFound` and `rowCount`, '
      + '`scripts/instrument-probe.js` gated on `o.skipped` and `o.mode`, and '
      + '`backfill-chart-identity-registry.js` gates on the RETURNED id matching the ASKED id. A field nobody reads is '
      + 'a claim nobody checks \u2014 it said `true` on every path and cost nothing until `instrumentRefresh` keyed its '
      + 'own 23h throttle on `!!out`. \u26a0 THE MIRROR DEFECT IS THE REAL RISK: a scan must fail on zero rows, but a '
      + 'PLAIN page read must NOT fail because the sidebar is collapsed \u2014 the desk pollers rotate the page every '
      + '15-60s by design. Judging both paths by `contract` would have reported genuine successes as failures, which '
      + 'is expensive in the other direction. \u26a0 EXTRACTED RATHER THAN INLINED because `instrumentProbe` '
      + 'top-level-requires `./browser`: a test that loaded it would attach to the desk\'s live Chrome. Same reason '
      + '`deliberationScope`, `staleExit` and `sizeReconcile.sizeVerdict` are separate modules. \u26a0 AND IT FOUND A '
      + 'SECOND STALE FIELD READ: the scan dispatch read `res.totals.withSpec`, but the value lives at '
      + '`res.checks.totals.withSpec` \u2014 `undefined` on every run, which reads as "not applicable" rather than '
      + '"wrong path".',
  },
  {
    id: 'cost-basis-one-number',
    landedAt: '2026-10-27',
    row: null,
    title: 'ONE COST NUMBER INSTEAD OF TWO, AND A CHECK THAT KEEPS THE TABLE HONEST. `costFactLines` told the chairs '
      + '"spread: no open-market capture \u2014 NOT usable as a cost" while `stopPolicy.adverseStopCap` priced the '
      + 'stop-cap floor from `backtest.costCfgFor` \u2014 two answers to one question inside one decision, neither '
      + 'naming the other. `venueCostFacts` now carries the cost model (`costModel`) and the line quotes THAT, with its '
      + 'population, showing a live capture only as corroboration. Soybeans leaves `flat_default` for a measured 0.0471. '
      + 'New `agent/spreadBasisDrift.js` + `scripts/spread-basis-drift.js` compare every curated entry against the '
      + 'desk\'s own `Trades.spreadSubmitPct` medians.',
    invalidates: 'THIS MOVES CHAIR INPUT. The cost line a chair reads changes shape for every symbol: instead of one '
      + 'spread field it now states the cost-model spread, its provenance (p75 of the desk\'s own two-sided ticks / '
      + 'PLACEHOLDER / curated-unverifiable) and the slippage term it is composed with. NO DIAL, GATE OR LEVEL MOVES: '
      + '`stopPolicy` reads the same `costCfgFor`, and for every live symbol `maxAdversePct` 2.5% still clears the '
      + 'floor (max 0.9021%), so no stop-cap decision flips. Soybeans\' cost falls 2.1x (0.10 flat -> 0.0471 measured), '
      + 'which lowers its floor but changes no decision at a 2.5% cap. \u26a0\u26a0 THE COMPARISON IS NOT INDEPENDENT FOR '
      + 'SOYBEANS: its entry was DERIVED FROM THE SAME FILLS it is then checked against, so it agrees by construction '
      + '(0.999). Only entries that predate the fills are real evidence. \u26a0 IT FOUND A DRIFT AND DID NOT ACT ON IT: '
      + '**Silver measures 1.266x against 39 fills** (curated 0.0936% round trip vs venue 0.118467%), i.e. the desk '
      + 'undercharges Silver by ~27%. NOT corrected here \u2014 the curated entry is a p75-of-ticks and the measurement '
      + 'is a median-of-fills, so 26.6% could be the statistic rather than the venue, and changing a live cost number '
      + 'in the same boundary that introduces its own check would remove the independent reading. It wants its own '
      + 'decision with the two populations named. Sugar sits at 0.877 (-12.3%), inside the 20% band. \u26a0 HALF vs ROUND '
      + 'TRIP: `cfdSpreadPct` is per side, `spreadSubmitPct` is a round trip, so the comparison is curated x 2 \u2014 the '
      + 'divisor trap `spreadDerivation.js` already records from TRD-79, now enforced in one place.',
  },
  {
    id: 'titles-not-rederivable',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE STORED ANALYSES TITLES ARE NOT REPAIRABLE BY RE-DERIVATION - MEASURED, NOT ASSUMED. 80 of 163 rows '
      + 'carry the site tagline as their title, and after `TITLE_STRONG` was ranked ahead of `TITLE_WEAK` the obvious '
      + 'next move is to re-derive them from `rawText`, which is intact and which the pure parser can read. Measured '
      + '2026-10-27 over every stored row: re-derivation changes **156 of 163** and leaves ONE unchanged. Two classes '
      + 'come out wrong - 5 of 40 `weekly` rows hold an INSTRUMENT page, and single-line owner-screenshot text turns '
      + 'into a 140-char prose slice. No backfill, and no read-time helper.',
    invalidates: 'NOTHING - no code path changes. This is a comment recording a measurement, and the only reader of '
      + '`AnalysesNotes` is `countRecentAnalyses` (`COUNT(*)`), which never touches a title. \u26a0\u26a0 THE NEGATIVE '
      + 'RESULT IS THE DELIVERABLE: without it the next session sees 80 bad titles, a pure parser and intact '
      + '`rawText`, and writes the backfill - which rewrites 96% of the corpus with a rule that is wrong twice. '
      + '\u26a0 AND IT FOUND A CAPTURE DEFECT UNDERNEATH, WHICH STAYS OPEN: 5 of 40 `weekly` rows contain instrument '
      + 'analysis text. `parseAnalysis` cannot detect that, because an explicit `view` DECIDES the kind '
      + '(`analysesParser.js`, v1.2 note), so a mis-targeted sweep is recorded as a valid weekly capture and its '
      + 'levels are skipped BY CONSTRUCTION (weekly extracts no levels). That is a capture-target question, not a '
      + 'parsing one.',
  },
  {
    id: 'trade-venue-instrument-id',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE TRADE NOW RECORDS WHICH INSTRUMENT IT WAS, INSTEAD OF THE AUDIT GUESSING LATER. '
      + '`constraintAudit` resolved a trade\'s `venueInstrumentId` from a symbol->id map built at AUDIT TIME '
      + '(`constraintAudit.js:182`), so the fact was reconstructed rather than recorded - and an OPTION contract could '
      + 'never join, because `Instruments.symbol` holds the underlying while `Trades.symbol` holds the venue\'s '
      + 'composite contract name. Migration 055 adds `Trades.venueInstrumentId`; `risk` carries it on `venueFloor`, '
      + '`wakePipeline` passes it from `sizeCalc.venueFloor`, and the audit prefers it with the symbol map as the '
      + 'legacy fallback.',
    invalidates: 'NOTHING CHANGES FOR ANY EXISTING ROW OR VERDICT. The 316 trades that predate the column record NULL '
      + 'and take exactly the symbol-map path they took before, so every stored assessment reproduces. NO DIAL, GATE, '
      + 'LEVEL OR PROMPT: `openTrade` gains an optional argument and `createTrade` an optional column, and the manual '
      + 'and pair callers pass nothing. \u26a0 IT DOES NOT FIX OPTIONS BY ITSELF, and the migration says so at the top - '
      + 'the registry cannot resolve a composite contract name either, which is why those four trades failed. This '
      + 'column is where the id can be RECORDED; sourcing it from the venue at submit is a separate change. '
      + '\u26a0 NO BACKFILL, DELIBERATELY: filling the 316 rows from `Instruments` by symbol would write an association '
      + 'that was never observed, into the one column whose purpose is to stop associations being guessed - and for '
      + 'the option rows it would produce precisely the plausible-looking wrong answer it exists to prevent. '
      + '\u26a0 AN EMPTY STRING IS TREATED AS ABSENT in `tradeInstrumentId`, because `\'\' != null` is TRUE and this repo '
      + 'has already paid for that comparison once (`sizeReconcile`\'s empty `positionId`).',
  },
  {
    id: 'trade-instrument-id-from-chart',
    landedAt: '2026-10-27',
    row: null,
    title: 'THE ORDER PATH NOW RECORDS THE INSTRUMENT THE VENUE SAYS IT TRADED. `engine.chart.symbol` is '
      + '`<venueInstrumentId>_<side>` (`11_Sell` = Gold); the desk read it inside `readChartBars` and threw it away '
      + 'everywhere else. `webtrader.placeOrder` now reads it while the ticket is open and returns it as '
      + '`fill.chartSymbol`; `executor.openTrade` parses it with `chartInstrumentId` and PREFERS it over the risk '
      + 'resolution. The identity rule moved to the pure module `plus500/chartIdentity.js`, because `capture.js` '
      + 'requires webtrader and requiring it back would have been a cycle.',
    invalidates: 'NOTHING IN THE DECISION PATH - one extra page read per order, and one more field on the fill and on '
      + 'the trade row. NO DIAL, GATE, LEVEL, PROMPT OR SCHEDULE. \u26a0 IT IS THE ONLY SOURCE THAT CAN NAME AN '
      + 'OPTION: the risk resolution cannot, because the composite contract name (`Oil | Call 94 | Sep W2`) has no '
      + 'registry row, which is exactly why those four trades are `instrument_unknown`. This makes the NEXT option '
      + 'entry joinable; the four historical ones stay unknown permanently and the migration says so. '
      + '\u26a0 THE READ IS A READ, NOT AN INTERACTION: no click, no navigation, no ticket touch, and it happens where '
      + '`readChartTitle` already ran - so the shared tab is provably on this instrument at that moment. Its failure '
      + 'mode is NULL, which falls back to the risk resolution, i.e. to today\'s behaviour: it can only add '
      + 'information. \u26a0 THE RULE MOVED RATHER THAN BEING COPIED. `capture.js` requires `webtrader`, so the reverse '
      + 'require would be a cycle - and copying the regex would give one fact two producers. `capture.js` re-exports '
      + 'both functions, so its two script callers are untouched.',
  },
];

const DAY = 86400000;
const asDate = (v) => (v instanceof Date ? v : new Date(v));

// âš  AN OPEN-ENDED SENTINEL, so the newest range matches everything after it and the join needs no special case.
const OPEN_END = '9999-12-31T23:59:59';

// â˜…â˜… THE RANGES ARE DERIVED IN ONE PLACE, for the same reason the chair-persona resolver is (TRD-DEL-1): the answer
// this module gives to `?about=` and the row a RAW SQL reader joins must not be able to disagree about where a
// boundary sits or what it is CALLED. A test caught the first version doing exactly that â€” the module named a regime
// after a feature (`chair-sees-panel`) while `FeatureEpochs` named it after the date (`day-2026-09-25`), so the same
// day had two names depending on how you asked. `scripts/sync-feature-epochs.js` imports this function instead of
// re-grouping, so the two cannot drift again.
//
// âš  ONE ROW PER DISTINCT LANDING DATE, NOT ONE PER FEATURE. Seven features landed on 2026-09-25, and a table with
// seven rows sharing a `landedAt` produces seven OVERLAPPING intervals â€” a single `Trades` row would match seven
// epochs and a JOIN would MULTIPLY the result. Grouping by date keeps intervals contiguous and disjoint, which is
// what makes `>= landedAt AND < nextLandedAt` correct.
function ranges() {
  const byDate = new Map();
  for (const f of FEATURES) {
    if (!byDate.has(f.landedAt)) byDate.set(f.landedAt, []);
    byDate.get(f.landedAt).push(f);
  }
  const dates = [...byDate.keys()].sort();
  return dates.map((d, i) => {
    const group = byDate.get(d);
    const next = i + 1 < dates.length ? dates[i + 1] : OPEN_END;
    return {
      // A date carrying exactly ONE feature keeps that feature's id, so a single-change day stays readable.
      id: group.length === 1 ? group[0].id : `day-${d}`,
      landedAt: d,
      nextLandedAt: next,
      rowId: group.map((f) => f.row).find((r) => r != null) || null,
      title: group.map((f) => f.title).join(' | '),
      invalidates: group.map((f) => `${f.id}: ${f.invalidates}`).join(' || '),
      features: group.map((f) => f.id),
    };
  });
}

function rangeFor(date) {
  const t = asDate(date).getTime();
  let best = null;
  for (const r of ranges()) if (asDate(r.landedAt).getTime() <= t) best = r;
  // âš  A DATE BEFORE THE EARLIEST RANGE HAS NO REGIME, and saying otherwise is the opposite of the truth.
  return best && t < asDate(best.nextLandedAt).getTime() ? best : null;
}

function featureOn(date) {
  const t = asDate(date).getTime();
  let best = null;
  for (const f of FEATURES) if (asDate(f.landedAt).getTime() <= t) best = f;
  return best;
}

function featuresBetween(since, until) {
  const a = since ? asDate(since).getTime() : -Infinity;
  const b = until ? asDate(until).getTime() : Infinity;
  return FEATURES.filter((f) => {
    const t = asDate(f.landedAt).getTime();
    return t > a && t <= b;
  });
}

// The annotation a caller renders INSTEAD OF, or BESIDE, the numbers. `safe` means "the window sits inside one
// feature regime", which is the only condition under which a single mean is a description of one thing.
function annotate({ since = null, until = null, about = null } = {}) {
  if (about) {
    // âš  THE REGIME NAME COMES FROM `rangeFor`, NOT FROM `featureOn`, so it matches the `id` a raw SQL reader joins
    // against in `FeatureEpochs`. Naming it after the individual feature is what a test caught drifting.
    const r = rangeFor(about);
    // â˜…â˜… `safe` HAS ONE MEANING, AND THE FIRST VERSION GOT IT WRONG IN A WAY THAT MATTERS.
    //
    // For a WINDOW, `safe` means "the range sits inside ONE regime". For a single date the first version set it to
    // "a regime exists" â€” so a date inside the SUPERSEDED `stop-cap` regime came back `safe: true` while that
    // regime's own `invalidates` field says its geometry is not comparable with what came after. A boolean that
    // means "there is a row" is not a boolean a reader can act on.
    //
    // It now means the same thing in both shapes: **is this data produced by the code that is running now?** Only
    // the newest, open-ended range can answer yes. An older regime returns `safe: false` with the reason, because
    // the honest answer to "may I pool this with current data" is no even though the regime is well documented.
    const current = r ? r.nextLandedAt === OPEN_END : false;
    const f = featureOn(about);
    const supersededBy = r && !current ? ranges().find((x) => x.landedAt === r.nextLandedAt) : null;
    return {
      about, epoch: EPOCH, landedAt: r ? r.landedAt : null,
      regime: r ? r.id : 'pre-registry',
      title: r ? r.title : 'before the earliest recorded feature',
      invalidates: f ? f.invalidates : null,
      currentRegime: current,
      supersededBy: supersededBy ? supersededBy.id : null,
      safe: current,
      reason: current
        ? 'this date sits in the regime now in force'
        : r
          ? `this date sits in an EARLIER regime (${r.id}), superseded on ${r.nextLandedAt} â€” its data is documented but not comparable with current data`
          : `this date predates the earliest recorded feature (${ranges()[0].landedAt}), so its provenance is unrecorded`,
    };
  }
  const spanned = featuresBetween(since, until);
  const sinceT = since ? asDate(since).getTime() : null;
  const untilT = until ? asDate(until).getTime() : null;
  const crossesEpoch = sinceT != null && sinceT < asDate(EPOCH).getTime();
  const spansEpochBoundary = crossesEpoch && (untilT == null || untilT >= asDate(EPOCH).getTime());
  return {
    since: since ? asDate(since).toISOString() : null,
    until: until ? asDate(until).toISOString() : null,
    epoch: EPOCH,
    // âš  ONLY THREE CONDITIONS MAKE A SINGLE MEAN A DESCRIPTION OF ONE THING.
    safe: !crossesEpoch && !spansEpochBoundary && spanned.length === 0,
    crossesEpoch,
    featuresInWindow: spanned.map((f) => ({ id: f.id, landedAt: f.landedAt, title: f.title })),
    // The part to render. A caller that shows only the first element is showing the one that invalidates the most.
    caveats: [
      ...(spansEpochBoundary ? [`window spans the POLICY EPOCH ${EPOCH}: rows either side were produced by different policy sets, and a single mean over them describes neither`] : []),
      ...spanned.map((f) => `${f.landedAt} ${f.id}: ${f.invalidates}`),
    ],
  };
}

// One line, for a report header. Deliberately states the WINDOW first: a number without one is the defect.
function windowLine({ since = null, until = null } = {}) {
  const a = annotate({ since, until });
  const win = `${a.since ? a.since.slice(0, 10) : 'inception'}..${a.until ? a.until.slice(0, 10) : 'now'}`;
  const tail = a.safe ? 'one regime' : `${a.caveats.length} boundary caveat(s)`;
  return `window ${win} (epoch ${a.epoch}) â€” ${tail}`;
}

// â˜… THE RAW-SQL PATH. An agent reading with `SELECT` sees neither this file's comments nor any endpoint, so the
// boundary has to be JOINABLE. `FeatureEpochs` is materialised from FEATURES by scripts/sync-feature-epochs.js with
// a `nextLandedAt` bound, so a range join is a plain inequality rather than a correlated subquery.
function sqlEpochJoin({ dateExpr = 't.createdAt', alias = 'e' } = {}) {
  return `LEFT JOIN FeatureEpochs ${alias} ON ${dateExpr} >= ${alias}.landedAt AND ${dateExpr} < ${alias}.nextLandedAt`;
}

module.exports = { EPOCH, POLICY_FREEZE, FEATURES, ranges, rangeFor, featureOn, featuresBetween, annotate, windowLine, sqlEpochJoin, DAY };
