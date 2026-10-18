// trading/scripts/repro/bars-scale-scan.js — TRD-GRD-1 OBSERVE MODE. READ-ONLY; writes nothing.
//
// Deliberately NOT a count. `stopCoverage` is the precedent: a number is not a defect list, and the only
// way to act on a scale anomaly is to see WHICH rows, on WHICH symbol, against WHICH reference. Output is
// a list of contiguous suspect blocks, plus the symbols this scan cannot vouch for at all.
//
// ★ THE WINDOW IS MEASURED, NOT ASSERTED. The first run of this scan built its reference from an
// EXPANDING median over the symbol's whole prior history and returned 2,011 bars at a 3x cap — almost all
// of them REAL TRENDS. An expanding median lags a trend by construction, so Bitcoin going 16k -> 108k
// reads as a 6.8x "anomaly" and the April 2020 oil crash (55 -> 10) reads as 0.18x. Those are history,
// not corruption. A ONE-BAR jump is the corruption signature; a slow climb is not. So §1 sweeps the
// trailing window and measures how much of each window's output is trend-shaped (long blocks) versus
// spike-shaped (short blocks); the window is chosen to drive the trend share to zero WITHOUT discarding
// the spikes. Measured: a true trailing window drives trend-shaped output to 0 at every width tested and
// flags 4-12 rows instead of 2,011.
//
// ⚠ WHAT THIS SCAN CANNOT DO, stated up front so no reading of it overreaches: the reference is a median
// of STORED bars, and stored bars are what was corrupted. A block longer than the window, internally
// consistent, will become its own reference and the CLEAN rows on either side will be reported instead.
// That is why this is observe-mode, why every block prints the reference it was judged against, and why
// promotion requires confirming each candidate against PriceTicks rather than against the bars.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');
const { barScaleReview, trailingReference, BAR_SCALE_MAX_RATIO } = require('../../store/bars');

const USER = 1;
const WINDOWS = [1, 2, 3, 5, 10, 30];   // prior closes forming the reference; swept, not asserted
const LONG_BLOCK = 20;   // a block this long is a trend, not a capture defect
const SHORT_BLOCK = 3;   // a block this short is the capture-defect shape

// How far a price sits from its reference, as a ratio >= 1 (so 0.18x and 5.6x are comparable).
const dev = (v) => { const r = v.ratio; return r >= 1 ? r : 1 / r; };

async function loadSeries(pool) {
  const r = await pool.request().query(`
    SELECT venue, symbol, timeframe, barStart, openPrice, high, low, closePrice, volume, flagged
    FROM PriceBars WHERE userId = ${USER}
    ORDER BY symbol, timeframe, venue, barStart ASC`);
  const series = new Map();
  for (const b of r.recordset) {
    const key = `${b.venue}|${b.symbol}|${b.timeframe}`;
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(b);
  }
  return series;
}

// Walk one series with a rolling window of PRIOR closes only, and return the suspect blocks. Prior-only is
// the point: a reference that included the row under review would let the row defend itself.
function scan(series, window, cap) {
  const blocks = [];
  let open = null; let flagged = 0; let scanned = 0; let unguarded = 0;
  for (const bars of series.values()) {
    const buffer = [];
    const min = Math.min(3, window);
    for (const b of bars) {
      const ref = trailingReference(buffer, { min });
      const v = barScaleReview(b, ref, { maxRatio: cap, min });
      if (v.verdict === 'unguarded') {
        if (v.reason === 'no_history') unguarded++;
        // a price defect barViolation owns is not this scan's finding — skip, do not double-report
      } else {
        scanned++;
        if (v.verdict === 'suspect') {
          flagged++;
          if (!open) open = { bars: [b], worst: v };
          else open.bars.push(b);
          if (dev(v) > dev(open.worst)) open.worst = v;
        } else if (open) { blocks.push(open); open = null; }
      }
      buffer.push(Number(b.closePrice));
      if (buffer.length > window) buffer.shift();
    }
    if (open) { blocks.push(open); open = null; }
  }
  return { blocks, flagged, scanned, unguarded };
}

async function main() {
  const pool = await getPool();
  const series = await loadSeries(pool);
  const totalBars = [...series.values()].reduce((s, v) => s + v.length, 0);
  console.log(`series: ${series.size}   rows: ${totalBars}   cap: ${BAR_SCALE_MAX_RATIO}x`);

  console.log('\n=== 1. WHICH WINDOW? — measured on the desk\'s own history ===');
  console.log('  prev closes   judged   flagged      %    trend-like(>20)   spike-like(<=3)   blocks');
  const sweep = [];
  for (const w of WINDOWS) {
    const s = scan(series, w, BAR_SCALE_MAX_RATIO);
    const inLong = s.blocks.filter((b) => b.bars.length > LONG_BLOCK).reduce((a, b) => a + b.bars.length, 0);
    const inShort = s.blocks.filter((b) => b.bars.length <= SHORT_BLOCK).reduce((a, b) => a + b.bars.length, 0);
    sweep.push({ w, ...s, inLong, inShort });
    console.log(`  ${String(w).padStart(11)}   ${String(s.scanned).padStart(6)}   ${String(s.flagged).padStart(7)}   ${(s.flagged / (s.scanned || 1) * 100).toFixed(3).padStart(5)}%   ${String(inLong).padStart(14)}   ${String(inShort).padStart(15)}   ${String(s.blocks.length).padStart(6)}`);
  }
  // Prefer the LARGEST window with no trend-shaped output: a larger window is the more tolerant
  // reference, so it is the lower false-positive rate while still holding the spikes.
  const clean = sweep.filter((s) => s.inLong === 0);
  const chosen = clean.length ? clean[clean.length - 1] : sweep[0];
  console.log(`\n  => window = ${chosen.w} prior close(s): ${chosen.inLong} trend-shaped row(s) flagged out of `
    + `${chosen.flagged} total, retaining ${chosen.inShort} spike-shaped row(s).`);
  const w30 = sweep[sweep.length - 1];
  console.log(`     for comparison, the 30-close window flagged ${w30.inLong} trend-shaped row(s) — history, not defects.`);

  const res = scan(series, chosen.w, BAR_SCALE_MAX_RATIO);
  const blocks = res.blocks.slice().sort((a, b) => dev(b.worst) - dev(a.worst));
  console.log(`\n=== 2. SUSPECT BLOCKS at window=${chosen.w} (${blocks.length}) — the list, not a count ===`);
  if (!blocks.length) console.log('  none.');
  for (const bl of blocks) {
    const first = bl.bars[0];
    const w = bl.worst;
    const shape = bl.bars.length <= SHORT_BLOCK ? 'SPIKE' : (bl.bars.length > LONG_BLOCK ? 'TREND?' : 'block');
    console.log(`  [${shape}] ${first.venue}/${first.symbol} ${first.timeframe}  ${String(bl.bars.length).padStart(5)} row(s)  `
      + `${new Date(first.barStart).toISOString().slice(0, 16)}`
      + `${bl.bars.length > 1 ? ' -> ' + new Date(bl.bars[bl.bars.length - 1].barStart).toISOString().slice(0, 16) : ''}`);
    console.log(`      worst: ${w.field} = ${w.value}  vs reference ${Number(w.reference).toFixed(6)}  `
      + `= ${dev(w).toFixed(3)}x  (${w.samples} prior closes)`);
  }

  console.log('\n=== 3. UNGUARDED — too few prior closes to judge (a finding, not a pass) ===');
  console.log(`  ${res.unguarded} row(s) had no usable reference and are NOT vouched for by this scan.`);

  console.log('\n⚠ A row above the cap is a CANDIDATE, not a defect. The pre-registered promotion step is to');
  console.log('  confirm each candidate against the venue\'s own quote (PriceTicks) at the same barStart —');
  console.log('  never against the bars, and never against the median that produced it.');

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
