// trading/scripts/repro/structure-k-sweep.js — choosing `k` from evidence instead of preference.
//
// WHY THIS EXISTS. `k` is the swing window half-width, and §10 Q4 registered `k=2` as the PRIMARY value.
// S1 then measured one swing per ~3.2 bars on Gold — and the same density on `plus500_chart` and yahoo —
// so the density is a property of `k`, not of the data. A swing every three hours is not a structural
// level. But "more swings than feels right" is not a criterion, so this script measures three things that
// are, for `k = 2..10`, on the desk's own series:
//
//   1. DENSITY        bars per confirmed swing. Context, not a verdict.
//   2. ATR DISTANCE ★ the one that matters. For each confirmed swing, |close at its confirmation bar −
//                     the swing price| ÷ ATR14 at that bar. This is how far the LEVEL sat from the market
//                     once the level was knowable. A level inside ~0.5 ATR is inside the noise: a stop
//                     placed behind it is a stop placed in the spread, and a "BOS" through it is a BOS
//                     through nothing. A structural level should be a meaningful multiple of ATR.
//   3. ALTERNATION    the share of adjacent confirmed swings of the SAME kind (high,high / low,low). A
//                     clean structural sequence alternates; a high share means the window is resolving
//                     local jitter rather than turns, which is the same defect seen from another angle.
//
// ★ REPORTED PER SYMBOL AND THEN AS A MEDIAN ACROSS SYMBOLS, because a value chosen to suit Gold is a
// value fitted to Gold. And across BOTH venues, because which venue owns structure is still open (§10
// residual Q1) and the answer must not depend on the choice.
//
// Read-only. Usage (from the repo root): node trading/scripts/repro/structure-k-sweep.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');
const store = require('../../store');
const { computeStructure } = require('../../agent/structure');
const { atr } = require('../../agent/indicators');

const USER_ID = Number(process.argv[2]) || 1;
const SYMBOLS = ['Gold', 'Oil', 'Silver', 'Bitcoin'];
const VENUES = ['plus500', 'plus500_chart'];
const KS = [2, 3, 4, 5, 6, 8, 10];

const pad = (s, n) => String(s ?? '').padEnd(n);
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const med = (xs) => q(xs, 0.5);
const f = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(dp));

// One (symbol, venue, k) measurement. Returns null when the series is too short to say anything.
function measure(bars, k) {
  const asOf = bars.length - 2;
  if (asOf < 30) return null;
  const r = computeStructure({ bars, asOf, params: { k, minBars: 30 }, basis: { venue: 'x', timeframe: '1h', sourceIntervalSec: null } });
  if (r.state !== 'ok') return null;

  const confirmed = r.swings.filter((s) => s.status === 'confirmed');
  if (!confirmed.length) return null;

  const highs = bars.map((b) => Number(b.high));
  const lows = bars.map((b) => Number(b.low));
  const closes = bars.map((b) => Number(b.closePrice));

  const dists = [];
  for (const s of confirmed) {
    const c = s.confirmedAtIndex;
    if (c > asOf) continue;
    const a = atr(highs.slice(0, c + 1), lows.slice(0, c + 1), closes.slice(0, c + 1), 14);
    if (!a || !Number.isFinite(a) || a === 0) continue;
    dists.push(Math.abs(closes[c] - s.price) / a);
  }

  let same = 0;
  for (let i = 1; i < confirmed.length; i++) if (confirmed[i].kind === confirmed[i - 1].kind) same++;

  return {
    swings: confirmed.length,
    barsPerSwing: (asOf + 1) / confirmed.length,
    dists,
    medianDist: med(dists),
    p10Dist: q(dists, 0.10),
    fracInsideHalfAtr: dists.length ? dists.filter((d) => d < 0.5).length / dists.length : null,
    sameKindShare: confirmed.length > 1 ? same / (confirmed.length - 1) : null,
  };
}

(async () => {
  const pool = await getPool();
  await pool.request().input('userId', sql.Int, USER_ID).query('SELECT 1'); // fail early if the DB is down

  const rows = []; // { venue, k, symbol, ...metrics }
  for (const venue of VENUES) {
    for (const symbol of SYMBOLS) {
      const bars = await store.listBars(USER_ID, { timeframe: '1h', symbol, venue, limit: 300 }).catch(() => []);
      for (const k of KS) {
        const m = measure(bars, k);
        rows.push({ venue, symbol, k, bars: bars.length, ...(m || { swings: null }) });
      }
    }
  }

  for (const venue of VENUES) {
    console.log(`\n=== ${venue} — swing quality by k (median across ${SYMBOLS.length} symbols) ===`);
    console.log('  ' + pad('k', 4) + pad('swings', 9) + pad('bars/swing', 12) + pad('median dist', 13)
      + pad('p10 dist', 10) + pad('%<0.5ATR', 10) + 'same-kind');
    for (const k of KS) {
      const per = rows.filter((r) => r.venue === venue && r.k === k && r.swings != null);
      if (!per.length) { console.log('  ' + pad(k, 4) + '(no series long enough)'); continue; }
      const distsAll = per.flatMap((p) => p.dists || []);
      console.log('  ' + pad(k, 4)
        + pad(med(per.map((p) => p.swings)), 9)
        + pad(f(med(per.map((p) => p.barsPerSwing)), 1), 12)
        + pad(f(med(distsAll), 2), 13)
        + pad(f(q(distsAll, 0.10), 2), 10)
        + pad(f(100 * distsAll.filter((d) => d < 0.5).length / Math.max(distsAll.length, 1), 0) + '%', 10)
        + f(med(per.map((p) => p.sameKindShare)) * 100, 0) + '%');
    }
  }

  console.log('\n=== per-symbol detail (median ATR distance of a confirmed swing level) ===');
  console.log('  ' + pad('symbol', 10) + pad('venue', 16) + KS.map((k) => pad('k=' + k, 8)).join(''));
  for (const symbol of SYMBOLS) {
    for (const venue of VENUES) {
      const cells = KS.map((k) => {
        const r = rows.find((x) => x.venue === venue && x.symbol === symbol && x.k === k);
        return pad(r && r.medianDist != null ? f(r.medianDist) : '—', 8);
      });
      console.log('  ' + pad(symbol, 10) + pad(venue, 16) + cells.join(''));
    }
  }
  console.log('\n  Reading it: `median dist` is how far the level sat from the market, in ATRs, at the moment\n'
    + '  it became knowable. Low k ⇒ levels inside the noise. The knee is where the number stops rising\n'
    + '  fast — beyond it you are buying fewer swings without buying more separation.\n');

  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
