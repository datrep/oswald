// trading/agent/epoch.js — WHEN EACH PIECE OF THE DESK LANDED, AND WHAT THAT MAKES OLD DATA UNABLE TO PROVE.
//
// ⚠⚠ WHY THIS EXISTS, AND IT IS NOT BOOKKEEPING. Over one session, pre-policy data produced THREE wrong answers —
// the last of which was written into a report as a conclusion:
//   · a wake census read one field of three and called 237 self-describing wakes "empty";
//   · a target-anchor study reported ONE mean over 57 trades spanning two different stop regimes;
//   · a Step-0 measurement concluded "the approved entries were negative, so the weak link is upstream of the
//     gate" — on a sample that was **83% pre-policy**, where the current week's approved entries are the OPPOSITE
//     sign. The owner had already ruled on this three times: *"dont trust previous data. they are before the new
//     policies are implemented."*
//
// The failure was never that old data existed. It was that a measurement **silently** included it and reported one
// number. Deleting the old data does not fix that (it removes the baseline that lets a reader tell policy from era)
// — so this module makes the boundary **impossible to cross by accident and impossible to cross silently**:
//
//   · `FEATURES` is the timeline as DATA, every entry citing the task row that records it, so it can be checked
//     rather than believed;
//   · `annotate({ since, until })` returns the window PLUS every boundary it spans and what that costs, so a
//     caller that renders only the numbers is not the only option;
//   · `sqlEpochJoin()` gives the same fact to a RAW SQL reader, which is the path an agent actually takes — an
//     annotation that lives only in a comment is invisible to `SELECT AVG(...)`.
//
// ⚠ AND THE STALENESS DIRECTION MATTERS: this file ages. A feature added without an entry here is a boundary a
// reader will cross blind, so `assertRegistryCoverage` (see `test/epoch-registry.test.js`) fails when a task row
// that CLOSED carries a landing date newer than the newest entry.
'use strict';

// ★ THE POLICY EPOCH. The Monday the current policy set began. Every artifact that reports a window cites this
// value rather than re-deriving "this week", which is a moving target.
const EPOCH = '2026-09-21';

// ★★ POLICY FREEZE (owner decision, 2026-10-02) — THE WINDOW THE DESK STOPS CHANGING SO N CAN ACCUMULATE.
//
// WHY THIS IS A RECORDED VALUE AND NOT AN INTENTION. Measured on 2026-10-02: the desk takes ~10-12 trades/day and
// had SEVEN behaviour boundaries in 14 days — one every ~2 days — so a "clean era" is ~2 days ≈ 20-25 trades, and
// EVERY change resets the clock. A study scoped by this registry collapsed to **n=1** for the regime actually in
// force. No policy question on this desk can be answered from its own forward record until the change rate falls
// below the rate at which N accumulates. That is arithmetic, not opinion.
//
// ⚠ SO THE FREEZE IS CHECKABLE, NOT ASPIRATIONAL — and an unverified freeze would be the same defect one level up.
// `changeAudit.unaccounted({ freeze })` reports ANY policy settings write or ANY change under `trading/**` after
// this date, and `trading/scripts/check-epoch-coverage.js` runs it. A window that silently contains a change is
// exactly the contamination this module exists to prevent.
const POLICY_FREEZE = {
  // ⚠ A TIMESTAMP, NOT A DATE, AND THE FIRST RUN OF THE GUARD IS WHY. With a date, the comparison is "after
  // 2026-10-02T00:00Z" — which counted the SAME DAY's setup work as a breach, including the EXE-14 arming at
  // 01:23:38Z that the freeze exists to protect. A window with a midnight start flags its own author. The window
  // opens when the desk is actually left alone, so it opens at a stated time.
  //
  // ★ RE-DECLARED 2026-10-02T05:00:00Z — AND THE PROTOCOL WORKED EXACTLY AS WRITTEN. The 03:00Z window was broken
  // by ONE owner-approved change (`bundle-stable-first`, the stable-first prompt reorder); the guard reported it
  // as a freeze_breach with its sanctioned fix ("register the change and restart the window, or revert"), and that
  // is what this is: the change is registered above and the window restarts here. The 03:00-05:00Z fragment is
  // transitional (n≈2) and must not be pooled with anything.
  //
  // ★ RE-DECLARED AGAIN 2026-10-02T06:20:00Z — the SECOND cost of the day, paid the same way. One owner-approved
  // recovery fix (`health-repair-fallback`, the A1 repair fallback for a tab parked off the trade route) broke the
  // 05:00Z window; register + restart, exactly as the guard's fix line says. The 05:00-06:20Z fragment must not be
  // pooled — it contains the day's second UI Fallback Pause lockout (05:35→06:2xZ), which is not desk behaviour.
  //
  // ★ RE-DECLARED A THIRD TIME 2026-10-02T07:05:00Z — and this time the guard caught something REAL, not a
  // deliberate change. Its first live finding was an account-poller baseline FLASH at 06:54Z, seconds after the
  // 06:53:25Z resume: one `#accountStatus` strip read returned the real-money account's level (22.28) and the
  // switch detector — which trusts a SINGLE read — re-based `day_start` and BOTH equity baselines to it; six
  // seconds later it re-based back. No kill-tier interaction and no persisted equity-curve sample (both verified);
  // the mechanism is written up in docs/incident-2026-10-02-ui-fallback-pause.md §6 and filed as TRD-RSK-17
  // (#1503). NO decision input was deliberately changed — the window is restarted because a window containing a
  // 6-second baseline flash must not be pooled, and the poller CONFIRMATION FIX IS NOT LANDED under this freeze.
  //
  // ★ RE-DECLARED A FOURTH TIME 2026-10-02T07:25:00Z — the release of the crisis soft kill, plus the fix the
  // guard's catch called for. The owner's dashboard SOFT KILL (set 06:17:45Z during the second lockout) was
  // released at 07:08:51Z via POST /trading/kill {tier:'off'}; the guard reported the kill.tier write as a
  // freeze_breach — exactly as designed — and this restart is the sanctioned fix. Landed in the same window:
  // `account-switch-confirmation` (TRD-RSK-17, #1503), the confirmation gate for the 06:54Z flash, deployed
  // by desk restart. The 07:05-07:25Z fragment must not be pooled: the kill was on until 07:08:51Z and the
  // fix was deployed mid-fragment.
  //
  // ★ RE-DECLARED A FIFTH TIME 2026-10-02T07:33:00Z — for the #1499 venue-close fill derivation (deployed by
  // desk restart), and for a RECORD CORRECTION rather than a live change: the owner's EXE-13 "go" found the
  // key ALREADY SPENT — `risk.entryDriftFactor` was set to 1.083 at 2026-10-01T00:30:55Z (settings_write
  // #152809) and every decision since 01:17:37Z sized with it, while the plan described the capability as
  // "built INERT". The switch is registered above with its TRUE date; no settings write landed today. The
  // 07:25-07:33Z fragment is transitional and must not be pooled: it contains no trades.
  //
  // ★ RE-DECLARED A SIXTH TIME 2026-10-02T08:00:00Z — the two small fixes, deployed together: `whitepaper-force-
  // refresh` (#1502: Generate now / black-swan can finally REWRITE a current-period tier) and `capture-
  // evaluate-timeout` (#1504: a wedged capture fails NAMED in 90 s instead of holding pageLock forever).
  // ALSO folded in, tooling only: the guard's settings-write scan is now scoped to userId=1 — measured at
  // 07:54Z the `npm test` SMOKE suite wrote its fixture policy keys as test user 42 against this DB and lit the
  // frozen window with breaches the desk never made. ⚠ The 07:33-08:00Z fragment contains the desk's FIRST
  // entry of the day after the lockouts (#1209 Sugar, 07:52:50Z) — it must NOT be pooled.
  //
  // ★ RE-DECLARED A TWELFTH TIME 2026-10-17T19:20:00Z — THE CONTINUITY MERGE (laptop hand-off bundle,
  // owner-directed return-to-service work). Five behaviour-neutral changes + five new read-only files
  // (registered above as `continuity-merge-2026-10-18`): the three capture-only env flags (UNSET on the
  // desk — every gated path returns before doing anything), bringToFront bounded to 3 s, the Polygon
  // Yahoo id correction (old id 404 — nothing was computed from it), `expenses` dashboard registration,
  // and the recorder/keepalive/watchdog scripts (not scheduled on the desk; docs/10-ARCHITECTURE-NOTES.md
  // carries the ADRs). No policy key, no decision input, no scope change — era clock untouched by
  // construction. Desk restarted 18:52:43Z to load the code (pid change only). The 10-08 to 10-17 span
  // contains the seven-day outage (desk off, 0 TradingEvents) and must not be pooled; post-T2 accounting
  // resumes from this instant.
  //
  // ★ RE-DECLARED A THIRTEENTH TIME 2026-10-17T19:06:00Z — THE MIRROR CYCLE DEADLINES (owner-directed,
  // same return-to-service pass): the mirror poller's four venue awaits are now bounded (45/20/20/30 s),
  // so a hung evaluate can no longer hold the shared bridge lock indefinitely and starve ticket flows
  // (recurring `bridge busy (mirror)` — 28 hits in one weekend). Registered as `mirror-cycle-deadline`.
  // Read-only beside the desk: no policy key, no decision input, no scope change; era clock untouched.
  //
  // ★ RE-DECLARED A FOURTEENTH TIME 2026-10-17T20:05:00Z — THE WATCHLIST QUOTE FAST PATH (owner-directed,
  // "start on 1"): the dynamic capture reads quotes in ONE watchlist-table read (burst moved to table
  // re-reads; quotes banked before the chart sweep), and the chart half is now deadline-bounded per symbol
  // and rotated least-recently-charted-first (5 per wake). Registered above as `watchlist-quote-fast-path`.
  // Same venue/source for prices; no policy key, no scope change — era clock untouched; the desk restarted
  // to load it (pid change only).
  // ★ RE-DECLARED A FIFTEENTH TIME 2026-10-17T20:20:00Z — the pin repair for the fast path (same night,
  // same owner directive): two source pins went red against the restructured captureDynamic and both
  // findings were real (dead chartIdentity/chartMerge accumulation removed; the chartMissing pin generalised
  // to its binding invariant). Registered as `watchlist-fast-path-pin-repair`. NO behaviour change — same
  // prices, same sources, no settings write — the desk restart loads an identical-behaviour build.
  // ★ RE-DECLARED A SIXTEENTH TIME 2026-10-17T20:50:00Z — night-shift improvements while the venue is closed:
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
  at: '2026-10-18T15:45:00Z',
  note: 'The owner froze the policy set so a forward sample can accumulate under ONE rule set. Any change after '
      + 'this instant invalidates the window that follows it — including changes that look like improvements, '
      + 'which is the whole difficulty: every one of the seven boundaries above looked like an improvement. '
      + 'Re-declared SIX TIMES on 2026-10-02: (1) at 05:00Z for `bundle-stable-first`; (2) at 06:20Z for '
      + '`health-repair-fallback`, the owner-approved A1 recovery fix; (3) at 07:05Z after the guard\u2019s first '
      + 'LIVE catch — a transient account-poller baseline flash (TRD-RSK-17), not a deliberate change; (4) at '
      + '07:25Z for the crisis-kill release plus `account-switch-confirmation`, the fix that answers the catch; '
      + '(5) at 07:33Z for `venue-close-fill-derivation` plus the EXE-13 record correction (key live since 10-01); '
      + '(6) at 08:00Z for `whitepaper-force-refresh` + `capture-evaluate-timeout`. '
      + 'One registered change costs one window restart, paid deliberately while the era is hours old instead of '
      + 'weeks. '
      + '★ RE-DECLARED A SEVENTH TIME 2026-10-08T00:52:00Z — THE PLANNED LIFT, NOT A BREACH: the #1506 re-take ran '
      + '(profit rule re-verified at n=140+: fragility unchanged — the sign still flips on removing #1093 — so it '
      + 'stays NOT adopted) and the owner-directed T2 bundle executed at the boundary 2026-10-08T00:45:50.735Z '
      + '(registered above as `t2-freeze-lift-bundle`; one window carries four writes: PRU-1 scope x4 + EXI-1c floor '
      + '+ chair shape (b) + era re-anchor). The 10-02→10-08 window is CLOSED (that era: 62 closed trades — '
      + 'measured, done, not pooled with anything). The post-T2 era opens here; the guard now audits from this instant. '
      + '★ RE-DECLARED AN EIGHTH TIME 2026-10-08T01:24:40Z — THE T2.5 FORENSICS WINDOW, executed deliberately: the '
      + 'T2.5 abort (00:52Z, venue read-back guard refused a Silver trail pre-write) was forensically answered with '
      + 'READ-ONLY instrumentation (`trail-probe-ticket-state`: optional stopPrice/size ticket-state inputs + counts '
      + 'override on the existing curve probe) and a measured DATA CORRECTION (`silver-pip-offset-remeasure`: offset '
      + '0.052→0.078, pip 0.001 and both clamps reconfirmed across six sweeps). Deploys 01:14Z/01:16Z (pid 50864); '
      + 'the automation\u2019s own config flip (enable 01:20:07Z → revert 01:22:37Z reads) rides the same window, as '
      + 'the protocol\u2019s §AUTOMATION states. T2.5 verification then PASSED on #1288 Silver (placed:true, not '
      + 'degraded). The 00:52→01:23Z fragment (~31 min, effectively no closes) is a forensics fragment and must not '
      + 'be pooled; the post-T2 era accounting continues from this instant. '
      + '★ RE-DECLARED A NINTH TIME 2026-10-08T01:54:26Z — THE OWNER-AUTHORISED STAGED BUILD (option 2, build-only): '
      + 'TRD-TRL-9/10/11 landed and deployed 01:53:33Z (pid 55796) with EVERY behaviour switch FALSE (engageOnTouch '
      + 'enabled:false; trail stays OFF; the new route is read-only `commit:false` only). The shadow monitor and '
      + 'pip sampler run read-only beside the desk. The 01:24→01:54Z fragment (~30 min) contains the staged build\u2019s '
      + 'landing and must not be pooled; the first live engage remains deliberately HELD for the owner walkthrough. '
      + 'The post-T2 era accounting continues from this instant. '
      + '★ RE-DECLARED A TENTH TIME 2026-10-08T05:28:19Z — THE TRD-PRU-3 READ-ONLY CANDIDATE SCREEN (owner ask: a '
      + 'winners-profile intake that touches nothing). Navigation-only route `POST /orders/instrument-screen-probe` '
      + 'deployed 05:27:35Z (pid 25228); no ticket, no order, no settings write, no decision input — the live scope '
      + 'and era clock are untouched by construction. The 01:54→05:28Z fragment contains the staged-build telemetry '
      + 'window and must not be pooled; the post-T2 era accounting continues from this instant. '
      + '★ RE-DECLARED AN ELEVENTH TIME 2026-10-08T05:31:16Z — TRD-PRU-3b, the per-symbol chart backfill read '
      + '(`POST /orders/instrument-bars-probe`, focus-only; series + interval-verdict fields), deployed 05:30:14Z '
      + '(pid 21076) for the candidate-profile study. Read-only again: no decision input, no scope change, era '
      + 'clock untouched. The 05:28→05:31Z fragment is a 3-minute deploy gap and must not be pooled. '
      + '★ RE-DECLARED A TWELFTH TIME 2026-10-17T19:20:00Z — THE CONTINUITY MERGE (laptop hand-off bundle, '
      + 'owner-directed return-to-service): five behaviour-neutral changes (three env-gated capture-only paths, '
      + 'ALL UNSET on the desk; bringToFront bounded to 3 s; Polygon Yahoo id POL-USD→POL28321-USD, old id 404; '
      + '`expenses` registered in config/servers.json) plus five new read-only recorder/watchdog files (none '
      + 'scheduled on the desk) and docs/10-ARCHITECTURE-NOTES.md. No policy key, no decision input, no scope '
      + 'change — era clock untouched by construction; the desk restarted 18:52:43Z to load the code. The '
      + '10-08→10-17 span contains the seven-day outage (desk off, 0 TradingEvents) and must not be pooled; '
      + 'post-T2 accounting resumes from this instant. '
      + '★ RE-DECLARED A THIRTEENTH TIME 2026-10-17T19:06:00Z — MIRROR CYCLE DEADLINES (owner-directed): the '
      + 'mirror poller\'s venue awaits are bounded (45/20/20/30 s) so a hung evaluate cannot hold the shared '
      + 'bridge lock indefinitely and starve ticket flows (recurring `bridge busy (mirror)`). Read-only beside '
      + 'the desk; no policy key, decision input or scope change; era clock untouched. '
      + '★ RE-DECLARED A FOURTEENTH TIME 2026-10-17T20:05:00Z — WATCHLIST QUOTE FAST PATH + CHART ROTATION '
      + '(owner-directed): quotes now read in one watchlist-table read (burst moved to table re-reads, banked '
      + 'before the chart sweep); charts are deadline-bounded per symbol (12 s) and rotated '
      + 'least-recently-charted-first, 5 per wake (~20-30 min per symbol — far inside BAR_FRESH_MS 4 h; each visit reads the '
      + 'full series, so no bar gaps). Same venue/source for prices; no policy key, no scope change.',
};

// ⚠ EVERY ENTRY INVALIDATES SOMETHING. An entry that says only "we shipped X" is a changelog; the `invalidates`
// field is the part a reader needs, because it says what a number computed from earlier rows CANNOT mean.
//
// `landedAt` is the date the behaviour changed, not the date the row was filed — where those differ, the row's own
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
    invalidates: 'Trades before this had an un-offset target, so their fill/near-miss behaviour is not comparable — and the offset was later shown to make expectancy slightly WORSE once the target anchor is corrected.',
  },
  {
    id: 'chart-interval',
    landedAt: '2026-09-25',
    row: 1408, // TRD-GRD-6
    title: 'The chart interval is MEASURED beside the layout claim, and sub-1h reads roll up to 1h',
    invalidates: 'Before this, the `timeframe` and `sourceIntervalSec` labels on `PriceBars` rows written from the chart are not trustworthy — the tab decided them, and a 15m tab wrote 15m rows while the only structure venue read 1h and received nothing.',
  },
  {
    id: 'chair-persona',
    landedAt: '2026-09-25',
    row: 1416, // TRD-DEL-1
    title: 'The resolved chair persona is reported (`personaSource`) and shown in the panel',
    invalidates: 'Before this, chair votes have no `personaSource`, and the panel rendered every seat as "seat default" — so a reader cannot tell a configured seat from an inherited one in older decisions.',
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
    invalidates: 'Before this, a seat voted without the panel while the RECORD held both — so an older decision read by a human shows a panel the seat never saw.',
  },
  {
    id: 'one-wake-one-event',
    landedAt: '2026-09-27',
    row: 1419, // TRD-WAK-1 / WAK-2
    title: 'A wake writes ONE event (the aggregator stopped writing its own)',
    invalidates: '⚠ ANY EVENT COUNT OVER A RANGE COVERING THIS DATE IS DOUBLED FOR THE EARLIER PART: 815 of 1,426 wakes wrote a duplicate pair, one wrote five. A count that clusters by the second is safe; a raw `COUNT(*)` is not.',
  },
  {
    id: 'veto-codes',
    landedAt: '2026-09-27',
    row: 1418, // TRD-RSK-2
    title: 'The risk gate emits machine-readable `vetoCodes` beside the prose',
    invalidates: 'Before this, a refusal carries prose ONLY, so `vetoCodes` is null and the cause has to be read out of a sentence — which is how the cost ceiling was once named for a correlation veto.',
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
    invalidates: 'Between 2026-09-25 and this correction the prompt stated `size = equity x riskPerTradePct% / stop` while `maxRiskPerTradePct` (0.07%) always overrode it — so chair reasoning in that window is about a rule 28x larger than the one in force.',
  },
  {
    id: 'pre-epoch-pruned',
    landedAt: '2026-09-27',
    row: 1422, // TRD-DAT-1
    title: 'Pre-epoch telemetry archived and removed from the live tables',
    invalidates: '`TradingEvents`, `ShadowSignals`, `QuarantinedTicks` and `TradingAlerts` have NO rows before 2026-09-21. A historical count from those tables now reads zero rather than "small" — the archives are in `trading/archive/pruned/`.',
  },
  // ⚠⚠ THE REGISTRY WAS ELEVEN DAYS STALE, AND IT WAS STALE EXACTLY WHERE IT COSTS THE MOST: SIZING.
  //
  // Every entry below landed after the previous newest entry (2026-09-27) and NOT ONE was registered, so a study
  // scoped by this file still pooled four different sizing rules and reported one number. The R-multiple study that
  // produced "the desk is roughly break-even at -0.042R/trade" did exactly that.
  //
  // ⚠ AND WHY NOTHING CAUGHT IT: this file's own header names a guard — "`assertRegistryCoverage` ... fails when a
  // task row that CLOSED carries a landing date newer than the newest entry" — **and that guard DOES NOT EXIST.**
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
    invalidates: 'THREE DIFFERENT TARGETS sat inside one week: none before 2026-09-25, 5% from 09-25, and 6% from 2026-09-30T10:29:08Z (settings_write #141101). ⚠ The `tp-offset` entry above still says 5% and is now WRONG about the live value — a registered feature whose parameter drifted is a boundary a reader crosses while believing the entry describes today.',
  },
  {
    id: 'pointvalue-notional',
    landedAt: '2026-10-01',
    row: null, // no task row was filed for the sweep
    title: 'NOTIONAL includes the instrument\u2019s pointValue, so a cents-quoted contract is no longer 100x over-stated',
    invalidates: 'The per-position notional cap, the exposure budget and the margin guard were all computed WITHOUT pointValue. Soybeans quotes in cents (pointValue 0.01), so its notional was 100x too large: the 35% cap bound at 0.69 instead of ~89, fell under the venue minimum, and the desk refused every entry — while reporting the arithmetic error as a VENUE FACT ("the minimum is ~487% of equity"). A size or a CAP REFUSAL from earlier rows is an artefact of a missing factor, not a statement about the instrument.',
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
    invalidates: 'Before this, a symbol with no `SYMBOL_CATEGORY` entry could ONLY be reached by the search fallback, whose click is an UNSCOPED `document.querySelector(\'.button-buy\')` on a page carrying 22 of them (measured 2026-10-02). Four Natural Gas attempts on 2026-10-01 failed as `order ticket did not open` for this reason, not for any market reason — so per-symbol activity before this date is a REACH artefact and says nothing about the instrument. ⚠ The date is the session in which the mapping was deployed; the first VERIFIED reach is 2026-10-02.',
  },
  {
    id: 'bundle-stable-first',
    landedAt: '2026-10-02',
    row: null, // owner-approved S1 (docs/llm-cache-attribution-and-stable-first-2026-10-02.md); no task row — registered at deploy, after the guard flagged the freeze
    title: 'The chair bundle is reordered STABLE-FIRST: byte-stable sections precede every per-wake value',
    invalidates: '⚠ ORDER-ONLY — not one byte of content was changed, but the seats read the same facts in a different sequence, and reordering is NOT provably behaviour-neutral (TRD-78 says so explicitly). What it invalidates is the CACHE comparison: the measured cross-wake reusable prefix grew from ~171 to ~3,029 tokens (mean over 15 consecutive wakes), so a cache-miss or prompt-order number pooled across this date mixes two orders. Registered together with the window restart below, per the guard protocol (register AND restart, or revert).',
  },
  {
    id: 'health-repair-fallback',
    landedAt: '2026-10-02',
    row: null, // owner-approved recovery fix after the day's second A1 lockout; no task row — registered with the window restart per the guard protocol
    title: 'The A1 selector-health check can recover a shared tab parked OFF the trade route: the repair falls back to a direct category navigation',
    invalidates: '⚠ RECOVERY-PATH ONLY — no decision input changed (sizing, gates and prompts are untouched). What it invalidates is the FAILURE record: before this date the one-shot repair (`gotoPage(page,\'trade\')`) navigated to a URL the SPA redirects back to the remembered trade route, so a tab parked on a table-less page (the mirror parks on `/open-positions`; probes park there by design) made the repair a NO-OP and the desk could latch the UI Fallback Pause with no human action available — two lockouts happened on 2026-10-02 itself (02:55→04:12Z, healed by an unidentified navigation; 05:35Z→cleared only by this fix). A capture-failure window after those dates is NOT evidence of a market or venue condition. Registered together with the window restart below, per the guard protocol.',
  },
  {
    id: 'account-switch-confirmation',
    landedAt: '2026-10-02',
    row: 1503, // TRD-RSK-17 — the guard's first live catch (06:54Z baseline flash); owner-approved fix, landed with the window restart per the guard protocol
    title: 'An account switch must persist across consecutive strip reads before it can re-base anything; a single wild read becomes account_flash telemetry',
    invalidates: '⚠ TELEMETRY/BASELINE HANDLING ONLY — no decision rule changed, but before this date ONE wild `#accountStatus` read could re-base `day_start` and BOTH equity baselines (measured 06:54:02Z: a 6-second latch to the real-money account level 22.28, self-corrected 06:54:08Z). An account_switch row before this date cannot be assumed to have persisted across reads, and a resolved unconfirmed read is now logged as `account_flash` (from/to/heldMs). Registered together with the window restart below, per the guard protocol.',
  },
  {
    id: 'entry-drift-sizing',
    landedAt: '2026-10-01',
    row: null, // TRD-EXE-13 has no task row; the switch is an owner key (P3, application-plan-2026-10-01)
    title: 'Sizing models the measured ENTRY drift (risk.entryDriftFactor = 1.083): sizes run ~8% smaller than the dial alone implies',
    invalidates: '⚠ POSTURE CHANGE — registered 2026-10-02 against a RECORD CORRECTION: the plan describes EXE-13 as "built INERT by default" and "switching it on is one key", but the key was ALREADY SPENT at 2026-10-01T00:30:55Z (settings_write #152809, null -> 1.083) and every decision since 01:17:37Z carries the drift term in its sizeCalc (measured on #1208: expectedLossDistance 28.5843 = stop 20.225 x 1.305 x 1.083). So sizes since 10-01 00:30Z are ~8% smaller than the review assumed, compounding with stopSlippageFactor 1.305; any size or risk-per-trade number pooled across that instant mixes two sizings. No code changed on 10-02: this entry corrects the REGISTRY, not the desk.',
  },
  {
    id: 'venue-close-fill-derivation',
    landedAt: '2026-10-02',
    row: 1499, // TRD-PNL-6 residual
    title: 'A venue close derives its FILL across currencies from the stamped fx rate nearest the close (the refusal is retired)',
    invalidates: '⚠ RECORDING ONLY — no decision input. Venue closes now store a converted `closeFillPrice` where the currencies differ and a stamped rate exists (`fxAtClose`: nearest sample AT OR BEFORE the close); before this date such rows stored NULL. A slippage/exit-quality number pooled across this date mixes derived fills with NULLs. Validation on the venue own worked row: #1148 derives 61.204978 against the close rate 61.205 at fx 1.2865.',
  },
  {
    id: 'whitepaper-force-refresh',
    landedAt: '2026-10-02',
    row: 1502, // TRD-WP-1
    title: 'White-paper force path: Generate now and the black-swan path can REWRITE a current-period tier (force bypasses the period gate; the auto wake path stays throttled)',
    invalidates: '⚠ CONTENT PATH — no decision input VALUES change, but a paper written after this date may have been REWRITTEN inside its period (manual button or black swan), so `period` no longer implies "unchanged since period start". The chairs read these papers in the bundle, so a forced rewrite moves bundle bytes mid-era.',
  },
  {
    id: 'capture-evaluate-timeout',
    landedAt: '2026-10-02',
    row: 1504, // TRD-EXE-16
    title: 'A capture that cannot return fails NAMED in 90 s (capture_timeout) and discards the wedged page, instead of holding pageLock forever on a half-dead CDP session',
    invalidates: '⚠ FAILURE-MODE ONLY — captures that used to hang silently now fail counted and self-discard the page. Capture-duration and latch statistics pooled across this date mix the two behaviours; the measured pre-fix hangs were ~8-9 minutes each (reproduced twice).',
  },
  {
    id: 'bridge-park',
    landedAt: '2026-10-03',
    row: null,
    title: 'Operator PARK control: one switch stops every browser-facing loop (scheduled/alert/manual wakes, capture cold-start, mirror cycle, account strip poller, sessionFeed re-attach)',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key (`bridge.*` is outside the guard regex). Landed INSIDE the frozen window with the owner\'s explicit authorisation (2026-10-03), treated as the same class as wake-Pause and the bridge latches. All gates are dormant when unparked (byte-identical behaviour); a PARKED window contains no wakes, no bridge reads and no loop telemetry — do not pool a parked window with a live one. The sessionFeed fix also landed here: the silence watch re-attaches ONLY when Chrome is alive; chrome-off/parked are reported states and are no longer “repaired” by launching Chrome (the measured 10-03 auto-restore).',
  },
  {
    id: 'watchdog-login-render',
    landedAt: '2026-10-03',
    row: null,
    title: 'Watchdog login check reads render-independent account evidence (li[automation] cells / strong labels) and waits for the SPA to settle before any death verdict — the false "plus500 signed out" pages ended',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the same 2026-10-03 authorization as the park build. The change makes the PAGER MORE TRUTHFUL; trading behaviour is untouched. False `watchdog_login_death` rows before this date were render-timing artifacts of the shared tab (the SPA shell boots for ~2-3 s after every mirror navigation), NOT session events — do not read them as logins lost. See docs/incident-2026-10-03-false-login-death.md.',
  },
  {
    id: 'news-aggregator-s1',
    landedAt: '2026-10-03',
    row: null, // open-work 4.19 (TRD-NEW-1 build)
    title: 'News aggregator S1+S2: hourly watchlist-news fetch into NewsItems via the owner\'s SearXNG, plus the deterministic digest endpoint, dashboard panel and content-free toast — write-only, NO consumer (nothing reaches a chair; S3 separately gated)',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the owner\'s explicit direction (2026-10-03 "do 3.14 first"). Writes `news_digest` telemetry + `NewsItems` rows only; chairs, budgets, wakes untouched (the `news` budget consumer was ADDED, inert, cap 60,000/day — spend begins only with the future classification step). Absence of `news_digest` before this date is "not built yet", not "a quiet feed" — the module records NAMED failure reasons per the F1 dead-feed rule (`searxng_unreachable` / `searxng_format_not_allowed` / `searxng_bad_json` / `no_items`). First live cycle 2026-10-03 13:34Z: 10 queries, 12 items, 0 failures. S2 (digest + panel + toast) shipped the same night; the panel carries "not shown to the AI" and nothing here is chair-facing.',
  },
  {
    id: 'hrefmap-guard-and-watchlist-park',
    landedAt: '2026-10-03',
    row: null, // open-work 4.11 + 4.12
    title: 'Two shared-tab hygiene fixes: the hrefMap guard compares CONTENT (no more timestamp-only settings_write churn) and POST /watchlist/open parks the tab back on /open-positions in its finally',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the owner\'s explicit approval (2026-10-03: "11 and 12"). (a) `bridge.hrefMap.at` now means "when the map last CHANGED" — journal rows before this date include ~76% timestamp-only noise (313/410 settings_write rows in the 72 h to 10-03); do not read the earlier churn as real changes, and do not read the drop as "less activity". (b) /watchlist/open no longer leaves the shared tab on the opened instrument — every consumer already assumed the /open-positions resting state. Strict live acceptance (no settings_write churn \u2265 30 min; tab-URL read) rides the first watched session after the weekend close.',
  },
  {
    id: 'volume-null-and-close-source',
    landedAt: '2026-10-03',
    row: null, // open-work 4.6 (absence fix) + 4.22 (close provenance)
    title: 'Volume absence is published as ABSENT end-to-end (NULL, never the 0 sentinel: capture seeds NULL, the interval rollup sums only when every component is known, the bars UI shows \u2014), and every executor close stamps its caller (`closeSource`: wake:<promptId> / review / api / sweep:kill / pairs:<id>) on the trade row and both close events',
    invalidates: '⚠ TWO CLASSES, both operator-scope — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Landed INSIDE the frozen window under the owner\'s explicit direction (2026-10-03: "complete 4.6" + "expand 4.22"). (a) CONTENT SEMANTICS: bars/tick `volume` written from this date is NULL when the feed omits it (previously 0) — a pooled pre/post volume or volume-derived statistic mixes real zeros with absences; interval rollups before this date could publish a partial sum as if complete. obv\'s all-constant guard was already live since 09-23. (b) TELEMETRY ONLY: `Trades.closeSource` (migration 046) — rows closed before this date carry NULL by design; the trade note stays byte-identical (`executor close`), so nothing downstream of notes changes. The completeness pin (test/close-provenance.test.js) makes a future 7th caller that forgets `source:` fail the suite.',
  },
  {
    id: 'premium-analyses-ledger',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 P0)
    title: 'Plus500 Premium-analyses collection ledger (TRD-PRM-1 P0): write-only tables AnalysesNotes + AnalysisLevels, append-only, first rows loaded from the owner screenshots — NO consumer, nothing chair-visible, nothing acts on it',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Write-only collection for a FUTURE pre-registered study (level/calendar confluence; brief: trading/docs/premium-analyses-integration-brief-2026-10-04.md). LOOKAHEAD RULE: any study may only use levels captured strictly BEFORE the trade it judges. Until the study passes AND a separate pre-registration approves a use, no desk component may read the ledger.',
  },
  {
    id: 'premium-analyses-capture',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 P1)
    title: 'Premium-analyses capture (TRD-PRM-1 P1): daily sweep of the Plus500 analyses pages into the write-only ledger from the desk\'s own logged-in Chrome — tryAcquire(\'analyses\') skip-class lock, park-in-finally, regex parse with NAMED failures; NO consumer, nothing chair-visible',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. The capture READS the analyses pages and writes AnalysesNotes/AnalysisLevels only (same class as the P0 ledger seed and news S1). Landed INSIDE the frozen window under the owner\'s direction (2026-10-04). The study clock starts at this ship; the study itself (brief Rev 2 §2 P3) remains gated on its own n.',
  },
  {
    id: 'premium-analyses-nav',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 P1 nav fix)
    title: 'Premium-analyses NAVIGATION fix (TRD-PRM-1 P1): the analyses arrive through the trade page\'s InstrumentInsights entry (per-row `InstrumentRow.<id>.Button.Insights`, client-side-only routes — hard loads of /insights-instruments/* bounce); the v0-v1.2 route guesses (public /action/inter/marketanalysis language-select page; LI-vs-anchor dispatch) are retired; a blocking platform dialog is dismissed before interacting',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Before this date the capture\'s navigation could not reach the analyses at all (named failures only; one junk no_levels row id 3 remains, append-only). Discovery notes: the insights entry is `a#InsightsNav[data-testid=NavigationBar.Button.InsightsNav.Open]` INSIDE its LI; real pointer events required (synthetic events on the LI are no-ops); `.offsetParent` is NULL for fixed-position elements. Nothing reads the ledger.',
  },
  {
    id: 'premium-analyses-vision',
    landedAt: '2026-10-04',
    row: null, // open-work 4.24 (TRD-PRM-1 vision extension, owner-directed)
    title: 'Premium-analyses VISION lane (TRD-PRM-1 extension, owner-directed 2026-10-04): per-view screenshot fed to the LLM (DeepSeek vision verified live HTTP 200) for chart/annotation extraction, stored as its OWN append-only source (`capture-vision`) with model + promptVersion stamped; deterministic regex parse stays the PRIMARY evidence; own budget consumer `analyses-vision`',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. The vision lane is NON-DETERMINISTIC evidence (LLM extraction) kept separate from the deterministic text lane and from the founding owner-screenshot rows; the pre-registered study (brief Rev 2 §2 P3) may only consume it via a further dated pre-registration. Cost: 1 vision call per view (~1.1k prompt tokens measured on a downscaled test image); capped by the `analyses-vision` budget consumer.',
  },
  {
    id: 'bridge-no-last-tab-close',
    landedAt: '2026-10-05',
    row: 1511, // TRD-BRG-1 — the Chrome churn / sign-out loop
    title: 'Wedged-capture recovery recycles the bridge tab by SWAP instead of closing Chrome\'s last tab (TRD-BRG-1 #1511): fresh tab FIRST, then close the wedged one; a 17-exit desk-caused Chrome churn loop is retired',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Bridge lifecycle only. TRD-EXE-16\'s timeout path called page.close() on the SHARED bridge tab, which is normally Chrome\'s ONLY tab — so every wedged capture sweep EXITED Chrome cleanly (no crash dump, no WER event), dropping the bridge for every consumer and risking the venue session: measured 2026-10-05, 17 desk-caused exits across two bursts (wakes ~10 min → sweep → wedged page.evaluate → 90 s timeout → close → exit). Now: fresh tab first (raced 8 s), close second, never the last tab; if the swap cannot start, close NOTHING. Trading behaviour untouched; pooling may continue.',
  },
  {
    id: 'mirror-nav-reduction',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Bridge navigation-traffic reduction (TRD-BRG-1 #1511, soft-nav scout): the mirror parks ONLY when off-park (was a full page load every 60 s cycle ≈ 1,400/day) and the venue-alerts mirror is cadence-throttled to 1-in-5 cycles (~5 min); real park navigations are logged (`mirror_park_nav`)',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Bridge lifecycle only. Measured context 2026-10-05: the desk was performing well over 100 full page loads/hour against Plus500 (mirror 2/cycle + wake captures + a ~90 s unexplained trade→crypto→park burst under investigation). Soft navigation (in-app route change) was scouted and is NOT available for standard routes — crafted AND real anchor clicks, pushState/popstate and menu clicks all produce hard document loads (temp/soft-nav-test*.js); REDUCTION, not soft-nav, is the session-safety lever. Venue-alert mirroring freshness is now ~5 min (was ~60 s); the desk\'s own 15 s crossing watch is unaffected.',
  },
  {
    id: 'venue-ui-testid-detection',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Venue-UI alignment (TRD-BRG-1 #1511): nav detection via NavigationBar TESTIDS (the 2026-10 UI renders icon buttons with no label text — text-only checks failed on every route), the demo guard READS the current page first (was goto(\'/trade\') on every call ≈1,000 navigations/day from the mirror read path — the actual ~90 s burst source), and the park prefers the app\'s own nav button (SOFT client-side route change — the operator finding that anchors/menu-text click hard-load while NavigationBar.Button.openPositionsNav does not)',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Detection/navigation plumbing only. Measured 2026-10-05: the literal string \'Open Positions\' is ABSENT from innerText even on the rich trade page while 18 NavigationBar testids are present; the parked /open-positions minimal render (213-char innerText) carries NavigationBar×18 + MoreMenu.Item.switchdemoreal×2 (textContent \'Switch to Real Money\'), so assertDemo passes in place and the new gate passes from the parked route — no repair-navigations, no pause latch. Trading behaviour untouched.',
  },
  {
    id: 'spread-latency-telemetry',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Spread + latency telemetry (owner-approved "additive", corroboration follow-up to the three external reports): Trades gains spreadSignalPct / signalTickAgeSec (desk tick bid/ask nearest the decision), spreadSubmitPct / spreadSubmitSource (the venue ticket\'s own Buy/Sell read inside placeOrder — NO navigation), signalToFillSec (decision→fill seconds; the audit\'s 31.1 s avg, 132 s max made a row fact) and anchorAgeSec (TRD-ANC-1 anchor age at submit, previously event-only)',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. Every column NULLable, no backfill (old rows stay NULL = unknown), writes best-effort on existing INSERTs; the placement of these columns means "before 2026-10-05T13:45Z the spread/latency split is unmeasured on the row", not that behaviour changed. Deliberately NOT changed: stop/target/trail/tolerance — the policy freeze (#1506) stands.',
  },
  {
    id: 'bridge-state-live-ui',
    landedAt: '2026-10-05',
    row: 1511,
    title: 'Live bridge state machine (owner ask: "a live (semi interactive) state machine, fitted inside the trading agent, not a html report"): the machine as DATA (trading/plus500/bridgeStateGraph.js — states/transitions/causes/windows) drawn by ONE shared renderer (trading/public/js/bridge-machine.js), mounted in the dashboard Health-area card (compact) and /bridge-state.html (full interactive: node/edge story panels, transition timeline, live signals table); the observer exports bridge-state-graph.json from the module and records STRUCTURED transitions ({at,fromState,state,cause})',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. UI/observability only. ⚠ THE PICTURE IS PINNED TO THE CODE: test/bridge-state-graph.test.js (17 pins) drives the reducer with one fixture per arrow and asserts destination state + cause — an edge that lies fails the suite; the two cannot drift. v0 limitations recorded: the observer\'s `attached` signal can flap for one 10 s sample around a DESK restart (seen live 14:23:57Z, self-recovered by 14:24:17Z via WEDGED→NAVIGATING→RESTING) — a display transient, not a desk event.',
  },
  {
    id: 'bridge-state-change-stream',
    landedAt: '2026-10-06',
    row: 1511,
    title: 'Change-driven bridge-state stream (owner: "change 5 s ping to \'when it changes state\'"): same-origin SSE `/bridge-state-stream` on the desk pushes the full state on connect + on every state|category|cause CHANGE (fs.watch on the observer\'s bridge-state.json, 300 ms debounce, fingerprint-gated) + a 5-minute snapshot refresh + a 25 s comment keepalive; both machine mounts and the /bridge-state.html diagnostics table ride ONE connection per page; a 30 s poll exists ONLY as a fallback when the stream is unavailable',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input changes, no epoch reset, no policy key. UI plumbing only. Replaces a 5 s poll across two views (~1.4k requests/hr idle) with push-on-change; payload exposure equals the static bridge-state.json it mirrors; modifier-only churn (e.g. feedSilentForMs ticking) does NOT push a state event.',
  },
  {
    id: 'supervise-auto-restart-policy',
    landedAt: '2026-10-06',
    row: 1511,
    title: 'Supervisor auto-restart, ACTUALLY ENFORCED and narrowed (follow-up to the 2026-10-05 silent desk death 13:08→13:45Z): `--restart` previously changed only the alert TEXT — restartTrading() was never called (an inert control that reported itself ENABLED). New: trading/scripts/supervise-policy.js (pure; 8 pins) + real invocation in supervise.js; the scheduled task passes --restart; restart ONLY when the desk is PROVABLY GONE (state down + crash-guard heartbeat pid dead), NEVER for hung/wedged (killing a live desk can strand an order), 10-minute backoff; "held" reasons are stated in the alert',
    invalidates: '⚠ OPERATOR-SCOPE — no policy keys, no era reset; supervision plumbing only. Behaviour change confined to the failure path: a desk that has PROVABLY vanished is now restarted within ~5 min instead of waiting for a human (the 10-05 outage cost 37 min); a live-but-sick desk still pages instead. First scheduled run with the new wrapper: 2026-10-06 00:25Z, result 0.',
  },
  {
    id: 'desk-mirror-ui',
    landedAt: '2026-10-06',
    row: 1511,
    title: 'Desk mirror UI (owner: "creating the dynamic UI mirror to the plus500 desk"): trading/scripts/mirror-export.js (read-only DB exporter, 4 s, detached) → trading/public/desk-mirror.json → trading/public/desk-mirror.html (live open positions with P&L/stops, account strip, last-24h closes + realized total, recent fills WITH the new spread/latency telemetry, era counter); dashboard Health-card link; the page fetches only while its tab is visible',
    invalidates: '⚠ OPERATOR-SCOPE — no decision inputs, no epoch reset, no policy key. Payload is the same public class as bridge-state.json; the page is a renderer over a public JSON. Nothing writes to the desk or the venue.',
  },
  {
    id: 't2-freeze-lift-bundle',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'T2 freeze-lift bundle (owner decision C executed; boundary 2026-10-08T00:45:50.735Z): (1) PRU-1 scope-only prune — symbolScope SGX/Sugar/Bitcoin/"Arabica Coffee" -> [] (journal #237651 changed:4); (2) TRD-EXI-1c near-stop cut floor 0.30 -> 0.20 (journal #237653 + code defaults exitPolicy.js/store.js; Sec 3.3 window started); (3) chair leaves the entry path — owner shape (b), deliberation.chairs: [] (journal #237654; chairsResolved derived-empties; risk gate + exits untouched); (4) era re-anchor at the first write + watchers re-armed',
    invalidates: '⚠ THE ERA BOUNDARY — the first sanctioned policy change after the 2026-10-02 freeze; opens the post-T2 era at 2026-10-08T00:45:50.735Z (n=30 clock restarts; earlier eras must NOT be pooled across it). FOUR WRITES RIDE ONE WINDOW — per-change attribution is LOST unless a change gets its own era (accepted deliberately; PRU-1 n>=60 kill rule and EXI-1c Sec 3.3 clock — first 25 permitted cuts OR 30 trading days — both run on this window; chair watched via entry-mix + attribution counts). Tests 1/2 restart at this boundary (dated revisions: pre-registration-2026-10-01 + PRU-1 Sec 8 + EXI-1c). The trail (TRD-TRL-2 / lock075_t15 candidate) is deliberately NOT bundled — its own T2.5 watched verification (automation armed) gates it. The #1506 re-take verdict: profit rule stays NOT adopted (fragility unchanged) — no profit-rule change rides this boundary.',
  },
  {
    id: 'trail-probe-ticket-state',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'TRD-TRL-8 read-only probe instrumentation (T2.5 abort forensics, 2026-10-08T00:49Z Silver read-back 0.65 vs 1.26): `probeTrailCurve` gains OPTIONAL ticket-state inputs — `stopPrice` (CloseAtLoss card engaged via toggleLimit + fillRate) and `size` (amount via the native setter) — plus a `counts` override on POST /orders/trail-curve-probe; the repro runner gains `counts= / stop= / size= / label=` args. Purpose: reproduce the ONE state variable every clean sweep lacked (the engaged stop card) and quantify Silver offset drift (measured 0.052 on 09-30 vs ~0.074 today, pip 0.001 confirmed both directions)',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision inputs change, no epoch reset, no policy key; the T2 era boundary stays 2026-10-08T00:45:50.735Z. The probe WRITES NOTHING: every input feeds `#trade-button`, which it never presses — nothing on this venue arms until that click, the same safety argument as the count itself.',
  },
  {
    id: 'silver-pip-offset-remeasure',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'Silver PIP_UNITS offset data correction (TRD-TRL-8 forensics): offset 0.052 -> 0.078, measuredAt 2026-10-08; pip 0.001 and both clamp ends (floor 45 / ceiling 37,850) reconfirmed unchanged across four read-only sweeps (buy+sell, n=8 rows). The 09-30 offset missed by ~2% at the T2.5 abort count — inside the landing band but outside the 2% verify band, i.e. straight into the fail-safe; the trail itself stays OFF and remains gated on its own T2.5 watched verification',
    invalidates: '⚠ OPERATOR-SCOPE — a measured NUMBER in an OFF feature\'s table, not a policy key: while the trail is disabled no live decision input changes. If/ when the trail re-enables this row becomes a real input and must not be pooled with the pre-correction paper studies (lock075_t15 etc. were measured with the 09-30 row). No epoch reset.',
  },
  {
    id: 'trd-trl-9-engage-staged',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'TRD-TRL-9/10/11 STAGED trail-promotion build (owner green light: option 2, build-only; first live engage held for the walkthrough): (a) `webtrader.setPositionTrail` — the post-entry trail engage through the Edit -> Set Limits card, commit-gated, with a fully read-only mode (`commit:false`) + route `POST /orders/edit-trail-probe` as its verification vehicle; (b) `agent/trailEngage.js` — the lock075_t15 touch decider (per-trade peak watermark; explicit missed-window and venue-minimum refusals) + a 60 s flag-gated loop in server.js; (c) settings seed `risk.trailingStop.engageOnTouch { enabled:false, lockR:0.75, trailR:0.15 }`; (d) forward SHADOW monitor `temp/shadow-exit-watch.js` — lock075_t15 vs the live build over live 1h bars (adv-first, scale-guarded), one `shadow_exit` event + TG line per finalized trade; (e) pip sampler `temp/pip-sampler-watch.js` — periodic read-only Silver sell sweeps recording price + ticket bid/ask + offset (the offset-vs-price hypothesis test)',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: every behaviour-changing switch ships FALSE. `engageOnTouch.enabled:false` at deploy; `trailingStop.enabled` stays false; `setPositionTrail` is reachable only in `commit:false` mode (the probe route) until the walkthrough. The shadow monitor and pip sampler are READ-ONLY (SELECTs; sweep probes on UNSUBMITTED tickets; their own event kinds `shadow_exit`/`trail_engage_*`); they change no decision input and must not be read as the promotion itself. Promotion requires, at the walkthrough: (i) the read-only edit-card verification passed on a live position, (ii) shadow deltas accumulating in the right direction, (iii) the fresh-n evidence re-read on current data.',
  },
  {
    id: 'trd-pru-3-candidate-screen',
    landedAt: '2026-10-08',
    row: 1506,
    title: 'TRD-PRU-3 READ-ONLY candidate screen (owner ask 2026-10-08: "a separate set of new instruments that has the same type as the winners, like another test case... since it not touching current, the timer wont reset"): route `POST /orders/instrument-screen-probe` + `webtrader.probeInstrumentPages` — CATEGORY-PAGE NAVIGATION ONLY, reads every instrument row own buy/sell, computes spread + spread% per instrument; runner temp/instrument-screen.js; PLUS `probeInstrumentBars` (TRD-PRU-3b: per-symbol chart backfill, series + interval-verdict fields, focus-only) via `POST /orders/instrument-bars-probe` — feeds the winners-profile intake: screen -> cost screen -> historical backfill + profile study -> paper evidence before ANY scope change.',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: navigation-only probe (no ticket, no order, no settings write); the live trading scope, all decision inputs and the era clock are untouched by construction. Any future LIVE promotion of a candidate symbol is its OWN pre-registered change with its own boundary — this entry does not cover that.',
  },
  {
    id: 'continuity-merge-2026-10-18',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'CONTINUITY MERGE from the laptop hand-off bundle (owner-directed return-to-service): five merged changes — (1) trading/server.js TRADING_CAPTURE_ONLY early-return (data-collection mode: skips every agent loop; 240 s capture deadline + in-flight guard + stage logging); (2) trading/plus500/browser.js#newPage() authoritative sever (TRADING_PLUS500_DISABLED — every navigable page flows through newPage, so one refusal severs all goto/reload/bringToFront sites) plus bringToFront() bounded to 3 s (the unbounded await stalled EVERY capture with no result and no error); (3) trading/plus500/capture.js TRADING_CAPTURE_SKIP_HEALTH bypass of the selector-health gate (read-only mode only); (4) trading/agent/providers.js Polygon Yahoo id POL-USD -> POL28321-USD (old id 404, re-verified live on the desk 2026-10-18: POL28321-USD 200, POL-USD 404); (5) config/servers.json registers `expenses` (it was found dead and unregistered — the dashboard starts children on boot but does NOT respawn a child that dies mid-run). Plus five NEW files: trading/scripts/record-instruments.js, record-plus500-ticks.js (no-navigation DOM tick reader), record-plus500-details.js (instrument-details cycler + session keep-alive), plus500-keepalive.js (Trade -> Open Positions -> Trade soft nav), Ensure-Services.ps1 (start-only service watchdog) — NONE scheduled on the desk; docs/10-ARCHITECTURE-NOTES.md carries the ADR rationale (navigation is the risk; page.evaluate has no timeout; sever at the choke point).',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: every behaviour-changing switch ships INERT (the three env flags are unset on the desk; the capture-only block returns before any loop starts; assertEnabled() passes; the SKIP_HEALTH branch is false). The bringToFront bound and the Polygon id fix are operational/data corrections with no decision input (the old id 404d, so no number was ever computed from it). No settings write, no scope change, no era reset — the T2 era boundary (2026-10-08T00:45:50.735Z) stands. ⚠ The seven-day outage span (10-09 -> 10-16; desk off, 0 TradingEvents) precedes this entry and must not be pooled.',
  },
  {
    id: 'mirror-cycle-deadline',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'MIRROR CYCLE DEADLINES (owner: "you can fix that, it is the weekend"): every venue await in the mirror poller now races a hard deadline — positions 45 s, closed-positions 20 s, alerts 20 s, park 30 s (MIRROR_DEADLINES_MS + withDeadline in trading/agent/mirrorPoller.js). Root cause: the mirror holds the SHARED pageLock for its whole cycle and ONE hung page.evaluate (Playwright has no default timeout) held it indefinitely — measured as recurring `bridge busy (mirror) — lock wait exceeded for ticket` (28 hits since the 10-17 restart; caller: the candidate-capture lane POST /orders/instrument-bars-probe with a 240 s ticket wait, the touch-probe lane waits 120 s). Worst-case mirror hold is now ~115 s, under every ticket waiter; the finally still releases the lock on timeout and the failure is named in the event stream.',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: no decision input, no settings write, no scope change — the mirror is read-only beside the desk and the T2 era boundary stands. ⚠ Behaviour note: when a bound trips, that cycle\'s reads are incomplete (named error in the log) and the NEXT cycle retries; a trip can briefly DELAY a mirrored venue close but never corrupt one (the ledger reconciles on the next successful read). Freeze window restarted after this deploy.',
  },
  {
    id: 'watchlist-quote-fast-path',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'WATCHLIST QUOTE FAST PATH (owner: "start on 1. watchlist name is analysis"; ADR-1 applied): the dynamic capture no longer searches per instrument for QUOTES — captureDynamic reads the venue watchlist table ONCE (webtrader.readInstrumentTable; /trade/watchlists--86806649 persisted as bridge.watchlistUrl) with the tick burst moved from per-symbol ticket re-reads to table re-reads (3 reads ≈ 4.5 s total vs ≈ 45 s), and quotes are BANKED BEFORE the chart sweep so a slow venue can never time-out the wake prices. CHART-BAR COVERAGE IS UNCHANGED: every watchlist symbol chart is still read on every dynamic capture via captureBySearch({chartsOnly}) with a focus-miss guard; symbols the table does not carry fall through to the legacy search path ({only}); the universe sweep keeps its unchanged triggers and its recoveries are banked too. Root cause measured: 10 symbols × (search+select 2-4 s + burst 3.6-5 s + chart 2-4 s + jitter) = 7-15 s/symbol > the 90 s budget → named capture_timeout + tab swap on nearly every wake. Pins: test/watchlist-quotes.test.js (4).',
    invalidates: '⚠ OPERATOR-SCOPE with a BEHAVIOUR NOTE: same prices from the same source (venue frontend, source=plus500_frontend, venue of record) and the same per-wake chart coverage — but a quote is now the watchlist row sell/buy at table-read time (three samples per wake, as before) instead of a ticket sample taken mid-search. Bar freshness semantics unchanged (every symbol chart still read each wake; quant BAR_FRESH_MS=4h untouched). bridge.watchlistUrl is account-specific data, not a policy key. No settings write, no scope change, no era reset.',
  },
  {
    id: 'watchlist-fast-path-pin-repair',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'WATCHLIST FAST PATH PIN REPAIR (same change window, same owner directive): the two source pins in test/capture-chart-bars.test.js went red against the restructured captureDynamic and BOTH findings were real — (1) mergeChart still accumulated chartIdentity/chartMerge, fields captureBySearch logs at the point of measurement and captureDynamic never returns, so the accumulation was DEAD CODE; removed. (2) The chartMissing pin asserted one literal destructure line; captureDynamic now declares its own accumulator, so the pin was GENERALISED to the invariant it was written for — every scope that MENTIONS chartMissing must BIND it (destructure OR declaration), the ReferenceError-at-capture-time guard intact. No behaviour change: the verified live capture (captured 30 ticks, missing 0, watchlist_quote_source goto 1441 / wait 4594 / burst 2980 ms) exercised this path before and after the cleanup. Pins: 17/17 across capture-chart-bars + watchlist-quotes.',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: dead-code removal plus a test-pin generalisation; no decision input, no settings write, no scope change; same prices, same sources, era clock untouched. Desk restarted to load the identical-behaviour build.',
  },
  {
    id: 'desk-singleton-guard',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'DESK SINGLETON GUARD (night shift, 2026-10-18): the desk REFUSES to boot when another desk already answers /healthz on 127.0.0.1:8115, and a bind failure is logged NAMED instead of dying anonymously. Measured failure this exists for: TWO trading\\server.js processes were alive at once — Windows let both bind :8114 because they had chosen different interfaces (one 127.0.0.1, one 0.0.0.0) — so EVERY POST /capture reached the STALE build while restarts reported "started pid N, healthz ok"; roughly forty minutes of this session was spent measuring code that was not running. Bind success is not the test (that is what silently passed twice): the health endpoint is, because only a desk serves /healthz and its listener is always loopback. Trading/lib/singleton.js#probeExistingDesk requires 200 + body ok, so a foreign listener on the port cannot block a legitimate boot. New pins: test/desk-singleton.test.js (4).',
    invalidates: '⚠ OPERATOR-SCOPE — NOT a policy boundary: boot-time guard only; no decision input, no settings write, no scope change. Inert whenever no other desk is serving (probe answers not-alive and boot proceeds exactly as before). Era clock untouched.',
  },
  {
    id: 'capture-rotation-backoff',
    landedAt: '2026-10-18',
    row: 1506,
    title: 'CHART ROTATION BACKOFF for a closed venue (night shift, 2026-10-18): after 2 consecutive rotations that complete but bank ZERO bars, the next 2 wakes skip the rotation and the 3rd tries again — so a weekend venue stops costing up to 40 s of shared-tab budget per wake (measured weekend capture 61.3 s vs ~15-20 s without rotation) and a venue REOPEN is still picked up within ~20 min (quant BAR_FRESH_MS = 4 h). Telemetry stays signal-only: the zero-bank event now carries zeroStreak + skipNextWakes, and a rotation that banks bars after a streak logs `chart_rotation resumed` once, so the weekend-to-Monday transition is visible instead of inferred. Backoff state is module memory (resets on restart — a restart simply tries once).',
    invalidates: '⚠ OPERATOR-SCOPE with a BEHAVIOUR NOTE: chart-bar coverage is unchanged while the venue serves bars (rotation runs exactly as before and clears the streak on the first banking run); ONLY a venue that banks nothing is backed off, and bars are supplementary (structure venue, 4 h SLA) — no quote ever depends on a chart visit. No settings write, no scope change, era clock untouched.',
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
];

const DAY = 86400000;
const asDate = (v) => (v instanceof Date ? v : new Date(v));

// ⚠ AN OPEN-ENDED SENTINEL, so the newest range matches everything after it and the join needs no special case.
const OPEN_END = '9999-12-31T23:59:59';

// ★★ THE RANGES ARE DERIVED IN ONE PLACE, for the same reason the chair-persona resolver is (TRD-DEL-1): the answer
// this module gives to `?about=` and the row a RAW SQL reader joins must not be able to disagree about where a
// boundary sits or what it is CALLED. A test caught the first version doing exactly that — the module named a regime
// after a feature (`chair-sees-panel`) while `FeatureEpochs` named it after the date (`day-2026-09-25`), so the same
// day had two names depending on how you asked. `scripts/sync-feature-epochs.js` imports this function instead of
// re-grouping, so the two cannot drift again.
//
// ⚠ ONE ROW PER DISTINCT LANDING DATE, NOT ONE PER FEATURE. Seven features landed on 2026-09-25, and a table with
// seven rows sharing a `landedAt` produces seven OVERLAPPING intervals — a single `Trades` row would match seven
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
  // ⚠ A DATE BEFORE THE EARLIEST RANGE HAS NO REGIME, and saying otherwise is the opposite of the truth.
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
    // ⚠ THE REGIME NAME COMES FROM `rangeFor`, NOT FROM `featureOn`, so it matches the `id` a raw SQL reader joins
    // against in `FeatureEpochs`. Naming it after the individual feature is what a test caught drifting.
    const r = rangeFor(about);
    // ★★ `safe` HAS ONE MEANING, AND THE FIRST VERSION GOT IT WRONG IN A WAY THAT MATTERS.
    //
    // For a WINDOW, `safe` means "the range sits inside ONE regime". For a single date the first version set it to
    // "a regime exists" — so a date inside the SUPERSEDED `stop-cap` regime came back `safe: true` while that
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
          ? `this date sits in an EARLIER regime (${r.id}), superseded on ${r.nextLandedAt} — its data is documented but not comparable with current data`
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
    // ⚠ ONLY THREE CONDITIONS MAKE A SINGLE MEAN A DESCRIPTION OF ONE THING.
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
  return `window ${win} (epoch ${a.epoch}) — ${tail}`;
}

// ★ THE RAW-SQL PATH. An agent reading with `SELECT` sees neither this file's comments nor any endpoint, so the
// boundary has to be JOINABLE. `FeatureEpochs` is materialised from FEATURES by scripts/sync-feature-epochs.js with
// a `nextLandedAt` bound, so a range join is a plain inequality rather than a correlated subquery.
function sqlEpochJoin({ dateExpr = 't.createdAt', alias = 'e' } = {}) {
  return `LEFT JOIN FeatureEpochs ${alias} ON ${dateExpr} >= ${alias}.landedAt AND ${dateExpr} < ${alias}.nextLandedAt`;
}

module.exports = { EPOCH, POLICY_FREEZE, FEATURES, ranges, rangeFor, featureOn, featuresBetween, annotate, windowLine, sqlEpochJoin, DAY };
