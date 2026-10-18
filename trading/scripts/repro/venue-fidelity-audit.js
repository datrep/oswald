// trading/scripts/repro/venue-fidelity-audit.js
//
// READ-ONLY. The last open item before S2 (§10 residual Q1): the venue-of-record OHLC series
// UNDERSTATES the hour's extremes, and the structure engine's levels ARE those extremes.
//
// The claim to test, and the reason this is an audit rather than a decision:
//
//   `plus500` is built by `upsertHourlyBars` as MAX(mid)/MIN(mid) over the handful of ticks the desk
//   captured in that hour (~3-6 at a 10m cadence). That is a SAMPLE of the hour, so its high/low must sit
//   INSIDE the true hour's range. `plus500_chart` is the venue's OWN chart series (ChartIQ masterData),
//   i.e. the venue's own aggregation — which is the range the market actually printed.
//
// So the test is not "which series has a bigger range" (a bigger range is trivially achievable by being
// wrong). It is three separate questions, and only all three together identify the faithful series:
//
//   1. DOES THE TICK SERIES CONTAIN THE CHART SERIES? For every overlapping hour, is `plus500`.high below
//      `plus500_chart`.high? A sampling explanation PREDICTS this almost always. A basis/contract
//      explanation predicts it about half the time.
//   2. IS THE DIFFERENCE A LEVEL OFFSET OR NOISE? A systematic constant gap (e.g. bid vs mid) would make
//      the two series incomparable for LEVELS even if both ranges were right. Measured on same-hour
//      CLOSES: a mean near zero with sign split ~50/50 is two views of one price; a lopsided mean is two
//      different prices.
//   3. DOES AN INDEPENDENT SOURCE AGREE ON MAGNITUDE? Gold's hourly range is a property of GOLD, so
//      yahoo's Gold series is a legitimate third opinion on the SIZE of the range even though its basis
//      is a different instrument (~116 bps). It cannot arbitrate LEVELS; it can arbitrate RANGE.
//
// A fourth measurement, reported because S2's volume-free activity measure depends on it: does the
// understatement VARY BY HOUR? If it is roughly constant, a ratio over the same hour-of-day cancels it.
//
// Usage (from the repo root): node trading/scripts/repro/venue-fidelity-audit.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');
const store = require('../../store');

const USER_ID = Number(process.argv[2]) || 1;
const SYMBOLS = ['Gold', 'Oil', 'Silver', 'Bitcoin', 'Wilmar International', 'SGX', 'Sugar', 'CK Hutchison'];

const pad = (s, n) => String(s ?? '').padEnd(n);
const lpad = (s, n) => String(s ?? '').padStart(n);
const f = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(dp));
const pct = (v, dp = 0) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(dp)}%`);

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rangeOf = (b) => Number(b.high) - Number(b.low);
const key = (b) => new Date(b.barStart).toISOString().slice(0, 13);

async function main() {
  const pool = await getPool();

  // ── 0. MIGRATION 043 LIVE CHECK — did the capture path write provenance on its first run? ──────────
  console.log('\n=== 0. migration 043 live check — sourceIntervalSec by venue ===');
  const prov = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT venue,
           COUNT(*) AS bars,
           SUM(CASE WHEN sourceIntervalSec IS NULL THEN 1 ELSE 0 END) AS src_null,
           SUM(CASE WHEN sourceIntervalSec = 3600 THEN 1 ELSE 0 END) AS src_3600,
           SUM(CASE WHEN sourceIntervalSec = 1800 THEN 1 ELSE 0 END) AS src_1800,
           SUM(CASE WHEN sourceIntervalSec IS NOT NULL AND sourceIntervalSec NOT IN (3600,1800)
                    THEN 1 ELSE 0 END) AS src_other,
           SUM(CASE WHEN barStart >= '2026-09-22 13:30' THEN 1 ELSE 0 END) AS bars_since_fix,
           SUM(CASE WHEN barStart >= '2026-09-22 13:30' AND sourceIntervalSec IS NOT NULL
                    THEN 1 ELSE 0 END) AS since_fix_declared,
           MAX(barStart) AS last_bar
      FROM PriceBars
     WHERE userId = @userId AND timeframe = '1h'
     GROUP BY venue ORDER BY COUNT(*) DESC`);
  console.log('  ' + pad('venue', 20) + lpad('bars', 8) + lpad('null', 8) + lpad('=3600', 8)
    + lpad('=1800', 8) + lpad('other', 7) + lpad('new', 7) + lpad('new+decl', 10) + '   last bar');
  for (const r of prov.recordset) {
    const newest = r.since_fix_declared > 0 ? '  <-- DECLARING' : (r.bars_since_fix > 0 ? '  <-- WROTE BARS, NO PROVENANCE' : '');
    console.log('  ' + pad(r.venue, 20) + lpad(r.bars, 8) + lpad(r.src_null, 8) + lpad(r.src_3600, 8)
      + lpad(r.src_1800, 8) + lpad(r.src_other, 7) + lpad(r.bars_since_fix, 7) + lpad(r.since_fix_declared, 10)
      + '   ' + (r.last_bar ? new Date(r.last_bar).toISOString().slice(0, 16) : '—') + newest);
  }
  console.log('  (a row written BEFORE 043 keeps NULL — honest, not a gap. Watch `new+decl` > 0.)');

  // ── 1-4. Range fidelity, containment, basis, and hour profile ─────────────────────────────────────
  console.log('\n=== 1. mean 1h range by venue — is the tick series the outlier? ===');
  console.log('  ' + pad('symbol', 22) + lpad('bar/tick', 9) + lpad('tick rng', 10) + lpad('tick bps', 9)
    + lpad('bars/chart', 11) + lpad('chart rng', 10) + lpad('chart bps', 10) + lpad('ratio', 7)
    + lpad('yahoo rng', 10));
  const series = new Map();
  for (const symbol of SYMBOLS) {
    const s = {};
    for (const venue of ['plus500', 'plus500_chart', 'yahoo']) {
      s[venue] = await store.listBars(USER_ID, { timeframe: '1h', symbol, venue, limit: 2000 });
    }
    series.set(symbol, s);
    const t = s.plus500, c = s.plus500_chart, y = s.yahoo;
    const tr = mean(t.map(rangeOf)), cr = mean(c.map(rangeOf)), yr = mean(y.map(rangeOf));
    const tp = mean(t.map((b) => Number(b.closePrice))) || 1;
    const cp = mean(c.map((b) => Number(b.closePrice))) || 1;
    console.log('  ' + pad(symbol, 22) + lpad(t.length, 9) + lpad(f(tr, 3), 10)
      + lpad(f((tr / tp) * 10000, 1), 9) + lpad(c.length, 11) + lpad(f(cr, 3), 10)
      + lpad(f((cr / cp) * 10000, 1), 10) + lpad(tr ? f(cr / tr, 2) : '—', 7) + lpad(f(yr, 3), 10));
  }

  console.log('\n=== 1b. THE FAIR COMPARISON — mean 1h range over the SAME HOURS ONLY ===');
  console.log('  Section 1 compares windows of different lengths, which makes the third-party figure')
  console.log('  window-dependent. This restricts all three venues to the hours the TWO BROKER venues share.')
  console.log('  ' + pad('symbol', 22) + lpad('hours', 7) + lpad('tick bps', 9) + lpad('chart bps', 10)
    + lpad('yahoo bps', 10) + lpad('chart/tick', 11) + lpad('yahoo/tick', 11) + lpad('yahoo/chart', 12));
  for (const symbol of SYMBOLS) {
    const s = series.get(symbol);
    const tByHour = new Map(s.plus500.map((b) => [key(b), b]));
    const yByHour = new Map(s.yahoo.map((b) => [key(b), b]));
    const rows = s.plus500_chart
      .map((c) => ({ c, t: tByHour.get(key(c)), y: yByHour.get(key(c)) }))
      .filter((p) => p.t);
    if (rows.length < 10) { console.log('  ' + pad(symbol, 22) + '  (too few shared hours)'); continue; }
    const px = mean(rows.map((p) => Number(p.c.closePrice))) || 1;
    // Per venue, over the SAME hour set. yahoo is averaged only over the subset it also has, and that
    // subset size is printed so a thin third opinion cannot masquerade as a broad one.
    const ySubset = rows.filter((p) => p.y);
    const rb = (sel) => (mean(rows.map((p) => sel(p))) / px) * 10000;
    const tickBps = rb((p) => Number(p.t.high) - Number(p.t.low));
    const chartBps = rb((p) => Number(p.c.high) - Number(p.c.low));
    const yahooBps = ySubset.length >= 10 ? (mean(ySubset.map((p) => Number(p.y.high) - Number(p.y.low))) / px) * 10000 : null;
    console.log('  ' + pad(symbol, 22) + lpad(rows.length, 7) + lpad(f(tickBps, 1), 9) + lpad(f(chartBps, 1), 10)
      + lpad(yahooBps == null ? '—' : f(yahooBps, 1), 10)
      + lpad(chartBps && tickBps ? f(chartBps / tickBps, 2) : '—', 11)
      + lpad(yahooBps && tickBps ? f(yahooBps / tickBps, 2) : '—', 11)
      + lpad(yahooBps && chartBps ? f(yahooBps / chartBps, 2) : '—', 12)
      + (ySubset.length < 10 ? `   (yahoo on ${ySubset.length}h only)` : ''));
  }

  console.log('\n=== 2. CONTAINMENT: for overlapping hours, is the tick high BELOW the chart high? ===');
  console.log('  A sampling explanation predicts "yes" almost always. A different-price explanation predicts ~50%.');
  console.log('  ' + pad('symbol', 22) + lpad('hours', 7) + lpad('high<tick', 11) + lpad('low>tick', 11)
    + lpad('mean hiGap', 12) + lpad('as bps', 8) + lpad('mean loGap', 12) + lpad('as bps', 8));
  const hourProfiles = new Map();
  for (const symbol of SYMBOLS) {
    const s = series.get(symbol);
    const tByHour = new Map(s.plus500.map((b) => [key(b), b]));
    const pairs = s.plus500_chart
      .map((c) => ({ c, t: tByHour.get(key(c)) }))
      .filter((p) => p.t);
    if (!pairs.length) { console.log('  ' + pad(symbol, 22) + '  (no overlapping hours)'); continue; }
    const hiGaps = pairs.map((p) => Number(p.c.high) - Number(p.t.high));   // >0 => tick understated
    const loGaps = pairs.map((p) => Number(p.t.low) - Number(p.c.low));    // >0 => tick understated
    const px = mean(pairs.map((p) => Number(p.c.closePrice))) || 1;
    const hiBelow = hiGaps.filter((g) => g > 0).length / pairs.length;
    const loAbove = loGaps.filter((g) => g > 0).length / pairs.length;
    console.log('  ' + pad(symbol, 22) + lpad(pairs.length, 7) + lpad(pct(hiBelow), 11) + lpad(pct(loAbove), 11)
      + lpad(f(mean(hiGaps), 3), 12) + lpad(f((mean(hiGaps) / px) * 10000, 1), 8)
      + lpad(f(mean(loGaps), 3), 12) + lpad(f((mean(loGaps) / px) * 10000, 1), 8));

    // Per-hour shortfall, for the S2 activity-measure denominator question.
    const byHour = new Map();
    for (const p of pairs) {
      const h = new Date(p.c.barStart).getUTCHours();
      if (!byHour.has(h)) byHour.set(h, []);
      byHour.get(h).push(Number(p.c.high) - Number(p.t.high));
    }
    hourProfiles.set(symbol, new Map([...byHour].map(([h, v]) => [h, mean(v) / px * 10000])));
  }

  console.log('\n=== 3. BASIS: same-hour CLOSE difference (chart − tick), signed. Offset or noise? ===');
  console.log('  A mean near 0 with a balanced sign split = one price seen twice. A lopsided mean = two prices.');
  console.log('  ' + pad('symbol', 22) + lpad('hours', 7) + lpad('mean bps', 10) + lpad('median', 9)
    + lpad('sd bps', 9) + lpad('chart>tick', 12) + lpad('|mean|/sd', 10));
  for (const symbol of SYMBOLS) {
    const s = series.get(symbol);
    const tByHour = new Map(s.plus500.map((b) => [key(b), b]));
    const pairs = s.plus500_chart.map((c) => ({ c, t: tByHour.get(key(c)) })).filter((p) => p.t);
    if (pairs.length < 5) continue;
    const bps = pairs.map((p) => ((Number(p.c.closePrice) - Number(p.t.closePrice)) / Number(p.t.closePrice)) * 10000);
    const m = mean(bps), sd = Math.sqrt(mean(bps.map((v) => (v - m) ** 2)));
    const above = bps.filter((v) => v > 0).length / bps.length;
    console.log('  ' + pad(symbol, 22) + lpad(pairs.length, 7) + lpad(f(m, 2), 10) + lpad(f(median(bps), 2), 9)
      + lpad(f(sd, 2), 9) + lpad(pct(above), 12) + lpad(sd ? f(Math.abs(m) / sd, 2) : '—', 10));
  }

  console.log('\n=== 4. DOES THE UNDERSTATEMENT VARY BY HOUR? (S2 activity measure: a constant cancels in a ratio) ===');
  console.log('  ' + pad('symbol', 22) + lpad('hours w/ data', 14) + lpad('min bps', 9) + lpad('max bps', 9)
    + lpad('mean bps', 10) + lpad('spread', 8));
  for (const [symbol, prof] of hourProfiles) {
    const vals = [...prof.values()].filter((v) => Number.isFinite(v));
    if (vals.length < 4) continue;
    console.log('  ' + pad(symbol, 22) + lpad(vals.length, 14) + lpad(f(Math.min(...vals), 1), 9)
      + lpad(f(Math.max(...vals), 1), 9) + lpad(f(mean(vals), 1), 10)
      + lpad(f(Math.max(...vals) - Math.min(...vals), 1), 8));
  }

  console.log('\n=== 5. depth: does the CHART series clear minBars (60) everywhere the tick series does not? ===');
  const depth = await pool.request().input('userId', sql.Int, USER_ID).query(`
    SELECT symbol,
           SUM(CASE WHEN venue = 'plus500' THEN 1 ELSE 0 END) AS tick_bars,
           SUM(CASE WHEN venue = 'plus500_chart' THEN 1 ELSE 0 END) AS chart_bars
      FROM PriceBars
     WHERE userId = @userId AND timeframe = '1h' AND flagged = 0
       AND venue IN ('plus500','plus500_chart')
     GROUP BY symbol ORDER BY SUM(CASE WHEN venue = 'plus500' THEN 1 ELSE 0 END) ASC`);
  const tickShort = depth.recordset.filter((r) => r.tick_bars < 60);
  console.log(`  symbols tracked on both venues: ${depth.recordset.length}`);
  console.log(`  tick series < 60 bars (below MIN_BARS): ${tickShort.length}`);
  console.log(`  of those, chart series >= 60 bars: ${tickShort.filter((r) => r.chart_bars >= 60).length}`);
  for (const r of tickShort.slice(0, 12)) {
    console.log(`    ${pad(r.symbol, 24)} tick=${lpad(r.tick_bars, 5)}  chart=${lpad(r.chart_bars, 5)}`
      + (r.chart_bars >= 60 ? '   <- chart rescues it' : '   <- both thin'));
  }

  console.log('\n=== 6. THE DISCRIMINATING TEST: if the tick series is a SAMPLE, its shortfall must SHRINK as the hour holds more ticks ===');
  console.log('  Hours bucketed by how many ticks the desk actually captured in them. The sampling hypothesis makes a');
  console.log('  falsifiable prediction: tick range / chart range must rise toward 1.0 with more ticks. If the ratio');
  console.log('  stays flat, the two series differ in KIND and sampling is not the explanation.');
  console.log('  ' + pad('symbol', 22) + pad('bucket', 12) + lpad('hours', 7) + lpad('tick rng', 10)
    + lpad('chart rng', 10) + lpad('ratio', 7) + lpad('tick hi<', 9));
  for (const symbol of SYMBOLS) {
    const s = series.get(symbol);
    const tByHour = new Map(s.plus500.map((b) => [key(b), b]));
    const pairs = s.plus500_chart.map((c) => ({ c, t: tByHour.get(key(c)) })).filter((p) => p.t);
    if (pairs.length < 20) continue;
    // Tick count per hour, straight from the tick table — the bar's `volume` for the tick venue IS that
    // count (mean ~12), which is the very field §4.1 calls a capture quantity rather than a market one.
    const buckets = [[1, 2], [3, 5], [6, 9], [10, 999]];
    for (const [lo, hi] of buckets) {
      const inB = pairs.filter((p) => {
        const n = Number(p.t.volume) || 0;
        return n >= lo && n <= hi;
      });
      if (inB.length < 3) continue;
      const tr = mean(inB.map((p) => Number(p.t.high) - Number(p.t.low)));
      const cr = mean(inB.map((p) => Number(p.c.high) - Number(p.c.low)));
      const below = inB.filter((p) => Number(p.t.high) < Number(p.c.high)).length / inB.length;
      console.log('  ' + pad(symbol, 22) + pad(`${lo}-${hi === 999 ? '+' : hi} ticks`, 12) + lpad(inB.length, 7)
        + lpad(f(tr, 4), 10) + lpad(f(cr, 4), 10) + lpad(cr ? f(tr / cr, 2) : '—', 7) + lpad(pct(below), 9));
    }
  }

  await pool.close();
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
