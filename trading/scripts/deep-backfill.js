// trading/scripts/deep-backfill.js - DEEP-WINDOW repull of a provider series into PriceBars.
//
// WHY THIS EXISTS. `yahoo.backfill` is TAIL-ONLY and cannot extend a series BACKWARDS, by construction:
//
//     period1 = Math.max(last.barStart - 1 bar, now - days*86400000)
//
// When bars already exist the FIRST term wins, so passing `rangeDays: 729` re-fetches from the newest
// stored bar and writes nothing new. A series that was first pulled with a shorter `rangeDays` therefore
// stays short FOREVER, and the only symptom is that it looks like a smaller window than its neighbours.
// Silver is the live case: 5,954 yahoo 1h bars from 2025-09-10 against Gold 11,696 and Oil 11,546 from
// 2024-09-11, on an instrument offering 11,437 bars. Two Silver lab pairs (regturtle #9, mtftrend #19)
// failed INSUFFICIENT-DATA on that half-length window, and Gold's three candidates share one identical
// freeze timestamp (2026-09-10 14:49:46.858) across seven symbols, so the freeze was not Silver-specific.
//
// THE MECHANISM IS `upsertProviderBars`, AND IT NEEDS NO EXPLICIT DELETE. It already clears the fetched
// window (DELETE ... barStart BETWEEN @from AND @to) and re-inserts, so a full-window fetch is a
// window-REPLACE - the TRD-27 pattern. This script only has to build the window correctly and declare
// provenance (043: `sourceIntervalSec` is mandatory, and an ABSENT key throws rather than defaulting).
//
// ⚠ THE CEILING IS A CLAIM ABOUT THE FEED, NOT A PREFERENCE. `--days` is refused above
// `yahoo.MAX_SPAN_DAYS[timeframe]` rather than silently clamped, because a clamped request would look
// like it succeeded while quietly returning less history than asked for - the exact failure this script
// exists to repair. The returned span is printed against the REQUESTED span so a truncation is visible.
//
// ⚠ DRY RUN BY DEFAULT. It reports what would change and writes nothing unless `--yes` is passed.
//
// USAGE
//   node trading/scripts/deep-backfill.js --symbol Silver --ticker SI=F --timeframe 1h --days 729
//   node trading/scripts/deep-backfill.js --symbol Silver --ticker SI=F --timeframe 1h --days 729 --yes
//
// All four flags are REQUIRED and never guessed: a wrong ticker silently backfills a different
// instrument, and a defaulted window is a window nobody chose.

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
// `sql` comes from shared/db, NOT from require('mssql'): db.js picks the driver at load time, and a
// directly-required `mssql` is a different instance whose type objects the pool rejects with
// "parameter.type.validate is not a function".
const { getPool, sql } = require('../../shared/db');
const yahoo = require('../agent/providers/yahoo');
const store = require('../store');

const USER = 1;
const VENUE = 'yahoo';
const APPLY = process.argv.includes('--yes');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : undefined;
}

function usage() {
  console.log('usage: node trading/scripts/deep-backfill.js --symbol <display> --ticker <provider ticker> --timeframe <tf> --days <n> [--yes]');
  console.log('       node trading/scripts/deep-backfill.js --symbol Silver --ticker SI=F --timeframe 1h --days 729');
  process.exit(2);
}

async function coverage(symbol, timeframe) {
  const pool = await getPool();
  const r = await pool.request()
    .input('userId', sql.Int, USER)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('timeframe', sql.NVarChar(8), timeframe)
    .input('venue', sql.NVarChar(32), VENUE)
    .query(`SELECT COUNT(*) AS bars, MIN(barStart) AS firstBar, MAX(barStart) AS lastBar,
                   ISNULL(SUM(CASE WHEN sourceIntervalSec IS NULL THEN 1 ELSE 0 END), 0) AS nullSrc
              FROM PriceBars
             WHERE userId = @userId AND symbol = @symbol AND timeframe = @timeframe AND venue = @venue`);
  return r.recordset[0];
}

const iso = (d) => (d ? new Date(d).toISOString().replace('.000Z', 'Z') : null);

(async () => {
  const symbol = arg('--symbol');
  const ticker = arg('--ticker');
  const timeframe = arg('--timeframe');
  const daysArg = arg('--days');
  if (!symbol || !ticker || !timeframe || !daysArg) usage();

  const days = Number(daysArg);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be a positive number (got ${JSON.stringify(daysArg)})`);

  const declared = store.TIMEFRAME_SECONDS[timeframe];
  if (!declared) throw new Error(`no declared interval for timeframe ${JSON.stringify(timeframe)} - add it to TIMEFRAME_SECONDS rather than inventing one here`);

  const ceiling = yahoo.MAX_SPAN_DAYS[timeframe];
  if (!ceiling) throw new Error(`yahoo has no depth claim for ${timeframe}; refusing to guess a ceiling`);
  if (days > ceiling) {
    throw new Error(`--days ${days} exceeds the verified provider depth for ${timeframe} (${ceiling}). `
      + `Refusing rather than clamping: a clamped request reports success while returning less history than asked for.`);
  }

  const before = await coverage(symbol, timeframe);
  const now = Date.now();
  const period1 = Math.floor((now - days * 86400000) / 1000);
  const period2 = Math.floor(now / 1000);

  console.log(`deep-backfill  ${symbol} <- ${ticker}  ${timeframe}  requested ${days}d (ceiling ${ceiling}d)`);
  console.log(`  requested window      ${iso(new Date(period1 * 1000))} .. ${iso(new Date(period2 * 1000))}`);
  console.log(`  stored BEFORE         ${before.bars} bars, ${iso(before.firstBar)} .. ${iso(before.lastBar)}, ${before.nullSrc} row(s) with no declared interval`);

  const raw = await yahoo.fetchChart(ticker, timeframe, { period1, period2 });
  if (!raw.length) throw new Error(`provider returned 0 bars for ${ticker} ${timeframe} - nothing written`);

  // fetchChart tags every row with the TICKER it fetched; the store keys on the DISPLAY name, so a
  // missing override would file SI=F under "SI=F" and leave "Silver" untouched while reporting success.
  const rows = raw.map((b) => ({ ...b, symbol, sourceIntervalSec: declared }));

  const first = rows[0].barStart;
  const last = rows[rows.length - 1].barStart;
  const requestedMs = (period2 - period1) * 1000;
  const gotMs = new Date(last).getTime() - new Date(first).getTime();
  // An EMPTY series has no "current first bar" to land before. Printing the extension message anyway
  // would assert a comparison that never happened - the exact failure mode this script exists to avoid
  // (a number that looks like a measurement and is not). Say which case it is.
  const empty = !before.firstBar;
  const newBars = empty ? rows.length : rows.filter((b) => new Date(b.barStart) < new Date(before.firstBar)).length;

  console.log(`  provider returned     ${raw.length} bars, ${iso(first)} .. ${iso(last)}  (span ${(gotMs / 86400000).toFixed(1)}d of ${(requestedMs / 86400000).toFixed(1)}d requested)`);
  console.log(empty
    ? `  rows NEWER-window     ${newBars} bar(s) - series was EMPTY, so every row is new (nothing to compare against)`
    : `  rows NEWER-window     ${newBars} bar(s) land BEFORE the current first bar (this is the extension)`);

  // A returned span far short of the request is the truncation this script exists to catch. Stated, not
  // asserted: the provider legitimately starts later for a young instrument, so it is a warning.
  if (gotMs < requestedMs * 0.8) {
    console.log(`  WARN span is ${((gotMs / requestedMs) * 100).toFixed(0)}% of the request - the provider may be truncating this interval, or the instrument is younger than the window.`);
  }

  if (!APPLY) {
    console.log('  DRY RUN - nothing written. Re-run with --yes to apply.');
    return;
  }

  const res = await store.upsertProviderBars(USER, rows);
  const after = await coverage(symbol, timeframe);

  console.log(`  upsertProviderBars     upserted ${res.upserted}, flagged ${res.flagged}`);
  console.log(`  stored AFTER          ${after.bars} bars, ${iso(after.firstBar)} .. ${iso(after.lastBar)}, ${after.nullSrc} row(s) with no declared interval`);
  console.log(`  delta                 bars ${after.bars - before.bars >= 0 ? '+' : ''}${after.bars - before.bars}, provenance filled ${before.nullSrc - after.nullSrc}`);
})().catch((e) => {
  console.error(`deep-backfill FAILED: ${e.message}`);
  process.exit(1);
});
