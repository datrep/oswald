// trading/scripts/repro/commodity-backtest.js - the BACKTEST half of the commodity ask (2026-09-24).
//
// WHY THIS EXISTS. The five commodity candidates (Silver, Soybean Oil, Soybean Meal, Platinum,
// Palladium) had provider data available and almost none of it stored: Silver was half-length,
// Platinum/Palladium held only a single plus500 capture (4 rows each), and Soybean Oil / Soybean Meal
// held nothing at all. `deep-backfill.js` has since written a full 729-day yahoo 1h series for each.
// This script measures what that series says, so the answer is "here is the number", not "the data
// is now deeper".
//
// ⚠ WHAT THIS IS NOT. It is NOT a tradeable-edge measurement, and it is not presented as one. None of
// the five has a registry row, so `costCfgFor` falls through to the flat placeholder `v1-flat` and the
// run prices carry at a flat rate rather than at the venue's own per-instrument funding. Every row
// below therefore reports WHICH cost basis produced it, and the script VERIFIES the missing registry
// row instead of asserting it. A signal measured on a placeholder cost basis is a hypothesis about a
// signal; the venue half of the ask (real captures) is TRD-45's, not this script's.
//
// ⚠ IT WRITES, ON PURPOSE, AND ONLY ONE KIND OF ROW. `backtest.runBacktest` persists a `BacktestRuns`
// row - that IS the backtest artifact the ask asked for, and it does not touch the Lab: no
// `LabCandidates` row is created, so the frozen family's size `k` and the BH correction over it are
// left exactly as they were. Creating Lab rows is a research-integrity act requiring explicit
// go-ahead; running a backtest is not.
//
// ⚠ `refreshData` IS OFF. The stored series is the object under measurement. Letting the provider
// touch it mid-run would mean the number printed describes a window that no longer exists by the time
// it is read.
//
// USAGE
//   node trading/scripts/repro/commodity-backtest.js
//   node trading/scripts/repro/commodity-backtest.js --symbols "Platinum,Soybean Oil" --range 1y

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');
const backtest = require('../../agent/backtest');
const store = require('../../store');

const USER = 1;
const VENUE = 'yahoo';
const TIMEFRAME = '1h';
const DEFAULT_SYMBOLS = ['Silver', 'Soybean Oil', 'Soybean Meal', 'Platinum', 'Palladium'];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined;
}

// VERIFY the registry claim rather than restating it: a symbol with no Instruments row cannot have a
// venue cost basis, and if that ever stops being true this table is what makes it visible.
async function registryState(symbols) {
  const pool = await getPool();
  const req = pool.request().input('userId', sql.Int, USER);
  const list = symbols.map((s, i) => { req.input(`s${i}`, sql.NVarChar(64), s); return `@s${i}`; }).join(', ');
  const r = await req.query(`SELECT symbol, COUNT(*) AS rows_ FROM Instruments
                              WHERE userId = @userId AND symbol IN (${list})
                              GROUP BY symbol`);
  return new Map(r.recordset.map((x) => [x.symbol, Number(x.rows_)]));
}

(async () => {
  const symbols = (arg('--symbols') || DEFAULT_SYMBOLS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const range = arg('--range') || '1y';

  console.log(`commodity-backtest  venue=${VENUE}  timeframe=${TIMEFRAME}  range=${range}  refreshData=false`);
  console.log('  (writes: one BacktestRuns row per symbol. LabCandidates is NOT touched.)\n');

  const reg = await registryState(symbols);

  console.log('  symbol          storedBars  spanD  costBasis      registryRow  trades  pf      netPnl    winRate  benchmark%');
  console.log('  --------------  ----------  -----  -------------  -----------  ------  ------  --------  -------  ----------');

  const out = [];
  for (const symbol of symbols) {
    const cfg = { ...backtest.costCfgFor(symbol), refreshData: false };
    const res = await backtest.runBacktest(USER, { symbol, venue: VENUE, timeframe: TIMEFRAME, range, config: cfg });
    if (res.error) {
      console.log(`  ${symbol.padEnd(14)}  ${String(res.error).slice(0, 100)}`);
      out.push({ symbol, error: res.error });
      continue;
    }
    const m = res.metrics.cfd;
    const basis = res.config.costModelVersion || 'v1-flat';
    const rows = reg.get(symbol) ?? 0;
    console.log(`  ${symbol.padEnd(14)}  ${String(res.bars).padStart(10)}  ${String(res.spanDays).padStart(5)}  `
      + `${basis.padEnd(13)}  ${String(rows).padStart(11)}  ${String(m.trades).padStart(6)}  `
      + `${String(m.profitFactor ?? 'null').padEnd(6)}  ${String(m.netPnl).padStart(8)}  `
      + `${String(m.winRate).padStart(7)}  ${String(res.benchmark ? res.benchmark.pnlPct : 'null').padStart(10)}`);
    out.push({ symbol, runId: res.id, bars: res.bars, spanDays: res.spanDays, basis, registryRows: rows, cfd: m, benchmark: res.benchmark });
  }

  console.log('\n  cf. the same run on the two series that were never short (reference, not candidates):');
  for (const symbol of ['Gold', 'Oil']) {
    const cfg = { ...backtest.costCfgFor(symbol), refreshData: false };
    const res = await backtest.runBacktest(USER, { symbol, venue: VENUE, timeframe: TIMEFRAME, range, config: cfg });
    if (res.error) { console.log(`  ${symbol.padEnd(14)}  ${res.error}`); continue; }
    console.log(`  ${symbol.padEnd(14)}  ${String(res.bars).padStart(10)}  ${String(res.spanDays).padStart(5)}  `
      + `${String(res.config.costModelVersion || 'v1-flat').padEnd(13)}  trades ${res.metrics.cfd.trades}  pf ${res.metrics.cfd.profitFactor}`);
  }

  console.log('\n  ⚠ every row above is priced on the basis named in `costBasis`. A `v1-flat` row is a SIGNAL');
  console.log('    MEASUREMENT, not a tradeable edge - the venue half of the ask is TRD-45\'s, not this script\'s.');

  const labRows = await store.countLabCandidates(USER);
  console.log(`  LabCandidates total after this run: ${labRows} (unchanged by this script - no Lab row is created here).`);
})().catch((e) => {
  console.error(`commodity-backtest FAILED: ${e.stack || e.message}`);
  process.exit(1);
});
