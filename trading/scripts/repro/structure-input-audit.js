// trading/scripts/repro/structure-input-audit.js
//
// READ-ONLY. Answers three questions that the structure-engine design
// (docs/structure-engine-design-2026-09-22.md) asserts answers to but does not prove:
//
//   A. Is `plus500_chart`.volume a MARKET quantity or a CAPTURE quantity?
//      The design's §4.1 calls the volume column a blocking defect. But `plus500_chart`
//      is written by capture.bankChartBars -> store.upsertProviderBars from the venue's
//      OWN ChartIQ masterData (webtrader.readChartBars maps `Volume`), which is a
//      different code path from upsertHourlyBars' `volume = s.ticks`. Those two must be
//      separated before a verdict is written, because IND_VENUE_PREF already prefers
//      plus500_chart over plus500 for indicator series.
//
//   B. Is n accumulating? (success criterion (b): positive expectancy at n >= 50 per
//      strategy; the live tracker is routes.js `/scorecard`, goal = 50.)
//
//   C. Did the LAB stall? BacktestRuns activity by day.
//
// Usage (from the repo root): node trading/scripts/repro/structure-input-audit.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');

const USER_ID = Number(process.argv[2]) || 1;

const pad = (s, n) => String(s ?? '').padEnd(n);
const num = (v, dp = 2) => (v == null ? '—' : Number(v).toFixed(dp));

async function main() {
  const pool = await getPool();
  const q = (text) => pool.request().input('userId', sql.Int, USER_ID).query(text);

  // ── A1. Which tables exist that could hold lab state ─────────────────────
  console.log('\n=== A1. lab/candidate-ish tables ===');
  const tabs = await pool.request().query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_NAME LIKE '%Lab%' OR TABLE_NAME LIKE '%Candidate%'
         OR TABLE_NAME LIKE '%Shadow%' OR TABLE_NAME LIKE '%Structure%'
      ORDER BY TABLE_NAME`);
  console.log(tabs.recordset.map((r) => r.TABLE_NAME).join(', ') || '(none)');

  // ── A2. volume provenance by venue ───────────────────────────────────────
  console.log('\n=== A2. PriceBars 1h — volume by venue ===');
  const vols = await q(`
    SELECT venue,
           COUNT(*) AS bars,
           COUNT(DISTINCT symbol) AS symbols,
           SUM(CASE WHEN volume IS NULL THEN 1 ELSE 0 END) AS v_null,
           SUM(CASE WHEN volume = 0 THEN 1 ELSE 0 END) AS v_zero,
           MIN(volume) AS v_min, MAX(volume) AS v_max,
           AVG(CAST(volume AS FLOAT)) AS v_avg,
           SUM(CASE WHEN flagged <> 0 THEN 1 ELSE 0 END) AS flagged,
           MIN(barStart) AS first_bar, MAX(barStart) AS last_bar
      FROM PriceBars
     WHERE userId = @userId AND timeframe = '1h'
     GROUP BY venue
     ORDER BY COUNT(*) DESC`);
  console.log(pad('venue', 16) + pad('bars', 9) + pad('sym', 5) + pad('null', 7)
    + pad('zero', 7) + pad('min', 12) + pad('max', 14) + pad('avg', 12) + pad('flag', 6) + 'last_bar');
  for (const r of vols.recordset) {
    console.log(pad(r.venue, 16) + pad(r.bars, 9) + pad(r.symbols, 5) + pad(r.v_null, 7)
      + pad(r.v_zero, 7) + pad(num(r.v_min, 2), 12) + pad(num(r.v_max, 2), 14)
      + pad(num(r.v_avg, 2), 12) + pad(r.flagged, 6)
      + (r.last_bar ? new Date(r.last_bar).toISOString().slice(0, 16) : '—'));
  }

  // ── A3. side-by-side, same symbol + same hour, two venues ────────────────
  console.log('\n=== A3. same symbol/hour, plus500 vs plus500_chart (last 8 overlapping 1h bars) ===');
  const both = await q(`
    WITH ov AS (
      SELECT symbol, barStart
        FROM PriceBars
       WHERE userId = @userId AND timeframe = '1h' AND venue IN ('plus500','plus500_chart')
       GROUP BY symbol, barStart
      HAVING COUNT(DISTINCT venue) = 2
    )
    SELECT TOP 8 b.symbol, b.barStart, b.venue, b.openPrice, b.high, b.low, b.closePrice, b.volume
      FROM PriceBars b JOIN ov ON ov.symbol = b.symbol AND ov.barStart = b.barStart
     WHERE b.userId = @userId AND b.timeframe = '1h' AND b.venue IN ('plus500','plus500_chart')
     ORDER BY b.barStart DESC, b.symbol, b.venue`);
  if (!both.recordset.length) console.log('(no symbol/hour has BOTH venues — cannot compare directly)');
  for (const r of both.recordset) {
    console.log(`  ${String(new Date(r.barStart).toISOString()).slice(0, 16)} ${pad(r.symbol, 14)}${pad(r.venue, 16)}`
      + `O=${pad(num(r.openPrice, 2), 10)}C=${pad(num(r.closePrice, 2), 10)}vol=${num(r.volume, 2)}`);
  }

  // ── A4. does plus500_chart volume carry hourly structure? ────────────────
  // A market quantity has an intraday shape. A capture count has the POLLER's shape.
  console.log('\n=== A4. plus500_chart volume by UTC hour (busiest symbol, 1h bars) ===');
  const top = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT TOP 1 symbol, COUNT(*) AS bars FROM PriceBars
     WHERE userId = @userId AND venue = 'plus500_chart' AND timeframe = '1h'
     GROUP BY symbol ORDER BY COUNT(*) DESC`);
  const topSym = top.recordset[0]?.symbol;
  if (!topSym) console.log('(no plus500_chart bars)');
  else {
    console.log(`  symbol: ${topSym} (${top.recordset[0].bars} bars)`);
    const hr = await pool.request()
      .input('userId', sql.Int, USER_ID).input('symbol', sql.NVarChar(32), topSym)
      .query(`SELECT DATEPART(HOUR, barStart) AS hh, COUNT(*) AS bars,
                     AVG(CAST(volume AS FLOAT)) AS v_avg, MAX(volume) AS v_max,
                     AVG(CAST(high - low AS FLOAT)) AS rng_avg
                FROM PriceBars
               WHERE userId = @userId AND venue = 'plus500_chart' AND timeframe = '1h'
                 AND symbol = @symbol AND volume IS NOT NULL
               GROUP BY DATEPART(HOUR, barStart) ORDER BY hh`);
    console.log('  ' + pad('UTC hh', 8) + pad('bars', 7) + pad('avg vol', 14) + pad('max vol', 14) + 'avg range');
    for (const r of hr.recordset) {
      console.log('  ' + pad(r.hh, 8) + pad(r.bars, 7) + pad(num(r.v_avg, 2), 14)
        + pad(num(r.v_max, 2), 14) + num(r.rng_avg, 4));
    }
  }

  // ── A5. per-symbol split: who actually HAS plus500_chart volume? ─────────
  console.log('\n=== A5. plus500_chart volume per symbol (ordered by bars) ===');
  const sym = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT symbol, COUNT(*) AS bars,
           SUM(CASE WHEN volume = 0 THEN 1 ELSE 0 END) AS zeros,
           SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) AS nonzero,
           MAX(volume) AS v_max, AVG(CAST(volume AS FLOAT)) AS v_avg
      FROM PriceBars
     WHERE userId = @userId AND venue = 'plus500_chart' AND timeframe = '1h'
     GROUP BY symbol ORDER BY COUNT(*) DESC`);
  console.log(pad('symbol', 20) + pad('bars', 7) + pad('zeros', 7) + pad('nonzero', 9)
    + pad('max vol', 16) + 'avg vol');
  for (const r of sym.recordset) {
    console.log(pad(r.symbol, 20) + pad(r.bars, 7) + pad(r.zeros, 7) + pad(r.nonzero, 9)
      + pad(num(r.v_max, 0), 16) + num(r.v_avg, 2));
  }

  // ── B. is n accumulating? ────────────────────────────────────────────────
  console.log('\n=== B. live n per strategy (the /scorecard goal:50 tracker) ===');
  const stats = await q(`
    SELECT strategyId, COUNT(*) AS n,
           SUM(CASE WHEN grossPnl > 0 THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(ISNULL(grossPnl,0)), 2) AS pnl
      FROM Trades
     WHERE userId = @userId AND status = 'closed' AND strategyId IS NOT NULL
     GROUP BY strategyId ORDER BY n DESC`);
  console.log(pad('strategy', 18) + pad('n', 6) + pad('win%', 8) + pad('pnl', 12) + 'toGo(50)');
  for (const r of stats.recordset) {
    const n = Number(r.n);
    const wr = n ? Math.round((Number(r.wins) / n) * 100) : 0;
    console.log(pad(r.strategyId, 18) + pad(n, 6) + pad(wr + '%', 8) + pad(num(r.pnl, 2), 12)
      + Math.max(0, 50 - n));
  }
  const tot = await q(`SELECT COUNT(*) AS n FROM Trades WHERE userId = @userId AND status = 'closed'`);
  console.log(`  total closed rows: ${tot.recordset[0].n}`);
  const tc = await pool.request().query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'Trades' AND (COLUMN_NAME LIKE '%los%' OR COLUMN_NAME LIKE '%Time%')
      ORDER BY COLUMN_NAME`);
  console.log('  candidate close-time columns: ' + tc.recordset.map((r) => r.COLUMN_NAME).join(', '));

  // ── B2. arrival rate — how long until n>=50 at the observed cadence? ─────
  // Q3 of the design doc proposes freezing the forward track until n>=50. That is only a
  // decision if the wait is bounded, so measure the cadence rather than assume it.
  console.log('\n=== B2. close arrival rate and time-to-50 ===');
  const rate = await q(`
    SELECT strategyId, COUNT(*) AS n, MIN(closeAt) AS first_close, MAX(closeAt) AS last_close
      FROM Trades
     WHERE userId = @userId AND status = 'closed' AND strategyId IS NOT NULL
     GROUP BY strategyId ORDER BY COUNT(*) DESC`);
  console.log(pad('strategy', 18) + pad('n', 5) + pad('first close', 12) + pad('last close', 12)
    + pad('span d', 8) + pad('closes/wk', 11) + 'weeks to n=50');
  for (const r of rate.recordset) {
    const n = Number(r.n);
    const a = r.first_close ? new Date(r.first_close) : null;
    const b = r.last_close ? new Date(r.last_close) : null;
    const spanD = a && b ? Math.max(0.5, (b - a) / 86400000) : null;
    const perWk = spanD ? (n / spanD) * 7 : null;
    const toGo = Math.max(0, 50 - n);
    const wks = perWk > 0 ? toGo / perWk : null;
    console.log(pad(r.strategyId, 18) + pad(n, 5)
      + pad(a ? a.toISOString().slice(0, 10) : '—', 12)
      + pad(b ? b.toISOString().slice(0, 10) : '—', 12)
      + pad(spanD ? num(spanD, 1) : '—', 8)
      + pad(perWk ? num(perWk, 2) : '—', 11)
      + (wks ? num(wks, 1) : '—'));
  }
  const byWeek = await q(`
    SELECT CONVERT(date, DATEADD(day, -((DATEDIFF(day, '2026-08-01', closeAt)) % 7), closeAt)) AS wk,
           COUNT(*) AS n
      FROM Trades WHERE userId = @userId AND status = 'closed'
     GROUP BY CONVERT(date, DATEADD(day, -((DATEDIFF(day, '2026-08-01', closeAt)) % 7), closeAt))
     ORDER BY wk`);
  console.log('  closes per week: ' + (byWeek.recordset.map((r) => `${String(r.wk).slice(5, 10)}:${r.n}`).join('  ') || '(none)'));
  const openT = await q(`SELECT status, COUNT(*) AS n FROM Trades WHERE userId = @userId GROUP BY status ORDER BY n DESC`);
  console.log('  Trades by status: ' + openT.recordset.map((r) => `${r.status}:${r.n}`).join('  '));

  // ── A6. what does the INDICATOR path actually see, per tradable symbol? ──
  // quant.symbolIndicators walks IND_VENUE_PREF = ['yahoo','binance','okx','plus500_chart','plus500']
  // and takes the FIRST venue with >= 30 1h bars. obv() accepts 0 as valid volume
  // (hasVol checks Number.isFinite, and 0 is finite), so an all-zero series returns
  // { obv: 0 } — a constant published as an indicator — rather than null.
  console.log('\n=== A6. venue selection for the indicator path, and obv safety ===');
  const PREF = ['yahoo', 'binance', 'okx', 'plus500_chart', 'plus500'];
  for (const s of ['Gold', 'Silver', 'Bitcoin', 'Oil']) {
    const rows = await pool.request()
      .input('userId', sql.Int, USER_ID).input('symbol', sql.NVarChar(32), s)
      .query(`SELECT venue, COUNT(*) AS bars,
                     SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) AS nonzero
                FROM PriceBars
               WHERE userId = @userId AND timeframe = '1h' AND symbol = @symbol
               GROUP BY venue`);
    const m = new Map(rows.recordset.map((r) => [r.venue, r]));
    const pick = PREF.find((v) => m.has(v) && Number(m.get(v).bars) >= 30);
    const p = pick ? m.get(pick) : null;
    const allZero = p ? Number(p.nonzero) === 0 : null;
    console.log(`  ${pad(s, 9)}IND picks: ${pad(pick || '(none — symbolIndicators returns null)', 14)}`
      + (p ? `bars=${pad(p.bars, 6)}nonzero=${pad(p.nonzero, 6)}` : '')
      + (allZero === true ? '  <-- obv() returns a CONSTANT 0, not null' : ''));
    console.log(`           ${PREF.filter((v) => m.has(v)).map((v) => `${v}:${m.get(v).bars}(nz=${m.get(v).nonzero})`).join('  ') || '(no bars)'}`);
  }

  // ── A7. is the zero/non-zero split TEMPORAL or PER-SYMBOL? ──────────────
  // The owner reports the chart PROFILE (hence whether the Volume study is mounted) differs
  // per section (trade / open positions / orders). If `bankChartBars` reads masterData.Volume
  // on a page without the study, volume lands as 0. That predicts a TIME boundary or a
  // section-correlated pattern, NOT a per-symbol one. Test it in the stored bars.
  console.log('\n=== A7. plus500_chart zero-vs-nonzero extent, per symbol ===');
  const ext = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT symbol,
           SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) AS nz,
           MIN(CASE WHEN volume > 0 THEN barStart END) AS nz_first,
           MAX(CASE WHEN volume > 0 THEN barStart END) AS nz_last,
           SUM(CASE WHEN volume = 0 THEN 1 ELSE 0 END) AS z,
           MIN(CASE WHEN volume = 0 THEN barStart END) AS z_first,
           MAX(CASE WHEN volume = 0 THEN barStart END) AS z_last,
           MIN(barStart) AS first_bar, MAX(barStart) AS last_bar
      FROM PriceBars
     WHERE userId = @userId AND venue = 'plus500_chart' AND timeframe = '1h'
     GROUP BY symbol
     HAVING SUM(CASE WHEN volume = 0 THEN 1 ELSE 0 END) > 0
     ORDER BY SUM(CASE WHEN volume = 0 THEN 1 ELSE 0 END) DESC`);
  const d10 = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
  console.log(pad('symbol', 20) + pad('nz', 6) + pad('nz from', 12) + pad('nz to', 12)
    + pad('z', 6) + pad('z from', 12) + pad('z to', 12) + 'span');
  for (const r of ext.recordset) {
    console.log(pad(r.symbol, 20) + pad(r.nz, 6) + pad(d10(r.nz_first), 12) + pad(d10(r.nz_last), 12)
      + pad(r.z, 6) + pad(d10(r.z_first), 12) + pad(d10(r.z_last), 12)
      + d10(r.first_bar) + '→' + d10(r.last_bar));
  }

  // ── A8. weekly shape for the three zeros + Oil, to expose a boundary ────
  console.log('\n=== A8. weekly non-zero / total, plus500_chart (Gold, Silver, Bitcoin, Oil) ===');
  for (const sym of ['Gold', 'Silver', 'Bitcoin', 'Oil']) {
    const wk = await pool.request()
      .input('userId', sql.Int, USER_ID).input('symbol', sql.NVarChar(32), sym)
      .query(`SELECT CONVERT(date, DATEADD(day, -((DATEDIFF(day, '2026-08-01', barStart)) % 7), barStart)) AS wk,
                     COUNT(*) AS bars,
                     SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) AS nz
                FROM PriceBars
               WHERE userId = @userId AND venue = 'plus500_chart' AND timeframe = '1h' AND symbol = @symbol
               GROUP BY CONVERT(date, DATEADD(day, -((DATEDIFF(day, '2026-08-01', barStart)) % 7), barStart))
               ORDER BY wk`);
    const s = wk.recordset.map((r) => `${String(r.wk).slice(4, 10)}:${r.nz}/${r.bars}`).join(' ');
    console.log('  ' + pad(sym, 10) + (s || '(none)'));
  }

  // ── A9. did PRICE flow where VOLUME did not? (proves the row is real) ───
  console.log('\n=== A9. OHLC sanity on zero-volume rows (a real bar with no volume) ===');
  const sane = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT symbol,
           COUNT(*) AS zero_rows,
           SUM(CASE WHEN high > low THEN 1 ELSE 0 END) AS has_range,
           SUM(CASE WHEN closePrice <> openPrice THEN 1 ELSE 0 END) AS moved,
           SUM(CASE WHEN high IS NULL OR low IS NULL OR closePrice IS NULL THEN 1 ELSE 0 END) AS missing_ohlc
      FROM PriceBars
     WHERE userId = @userId AND venue = 'plus500_chart' AND timeframe = '1h' AND volume = 0
     GROUP BY symbol ORDER BY COUNT(*) DESC`);
  console.log(pad('symbol', 20) + pad('zero rows', 11) + pad('high>low', 10) + pad('moved', 8) + 'missing OHLC');
  for (const r of sane.recordset) {
    console.log(pad(r.symbol, 20) + pad(r.zero_rows, 11) + pad(r.has_range, 10) + pad(r.moved, 8) + r.missing_ohlc);
  }

  // ── A10. WHAT HAPPENED around 2026-09-11..15? (the volume cut-off) ──────
  // A7/A8 put a hard boundary on plus500_chart volume: every symbol that ever had it stopped
  // by 2026-09-15. Find the event.
  console.log('\n=== A10. TradingEvents mentioning chart/volume, 2026-09-08..2026-09-23 ===');
  const ev = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT CONVERT(date, createdAt) AS d, kind, COUNT(*) AS n
      FROM TradingEvents
     WHERE userId = @userId AND createdAt >= '2026-09-08' AND createdAt < '2026-09-23'
       AND (payload LIKE '%chart%' OR payload LIKE '%volume%' OR payload LIKE '%stale%')
     GROUP BY CONVERT(date, createdAt), kind ORDER BY d, kind`);
  console.log(pad('day', 12) + pad('kind', 18) + 'n');
  for (const r of ev.recordset) console.log(pad(String(r.d).slice(0, 10), 12) + pad(r.kind, 18) + r.n);
  if (!ev.recordset.length) console.log('  (no matching events)');

  console.log('\n=== A10b. all TradingEvents by day, 2026-09-08..2026-09-23 (top kinds) ===');
  const ev2 = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT CONVERT(date, createdAt) AS d, kind, COUNT(*) AS n
      FROM TradingEvents
     WHERE userId = @userId AND createdAt >= '2026-09-08' AND createdAt < '2026-09-23'
     GROUP BY CONVERT(date, createdAt), kind HAVING COUNT(*) > 5 ORDER BY d, n DESC`);
  for (const r of ev2.recordset) console.log('  ' + pad(String(r.d).slice(0, 10), 12) + pad(r.kind, 20) + r.n);

  // ── A11. raw telemetry payloads across the cut-off ──────────────────────
  console.log('\n=== A11. telemetry payloads 2026-09-12 .. 2026-09-16 (first 18) ===');
  const raw = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT TOP 18 createdAt, LEFT(CAST(payload AS NVARCHAR(MAX)), 200) AS p
      FROM TradingEvents
     WHERE userId = @userId AND kind = 'telemetry'
       AND createdAt >= '2026-09-12' AND createdAt < '2026-09-16'
     ORDER BY createdAt`);
  for (const r of raw.recordset) {
    console.log('  ' + String(new Date(r.createdAt).toISOString()).slice(5, 16).replace('T', ' ')
      + '  ' + String(r.p).replace(/\s+/g, ' '));
  }

  // ── A12. HOW MUCH VENUE-OF-RECORD HISTORY IS THERE FOR STRUCTURE? ──────
  // Option A (2026-09-22) computes structure from the venue the desk TRADES at, not from IND_VENUE_PREF's
  // first match. That is the right instrument and a DIFFERENT series, so its depth has to be measured
  // before anyone assumes structure is available: the structure engine's own `minBars` default is 60, and
  // a swing engine needs a warm-up that quant's MIN_BARS (30) does not.
  console.log('\n=== A12. 1h bar depth per venue for the desk\'s symbols (venue of record vs indicator) ===');
  const drank = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT symbol, venue, COUNT(*) AS bars, MIN(barStart) AS first_bar, MAX(barStart) AS last_bar
      FROM PriceBars
     WHERE userId = @userId AND timeframe = '1h' AND venue IN ('plus500', 'plus500_chart', 'yahoo')
     GROUP BY symbol, venue`);
  const bySymbol = new Map();
  for (const r of drank.recordset) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, {});
    bySymbol.get(r.symbol)[r.venue] = r;
  }
  console.log(pad('symbol', 22) + pad('plus500', 10) + pad('+chart', 10) + pad('yahoo', 10) + 'venue-of-record verdict');
  for (const [sym, v] of [...bySymbol.entries()].sort((a, b) => (b[1].plus500?.bars || 0) - (a[1].plus500?.bars || 0))) {
    const p = v.plus500 ? v.plus500.bars : 0;
    const verdict = p >= 60 ? 'ok for structure' : (p > 0 ? 'BELOW minBars 60' : 'no venue-of-record series at all');
    console.log(pad(sym, 22) + pad(v.plus500 ? v.plus500.bars : '—', 10)
      + pad(v.plus500_chart ? v.plus500_chart.bars : '—', 10) + pad(v.yahoo ? v.yahoo.bars : '—', 10) + verdict);
  }

  // ── C. did the lab stall? ────────────────────────────────────────────────
  console.log('\n=== C. BacktestRuns activity (the lab) ===');
  const runs = await q(`
    SELECT TOP 12 id, strategy, createdAt FROM BacktestRuns
     WHERE userId = @userId ORDER BY id DESC`);
  if (!runs.recordset.length) console.log('(none)');
  for (const r of runs.recordset) {
    console.log(`  #${pad(r.id, 8)} ${pad(r.strategy, 20)}`
      + (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 19).replace('T', ' ') : '—'));
  }
  const byDay = await q(`
    SELECT CONVERT(date, createdAt) AS d, COUNT(*) AS runs FROM BacktestRuns
     WHERE userId = @userId GROUP BY CONVERT(date, createdAt) ORDER BY d DESC`);
  console.log('  runs per day: ' + (byDay.recordset.map((r) => `${String(r.d).slice(0, 10)}:${r.runs}`).join('  ') || '(none)'));

  console.log('\ndone.\n');
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
