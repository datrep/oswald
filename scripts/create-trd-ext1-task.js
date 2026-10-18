// scripts/create-trd-ext1-task.js — register the exit-policy re-measurement of 2026-09-24.
//
// Consequence of the owner asking to MEASURE the Gold position rather than infer it. The measurement
// (a) refutes the premise for the specific trade, and (b) contradicts a CLOSED task and exposes a
// degenerate cohort split in the only harness that ranks exit rules.
//
// Same discipline as scripts/create-trd-shw4-task.js: writes through `models/taskModel.createTask`.
// Schema traps: `plannedStart` is NOT NULL with no defaults; `active` is COMPUTED (never insert it) and a
// raw SQL `GETDATE()` writes local wall-clock, 8h ahead of its `GETUTCDATE()` comparison -> active = 0.
//
// Usage:
//   node scripts/create-trd-ext1-task.js          # DRY RUN
//   node scripts/create-trd-ext1-task.js --yes    # writes
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;   // "Trading Agent"
const OPEN = 1;
const TODAY = new Date();

const NAME = 'TRD-EXT-1: Exit policy — the follow-through rule is now the BEST candidate (contradicting closed TRD-38), and the cohort split that would test it is degenerate';

const INFO =
  'FOUND 2026-09-24 by MEASUREMENT, after the owner asked that a Gold position be measured rather than '
  + 'inferred. Registered under the owner rule that a novel repo-specific finding becomes a task, not a memory '
  + 'note.\n\n'
  + '★★ (1) THE PROMPTING OBSERVATION IS REFUTED FOR THE TRADE IT CAME FROM. The owner screenshotted a Gold '
  + 'row (Sell 0.225 Troy Ounces, P/L -S$2.90, 4,277.03 / 4,287.02, 9/24/2026 10:19 AM, "Loss call") and read '
  + 'it as "hovering $10 P/L before a sharp traceback", so that a trailing stop would have banked profit. That '
  + 'row is `Trades` id **1090** — matched on FOUR independent fields: `grossPnl` exactly -2.9, `closePrice` '
  + 'exactly 4287.02, `closeAt` 2026-09-24T02:19:00Z = 10:19 SGT, and `note` "venue closed — Loss call". Its '
  + 'measured `mfePct` is **-0.0196%** (about -$0.19) with `maePct` -0.2373% and `holdingMinutes` **8**. **It '
  + 'was never favourable at all**, so there was no profit to protect. The counterfactual agrees independently: '
  + 'the study below scores id 1090 at **follow 10m = -1.28 R, IDENTICAL to actual and to venue-only**. And no '
  + 'recent Gold trade reached +$10 — MFE in dollars: id 1089 **+$5.01**, 1091 **+$4.59**, 1085 +$2.13, 1087 '
  + '+$1.79, 1090 -$0.19. **The "$10" does not match any recent Gold trade, so the row being read should be '
  + 're-identified before acting on it.**\n\n'
  + '★★ (2) THE CLOSE AUTHORITY WAS THE VENUE, AND THE RACE IS STRUCTURAL. `note` = "venue closed — Loss '
  + 'call", `closePriceSource` = `venue_rate`, and `stopPrice` 4286.9624 was touched. ★ The harness states the '
  + 'general rule: **the venue acts SERVER-SIDE, so it wins the race against any desk-side rule** ("if a VENUE '
  + 'LEVEL is touched first, the trade ends there"). Measured: **venue level touched within 24h on 23 of 45 '
  + 'trades.** ⇒ Teaching the waker the moving trail level (recorded in `trading/docs/'
  + 'STRATEGY_AMENDMENT_REPORT.md:339`) only helps once the trail has ratcheted TIGHTER THAN the venue stop. '
  + 'For a position that never went favourable it cannot help, because the venue gets there first.\n\n'
  + '★★★ (3) THE REAL FINDING — THE CURRENT DATA CONTRADICTS A CLOSED TASK. `trading/scripts/repro/'
  + 'exit-policy-study.js`, run 2026-09-24 over 45 trades opened 2026-09-15..2026-09-24 (R-multiples, real mid '
  + 'paths replayed forward 24h):\n'
  + '    actual          -8.53 R\n'
  + '    venue-only     -12.14 R   (delta -3.61, 10 better / 15 worse)\n'
  + '    maxHold 30m     +1.55 R   (delta +10.08, 27/13)\n'
  + '    ★ follow 10m    +3.54 R   (delta +12.07, 26/16)  <-- BEST of 13 rules\n'
  + '    follow 60m      -2.54 R   (delta  +5.99, 17/18)  <-- WORST of 13 rules\n'
  + 'TRD-38 (id 1279, **state 3 CLOSED**) is titled "Exit-policy counterfactual — **every short-horizon rule '
  + 'is worse**, which contradicts A1 as written". **On the current sample the opposite holds: the '
  + 'short-horizon follow-through rule is the single best candidate tested.** Either that conclusion was '
  + 'sample-specific or its closure was premature; both readings require an owner ruling, and neither should '
  + 'be assumed.\n\n'
  + '★★★ (4) AND THE CHECK THAT WOULD SETTLE IT IS NOW DEGENERATE. The harness splits cohorts at '
  + '`FIX_DATE = 2026-09-11T22:00:00Z` (TRD-33, the phantom trailing stop) precisely because "the 2026-09-18 '
  + 're-run showed the ranking INVERT" between cohorts — and it tells the reader to "read the cohort tables". '
  + 'But the sample is now **"opened 2026-09-15 .. 2026-09-24", i.e. ALL 45 TRADES ARE POST-FIX and the '
  + 'pre-fix cohort is EMPTY.** The ALL and POST-FIX tables are byte-identical in the output. ⇒ **The '
  + 'stability test the harness was built around can no longer be run from this data window**, so the ranking\'s '
  + 'stability is currently UNFALSIFIABLE here — and stability is the single caveat that matters most before '
  + 'pre-registering a rule. This is the finding to act on first: either widen the tick-coverage window so the '
  + 'pre-fix cohort returns, or state plainly that the harness can no longer test its own central caveat.\n\n'
  + '★ (5) LIMITS THAT MUST BE CARRIED WITH EVERY NUMBER ABOVE (`exit-policy-study.js` header, verbatim '
  + 'intent): it is a counterfactual over trades the desk ACTUALLY TOOK, so it cannot speak about trades a '
  + 'different rule would have avoided or created; n is in the tens and the per-rule deltas are smaller than '
  + 'single-trade variance; ★ ticks land on the ~5 min wake cadence, so **`follow 10m` sits barely above the '
  + 'resolution floor and all the apparent gain is at the short end**, which is exactly the end least '
  + 'resolvable; and it RANKS candidates, it does not establish an edge — Rule L still applies in full '
  + '(pre-register, walk forward, BCa + BH, PF >= 1.2, paper-forward >= 50, owner sign-off). **No look was '
  + 'spent** — this script reads trades and ticks and writes nothing.\n\n'
  + 'ACCEPTANCE: (1) a ruling recorded on whether TRD-38\'s "every short-horizon rule is worse" is retracted, '
  + 'superseded or sample-bound, citing this table; (2) the cohort question answered — restore a pre-fix cohort '
  + 'or declare the stability test unavailable, explicitly and in the harness; (3) if a follow-through time-stop '
  + 'is to be pre-registered, its window is chosen with the ~5-min tick floor stated as the reason a 10-minute '
  + 'value is at the edge of resolvability; (4) the row the owner was reading is re-identified, because the '
  + '$10 premise is not supported by any recent Gold trade and a fix aimed at it would be aimed at nothing.';

async function main() {
  console.log(`edict ${EDICT} — would write:\n`);
  console.log(`  ${NAME}`);
  console.log(`  state 1 (open) · priority 2 · assignedToUserId null · ${INFO.length} chars of info\n`);
  if (!APPLY) {
    console.log('DRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  const existing = (await taskModel.getTasksByEdict(EDICT))
    .filter((t) => /^TRD-EXT-1\s*:/.test(String(t.name || '')));
  if (existing.length) {
    console.log('ALREADY REGISTERED — refusing to insert a second row behind the same label:');
    for (const t of existing) console.log(`  id ${t.id} state=${t.state} active=${t.active}`);
    return;
  }

  await taskModel.createTask(NAME, TODAY, null, INFO, 2, OPEN, null, EDICT);
  const made = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.name === NAME);
  console.log(made ? `created TRD-EXT-1 as task id ${made.id} (sortOrder ${made.sortOrder}, active ${made.active})`
                   : 'created, but the row was not found on read-back');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
