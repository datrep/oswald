// scripts/create-trd-act1-task.js — register `activity`'s own forward endpoint.
//
// This is the row that completes the §11.1 ruling (§12.7 of docs/trd-str-2-pre-registration-2026-09-23.md):
// `activity` is declared CHAIR-ONLY and outside the shadow gate, on condition that its usefulness is
// validated by a SEPARATE endpoint rather than by widening gate 2's registered question.
//
// Same discipline as scripts/create-trd-shw4-task.js: writes through `models/taskModel.createTask` so
// `sortOrder` is allocated per edict and `completedAt` is set by the STATE, never by the caller.
//
// ★ THE SCHEMA TRAPS (hit 2026-09-24; also recorded in create-trd-aih1-task.js and create-trd-reg1-task.js):
//   1. `Tasks.plannedStart` is NOT NULL and there are NO column defaults.
//   2. `Tasks.active` is COMPUTED — `GETUTCDATE() >= plannedStart` (sql/migrations/013_utc_edicts_tasks.sql:101)
//      — never name it in an INSERT. A raw SQL `GETDATE()` writes LOCAL wall-clock (SGT here), which is 8h
//      ahead of the UTC comparison, so the row lands with active = 0: present, and reading as not-yet-started.
//
// Usage (from the repo root):
//   node scripts/create-trd-act1-task.js          # DRY RUN — prints exactly what would be written
//   node scripts/create-trd-act1-task.js --yes    # writes
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;   // "Trading Agent"
const OPEN = 1;
const TODAY = new Date(); // written as UTC wall-clock — this is what makes `active` compute to 1

const NAME = 'TRD-ACT-1: Activity — the measure the chair consumes has no forward endpoint of its own, and nothing records it per call';

const INFO =
  'FOUND 2026-09-24 as the direct consequence of the §11.1 ruling (pre-registration §12.7). Registered under '
  + 'the owner rule that a novel repo-specific finding becomes a task, not a memory note — and because §12.7 '
  + 'explicitly says §11.1 is NOT discharged until this row exists.\n\n'
  + '★★ THE RULING THIS COMES FROM. `shadow.js`\'s `structureRow(s)` is a WHITELIST. §11.1 asked S4 to pick '
  + 'one: extend `structureRow` so the shadow prompt carries `activity`, or declare `activity` chair-only and '
  + 'outside the gate. RULED: **chair-only, outside the gate, `structureRow` NOT extended.** Two reasons. '
  + '(a) The shadow prompt\'s registered question is about STRUCTURE — "is a directional move starting BEFORE '
  + 'the 1h Donchian/ADX confirmation would register it?" — while `activity` is a PARTICIPATION measure (the '
  + 'bar\'s range and body against the SAME-HOUR MEDIAN over trailing days). Adding it would not add a field, '
  + 'it would change what the question is about. (b) The attributability cost of a joint test is IRREDUCIBLE '
  + 'inside one prompt: the only way back is a model SELF-REPORTED attribution, and that would be the FOURTH '
  + 'fabricated value in this family after `rOf(null)` (SHW-4), `benchmarkLongR = 0` and the fixture that '
  + 'laundered a field-name mismatch.\n\n'
  + '★ AND A COST ASSERTED IN §12.6 WAS WRONG, RETRACTED IN §12.7: chair-only does NOT leave the measure '
  + 'unconsumed. §3 item 1 renders the computed structure fields into the **chair prompt + `bundleObj`**, so '
  + '`activity` has a consumer — the chair. The residual cost is narrower and honest: **the forward gate never '
  + 'validates that the chair can USE it.**\n\n'
  + '★★ THE OBJECTIVE, AND WHY IT NEEDS NO PROMPT CHANGE. `shadowGate.GATE` already carries `FAMILY_K: 2` and '
  + 'is BH-corrected, so the machinery for more than one endpoint exists. `activity` gets its **own forward '
  + 'endpoint with its own alpha**, registered separately rather than folded inside gate 2 — one factor per '
  + 'endpoint, so attribution is STRUCTURAL rather than argued, and `PROMPT_VERSION` does not move. That is '
  + 'the whole point of the ruling.\n\n'
  + '★★ PREREQUISITE, FOUND BY READING THE PRODUCER — AND IT IS NOT SATISFIED TODAY. A stratified or '
  + 'factor-specific endpoint needs the `activity` value AT EACH CALL. **`ShadowSignals` records no activity '
  + 'column at all.** Its full column list, read from INFORMATION_SCHEMA.COLUMNS (2026-09-24): id, userId, '
  + 'createdAt, deployedAt, promptVersion, horizonBars, symbol, venue, evidence, direction, confidence, basis, '
  + 'rawResponse, priceAtCall, atr14, adx14, regime, sessionState, scheduledEvent, inputTokens, outputTokens, '
  + 'barsToHorizon, horizonAt, closeAt, mfePct, maePct, realisedR, confirmedByStrategy, scoredAt, '
  + 'benchmarkLongR. It stores price, ATR, ADX and regime — and NOT `activity`. **So there is nothing to '
  + 'stratify on.** Two routes, and they are not equivalent: (a) record the value the prompt actually carried, '
  + 'per row, going forward; or (b) recompute it from the bar series at the call timestamp, which is possible '
  + 'because `computeActivity({bars, asOf})` depends only on bars + asOf. ⚠ (b) CARRIES THE REPO\'S SIGNATURE '
  + 'FAILURE: a recompute using a different series or different params than the prompt used is a fixture that '
  + 'agrees with itself — the §1.4 trap. If (b) is chosen, it must pin the series AND the params to the ones '
  + 'the call actually used, and say so.\n\n'
  + '⚠ IT SPENDS A LOOK, SO IT MUST BE PRE-REGISTERED BEFORE ITS FIRST LOOK. This repo has already been bitten '
  + 'by a gate that tightens its own boundary every time it runs (TRD-110/TRD-41), and one clean look is worth '
  + 'more than two muddy ones. Nothing here may be run "just to look" before the pre-registration exists.\n\n'
  + 'WHAT THE ENDPOINT MUST SPECIFY: the population (directional shadow calls, same as gate 2, or a declared '
  + 'subset); the statistic and the horizon (24 bars, `shadow.HORIZON_BARS`); how the covariate is recovered '
  + '(route (a) or (b) above, with the pin if (b)); whether it JOINS `GATE`\'s existing BH family or carries '
  + 'its own `FAMILY_K` — declaring this is mandatory, because silently joining a k=2 family as a third test is '
  + 'exactly the un-marked comparison the BH correction exists to prevent; and the alpha.\n\n'
  + 'ACCEPTANCE: (1) a pre-registration document exists naming all of the above, before any run; (2) the '
  + 'covariate is recoverable — proved by reconstructing it for at least one ALREADY-RECORDED call and showing '
  + 'it matches what that call was shown; (3) `PROMPT_VERSION` is UNCHANGED by this work — if the endpoint '
  + 'cannot be built without moving it, the ruling has been misread; (4) the family membership decision is '
  + 'written down explicitly rather than implied by the code.';

async function main() {
  console.log(`edict ${EDICT} — would write:\n`);
  console.log(`  ${NAME}`);
  console.log(`  state 1 (open) · priority 2 · assignedToUserId null · ${INFO.length} chars of info`);
  console.log(`  plannedStart ${TODAY.toISOString()} (written as UTC wall-clock so active computes to 1)\n`);
  if (!APPLY) {
    console.log('DRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  // Idempotency guard: `createTask` has none (that absence is TRD-REG-1), so a re-run would create a second
  // row behind the same label. Check the label first.
  const existing = (await taskModel.getTasksByEdict(EDICT))
    .filter((t) => /^TRD-ACT-1\s*:/.test(String(t.name || '')));
  if (existing.length) {
    console.log('ALREADY REGISTERED — refusing to insert a second row behind the same label:');
    for (const t of existing) {
      console.log(`  id ${t.id} state=${t.state} active=${t.active} sortOrder=${t.sortOrder}  ${String(t.name).slice(0, 110)}`);
    }
    return;
  }

  // NOTE: `taskModel.createTask` returns void, so the id is read back by name.
  await taskModel.createTask(NAME, TODAY, null, INFO, 2, OPEN, null, EDICT);
  const made = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.name === NAME);
  console.log(made ? `created TRD-ACT-1 as task id ${made.id} (sortOrder ${made.sortOrder}, active ${made.active})`
                   : 'created, but the row was not found on read-back — check the DB');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
