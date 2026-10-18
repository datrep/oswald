// scripts/prune-pre-epoch.js — archive, then delete, everything the desk does not need before the POLICY EPOCH.
//
// WHY AN EPOCH AND NOT A DATE. The owner's ask was "delete all data that's before this week". That is a moving
// target: next week it means something else, and the contamination it is aimed at came from a measurement silently
// including pre-policy rows. So the boundary is a RECORDED constant — the Monday the current policy set began — and
// every artifact that reports it can cite the same value instead of each re-deriving a week.
//
// ⚠⚠ THE ORDER IS THE GUARANTEE, exactly as `agent/tickArchive.js` has it: EXPORT first, then delete bounded by the
// largest id that made it into the file. If the export throws, NOTHING is deleted. The cheap wrong answer is to
// delete first and archive afterwards, which is the bug with a bow on it.
//
// ⚠ AND THE TABLE SET IS CHOSEN FROM A MEASUREMENT, NOT FROM THE SENTENCE. `PriceBars` is REFUSED outright: the
// strategies compute Donchian(20) and ATR(14) over 1h bars, so pruning bars to one week leaves no warm-up and the
// desk stops producing signals. `Trades` / `TradingPrompts` / `BacktestRuns` are REFUSED too — deleting them would
// leave n=11 approved vs n=50 declined, a single week with nothing to compare against, which makes the
// contamination worse rather than better.
//
//   node scripts/prune-pre-epoch.js                     # DRY RUN: report what would go, archive nothing
//   node scripts/prune-pre-epoch.js --archive           # write the archives, delete NOTHING
//   node scripts/prune-pre-epoch.js --archive --delete  # archive AND delete
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getPool } = require('../shared/db');

// ★ THE POLICY EPOCH IS A RECORDED VALUE. Change it here and every run cites the new one.
const POLICY_EPOCH = '2026-09-21';

const ARCHIVE_DIR = path.join(__dirname, '..', 'trading', 'archive', 'pruned');
const BATCH = 2000;
// Hard ceiling on what one run will remove, so a mistake cannot empty a table in one command.
const MAX_ROWS_PER_TABLE = 60000;

// `dateCol` is the column the epoch is applied to. `why` is the reason it is in this set.
const PRUNABLE = {
  TradingEvents: { dateCol: 'createdAt', why: 'telemetry and the append-only audit trail; also the source of the PRE-FIX DUPLICATE wake pairs that broke a census' },
  ShadowSignals: { dateCol: 'createdAt', why: 'forward-scorer shadow output — nothing trades on it' },
  QuarantinedTicks: { dateCol: 'capturedAt', why: 'quarantine evidence, nothing reads it at decision time' },
  TradingAlerts: { dateCol: 'createdAt', why: 'alert cooldown state; old rows are inert' },
};

// ⚠ REFUSED, WITH THE REASON. Not a comment — the script will not act on these even if asked, until the reason is
// dealt with. Editing this map is the deliberate act.
const REFUSED = {
  PriceBars: 'FATAL: strategies compute Donchian(20)/ATR(14) over 1h bars and backtests need long windows — pruning to one week leaves NO WARM-UP and the desk stops producing signals',
  Trades: 'RISKY: the P&L track record; strategyStats gates chair evidence at n>=20, and the tuner/autopsy read it',
  PaperTrades: 'RISKY: the sim book — same evidence role as Trades in paper mode',
  TradingPrompts: 'RISKY: the decision record; deleting it leaves one week with nothing to compare against',
  BacktestRuns: 'RISKY: the stored backtests the strategies are scored on',
  LabCandidates: 'RISKY: Lab evidence — the frozen candidates and their provenance',
  EquityTicks: 'RISKY: the equity curve — the divergence monitor compares live vs backtest over a window',
  EquitySnapshots: 'RISKY: same, at coarser cadence; also the disaster-floor story',
  AuditLogs: 'RISKY: the audit trail',
  ApiLogs: 'OTHER-APP: belongs to the main Oswald app, not the trading desk',
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';

(async () => {
  const doArchive = process.argv.includes('--archive');
  const doDelete = process.argv.includes('--delete');
  if (doDelete && !doArchive) {
    console.error('refusing --delete without --archive: the order is the guarantee, and deleting first is the bug');
    process.exit(2);
  }
  const only = (process.argv.find((a) => a.startsWith('--table=')) || '').split('=')[1] || null;
  const askedRefused = only && Object.keys(REFUSED).includes(only);
  if (askedRefused) {
    console.error(`REFUSED: ${only}\n  ${REFUSED[only]}\n`);
    console.error('Nothing was touched. If this table genuinely belongs in the set, move it to PRUNABLE and say why.');
    process.exit(2);
  }

  const pool = await getPool();
  const epoch = new Date(POLICY_EPOCH);
  console.log(`POLICY EPOCH ${POLICY_EPOCH}   mode: ${doDelete ? 'ARCHIVE + DELETE' : doArchive ? 'ARCHIVE ONLY' : 'DRY RUN'}\n`);

  const tables = Object.keys(PRUNABLE).filter((t) => !only || t === only);
  let archivedTotal = 0, deletedTotal = 0;

  for (const table of tables) {
    const { dateCol, why } = PRUNABLE[table];
    const q = await pool.request().input('ep', epoch).query(
      `SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM [${table}] WHERE [${dateCol}] < @ep`);
    const { n, lo, hi } = q.recordset[0];
    console.log(`${table}  (${dateCol} < ${POLICY_EPOCH})`);
    console.log(`  rows: ${n}   id range: ${lo ?? '-'}..${hi ?? '-'}`);
    console.log(`  why prunable: ${why}`);
    if (!n) { console.log('  nothing to do\n'); continue; }
    if (Number(n) > MAX_ROWS_PER_TABLE) {
      console.log(`  ⚠ ${n} exceeds the per-run ceiling of ${MAX_ROWS_PER_TABLE} — nothing done; raise the ceiling deliberately\n`);
      continue;
    }

    if (!doArchive) { console.log('  DRY RUN — would export then delete\n'); continue; }

    // --- 1. EXPORT, in id-page order, to one gzipped JSONL file. ------------------------------------
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const file = path.join(ARCHIVE_DIR, `${table}-epoch${POLICY_EPOCH}_${stamp()}.jsonl.gz`);
    const chunks = [];
    let written = 0, afterId = 0, maxId = 0;
    for (;;) {
      const page = await pool.request()
        .input('ep', epoch).input('afterId', afterId).input('lim', BATCH)
        .query(`SELECT TOP (@lim) * FROM [${table}] WHERE [${dateCol}] < @ep AND id > @afterId ORDER BY id ASC`);
      if (!page.recordset.length) break;
      for (const r of page.recordset) { chunks.push(JSON.stringify(r)); written++; maxId = Math.max(maxId, Number(r.id)); }
      afterId = Number(page.recordset[page.recordset.length - 1].id);
      if (page.recordset.length < BATCH) break;
    }
    // ⚠ THE FILE IS WRITTEN BEFORE ANY DELETE, AND ITS maxId IS WHAT BOUNDS THE DELETE.
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(chunks.join('\n') + '\n', 'utf8')));
    archivedTotal += written;
    console.log(`  ✔ archived ${written} rows -> ${path.basename(file)} (${(fs.statSync(file).size / 1024).toFixed(1)} KB, maxId ${maxId})`);
    if (written !== Number(n)) {
      console.log(`  ⚠ archived ${written} but counted ${n} — the delete is still bounded by maxId ${maxId}, so the extra rows survive to the next run`);
    }

    if (!doDelete) { console.log('  (archive only — nothing deleted)\n'); continue; }

    // --- 2. DELETE, bounded by the SAME cutoff AND by the largest id that made it into the file. -----
    const del = await pool.request().input('ep', epoch).input('maxId', maxId).query(
      `DELETE FROM [${table}] WHERE [${dateCol}] < @ep AND id <= @maxId AND id > 0`);
    const removed = Number(del.rowsAffected?.[0]) || 0;
    deletedTotal += removed;
    console.log(`  ✔ deleted ${removed} rows (bounded by id <= ${maxId})\n`);
  }

  const left = await pool.request().query(`SELECT COUNT(*) AS n FROM TradingEvents`);
  console.log(`\nTOTAL archived ${archivedTotal}, deleted ${deletedTotal}. TradingEvents now ${left.recordset[0].n} rows.`);
  console.log('⚠ The archives are the only copy of what was removed — verify one before trusting the delete.');
  await pool.close();
})().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
