// scripts/create-trd-shw4-task.js — register the shadow-scorer blocker found while grounding TRD-STR-2.
//
// TRD-SHW-4 was NOT in the approved task set. It is registered because it was found by measurement while
// preparing TRD-STR-2's pre-registration (docs/trd-str-2-pre-registration-2026-09-23.md §1), and the owner's
// standing rule is that a novel, repo-specific finding becomes a policy/task rather than a memory note.
//
// Same discipline as scripts/create-trd-structure-tasks.js: writes through `models/taskModel.createTask` so
// `sortOrder` is allocated per edict and `completedAt` is set by the STATE, never by the caller.
//
// ★ STATE 1 IS THE HONEST STATE. The defect is MEASURED and REPRODUCED, but the fix is not made: §5 of the
// pre-registration makes acceptance depend on a tick-level reproduction that a document cannot supply. A
// measured defect is not a done task.
//
// Usage (from the repo root):
//   node scripts/create-trd-shw4-task.js          # DRY RUN — prints exactly what would be written
//   node scripts/create-trd-shw4-task.js --yes    # writes
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;     // "Trading Agent"
const OPEN = 1;
const PRE_REG = 'docs/trd-str-2-pre-registration-2026-09-23.md';
// ★ `Tasks.plannedStart` is NOT NULL in this schema, so it cannot be omitted — the first attempt at this
// registration failed on exactly that. `plannedEnd` is nullable and stays null, matching the 1372–1380 set.
const TODAY = new Date();

const INFO =
  'FOUND 2026-09-23 by measurement while grounding TRD-STR-2\'s pre-registration (the pre-registration was the '
  + 'deliverable; this blocked it). Registered under the owner rule that a novel repo-specific finding becomes '
  + 'a task, not a memory note.\n\n'
  + '★★ THE SHADOW LEDGER\'S PRIMARY ENDPOINT HAS NEVER BEEN WRITTEN, NOT ONCE. ShadowSignals userId 1: '
  + '546 rows, 62 directional, **0 with a non-NULL realisedR**; 45 of the 62 directional rows were scored '
  + '(`scoredAt` set, `horizonAt`/`closeAt` set) between 2026-09-16 08:21 and 2026-09-23 01:25 with EVERY '
  + 'outcome column NULL. A further 17 await their 24-bar horizon and will burn the same way.\n\n'
  + 'CAUSE, PROVEN NOT INFERRED: store.listBars runs `SELECT TOP (@limit) * FROM PriceBars` with no aliasing, '
  + 'and PriceBars columns are openPrice / high / low / closePrice. shadowScore.excursionOf reads **b.open** '
  + '(line 67) and benchmarkLongPct reads **rows[0].open** (line 94) -> undefined -> null. Proven by direct '
  + 'call: excursionOf(storeShapeRows,\'sell\') = null; excursionOf(aliasedRows,\'sell\') = {closePct:-18}; '
  + 'benchmarkLongPct(storeShapeRows) = null. b.high, b.low and b.closePrice are all CORRECT - `open` is the '
  + 'ONLY wrong name, which is why the other three lines worked harmlessly.\n\n'
  + '★★ SECOND DEFECT, MORE DANGEROUS, AND FIXING THE FIRST ACTIVATES IT: `rOf(null, 2)` returns **0**, '
  + 'because Number(null) === 0 (rOf(undefined,2) correctly returns null). So benchmarkLongR is NOT null on '
  + 'disk - it is **0.000000**, a plausible load-bearing number that shadowGate.isNum accepts. Baseline B '
  + 'pairs on isNum(benchmarkLongR), so the moment realisedR lands, T1 silently becomes "is the shadow\'s R '
  + 'different from ZERO" - a DIFFERENT test from the registered "shadow vs unmirrored long", same critical '
  + 'path, no error, no warning. A one-line fix to b.open would turn a dead gate into a wrongly-specified one. '
  + 'Both must land together.\n\n'
  + 'WHY 1,295 PASSING TESTS COULD NOT CATCH IT - THE FIXTURE IS COMPLICIT: test/shadow-score.test.js:15 reads '
  + '`const bar = (iso, open, high, low, close) => ({barStart: iso, open, high, low, closePrice: close})` - the '
  + 'SAME wrong name as the code. test/shadow-gate.test.js:25 does the same. The tests agree with the '
  + 'implementation and disagree with the producer, so 8 tests over excursionOf pass while it has never once '
  + 'been fed a real bar. 4th instance in this repo of a shape mismatch presenting as a plausible number '
  + '(cf. sw.direction vs swingKind, 2026-09-23); 2nd where a fixture laundered it.\n\n'
  + 'THE CODEBASE ALREADY SOLVED THIS TWICE - THE FIX IS 2 LINES: lab.js normalize() doc comment names the '
  + 'store shape and resolves `open: Number(b.openPrice != null ? b.openPrice : b.open)`; '
  + 'strategies/survGoldStruct.js:79 does the same. On PriceBars the other three names are already correct, so '
  + 'the defect is NOT that the code did not know the contract - it is that it SKIPPED THE LAYER THAT '
  + 'DOCUMENTS IT (lab.normalize).\n\n'
  + 'CONSEQUENCE FOR THE GATE: shadowGate GATE.MIN_YES = 50 counts directional rows with a numeric realisedR '
  + '-> that count is 0 and can only be 0, so **TRD-SHW-3\'s gate can never open**. And TRD-SHW-3\'s shipped '
  + 'projection ("~103 wakes/day, ~20% directional, ~245 calls, ~2.4 days") is measured WRONG on both inputs: '
  + '63.4 calls/day and 11.36% directional (62/546) -> ~7.2 directional calls/day -> **~6.9 days** for 50 YES. '
  + 'That projection was never checked because the gate was never reached; it has been read as a measurement.\n\n'
  + '★ ONE-SHOT SCORER - THE WINDOW IS CLOSING: listUnscoredShadowSignals filters `scoredAt IS NULL`, so the '
  + '45 burned rows can NEVER be rescored. The 17 pending are recoverable ONLY if the fix lands before their '
  + 'horizon elapses (~2.4 days at the measured rate). After that, gate 2 restarts at zero.\n\n'
  + 'ACCEPTANCE (pre-registered, ' + PRE_REG + ' §5): P1 - at least one directional row carries a non-NULL '
  + 'realisedR REPRODUCED INDEPENDENTLY FROM PriceTicks (not from PriceBars alone, and NOT from a fixture: '
  + '§1.4 is the proof that a self-consistent fixture is exactly how this survived). P2 - benchmarkLongR must '
  + 'be NULL when the window is incomplete and equal ((close-open)/open)*100/riskPct when complete; a stored '
  + '0.000000 alongside a NULL realisedR must be impossible.\n\n'
  + '⚠ NOT DONE: no code changed. shadowGate.GATE, shadow.PROMPT_VERSION and HORIZON_BARS are untouched and '
  + 'must stay untouched - the fix changes INPUTS, never the frozen block.';

const NAME = 'TRD-SHW-4: Shadow signals - the forward scorer has never written a realisedR, so the gate it feeds can never open';

async function main() {
  console.log(`edict ${EDICT} — would write:\n`);
  console.log(`  ${NAME}`);
  console.log(`  state 1 (open) · priority 1 · assignedToUserId null · ${INFO.length} chars of info\n`);
  console.log(`  and update task 1377 (TRD-STR-2) info with a pointer to ${PRE_REG}\n`);
  if (!APPLY) {
    console.log('DRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  // NOTE: `taskModel.createTask` returns void, so the id is not available here — read it back by name.
  await taskModel.createTask(NAME, TODAY, null, INFO, 1, OPEN, null, EDICT);
  const made = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.name === NAME);
  console.log(`created TRD-SHW-4 as task id ${made ? made.id : '(not found — check the DB)'}`);

  const cur = await taskModel.getTaskById(1377);
  if (!cur) { console.log('WARN: task 1377 not found — TRD-STR-2 pointer NOT updated.'); return; }
  const pointer = `\n\n★ PRE-REGISTRATION WRITTEN 2026-09-23: ${PRE_REG}. `
    + 'It found a BLOCKER before the bump: the shadow ledger\'s primary endpoint has never been written '
    + '(ShadowSignals: 62 directional, 0 with realisedR; cause = shadowScore reads b.open instead of '
    + 'b.openPrice, plus rOf(null)=0). A prompt-version bump today would DISCARD the only cohort that exists '
    + 'and start a second one the same broken scorer would burn. Registered order: fix scorer -> observe gate 2 '
    + 'accumulate -> THEN bump. See TRD-SHW-4.';
  if (String(cur.info || '').includes(PRE_REG)) {
    console.log('task 1377 already carries the pointer — skipped');
  } else {
    await taskModel.updateTask(1377, { info: String(cur.info || '') + pointer });
    console.log('updated task 1377 (TRD-STR-2) with the pre-registration pointer');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
