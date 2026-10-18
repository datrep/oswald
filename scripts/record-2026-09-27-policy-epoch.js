// scripts/record-2026-09-27-policy-epoch.js — the data decision the "delete before this week" ask produced.
// Creates TRD-DAT-1. Dry by default.
//   node scripts/record-2026-09-27-policy-epoch.js [--yes]
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 policy-epoch##';
const NAME = 'TRD-DAT-1: Data — the POLICY EPOCH is now a recorded value (2026-09-21), and the pre-epoch telemetry '
  + 'is archived and pruned; market data and the evidence tables are deliberately KEPT';

const INFO = `
${MARK}
★ THE ASK, and the question that produced it. The owner asked: **"does N include ones this week or before this
week?"**, then — because the answer is repeatedly *yes* — **"since that keeps being a problem, can we delete all
data thats before this week?"**

★ THE ANSWER TO THE QUESTION OVERTURNED A CONCLUSION IN THIS SESSION. Step 0's headline ("approved entries were
negative, so the weak link is upstream of the gate") was **83% pre-epoch data**: 54 of its 65 approved entries
predated 2026-09-21, and in the current week the same group is **+0.307%**, the opposite sign. That is the THIRD
time in one session that pre-policy data produced a wrong answer, and the machine was wrong each time rather than
the owner, who had already ruled on it: *"dont trust previous data. they are before the new policies are
implemented."*

★★ SO THE PROCESS FIX IS THE DELIVERABLE, NOT THE DELETE. The failure was never that old data existed — it was that
a measurement **silently** included it and reported ONE mean. Two things now make that structural:

  1. **THE POLICY EPOCH IS A RECORDED VALUE: \`2026-09-21\`** — the Monday the current policy set began. It is a
     constant in \`scripts/prune-pre-epoch.js\`, not a date a reader is expected to reconstruct from a task number.
     A measurement must state its window, and one spanning the epoch must say so in its own output.
  2. **THE PRE-EPOCH TELEMETRY IS GONE FROM THE LIVE TABLES**, so an unfiltered query cannot reach across the
     boundary by accident.

★ WHAT WAS ARCHIVED AND DELETED — **37,444 rows, in four tables**:

    TradingEvents      36,287   id 1..41003      -> 1,403.7 KB   (telemetry + the append-only audit trail; also the
                                                                   source of the PRE-FIX DUPLICATE wake pairs)
    ShadowSignals         274   id 1..274        ->    22.9 KB
    QuarantinedTicks      880   id 1..4741       ->    11.6 KB
    TradingAlerts           3   id 34..36        ->     0.3 KB
    ------------------------------------------------------------------
    TradingEvents 92,635 -> 56,348 rows, and 0 rows remain below the epoch in all four.

**Method: ARCHIVE FIRST, THEN DELETE, AND THE DELETE IS BOUNDED BY THE FILE.** The order is the guarantee, exactly as
\`agent/tickArchive.js\` has it: export to gzipped JSONL, then delete \`WHERE <dateCol> < epoch AND id <= <maxId in that
file>\`. If the export throws, nothing is deleted. The archives were **VERIFIED BEFORE THE DELETE RAN** — every line
re-parsed, and each file's row count matched the database's exactly (36,287/36,287, 880/880, 274/274, 3/3). An
archive that does not parse is not a backup, and a count that disagrees is a delete that would lose data.
Location: \`trading/archive/pruned/\`. The archive-only pass left a second, identical set of files; both are kept.

★★ WHAT WAS DELIBERATELY **NOT** DELETED, and this is the part of the ask that could not be granted as stated:

  · **\`PriceBars\` — 259,679 pre-epoch rows KEPT.** The strategies compute **Donchian(20)** and **ATR(14)** over 1h
    bars. Pruning to one week leaves **no warm-up**, so the strategies stop producing signals — a live-desk failure,
    and the desk opens at 21:00Z. The tool REFUSES this table by name and will not act on it even if asked.
  · **\`Trades\` (68 pre-epoch), \`TradingPrompts\` (637), \`BacktestRuns\` (167), \`EquityTicks\` (92,668),
    \`EquitySnapshots\` (1,007), \`LabCandidates\` (18), \`AuditLogs\` (89) — KEPT. Deleting the evidence tables would
    leave **n=11 approved vs n=50 declined**: a single week with nothing to compare it against, and every
    measurement resting on it. **That makes the contamination worse, not better** — the baseline is the thing that
    lets a reader tell policy from era.
  · **\`ApiLogs\` (385,513 pre-epoch) — KEPT: it belongs to the main Oswald app, not the trading desk.**

★ THE PRINCIPLE, stated so the next ask has an answer ready: **an epoch filter fixes a contaminated measurement; a
delete removes the baseline.** The rows deleted here are the ones nothing reads at decision time. The rows kept are
the ones that make a future measurement possible at all.

★ THE TOOL: \`scripts/prune-pre-epoch.js\`. Dry-run by default; \`--archive\` writes the archives and deletes nothing;
\`--archive --delete\` does both; \`--table=X\` targets one table; \`--delete\` without \`--archive\` is refused outright,
because deleting first is the bug with a bow on it. A per-table ceiling of 60,000 rows means a mistake cannot empty a
table in one command, and the REFUSED map carries the reason beside every table it will not touch.

⚠ NOT DONE HERE: no \`Trades\`, \`TradingPrompts\`, bar, equity or Lab data was touched, and no strategy, gate,
threshold or setting changed. The desk was verified healthy after the delete (healthz 200).
`;

(async () => {
  const pool = await getPool();
  const dup = await pool.request().query(`SELECT id FROM Tasks WHERE info LIKE '%${MARK}%' OR (edictId = 52 AND name LIKE 'TRD-DAT-1:%')`);
  if (dup.recordset.length) { console.log(`already recorded as #${dup.recordset[0].id} — nothing to do.`); await pool.close(); return; }
  const maxSort = await pool.request().query('SELECT ISNULL(MAX(sortOrder),0) AS m FROM Tasks');
  const sortOrder = Number(maxSort.recordset[0].m) + 1;
  console.log(`create "${NAME.slice(0, 62)}..." info ${INFO.length} chars, sortOrder ${sortOrder}`);
  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }
  // ⚠ state 1 = Draft = the OPEN band on edict 52; priority 2 (it is a completed decision, not active work).
  const ins = await pool.request()
    .input('name', NAME).input('info', INFO).input('plannedStart', new Date()).input('sortOrder', sortOrder)
    .query(`INSERT INTO Tasks (name, info, plannedStart, priority, state, edictId, sortOrder, createdAt)
            OUTPUT INSERTED.id
            VALUES (@name, @info, @plannedStart, 2, 1, 52, @sortOrder, SYSUTCDATETIME())`);
  console.log(`✔ created TRD-DAT-1 as #${ins.recordset[0].id}`);
  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('edict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
