// scripts/record-2026-09-29-pp-TUN1.js
//
// Records TRD-TUN-1 (#1392) on the task row. The guard is implemented; the task's EVIDENCE ROW IS GONE.
//
// The block records three things:
//   · revert() now refuses a dry-run proposal and writes nothing — before it silently adopted a never-applied
//     proposal's stale before-values into live settings, dressed as an ordinary undo;
//   · the panel can now TELL a proposal from an applied change, and a refusal is a 409, not a 404;
//   · ★ THE TASK'S OWN EVIDENCE ROW HAS AGED OUT OF THE RETAINED WINDOW, so the original sighting is
//     unrecoverable and this row's numbers can no longer be re-measured from the record.
//
// DRY RUN BY DEFAULT (pass --yes). Marker-guarded, occurrence-counted, READ BACK.
// The gates RE-RUN the guard against a stub store and RE-MEASURE the retention finding.
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool } = require('../shared/db');
const store = require('../trading/store');
const tuner = require('../trading/agent/tuner');

const ROOT = path.join(__dirname, '..');
const TASK_ID = 1392;
const MARKER = '##2026-09-29 tuner revert dryRun##';
const YES = process.argv.includes('--yes');

const EM = '\u2014';
const STAR = '\u2605';
const WARN = '\u26A0';
const ARROW = '\u21D2';
const CHECK = '\u2714';

const ADDENDUM = `
${MARKER} FIXED: A DRY RUN COULD BE "REVERTED", AND THE REVERT WAS RECORDED AS AN UNDO.##

${STAR} THE DEFECT. 'tuner.run()' guards every write with 'if (!dryRun)', so a dry run writes NO settings and
sends NO alert ${EM} but it still logs a 'tune' event carrying the full proposed before/after, and the Strategy tab
rendered that event with a WORKING Revert button. 'tuner.revert()' never inspected 'payload.dryRun' at all.

${WARN} TWO HARMS, AND THE SECOND IS THE BAD ONE.
  (a) It is a NO-OP that STILL WRITES a 'tune_revert' row ${EM} a record asserting a live change was undone when
      nothing had been changed and nothing needed undoing.
  (b) 'params.before' is the FULL effective param map AT THE TIME OF THE PROPOSAL. So if the settings have moved
      since, reverting a dry run **SILENTLY ADOPTS parameters from a proposal that was never executed** ${EM} a
      settings mutation with no gate, wearing the provenance of an ordinary undo. Measured TODAY: the live
      'strategies.enabled' list holds **12** strategies, while this row's dry-run proposal was written when it
      held **2**. The stale-write path is not hypothetical; the settings have moved.

${STAR} WHAT LANDED. 'revert()' now returns '{ refused: true, error }' when 'ev.payload.dryRun === true', BEFORE
any settings read or write ${EM} so a refusal writes nothing and LOGS nothing, because a refused revert must not
itself become a record. The guard tests '=== true' rather than truthiness, so an event with NO 'dryRun' key (every
applied event, and every event predating the flag) still reads as applied ${EM} defaulting to refuse would make
the whole panel inert. 'GET /tuner/history' now forwards 'dryRun' (it was on the payload all along and simply was
not passed through), the Strategy tab labels such a row **"proposal — never applied"** and offers no button, and a
refusal maps to **409**, not the 404 that every '{ error }' used to get ${EM} "never applied" is not the same
finding as "not found". Pins: 'test/tuner-revert-guard.test.js' (6), including a NEGATIVE CONTROL that an APPLIED
change is still revertible, because a guard that refused everything would satisfy the obvious test and be worse
than the defect.

${WARN}${WARN} **AND THIS ROW'S OWN EVIDENCE HAS AGED OUT OF THE RETAINED WINDOW ${EM} THE ORIGINAL SIGHTING IS
UNRECOVERABLE.** The row cites 'TradingEvents' id **4544** as its measurement. That row is GONE, and the reason is
RETENTION rather than a bad id: the table now spans ids **41,004..124,211** and **4544 is BELOW the retained
floor**, while the retained span is essentially FULLY DENSE (the span width and the row count differ by fewer than
ten ${EM} measured at write time; both figures DRIFT as events arrive, so the gate re-measures them rather than
trusting this line) ${EM} which means ids 1..41,003 are not missing by accident, they are the PRUNED TAIL, and
4544 is in it. **Zero 'tune' events and zero
'tune_revert' rows survive at all.** So the defect's two stated consequences (the no-op undo, and the stale before-map) **can no longer be
re-measured from the record**, and I will not restate them as if they could: the guard is implemented and pinned
synthetically, and the sighting that motivated it is no longer reproducible. What DOES still verify, and was
checked before writing this: the row's quoted 'params.rsi2' matches live settings exactly
('{rsiPeriod:2, low:10, high:90, smaExitPeriod:5, riskPerTradePct:0.5}'), and the tuner is 'enabled: true' at a
24h interval, so the code path is live.

${ARROW} **THE GENERAL LESSON, worth keeping: A TASK THAT CITES A SPECIFIC EVENT ID AS ITS EVIDENCE HAS AN
EXPIRY DATE.** Retention prunes the referent and the claim silently becomes un-re-measurable while still reading
as measured. Same class as TRD-92 (tick retention) and TRD-120's aging evidence ${EM} and it argues for every such
task to record the QUERY and the SHAPE, not only the row id.

${WARN} RELATED, NOT FIXED HERE: TRD-TUN-2 (#1393) ${EM} the tuner resolves params through 'strategies.list()',
which cannot see the per-symbol layer the desk actually trades, so a change can be recorded, displayed and
ignored. Still open.

${STAR} STATUS: suite **1,769 tests / 1,768 pass / 0 fail / 1 skipped** (was 1,763/1,762 ${EM} the 6 new pins);
eslint exit 0 on 'tuner.js', 'routes.js' and the new test. No size, cap, dial or veto was changed: this closes a
settings-mutation path, which is strictly less exposure than before.`;

const fail = async (msg) => { console.error(`\n${WARN} REFUSING TO WRITE: ${msg}\n`); process.exit(2); };

(async () => {
  const pool = await getPool();
  const q = async (t) => (await pool.request().query(t)).recordset;

  console.log('=== TRD-TUN-1 — recording gates ===\n');

  console.log('1. the guard refuses a dry run, and writes NOTHING');
  const saved = [], logged = [];
  const orig = { listEvents: store.listEvents, getSettings: store.getSettings, saveSettings: store.saveSettings, logEvent: store.logEvent };
  store.listEvents = async () => [{ id: 4544, payload: { dryRun: true, changes: [{ strategy: 'rsi2', params: { before: { low: 10 }, after: { low: 8 } }, enabled: { before: false, after: true } }] } }];
  store.getSettings = async () => ({ strategies: { enabled: ['survgold'], params: {} } });
  store.saveSettings = async (u, s) => { saved.push(s); };
  store.logEvent = async (...a) => { logged.push(a); };
  let refused;
  try { refused = await tuner.revert(1, { eventId: 4544, index: 0 }); } finally { Object.assign(store, orig); }
  if (refused.refused !== true) await fail('a dry-run revert was NOT refused');
  if (saved.length || logged.length) await fail(`a refusal wrote ${saved.length} setting(s) and ${logged.length} event(s)`);
  console.log(`  ${CHECK} refused, 0 writes, 0 log rows`);

  console.log('\n2. an APPLIED change is still revertible (the guard is not a blanket refusal)');
  const saved2 = [], logged2 = [];
  store.listEvents = async () => [{ id: 3586, payload: { dryRun: false, changes: [{ strategy: 'rsi2', params: { before: { low: 10, high: 90 }, after: { low: 8, high: 88 } }, enabled: { before: false, after: true } }] } }];
  store.getSettings = async () => ({ strategies: { enabled: ['survgold', 'rsi2'], params: {} } });
  store.saveSettings = async (u, s) => { saved2.push(s); };
  store.logEvent = async (...a) => { logged2.push(a); };
  let ok;
  try { ok = await tuner.revert(1, { eventId: 3586, index: 0 }); } finally { Object.assign(store, orig); }
  if (ok.reverted !== 'rsi2' || saved2.length !== 1 || logged2.length !== 1) await fail(`an applied revert regressed: ${JSON.stringify(ok)}`);
  console.log(`  ${CHECK} applied change reverts, 1 write, 1 tune_revert`);

  console.log('\n3. the retention finding, RE-MEASURED (this is why the block is careful)');
  const rng = (await q(`SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS n FROM TradingEvents`))[0];
  const ev4544 = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE id = 4544`))[0].n;
  const tunes = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind = 'tune'`))[0].n;
  const revs = (await q(`SELECT COUNT(*) AS n FROM TradingEvents WHERE kind = 'tune_revert'`))[0].n;
  if (ev4544 !== 0) await fail('event 4544 EXISTS again — the retention claim is wrong, do not record it');
  // ⚠ THE FIRST VERSION OF THIS GATE ASSERTED 4544 WAS *INSIDE* lo..hi AND REFUSED TO WRITE. It was right to
  // refuse: 4544 is BELOW the floor. "Pruned" and "never existed" are different findings, and the test for
  // which one applies is the SIDE of the floor the id falls on, plus how DENSE the retained range is.
  if (!(4544 < rng.lo)) await fail(`4544 is not below the retained floor ${rng.lo} — the pruning claim is wrong`);
  const density = rng.n / (rng.hi - rng.lo + 1);
  if (density < 0.99) await fail(`the retained range is only ${(density * 100).toFixed(1)}% dense — a SPARSE range means ids were deleted individually, not pruned from the tail, so "retention" is not the right explanation`);
  if (tunes !== 0 || revs !== 0) await fail(`tune=${tunes} tune_revert=${revs} — the block claims none survive`);
  console.log(`  ${CHECK} 4544 < retained floor ${rng.lo}; range ${(density * 100).toFixed(2)}% dense; tune events 0; tune_revert rows 0`);

  console.log('\n4. the tuner path is LIVE, so the guard is not guarding a dead code path');
  const st = await store.getSettings(1);
  if (!st || st.tuner === undefined) await fail('cannot read settings.tuner');
  if (st.tuner.enabled !== true) await fail('the tuner is not enabled — the guard would be untestable in practice');
  console.log(`  ${CHECK} tuner enabled=${st.tuner.enabled} interval=${st.tuner.intervalHours}h; enabled strategies=${(st.strategies.enabled || []).length}`);

  console.log('\n5. the route and the panel');
  const routesSrc = fs.readFileSync(path.join(ROOT, 'trading/routes.js'), 'utf8').replace(/\r\n/g, '\n');
  const appSrc = fs.readFileSync(path.join(ROOT, 'trading/public/js/app.js'), 'utf8').replace(/\r\n/g, '\n');
  if (!/dryRun: e\.payload\?\.dryRun === true,/.test(routesSrc)) await fail('history does not forward dryRun');
  if (!/if \(r\.refused\) return res\.status\(409\)/.test(routesSrc)) await fail('a refusal is still a 404');
  if (!/const dry = ev\.dryRun === true;/.test(appSrc)) await fail('the panel cannot tell a proposal from an applied change');
  if (appSrc.indexOf('const dry = ev.dryRun === true;') > appSrc.indexOf('data-revert=')) await fail('the button is rendered before the dry check');
  console.log(`  ${CHECK} history forwards dryRun; refusal -> 409; the button is behind the dry check`);

  console.log('\n6. the row and its marker');
  const t = (await q(`SELECT id, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  if (!t) await fail(`row ${TASK_ID} does not exist`);
  const n = (t.info || '').split(MARKER).length - 1;
  console.log(`  #${TASK_ID}: ${(t.info || '').length} chars, this marker ${n}x`);

  if (!YES) {
    console.log(n === 0
      ? `\n  would append ${ADDENDUM.length} chars. DRY RUN ${EM} not written.`
      : `\n  block already present. DRY RUN ${EM} not written.`);
    await pool.close();
    return;
  }
  if (n === 0) {
    await pool.request().query(`UPDATE dbo.Tasks SET info = info + N'${ADDENDUM.replace(/'/g, "''")}' WHERE id = ${TASK_ID}`);
    console.log(`  ${CHECK} block appended`);
  } else console.log('  block already present.');

  const after = (await q(`SELECT LEN(info) AS n, info FROM dbo.Tasks WHERE id = ${TASK_ID}`))[0];
  const fn = (after.info || '').split(MARKER).length - 1;
  if (fn !== 1) await fail(`the block appears ${fn}x — expected exactly 1 (idempotency)`);
  if (!(after.info || '').includes('THE ORIGINAL SIGHTING IS')) await fail('read-back cannot find the block');
  console.log(`  ${CHECK} #${TASK_ID}.info is now ${after.n} chars, block x${fn}, read back`);
  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
