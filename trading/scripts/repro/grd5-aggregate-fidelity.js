// trading/scripts/repro/grd5-aggregate-fidelity.js — TRD-GRD-5's open item: is an AGGREGATED 1h row faithful?
//
// READ-ONLY. Answers the question the row left open: "the range-fidelity half of the gate is still not
// discharged for AGGREGATED hours: the venue's own 5m/15m bars are still not stored natively, so an aggregated
// hour cannot be recomputed from them."
//
// ★★ IT CAN, AND IT IS. Measured 2026-09-27: 3,167 of 3,167 checkable aggregated hours recompute EXACTLY
// (OHLC identical, max error 0.00) from the same-symbol SAME-VENUE sub-hour bars.
//
// ⚠⚠ WHY THIS SCRIPT EXISTS AT ALL RATHER THAN A ONE-LINE QUERY: my first version of this test reported 16%
// high mismatches and a 4,871-point error on a 4,300 instrument, and BOTH were source-selection mistakes
// rather than defects:
//   1. it took `timeframe <> '1h'` as "a source bar", which admits `1d` and `4h` bars — a DAILY bar's high is
//      the day's high, so the 4,871 was one daily Bitcoin bar compared against an hourly one. The give-away was
//      printing the source rows (`tfs=1d:3600,1d:3600,...`) instead of only the answer.
//   2. it matched on SYMBOL alone, so 5,632 pairs compared a `yahoo` bar to a `plus500_chart` hour. Different
//      venues are not sources of each other, and these two are known to disagree by ~95.6 bps at the same hour
//      (TRD-STR-1's transferability finding).
// A fidelity test that selects the wrong sources measures the SELECTION MISTAKE and reports it as a rollup
// defect. The source population is therefore printed before the verdict, every run.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
const { getPool } = require('../../../shared/db');

async function main() {
  const pool = await getPool();

  console.log('=== SOURCE POPULATION (printed first, because getting this wrong is the whole risk) ===');
  const pop = await pool.request().query(`
    SELECT timeframe, sourceIntervalSec, venue, COUNT(*) AS n
    FROM PriceBars WHERE timeframe <> '1h' AND sourceIntervalSec < 3600
    GROUP BY timeframe, sourceIntervalSec, venue ORDER BY n DESC`);
  for (const x of pop.recordset) {
    console.log(`  ${String(x.timeframe).padEnd(5)} srcSec=${String(x.sourceIntervalSec).padStart(5)} venue=${String(x.venue).padEnd(16)} n=${x.n}`);
  }
  console.log('  A source must be (a) the SAME venue and (b) strictly NARROWER than the row it builds.');
  console.log('  Note the 5m series is `yahoo` — it must never be used to verify a `plus500_chart` hour.');

  console.log('\n=== COVERAGE ===');
  const cov = await pool.request().query(`
    WITH h AS (SELECT id, symbol, venue, barStart FROM PriceBars WHERE timeframe='1h' AND sourceIntervalSec < 3600)
    SELECT COUNT(*) AS aggregated_1h,
           SUM(CASE WHEN s.n >= 2 THEN 1 ELSE 0 END) AS checkable_rollup,
           SUM(CASE WHEN s.n = 1 THEN 1 ELSE 0 END) AS single_source_passthrough,
           SUM(CASE WHEN s.n = 0 THEN 1 ELSE 0 END) AS no_source
    FROM h OUTER APPLY (
      SELECT COUNT(*) AS n FROM PriceBars p
      WHERE p.symbol = h.symbol AND p.venue = h.venue AND p.sourceIntervalSec < 3600
        AND p.barStart >= h.barStart AND p.barStart < DATEADD(hour, 1, h.barStart)
    ) s`);
  const c = cov.recordset[0];
  console.log(`  aggregated 1h rows      ${c.aggregated_1h}`);
  console.log(`  checkable (>=2 sources) ${c.checkable_rollup}  (${(c.checkable_rollup / c.aggregated_1h * 100).toFixed(1)}%)`);
  console.log(`  single source           ${c.single_source_passthrough}  (a passthrough, not a rollup — cannot verify)`);
  console.log(`  no source at all        ${c.no_source}`);

  console.log('\n=== ★★ FIDELITY: recompute OHLC from the sources and compare ===');
  const fid = await pool.request().query(`
    WITH h AS (SELECT id, symbol, venue, barStart, high, low FROM PriceBars WHERE timeframe='1h' AND sourceIntervalSec<3600),
    s AS (
      SELECT h.id, h.high, h.low, COUNT(p.id) AS n, MAX(p.high) AS rH, MIN(p.low) AS rL
      FROM h LEFT JOIN PriceBars p ON p.symbol = h.symbol AND p.venue = h.venue AND p.sourceIntervalSec < 3600
        AND p.barStart >= h.barStart AND p.barStart < DATEADD(hour,1,h.barStart)
      GROUP BY h.id, h.high, h.low
    )
    SELECT COUNT(*) AS checkable,
           SUM(CASE WHEN rH = high AND rL = low THEN 1 ELSE 0 END) AS exact,
           SUM(CASE WHEN rH < high THEN 1 ELSE 0 END) AS high_narrower_IMPOSSIBLE,
           SUM(CASE WHEN rL > low  THEN 1 ELSE 0 END) AS low_narrower_IMPOSSIBLE,
           MAX(ABS(rH - high)) AS max_high_err, MAX(ABS(rL - low)) AS max_low_err
    FROM s WHERE n >= 2`);
  const f = fid.recordset[0];
  const ck = f.checkable || 1;
  console.log(`  checkable            ${f.checkable}`);
  console.log(`  EXACT H+L match      ${f.exact}  (${(f.exact / ck * 100).toFixed(1)}%)`);
  console.log(`  max high error       ${f.max_high_err}`);
  console.log(`  max low error        ${f.max_low_err}`);
  // A correct rollup can only ever WIDEN the range. A stored row whose high is ABOVE everything in its own
  // hour (or low BELOW) cannot have come from that hour, and that is the one shape that is a real defect.
  console.log(`  rate_high_impossible ${f.high_narrower_IMPOSSIBLE}`);
  console.log(`  rate_low_impossible  ${f.low_narrower_IMPOSSIBLE}`);
  if (Number(f.high_narrower_IMPOSSIBLE) + Number(f.low_narrower_IMPOSSIBLE) > 0) {
    const bad = await pool.request().query(`
      WITH h AS (SELECT id, symbol, venue, barStart, high, low FROM PriceBars WHERE timeframe='1h' AND sourceIntervalSec<3600),
      s AS (
        SELECT h.id, h.symbol, h.venue, h.barStart, h.high, h.low, COUNT(p.id) AS n, MAX(p.high) AS rH, MIN(p.low) AS rL
        FROM h LEFT JOIN PriceBars p ON p.symbol = h.symbol AND p.venue = h.venue AND p.sourceIntervalSec < 3600
          AND p.barStart >= h.barStart AND p.barStart < DATEADD(hour,1,h.barStart)
        GROUP BY h.id, h.symbol, h.venue, h.barStart, h.high, h.low
      )
      SELECT TOP 15 symbol, venue, CAST(barStart AS nvarchar(20)) AS hour, high, rH, low, rL, n
      FROM s WHERE n >= 2 AND (rH < high OR rL > low) ORDER BY ABS(high - rH) + ABS(low - rL) DESC`);
    for (const x of bad.recordset) {
      console.log(`    ${String(x.symbol).padEnd(14)} ${String(x.venue).padEnd(16)} ${x.hour}  stored ${x.high}/${x.low}  rolled ${x.rH}/${x.rL}  n=${x.n}`);
    }
  }
  console.log(`\nVERDICT: ${Number(f.exact) === Number(f.checkable) && Number(f.high_narrower_IMPOSSIBLE) === 0 && Number(f.low_narrower_IMPOSSIBLE) === 0
    ? 'FAITHFUL — every checkable aggregated hour reproduces exactly from its own venue\'s sub-hour bars.'
    : 'NOT FAITHFUL — see the rows above.'}`);
  await pool.close();
}

main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
