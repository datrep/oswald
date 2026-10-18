// scripts/create-trd-aih1-task.js — register the 2026-09-24 memory-file incident.
//
// TRD-AIH-1 was NOT in any approved task set. It is registered under the owner's standing rule that a novel,
// repo-specific finding becomes a policy/task rather than only a memory note.
//
// Same discipline as scripts/create-trd-shw4-task.js: writes through `models/taskModel.createTask` so
// `sortOrder` is allocated per edict and `completedAt` is set by the STATE, never by the caller.
//
// ★ TWO SCHEMA TRAPS, BOTH HIT ON THE FIRST ATTEMPT (2026-09-24) — a direct INSERT failed twice:
//   1. `Tasks.plannedStart` is NOT NULL and there are NO column defaults, so it cannot be omitted.
//   2. `Tasks.active` is a COMPUTED column and must never be named in an INSERT:
//        active AS (CASE WHEN GETUTCDATE() >= plannedStart AND (plannedEnd IS NULL OR GETUTCDATE() <= plannedEnd)
//                        THEN 1 ELSE 0 END)          -- sql/migrations/013_utc_edicts_tasks.sql:101
//      ★ THE TRAP THAT MAKES IT SILENT: `GETUTCDATE()` is compared against `plannedStart`, but a raw SQL
//      `GETDATE()` writes the SERVER'S LOCAL wall-clock (SGT). On this box that is UTC+8, so a row inserted
//      with `plannedStart = GETDATE()` is EIGHT HOURS IN THE FUTURE in UTC terms and lands with active = 0 —
//      created, present, and reading as not-yet-started. `taskModel.createTask` avoids this because the mssql
//      driver writes a JS `Date` as its UTC wall-clock. **Never hand-write plannedStart in SQL; pass a Date.**
//
// Usage (from the repo root):
//   node scripts/create-trd-aih1-task.js          # DRY RUN — prints exactly what would be written
//   node scripts/create-trd-aih1-task.js --yes    # writes
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const taskModel = require('../models/taskModel');

const APPLY = process.argv.includes('--yes');
const EDICT = 52;   // "Trading Agent"
const OPEN = 1;
const TODAY = new Date(); // written as UTC wall-clock — this is what makes `active` compute to 1

const NAME = 'TRD-AIH-1: Agent hygiene — never read a memory file whole; the memory tool doubles the file on write';

const INFO =
  'FOUND 2026-09-24 by measurement, during the recovery from a worker crash. Registered under the owner rule '
  + 'that a novel repo-specific finding becomes a policy/task, not a memory note.\n\n'
  + '★★ THE MEMORY FILE WAS DUPLICATING ITSELF. `memories/repo/oswald.md` reached **4,185 KB / 12,095 lines**: '
  + '1,169 `## ` headings but only **144 unique** (8.1x). The 2026-08-05 block appeared **16 times** — SHA-256 '
  + 'over the 260-line block at all 16 offsets returned exactly **2 hashes, 8 copies each**, so the copies are '
  + 'byte-identical rather than merely similar. No workspace code writes that file (verified by grep), so it is '
  + 'Copilot\'s own memory tool; the shape (oldest content x16, newest x1) is consistent with a write that '
  + 'appends `old + new` and therefore DOUBLES each time. ⚠ The doubling mechanism is INFERRED; the duplication '
  + 'is MEASURED.\n\n'
  + '★★ SYMPTOM 1 — THE HEAP OOM, AND IT IS NOT IN ANY WORKSPACE LOG. Reading the file whole (`memory view '
  + '/memories/repo/oswald.md`) killed the worker. The only record is VS Code\'s own extension log: '
  + '`logs/20260924T093525/window1/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log:3076` -> '
  + '`2026-09-24 14:04:20.731 [error] Error: Worker terminated due to reaching memory limit: JS heap out of '
  + 'memory`, stack `[kOnExit]` / `Worker.<computed>.onexit` (the PARENT observing the worker\'s death, so the '
  + 'stack names nothing useful). The line immediately before it names the tool set: `14:04:16.345 [info] '
  + '[VoiceProgress] fallback request=... phase=investigating emitted=false tools=list_dir,grep_search,memory`. '
  + 'The extension host then restarted at 14:06:02. **A crash that lives only in the exthost log is invisible to '
  + '`logs/*.log` — grep `%APPDATA%\\Code\\logs\\<stamp>\\window1\\exthost` when a worker dies.**\n\n'
  + '★★ SYMPTOM 2 — IT CAUSED ds-watch TRIP #22, VIA THE COMPACTION. The ~450k-token tool result pushed the '
  + 'chat past its compaction threshold, and the summarizer rewrote the prompt PREFIX: `14:25:49 CACHE REFILL '
  + '(rate 8%, hit 22.8k of 290.8k)` = prompt **426,778 -> 290,828**; then `14:26:28 *** TRIP #22: rate 45% with '
  + 'a 130.4k-token cached prefix (prompt 292.3k)`. The prefix only ever re-established **130.4k**, the 14:28:22 '
  + 'probe returned **44%**, and the circuit stayed OPEN refusing `/chat/completions` with 429 until '
  + '`14:28:37 RESET via /reset - circuit closed`. ⇒ **The two symptoms are ONE cause: an unbounded read.**\n\n'
  + '★ MEASURED CAPACITY — THE BALANCE, AND WHERE THE GUARD BELONGS. The file is *listed, not injected* (the '
  + 'repo-memory block carries filenames only, and no user-memory file lives under `memory-tool/memories`), so '
  + '**its size on disk is NOT the binding constraint — a single unbounded READ is.** Measured ceiling: requests '
  + 'ran 412,948 -> 426,778 tokens at rate=100%; after a summarization the working set is ~290k. Budget: '
  + '**<= 100 KB (~25k tokens) per read.** At 752 KB / 1,887 lines a section averages ~5 KB, so a `view_range` '
  + 'slice of ~250 lines fits comfortably; reading the whole file costs ~192k tokens and WILL force another '
  + 'summarization. ⇒ **The guard is a read-size budget, not a file-size limit.**\n\n'
  + 'REPAIR APPLIED 2026-09-24: de-duplicated to **752 KB / 1,887 lines** (82% smaller; 149 sections, 148 '
  + 'unique) by dropping only sections whose ENTIRE heading+body were byte-identical to one already kept — no '
  + 'unique content dropped, original order preserved, first occurrence wins. Backup (full rollback): '
  + '`logs/archive/oswald-repo-memory-2026-09-24T07-20-25-407Z.md` (4,185 KB).\n\n'
  + '★ TOOL: `node scripts/dedupe-repo-memory.js` (check — exits 1 on duplication, prints the per-read budget '
  + 'and the whole-read token cost) / `--write` (repair, backs up to `logs/archive/` first).\n\n'
  + 'ACCEPTANCE: (1) `--check` reports 0 exact duplicates before any long session; (2) every memory read passes '
  + '`view_range`; (3) a file over ~100 KB is ALWAYS read as a slice, never whole; (4) recurrence of '
  + 'self-duplication is treated as a DEFECT, not as growth — it inflates every subsequent read.';

async function main() {
  console.log(`edict ${EDICT} — would write:\n`);
  console.log(`  ${NAME}`);
  console.log(`  state 1 (open) · priority 2 · assignedToUserId null · ${INFO.length} chars of info`);
  console.log(`  plannedStart ${TODAY.toISOString()} (written as UTC wall-clock so active computes to 1)\n`);
  if (!APPLY) {
    console.log('DRY RUN — pass --yes to write. No DB write performed.');
    return;
  }

  // NOTE: `taskModel.createTask` returns void, so the id is read back by name.
  await taskModel.createTask(NAME, TODAY, null, INFO, 2, OPEN, null, EDICT);
  const made = (await taskModel.getTasksByEdict(EDICT)).find((t) => t.name === NAME);
  console.log(made ? `created TRD-AIH-1 as task id ${made.id} (sortOrder ${made.sortOrder}, active ${made.active})`
                   : 'created, but the row was not found on read-back — check the DB');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
