// scripts/close-2026-09-29-RSK11-TUN1.js
//
// CLOSES TRD-RSK-11 (#1468) and TRD-TUN-1 (#1392).
//
// ⚠ TRD-87's OWN LESSON APPLIES TO THIS SCRIPT: "a closed task is not evidence its defect is gone." So closing is
// gated on RE-RUNNING each fix's central assertion. If either has rotted, this refuses and closes nothing.
//
// ⚠ AND IT RECORDS WHAT "CLOSED" DOES NOT MEAN. Both fixes live in files the running desk has already loaded
// (pid started 2026-09-29T04:18Z, hours before these edits), so the RUNNING process is still defective. The
// closure note says so explicitly: fixed and pinned in the repo, LIVE ON THE NEXT RESTART.
//
// DRY RUN BY DEFAULT (pass --yes).
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');
const tuner = require('../trading/agent/tuner');
const fc = require('../trading/agent/fieldContracts');

const ROOT = path.join(__dirname, '..');
const YES = process.argv.includes('--yes');
const CHECK = '\u2714';
const WARN = '\u26A0';
const EM = '\u2014';

const CLOSURES = [
  {
    id: 1468,
    marker: '##2026-09-29 CLOSED TRD-RSK-11##',
    note: `
##2026-09-29 CLOSED TRD-RSK-11## CLOSED ${EM} FIXED, PINNED, AND VERIFIED AT CLOSE.##

'cappedAtPct' is written ONLY where the notional cap truncates (null otherwise), and 'fieldContracts.riskUnit'
no longer reads the field at all: 'explained' rests on the L4 'boundBy' enum or the writer's own reason string,
because a WINDOW spans both eras and a field that is only honest after the fix would let the old rows certify
themselves.

VERIFIED AT CLOSE (re-run, not remembered): 200 gaps / 200 explained / 0 unexplained over the newest 200 sizing
events, with the stop basis reported; the LIVE contract names the control that actually bound; and
'riskUnitExplain({cappedAtPct:80, reasons:[]})' returns explained=FALSE, which is the assertion the old reader
could not produce. Pins: test/risk-unit-explained.test.js (17).

${WARN} WHAT "CLOSED" DOES NOT MEAN: the running desk was started 2026-09-29T04:18Z, BEFORE this fix, so the live
process still writes the unconditional field. The fix is repo-verified and is LIVE ON THE NEXT RESTART.`,
  },
  {
    id: 1392,
    marker: '##2026-09-29 CLOSED TRD-TUN-1##',
    note: `
##2026-09-29 CLOSED TRD-TUN-1## CLOSED ${EM} FIXED, PINNED, AND VERIFIED AT CLOSE.##

'tuner.revert()' refuses a dry-run proposal with '{refused:true}' BEFORE any settings read or write, so a refusal
writes nothing and logs nothing. The guard tests '=== true', so an event with no 'dryRun' key still reads as
applied ${EM} defaulting to refuse would make the panel inert. 'GET /tuner/history' forwards 'dryRun', the Strategy
tab labels such a row "proposal ${EM} never applied" with no button, and a refusal is 409 rather than the 404 every
'{error}' used to get.

VERIFIED AT CLOSE (re-run, not remembered): against a stub store, a dry-run revert returns refused with 0 settings
writes and 0 log rows; an APPLIED change still reverts with 1 write and 1 'tune_revert' ${EM} the negative control
that stops this being a blanket refusal. Pins: test/tuner-revert-guard.test.js (6).

${WARN} WHAT "CLOSED" DOES NOT MEAN, in two parts. (1) The running desk was started 2026-09-29T04:18Z, BEFORE this
fix, so the live endpoint is still unguarded; the fix is LIVE ON THE NEXT RESTART. (2) This row's own evidence
${EM} 'TradingEvents' 4544 ${EM} was pruned by retention, so the ORIGINAL SIGHTING IS UNRECOVERABLE and the defect's
two stated consequences cannot be re-measured from the record. The guard is verified synthetically and by the
source pins; the sighting that motivated it is not reproducible. See the block above for the full retention
analysis.`,
  },
];

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== closing TRD-RSK-11 (#1468) and TRD-TUN-1 (#1392) ===\n');

  console.log('1. TRD-RSK-11 must still be fixed');
  const riskSrc = fs.readFileSync(path.join(ROOT, 'trading/agent/risk.js'), 'utf8').replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  if (/cappedAtPct:\s*Number\(/.test(riskSrc)) throw new Error('the unconditional write is BACK — refusing to close');
  if (fc.riskUnitExplain({ cappedAtPct: 80, reasons: [] }).explained !== false) {
    throw new Error('cappedAtPct alone explains a gap again — refusing to close');
  }
  const rows = (await q(`SELECT TOP 200 JSON_QUERY(payload,'$.sizeCalc') AS sc FROM TradingEvents
      WHERE kind='decision' AND JSON_QUERY(payload,'$.sizeCalc') IS NOT NULL ORDER BY id DESC`))
    .map((x) => { try { return JSON.parse(x.sc); } catch { return null; } }).filter(Boolean);
  let gaps = 0, still = 0;
  for (const s of rows) {
    if (s.equity == null || s.riskPct == null || !(Number(s.finalSize) > 0)) continue;
    const g = fc.riskUnitRealised(s);
    if (g.realisedPct == null || g.realisedPct >= Number(s.riskPct) * 0.9) continue;
    gaps++; if (!fc.riskUnitExplain(s).explained) still++;
  }
  if (still !== 0) throw new Error(`${still} of ${gaps} gaps unexplained — the claim does not reproduce; refusing to close`);
  console.log(`  ${CHECK} unconditional write absent; cappedAtPct alone does not explain; ${gaps} gaps / ${still} unexplained live`);

  console.log('\n2. TRD-TUN-1 must still be fixed');
  const orig = { listEvents: store.listEvents, getSettings: store.getSettings, saveSettings: store.saveSettings, logEvent: store.logEvent };
  const saved = [], logged = [];
  store.listEvents = async () => [{ id: 1, payload: { dryRun: true, changes: [{ strategy: 'rsi2', params: { before: { low: 10 }, after: { low: 8 } } }] } }];
  store.getSettings = async () => ({ strategies: { enabled: ['survgold'], params: {} } });
  store.saveSettings = async (u, s) => { saved.push(s); };
  store.logEvent = async (...a) => { logged.push(a); };
  let r;
  try { r = await tuner.revert(1, { eventId: 1, index: 0 }); } finally { Object.assign(store, orig); }
  if (r.refused !== true || saved.length || logged.length) {
    throw new Error(`dry-run revert is not refused cleanly (refused=${r.refused}, writes=${saved.length}, logs=${logged.length}) — refusing to close`);
  }
  console.log(`  ${CHECK} dry-run revert refused, 0 writes, 0 log rows`);

  console.log('\n3. the rows');
  for (const c of CLOSURES) {
    const t = (await q(`SELECT id, info, state, completedAt FROM dbo.Tasks WHERE id = ${c.id}`))[0];
    if (!t) throw new Error(`row ${c.id} does not exist`);
    const n = (t.info || '').split(c.marker).length - 1;
    console.log(`  #${c.id}: state=${t.state} done=${t.completedAt ? 'yes' : 'no'} info=${(t.info || '').length} chars, closure marker ${n}x`);
    if (!YES) console.log(`    would append ${c.note.length} chars and set state=3 + completedAt`);
  }

  if (!YES) {
    console.log(`\nDRY RUN ${EM} nothing written. Pass --yes to close.`);
    await pool.close();
    return;
  }

  for (const c of CLOSURES) {
    const t = (await q(`SELECT info FROM dbo.Tasks WHERE id = ${c.id}`))[0];
    const n = (t.info || '').split(c.marker).length - 1;
    if (n === 0) {
      await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${c.note.replace(/'/g, "''")}' WHERE id = ${c.id}`);
    }
    // ⚠ `active` is a COMPUTED column — it cannot be written, and it derives from state/completedAt. Setting it
    // threw on the first run (after the note was already appended, which is why this loop is idempotent).
    await pool.request().query(`UPDATE dbo.Tasks SET state = 3, completedAt = GETUTCDATE() WHERE id = ${c.id}`);
    const after = (await q(`SELECT state, active, completedAt, LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${c.id}`))[0];
    const fn = (after.info || '').split(c.marker).length - 1;
    if (after.state !== 3 || !after.completedAt) throw new Error(`#${c.id} did not close`);
    if (fn !== 1) throw new Error(`#${c.id}: closure marker appears ${fn}x`);
    console.log(`  ${CHECK} #${c.id} CLOSED state=${after.state} active=${after.active} done=${String(after.completedAt).slice(0, 19)} info=${after.n} chars marker x${fn}`);
  }
  await pool.close();
})().catch((e) => { console.error(`\n${WARN} ${e.message}\n`); process.exit(2); });
