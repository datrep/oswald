// scripts/close-2026-09-27-finished-rows.js — archive the rows whose work shipped and verified.
//
// ⚠ A CLOSURE APPENDS A NOTE RATHER THAN JUST FLIPPING `state`. A row that is archived with no statement of what
// closed it is indistinguishable from one that was abandoned, and any RESIDUAL the row recorded would disappear
// with it — so each note names what landed AND what remains open, deliberately.
//
//   node scripts/close-2026-09-27-finished-rows.js          # report what would change
//   node scripts/close-2026-09-27-finished-rows.js --yes    # write
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

const YES = process.argv.includes('--yes');
const MARK = '##2026-09-27 closed##';

const ROWS = [
  {
    id: 1416, tag: 'TRD-DEL-1',
    note: `CLOSED 2026-09-27. The ask is discharged: the RESOLVED persona is now rendered, and the resolution
happens in ONE exported function (\`aggregator.resolveChairs\`) that REPORTS its source (\`configured\` /
\`seat-default\` / \`none\`), so the panel shows \`seat default -> risk\` instead of a word that means something the
reader cannot see. \`GET /settings\` publishes \`chairsResolved\` as a SIBLING of \`chairs\` — never a mutation, because
\`chairs\` is what the save round-trips and annotating it would have written the resolved personas back as though
the operator had typed them. Verified live: all three seats read \`seat-default\` -> trend/risk/macro.
Records now carry \`personaSource\` with every vote, so a stored decision says whether a seat chose its lens.
★ A TRAP FOUND WHILE TESTING, pinned rather than noted: the fallback is by ARRAY POSITION, not by chair id, so
DELETING A SEAT RE-LENSES EVERY SEAT AFTER IT — chair-2 sitting at index 0 votes as \`trend\`.
⚠ RESIDUAL, deliberately not done here and not lost: the row also suggested showing each seat's own yes/no tally
(all three lean no). That is a display extra beyond the ask; the numbers are in the row above and are cheap to add.
8 tests in \`test/chair-persona-source.test.js\`, including one asserting the roster the PANEL publishes is deep-equal
to the roster the VOTE loop resolves.`,
  },
  {
    id: 1414, tag: 'TRD-LLM-3',
    note: `CLOSED 2026-09-27. \`quantVotes\` ran one line before it was discarded; the chairs now receive the panel.
The direction was decided the way this row recommended: each vote is stated as a FACT WITH ITS BASIS, and the
BLENDED SCORE IS DELIBERATELY OMITTED, because a single number invites the deference defect already recorded in
promptBuilder ("the panel always outvoted it, because the panel had scored the live number"). The seat is also told
that the panel enters the blend at the same weight the seats do AND that its own dissent is scored — measured true
(chairScore negative in 219 of 343, 174 declined by the score rule against 34 vetoes), so disclosure does not become
pressure. 6 tests in \`test/quant-panel-disclosure.test.js\`, one of them structural on purpose: it asserts
\`quantPanelNote(qv)\` appears inside the expression that BUILDS the chair text, because the defect was a MISSING
ARGUMENT and a formatter-only test would have passed while the aggregator still dropped the note.`,
  },
  {
    id: 1408, tag: 'TRD-GRD-6',
    note: `CLOSED 2026-09-27. The chart interval is now MEASURED beside the layout's claim (\`barSpacingSec\` = the
MINIMUM positive delta, because a gap can only inflate one), a row is written only when the two AGREE, and a
sub-1h read is ROLLED UP to 1h so the structure venue is refreshed at every interval instead of only those that
happen to map to 1h. \`setPeriodicity\` is a LABEL-CHANGER on this venue and is not called. Live acceptance showed
\`chartInterval { agree: 12, disagree: 0, unmeasured: 0, rollups: 2876 }\`.
⚠ RESIDUALS, retained: the chart can be MEASURED but not PINNED; \`sourceIntervalSec = 900\` rows in the 1h series
are AGGREGATED and the range-fidelity question travels with them; and pinning to native 1h would multiply a
wrong-instrument blast radius from ~10.4 days to ~41.7 days, which is why GRD-4's enforcement stays an owner call.`,
  },
  {
    id: 1409, tag: 'TRD-RSK-1',
    note: `CLOSED 2026-09-27. The decision card no longer publishes the DECLARED stop beside a cost share computed on
the CAPPED one. \`aggregator\` now carries \`stopDistance\` (declared), \`effectiveStopDistance\` (the venue distance the
numbers are actually about) and \`stopCap\` on BOTH the risk-refusal path and the approved path — the refusal being
the case that most needs auditing.
⚠ RESIDUAL, retained and unresolved here: whether the desk SHOULD veto an entry whose stop the risk engine's own cap
has driven inside noise (0.2784 vs ATR 0.6769 = 0.41x ATR) is a strategy question this row does not decide. The cap
is the measured-best lever (-28.89 net vs -72.15 uncapped) and is also what the chair then objects to, so the risk
lever and the committee can be systematically opposed on the same ticket. See TRD-RSK-2 and TRD-TP-1.`,
  },
  {
    id: 1410, tag: 'TRD-COV-1',
    note: `CLOSED 2026-09-27. The real blocker was six EXPLICITLY EMPTY scope lists, and coverage is now 6 of 6,
backfilled through the API so the venue supplies the id->symbol mapping rather than the desk asserting it. The
four cross-product wrappers were SUPERSEDED by ten replicas of the two proven survivors, with the frozen set
imported BY REFERENCE.
⚠ RESIDUALS, retained: this is NOT a Lab qualification (measured on the current series in a 1-year window, not the
frozen dev period); a replica is not a claim that the strategy works on that instrument; and every new instrument
now requires an edit to BOTH \`quant.GATE_OWNERS.donchian\` and \`.adx\`, or the reasons are stripped from the
instrument being opened — that map is the second place to look after \`survReplicas.js\`.`,
  },
];

(async () => {
  const pool = await getPool();
  const ids = ROWS.map((r) => r.id);
  const cur = await pool.request().query(
    `SELECT id, name, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id IN (${ids.join(',')}) ORDER BY id`);
  const byId = new Map(cur.recordset.map((r) => [r.id, r]));

  for (const r of ROWS) {
    const row = byId.get(r.id);
    if (!row) { console.error(`⚠ #${r.id} (${r.tag}) NOT FOUND — aborting rather than closing blind`); process.exit(1); }
    const done = row.state === 3;
    console.log(`#${row.id} ${r.tag.padEnd(11)} state=${row.state}${done ? ' (already closed)' : ''} info=${row.len} -> ${Number(row.len) + r.note.length + MARK.length}`);
  }

  if (!YES) { console.log('\nDRY RUN — pass --yes to write.'); await pool.close(); return; }

  for (const r of ROWS) {
    const row = byId.get(r.id);
    if (row.state === 3) { console.log(`#${r.id} already closed — skipping`); continue; }
    // ⚠ plannedStart/updatedAt are not touched: only `info` gains the closure note and `state` moves to the
    // Archived band. Three is the DONE pile on this edict (1 = Draft = open, 2 = Published, 3 = Archived).
    await pool.request()
      .input('note', `\n${MARK}\n${r.note}\n`).input('id', r.id)
      .query('UPDATE Tasks SET info = CAST(info AS nvarchar(max)) + @note, state = 3 WHERE id = @id');
    console.log(`✔ #${r.id} ${r.tag} closed`);
  }

  const chk = await pool.request().query(
    `SELECT id, state, LEN(CAST(info AS nvarchar(max))) AS len FROM Tasks WHERE id IN (${ids.join(',')}) ORDER BY id`);
  console.log('\nread-back:');
  for (const r of chk.recordset) console.log(`  #${r.id} state=${r.state} info=${r.len}`);
  const s = await pool.request().query('SELECT state, COUNT(*) AS n FROM Tasks WHERE edictId = 52 GROUP BY state');
  console.log('edict 52 by state: ' + s.recordset.map((x) => `${x.state}=${x.n}`).join('  '));
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
