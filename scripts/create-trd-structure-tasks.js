// scripts/create-trd-structure-tasks.js — register this session's task set against edict 52 (Trading Agent).
//
// Runs through `models/taskModel.createTask` rather than raw INSERT so the two invariants that live in that
// module are honoured: `sortOrder` is allocated per edict (so the manual ordering does not collide), and
// `completedAt` is set by the STATE rather than by the caller (state 3 = done). A hand-rolled INSERT would
// have to reproduce both, and the second one is exactly the kind of derived field this repo refuses to let
// a caller set.
//
// Naming follows the owner's mandated convention (user memory, 2026-08-05):
//   (policy short name, <=3 chars)-(function name, <=3 chars)-(numbered task set): <domain> — <description>
// The function segment is present because every name here is 3 characters.
//
// ★ STATE IS ASSIGNED FROM EVIDENCE, NOT FROM OPTIMISM. A task is only state 3 (done) if the artefact it
// names exists and was verified in this session. TRD-GRD-1 and TRD-AUD-1 meet that bar; the other seven do
// not, and are state 1. In particular TRD-REV-1's *measurement* is complete but its *deliverable* (the
// observe-mode rule) is not, so it stays open — a done-measurement is not a done-task.
//
// Usage (from the repo root):
//   node scripts/create-trd-structure-tasks.js          # DRY RUN — prints every row it would write
//   node scripts/create-trd-structure-tasks.js --yes    # writes them
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;            // "Trading Agent"
const USER = null;           // unassigned, matching TRD-115..119
const TODAY = new Date();
const DONE = 3;
const OPEN = 1;

const TASKS = [
  {
    name: 'TRD-GRD-1: Capture integrity — observe-mode bar-scale detector, and the 4 wrong-instrument rows it found',
    state: DONE, priority: 1,
    info: 'DONE 2026-09-23. `barScaleReview` + `trailingReference` + `BAR_SCALE_MAX_RATIO` in '
      + 'trading/store/bars.js, exported, NOT wired to the write path. 8 tests, test/bar-scale-review.test.js. '
      + 'barViolation is ROW-INTERNAL: the China Telecom row (open 4.40, high 93.29, low 4.40, close 89.61) '
      + 'passes it, because an internally-consistent bar about the WRONG INSTRUMENT is invisible to it. '
      + 'WINDOW IS MEASURED: an expanding median gave 2,011 candidates, ALL false (trends — BTC 16k->108k '
      + 'reads 6.8x; Apr-2020 oil 55->10 reads 0.18x). A true TRAILING window gives 4. '
      + 'CONFIRMED against venue quotes: 4 rows, all 2026-09-17, all unflagged — plus500_chart/SGX 1d '
      + '(open 22.214, high 277.520, low 22.080, close 276.720 vs venue 21.97-22.53) and plus500_chart/'
      + 'Sands China 1d+1h 05:00/06:00/14:00 (97.00-99.00 vs venue 12.06-12.23; the 07:00/08:00 rows hold '
      + 'the TRUE 12.05-12.18 and everything else is an intruder near Oil\'s level that day). '
      + 'Blast radius measured against PriceTicks first: exactly 5 rows. Deleted by UQ key. '
      + '★ ONE ROW WAS FOUND ONLY BY THE CONFIRMATION STEP, not the detector — the Sands China 1d row was '
      + '`unguarded` (too few prior daily closes). That is why promotion requires the tick comparison.',
  },
  {
    name: 'TRD-AUD-1: Deliverables — structure-engine stage audit',
    state: DONE, priority: 1,
    info: 'DONE 2026-09-23. Report: trading/docs/structure-engine-stage-audit-2026-09-23.md. '
      + 'S1/S2 verified standing; S4 genuinely absent (promptBuilder has zero refs to structure/activity/'
      + 'candidateProximity). ★ THE DESIGN REPORT §12 IS STALE: S3 IS registered — LabCandidates id 24, '
      + 'survgoldstruct/Gold/yahoo, registrationNo 372, status `registered`. id 23 (plus500_chart) is the '
      + 'mis-registration, archived 22s earlier WITH its `score` retained, so a strategy-only query returns '
      + 'the withdrawn row\'s score. ★ LOCKBOX RELEASED EXACTLY ONCE: 2026-09-10, m=1, mFrozen=15, '
      + 'kCounter=367, bhResult.significant=[] (nothing significant), prdsCheck flagged r=-0.3846. '
      + '★ THE FOUR GATES, MEASURED — TRD-26 is NOT "lockbox starved" but starved of SUBJECTS (its three '
      + 'rows are candidates 20/21/22, ALL ARCHIVED, with w4n 33/61/51 all ABOVE the n>=20 floor, and '
      + 'survgold/survoil are not in the row set at all). TRD-71: total 2, allow 0, exempt 2, '
      + 'exemptSharePct 100 — it has never had one pair it was permitted to judge. TRD-110: the lever is '
      + 'SPENT not forgotten (registrationNo IS the family k). TRD-112: 6 consecutive refusals, one reason.',
  },
  {
    name: 'TRD-EVD-1: Strategy evidence — condition-paired decision unit (replaces absolute expectancy)',
    state: OPEN, priority: 1,
    info: 'THE ARGUMENT (from TRD-AUD-1): four gates fail for four proximate reasons and ONE shared root — '
      + 'the unit of evidence is the absolute expectancy of a single registered pair judged at one lockbox '
      + 'release with m=1. Under that unit a pair cannot be judged until n>=50; a release judges the whole '
      + 'family at once and spends the window permanently; adding pairs to reach throughput makes the BH '
      + 'correction harsher; and the one release that happened returned nothing significant so no '
      + 'downstream flag may flip. THE CHANGE: unit = a PRE-REGISTERED CONDITION judged PAIRED on the same '
      + 'trades. Reuses trades the desk already has, needs no release, does not widen k. '
      + 'LEVER (owner-decided 2026-09-23): (i) DEEPEN the series window — changes no rule, only the data '
      + 'window, so it needs a recorded window LABEL or verdicts stop being comparable. '
      + 'BLOCKER: lab/scoreboard.js loadLabSeries range:\'1y\' -> the lockbox W4 can fall below n>=20. '
      + 'REQUIRED BEFORE THE FIRST RUN: a §14-style pre-registration. DO NOT call releaseAll first.',
  },
  {
    name: 'TRD-REV-1: Position review — boundary-triggered cadence (observe mode, NOT a gate)',
    state: OPEN, priority: 2,
    info: 'MEASURED 2026-09-23, script trading/scripts/repro/review-gate-thresholds.js (read-only). '
      + 'TWO of my own errors were found and corrected, both producing a fake zero: run 1 priced the path on '
      + 'the MID (a SELL is closed by the venue buying at the ASK); run 2 fixed that and STILL read zero '
      + 'because `position_poll` (10s, single-sided venue rate) STOPS AT THE CLOSE — the touch always falls '
      + 'in the blind gap (measured 26s on #1067: last poll 4371.25, stop 4372.4381, venue fill 4373.85). '
      + 'Recovered instead from `closePrice`, a FILL not a sample: 6 events, and the note/closePrice '
      + 'reconciliation is clean (12 venue-closed, 9 closePrice-at-a-level, 9 agree, 0 conflict). '
      + 'HAZARD (n=6): <0.1% 25.0% | 0.1-0.2% 7.1% | 0.2-0.3% 1.2% | >=0.3% 0 of 700. '
      + '5-MIN TRAVEL (30,839 pairs): p50 0.036% | p90 0.115% | p95 0.148% | p99 0.244%. '
      + '=> P* = 0.25% absolute and ceiling ~90 min (dwell p50 2m / p90 87m / p95 162m). '
      + '⚠ The 1% budget passes at EVERY candidate at n=6, so the budget excludes nothing; the travel '
      + 'distribution is what pins the value. ⚠ 27 reviews produced ZERO close verdicts, so the GATE\'S VALUE '
      + 'is still unmeasurable — deliverable is the pre-registered rule + observe-mode `would_suppress` '
      + 'logging, never a silent skip (a skipped review IS a max-confidence hold). '
      + '★ SECOND DEFECT FOUND: plus500_frontend samples the watchlist every 12-14 min — COARSER than the '
      + '5-min review cadence, so a review re-reads the same quote ~2 of 3 times (433-min stall on #1066).',
  },
  {
    name: 'TRD-STR-1: Structure engine — S3 gate input venue (backtest reads yahoo, live reads plus500_chart)',
    state: OPEN, priority: 2,
    info: 'Recorded as a residual asymmetry in the design report and still open. The Lab loads ONE series '
      + 'per candidate, so the registered S3 pair (LabCandidates id 24, venue `yahoo`) runs its GATE on '
      + 'yahoo structure while the LIVE signal resolves structure from the venue of record '
      + '(`plus500_chart`). §7 rule 4 wants those to agree. The lockbox comparison stays internally valid '
      + '(both arms on the same series) but its absolute numbers cannot reproduce live. Registering with '
      + 'venue `plus500_chart` matches the structure venue and leaves the signal venue unmatched — '
      + 'neither choice removes the asymmetry, so this is a ruling to make, not a bug to fix.',
  },
  {
    name: 'TRD-STR-2: Structure engine — S4 vocabulary: prompt-version bump + fresh shadow pre-registration',
    state: OPEN, priority: 2,
    info: 'S4 is the only stage with no code (verified: promptBuilder.js has zero references to `structure`, '
      + '`activity` or `candidateProximity`). It carries three things, and they must land together: the '
      + 'computed structure fields in the bundle, the vocabulary/P3 change, and the `candidateProximity` '
      + 'clause MOVED HERE from S2 (it renders into both the chair prompt and bundleObj, so it is a '
      + 'reviewer-visible change by construction). Gated on: a prompt-version bump AND a fresh shadow '
      + 'pre-registration — shadowGate marks its gate FROZEN and any bundle change invalidates it, and '
      + 'TRD-72 already invalidated it once. Depends on TRD-STR-1 (which structure is being published).',
  },
  {
    name: 'TRD-STR-3: Evidence — the lockbox release that would give S3 a verdict (one-shot, family-wide)',
    state: OPEN, priority: 3,
    info: 'OWNER DECISION, deliberately not scheduled as work. LabCandidates id 24 has verdict NULL, which '
      + 'eligibility.liveEligible reads as "no release has ever scored this candidate" -> not eligible. '
      + 'A verdict requires a release, and a release is family-wide and widens the correction for the 15 '
      + 'frozen pairs: registrationNo IS the family k (lab-register-s3.js says so in its own header). '
      + 'The single release so far was 2026-09-10 (m=1, mFrozen=15, kCounter=367) and returned '
      + 'significant: []. This task exists to record the cost, not to recommend spending it — which is '
      + 'exactly what TRD-EVD-1 is for instead.',
  },
  {
    name: 'TRD-STR-4: Evidence — resolve the unresolved PRDS flag on release 3 (r=-0.3846, flagged true)',
    state: OPEN, priority: 1,
    info: 'THE CHEAPEST ITEM IN THIS SET AND THE ONLY ALREADY-INCURRED OBLIGATION. LabReleases id 3 '
      + '(2026-09-10) carries prdsCheck = {"r":-0.3846,"n":15,"flagged":true,"note":"weak/negative '
      + 'cross-correlation across W4 halves - OWNER REVIEW required before BH"}, and no disposition is '
      + 'recorded anywhere. A flagged research-integrity check is sitting on the record with no '
      + 'resolution. It needs an owner reading and a recorded answer, not code.',
  },
  {
    name: 'TRD-GRD-2: Capture integrity — promote the bar-scale detector past observe mode',
    state: OPEN, priority: 2,
    info: 'BLOCKED ON ITS OWN PRE-REGISTERED CRITERION, written into trading/store/bars.js before the first '
      + 'run and not to be moved: (a) >=14 consecutive days of observation with a capture sweep each day; '
      + 'AND (b) ZERO false positives on bars a human has confirmed legitimate — where "legitimate" is '
      + 'established from the venue\'s own quotes in PriceTicks at the same barStart, NEVER from the bar '
      + 'and NEVER from the median (that is the circularity TRD-117 caught in maeSource=\'close\'). '
      + 'First-pass evidence: 4/4 candidates confirmed real, 0 FP — but n=4, so the criterion is NOT met. '
      + '★ THE TRAP IS PROVED EXECUTABLE IN THE TEST FILE, not just described: a majority-corrupt history '
      + 'makes the median the corruption and the CLEAN repair row gets flagged. Until both criteria hold '
      + 'the output stays a list to read, never a rule that acts.',
  },
];

(async () => {
  console.log(`edict ${EDICT} · ${TASKS.length} task(s) · ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  for (const t of TASKS) {
    console.log(`  [state ${t.state}${t.state === DONE ? ' DONE' : ''}] pri ${t.priority}  ${t.name}`);
    console.log(`      info: ${t.info.length} chars`);
  }
  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --yes.');
    process.exit(0);
  }
  for (const t of TASKS) {
    await taskModel.createTask(t.name, TODAY, null, t.info, t.priority, t.state, USER, EDICT);
    console.log(`wrote: ${t.name.slice(0, 70)}…`);
  }
  const all = await taskModel.getAllTasks({ limit: 12 });
  console.log(`\nnewest rows now:`);
  for (const r of all.slice(0, TASKS.length)) {
    console.log(`  id ${r.id} state ${r.state} completedAt ${r.completedAt ? 'set' : 'null'}  ${String(r.name).slice(0, 80)}`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
