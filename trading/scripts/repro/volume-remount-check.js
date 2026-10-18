// trading/scripts/repro/volume-remount-check.js
//
// READ-ONLY. The §10 Q5 item: `plus500_chart`.volume stopped being written around
// 2026-09-11..15 and stayed zero. The surviving reading was NOT "the feed changed"
// but "the Volume study was un-mounted on the desk's chart profiles, so
// capture.bankChartBars read an absent study and wrote 0".
//
// The owner has now re-mounted the Volume study on /trade (seen on Gold). That gives
// two opposite, both-observable predictions:
//
//   (1) RE-MOUNT  -> plus500_chart volume returns to non-zero for the symbols whose
//                    chart profiles were fixed, and the resume is STEPPED (it starts
//                    at the re-mount time), not a smooth continuation.
//   (2) FEED      -> volume stays zero everywhere for every symbol; nothing resumes.
//
// A stepped resume at a single timestamp is decisive for (1). This script looks for
// that step. It does NOT touch the desk or write anything.
//
// Usage (from the repo root): node trading/scripts/repro/volume-remount-check.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');

const USER_ID = Number(process.argv[2]) || 1;

const pad = (s, n) => String(s ?? '').padEnd(n);
const lpad = (s, n) => String(s ?? '').padStart(n);
const num = (v, dp = 0) => (v == null ? '—' : Number(v).toFixed(dp));
const stamp = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : '—');

async function main() {
  const pool = await getPool();
  const q = (text, extra) => {
    let req = pool.request().input('userId', sql.Int, USER_ID);
    for (const [k, v] of Object.entries(extra || {})) req = req.input(k, sql.NVarChar, v);
    return req.query(text);
  };

  // ── 1. Gold: the symbol the owner says now shows a volume chart ───────────
  // Scoped to the two BROKER venues and the recent window. Yahoo's history goes back
  // years and drowned this the first time — and Yahoo volume is a real market quantity
  // anyway, so it is not the question.
  console.log('\n=== 1. GOLD — broker venues only, per-day volume (1h bars), last 8 days ===');
  const gold = await q(`
    SELECT venue, CAST(barStart AS DATE) AS d,
           COUNT(*) AS bars,
           SUM(CASE WHEN volume IS NULL THEN 1 ELSE 0 END) AS v_null,
           SUM(CASE WHEN volume = 0 THEN 1 ELSE 0 END) AS v_zero,
           SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) AS v_pos,
           MAX(volume) AS v_max
      FROM PriceBars
     WHERE userId = @userId AND timeframe = '1h' AND symbol LIKE '%Gold%'
       AND venue IN ('plus500','plus500_chart')
       AND barStart >= '2026-09-14'
     GROUP BY venue, CAST(barStart AS DATE)
     ORDER BY d DESC, venue`);
  if (!gold.recordset.length) console.log('  (no rows)');
  console.log('  ' + pad('venue', 16) + pad('day', 12) + lpad('bars', 6)
    + lpad('null', 7) + lpad('zero', 7) + lpad('>0', 6) + lpad('max', 10));
  for (const r of gold.recordset) {
    console.log('  ' + pad(r.venue, 16) + pad(stamp(r.d).slice(0, 10), 12) + lpad(r.bars, 6)
      + lpad(r.v_null, 7) + lpad(r.v_zero, 7) + lpad(r.v_pos, 6) + lpad(num(r.v_max, 2), 10));
  }

  // ── 1b. THE DECISIVE ROW — Gold's NEWEST bar on each broker venue, and its volume.
  // A re-mount cannot be observed before a capture has run against the fixed chart, so
  // the question is whether the newest plus500_chart bar is still volume=0.
  console.log('\n=== 1b. GOLD — newest broker bars (the read that settles the re-mount) ===');
  const newest = await q(`
    SELECT TOP 12 venue, symbol, timeframe, barStart, openPrice, high, low, closePrice, volume
      FROM PriceBars
     WHERE userId = @userId AND symbol LIKE '%Gold%'
       AND venue IN ('plus500','plus500_chart')
     ORDER BY barStart DESC, venue`);
  console.log('  ' + pad('venue', 16) + pad('barStart', 18) + lpad('high', 10) + lpad('low', 10)
    + lpad('volume', 10) + pad('  flag', 8));
  for (const r of newest.recordset) {
    console.log('  ' + pad(r.venue, 16) + pad(stamp(r.barStart), 18) + lpad(num(r.high, 4), 10)
      + lpad(num(r.low, 4), 10) + lpad(num(r.volume, 2), 10)
      + (Number(r.volume) === 0 ? '  <-- ZERO' : '  ok'));
  }

  // ── 2. THE STEP DETECTOR — does ANY symbol resume non-zero volume, and when ──
  // If the cause is a re-mount, the first non-zero bar after the dead window is a
  // single date band across the fixed symbols. If the feed changed, this is empty.
  console.log('\n=== 2. STEP DETECTOR — last non-zero-volume bar per symbol, plus500_chart ===');
  const step = await q(`
    SELECT symbol,
           MAX(CASE WHEN volume > 0 THEN barStart END) AS last_vol,
           MAX(barStart) AS last_bar,
           SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) AS vol_bars,
           COUNT(*) AS bars
      FROM PriceBars
     WHERE userId = @userId AND timeframe = '1h' AND venue = 'plus500_chart'
     GROUP BY symbol
     ORDER BY MAX(CASE WHEN volume > 0 THEN barStart END) DESC, symbol`);
  console.log('  ' + pad('symbol', 22) + pad('last >0 vol bar', 18) + pad('last bar', 18)
    + lpad('vol bars', 9) + lpad('/ total', 9));
  for (const r of step.recordset) {
    console.log('  ' + pad(r.symbol, 22) + pad(stamp(r.last_vol), 18) + pad(stamp(r.last_bar), 18)
      + lpad(r.vol_bars, 9) + lpad('/' + r.bars, 9));
  }

  // ── 3. Is the resume STEPPED (one date) or SMOOTH (the feed came back)? ───
  // Distinct first-non-zero dates across symbols. One date band = a mount event.
  console.log('\n=== 3. FIRST non-zero-volume bar per symbol, since 2026-09-16 (post-dead-window) ===');
  const resume = await q(`
    SELECT symbol, MIN(barStart) AS first_vol
      FROM PriceBars
     WHERE userId = @userId AND timeframe = '1h' AND venue = 'plus500_chart'
       AND volume > 0 AND barStart >= '2026-09-16'
     GROUP BY symbol
     ORDER BY MIN(barStart), symbol`);
  if (!resume.recordset.length) {
    console.log('  (NOTHING has resumed non-zero volume since 2026-09-16 — prediction (2): the feed)');
  } else {
    for (const r of resume.recordset) console.log('  ' + pad(r.symbol, 22) + stamp(r.first_vol));
    const dates = new Set(resume.recordset.map((r) => stamp(r.first_vol).slice(0, 10)));
    console.log(`  -> distinct resume dates: ${[...dates].join(', ')} ` +
      `(${dates.size === 1 ? 'A STEP — one mount event' : 'spread — evaluate per symbol'})`);
  }

  // ── 4. The interval defect, in the same breath: bar cadence on plus500_chart ──
  // tfMap maps BOTH 1800 and 3600 to '1h', so a 30-minute chart stores two bars per
  // '1h' bucket and PriceBars cannot tell them apart. A gap distribution that is
  // heavily 30-minute on some symbols is that defect, visible from here.
  console.log('\n=== 4. bar-start spacing (minutes) per symbol — a 30m chart stored as 1h shows gaps of 30 ===');
  const gaps = await q(`
    WITH s AS (
      SELECT symbol, barStart,
             DATEDIFF(MINUTE, LAG(barStart) OVER (PARTITION BY symbol ORDER BY barStart), barStart) AS gap
        FROM PriceBars
       WHERE userId = @userId AND timeframe = '1h' AND venue = 'plus500_chart'
         AND barStart >= '2026-09-16')
    SELECT symbol, COUNT(*) AS gaps,
           SUM(CASE WHEN gap = 30 THEN 1 ELSE 0 END) AS g30,
           SUM(CASE WHEN gap = 60 THEN 1 ELSE 0 END) AS g60,
           SUM(CASE WHEN gap > 60 AND gap <= 180 THEN 1 ELSE 0 END) AS g_gt60
      FROM s WHERE gap IS NOT NULL
     GROUP BY symbol ORDER BY SUM(CASE WHEN gap = 30 THEN 1 ELSE 0 END) DESC, symbol`);
  if (!gaps.recordset.length) console.log('  (no bars since 2026-09-16)');
  console.log('  ' + pad('symbol', 22) + lpad('gaps', 6) + lpad('=30m', 7) + lpad('=60m', 7) + lpad('>60m', 7));
  for (const r of gaps.recordset) {
    const flag = r.g30 > 0 ? `   <-- ${Math.round((100 * r.g30) / (r.g30 + r.g60))}% of clean gaps are 30m` : '';
    console.log('  ' + pad(r.symbol, 22) + lpad(r.gaps, 6) + lpad(r.g30, 7) + lpad(r.g60, 7)
      + lpad(r.g_gt60, 7) + flag);
  }

  await pool.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
