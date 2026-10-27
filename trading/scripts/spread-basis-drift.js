'use strict';
// trading/scripts/spread-basis-drift.js — the maintenance half of the cost table.
//
// The curated spread table is what the desk charges, floors its stop cap on, and tells the chairs about. Nothing
// re-checked it, so two entries had drifted (Silver 1.27x, Sugar 0.88x, measured 2026-10-27). This asks the desk's
// own fills whether each entry is still true.
//
// ⚠ NO BROWSER, NO PAGE LOCK, NO `ticket` LOCK. The comparison comes from `Trades.spreadSubmitPct`, which the desk
// writes on every entry (`executor.js:587-600`). That is why this is safe to run at any hour: it reads SQL and
// nothing else. `server.js:449` states the same thing about why the probe is not the spread source.
//
// Usage: node trading/scripts/spread-basis-drift.js [--json]
// Exit:  0 = every compared symbol within tolerance · 1 = at least one drift · 2 = could not read the fills
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getPool } = require('../db');
const bt = require('../agent/backtest');
const { driftVerdict, actionable } = require('../agent/spreadBasisDrift');

const USER = 1;

(async () => {
  const pool = await getPool();
  let rows;
  try {
    const r = await pool.request()
      .input('u', require('../db').sql.Int, USER)
      .query(`SELECT DISTINCT symbol,
                     COUNT(*) OVER (PARTITION BY symbol) AS n,
                     CAST(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY spreadSubmitPct)
                          OVER (PARTITION BY symbol) AS DECIMAL(18,6)) AS medianRoundTrip
                FROM Trades
               WHERE userId = @u AND spreadSubmitPct IS NOT NULL`);
    rows = r.recordset || [];
  } catch (e) {
    console.error('COULD NOT READ THE FILLS:', (e && e.message) || e);
    console.error('This is a named failure, not "no drift" — the comparison did not run.');
    process.exit(2);
  }

  const measured = new Map(rows.map((r) => [r.symbol, { n: Number(r.n), median: Number(r.medianRoundTrip) }]));
  const curated = bt.CALIBRATED_SPREAD_HALF_PCT || {};
  // The union, so a curated entry with no fills is reported as UNMEASURED rather than quietly absent.
  const symbols = [...new Set([...Object.keys(curated), ...measured.keys()])].sort();

  const results = symbols.map((symbol) => {
    const m = measured.get(symbol) || { n: 0, median: null };
    const cfg = bt.costCfgFor(symbol);
    return {
      ...driftVerdict({
        symbol,
        curatedHalfPct: curated[symbol] != null ? curated[symbol] : (cfg.cfdSpreadPct != null ? cfg.cfdSpreadPct : null),
        measuredRoundTripPct: m.median,
        n: m.n,
      }),
      basis: cfg.costModelBasis ? cfg.costModelBasis.spread : null,
      inTable: curated[symbol] != null,
    };
  });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: actionable(results).length === 0, results }, null, 2));
    process.exit(actionable(results).length ? 1 : 0);
  }

  console.log('=== CURATED COST SPREAD vs THE VENUE\'S OWN SUBMIT LABELS ===');
  console.log('unit: both columns are PERCENT; curated is HALF-spread per side, measured is a ROUND TRIP, so the');
  console.log('      comparison is curated x 2 (see agent/spreadBasisDrift.js for why that is not optional)\n');
  console.log('symbol'.padEnd(18), 'n'.padStart(3), 'curatedRT'.padStart(10), 'measured'.padStart(10), 'ratio'.padStart(7), '  verdict');
  for (const r of results) {
    const cur = r.curatedRoundTripPct != null ? r.curatedRoundTripPct.toFixed(6) : (r.curatedHalfPct != null ? (r.curatedHalfPct * 2).toFixed(6) : 'n/a');
    const mea = r.measuredRoundTripPct != null ? r.measuredRoundTripPct.toFixed(6) : 'n/a';
    console.log(
      String(r.symbol).slice(0, 17).padEnd(18),
      String(r.n).padStart(3),
      String(cur).padStart(10),
      String(mea).padStart(10),
      String(r.ratio != null ? r.ratio.toFixed(3) : 'n/a').padStart(7),
      ` ${r.verdict}${r.driftPct != null ? ` (${r.driftPct > 0 ? '+' : ''}${r.driftPct}%)` : ''}${r.inTable ? '' : ' [not in table]'}`,
    );
  }

  const drift = actionable(results);
  const unmeasured = results.filter((r) => r.verdict === 'insufficient_sample');
  console.log(`\n${results.length} symbols · ${results.length - drift.length - unmeasured.length} agree · ${drift.length} drift · ${unmeasured.length} insufficient sample`);
  if (drift.length) {
    console.log('\nDRIFT — the table is what the desk charges, so these are wrong costs, not a curiosity:');
    for (const d of drift) console.log(`  ${d.symbol}: curated ${d.curatedRoundTripPct}% vs venue ${d.measuredRoundTripPct}% over n=${d.n} (${d.driftPct > 0 ? '+' : ''}${d.driftPct}%)`);
  }
  if (unmeasured.length) {
    console.log('\nINSUFFICIENT SAMPLE — NOT agreement; these were not judged:');
    for (const u of unmeasured) console.log(`  ${u.symbol}: n=${u.n} (need ${u.minSample})`);
  }
  process.exit(drift.length ? 1 : 0);
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exit(2); });
