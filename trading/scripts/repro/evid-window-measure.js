// trading/scripts/repro/evid-window-measure.js — READ-ONLY. TRD-EVD-1's blocker, measured rather than asserted.
//
// The claim to test: `lab/scoreboard.js` `loadLabSeries` hard-codes `range: '1y'`, and the walk-forward
// windows are FRACTIONS of whatever series is loaded (`walkforward.WINDOWS`: A 0.6-0.8, B 0.8-0.9,
// LOCKBOX 0.9-1.0). So the lockbox trade count scales with the series length, and a short series can leave
// W4 below the desk's n>=20 floor — in which case `releaseAll` writes verdict INSUFFICIENT-DATA and the
// lockbox can NEVER return a p-value, no matter how many times it is run.
//
// The lever under test is (i) DEEPEN THE WINDOW: `range: '1y'` -> `range: null`. `backtest.loadSeries`
// loads up to 12,000 bars from the DB first in BOTH cases, so `null` returns the full stored history
// rather than triggering a fresh download (with refreshData:false nothing is written or fetched).
//
// Nothing here writes. No release is made. `releaseAll` is NOT called — spending the family's out-of-sample
// window is not a measurement, it is the act the pre-registration exists to precede.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');
const backtest = require('../../agent/backtest');
const strategies = require('../../agent/strategies');
const wf = require('../../agent/lab/walkforward');
const { seedFor } = require('../../agent/lab/scoreboard');

const USER = 1;
const SYMBOL = 'Gold';
const VENUE = 'yahoo';
const TF = '1h';
// The registered S3 pair's own number, so the seed matches what a real release would use.
const REGISTRATION_NO = 372;
const CANDIDATES = [
  { id: 'survgold', role: 'control (ungated)' },
  { id: 'survgoldstruct', role: 'gated (S3)' },
];
const RANGES = [
  { key: '1y', label: "range '1y'  (what loadLabSeries uses)" },
  { key: null, label: 'range null   (full stored history)' },
];

function pad(s, n) { return String(s).padEnd(n); }
function lpad(s, n) { return String(s).padStart(n); }

async function main() {
  await getPool();
  console.log(`TRD-EVD-1 window measurement — ${VENUE}/${SYMBOL}/${TF}, seed for registrationNo ${REGISTRATION_NO}`);
  console.log(`walkforward.WINDOWS = ${JSON.stringify(wf.WINDOWS)}\n`);

  for (const r of RANGES) {
    const loaded = await backtest.loadSeries(USER, {
      symbol: SYMBOL, venue: VENUE, timeframe: TF, range: r.key, refreshData: false,
    });
    if (loaded.error) { console.log(`\n=== ${r.label} ===\n  ERROR: ${loaded.error}`); continue; }

    const n = loaded.series.length;
    const w = (s) => {
      const idx = wf.windowIndices(n, s);
      return idx ? `${idx.start}-${idx.end}` : '—';
    };
    console.log(`\n=== ${r.label} ===`);
    console.log(`  bars ${n}   span ${loaded.spanDays} d   ${loaded.rangeNote ? `NOTE: ${loaded.rangeNote}` : 'no range note'}`);
    console.log(`  window indices  A ${w('A')}   B ${w('B')}   LOCKBOX ${w('LOCKBOX')}  (last 10% = ${Math.round(n * 0.1)} bars)`);

    for (const c of CANDIDATES) {
      const strat = strategies.get(c.id);
      if (!strat || !strat.backtest) { console.log(`  ${c.id}: no backtest`); continue; }
      const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor(SYMBOL) };
      const stages = wf.runWalkForward({ series: loaded.series, strat, cfg, seed: seedFor(REGISTRATION_NO) });
      console.log(`\n  ${pad(c.id, 16)} ${c.role}`);
      console.log(`    ${pad('stage', 9)}${lpad('n', 6)}${lpad('pf', 9)}${lpad('p', 11)}${lpad('n>=20?', 9)}`);
      for (const s of ['A', 'B', 'LOCKBOX']) {
        const st = stages[s] || {};
        console.log(`    ${pad(s, 9)}${lpad(st.n ?? '—', 6)}${lpad(st.pf == null ? '—' : Number(st.pf).toFixed(3), 9)}`
          + `${lpad(st.p == null ? 'null' : Number(st.p).toFixed(5), 11)}${lpad(st.n >= 20 ? 'YES' : 'NO', 9)}`);
      }
      const lb = stages.LOCKBOX || {};
      if (lb.w4Split) {
        console.log(`    w4Split: ${JSON.stringify(lb.w4Split)}`);
      }
      // The verdict releaseAll would write, by its own rule (scoreboard.js line ~135).
      const verdict = lb.n == null ? '—'
        : lb.n < 20 ? 'INSUFFICIENT-DATA'
          : (lb.pf != null && lb.pf > 1 && lb.p != null && lb.p < 0.05 ? 'PASS (screen)' : 'FAIL');
      console.log(`    -> scoreboard's own rule would write: ${verdict}`);
    }
  }

  console.log('\n★ NO RELEASE WAS MADE. A release freezes the whole family and widens the BH correction');
  console.log('  for every frozen pair; that is an owner decision, not a measurement.');
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
