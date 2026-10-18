// trading/scripts/repro/structure-direction-sweep.js — choosing the direction rule from evidence.
//
// THE DEFECT THIS MEASURES. `computeStructure` derives `direction` from the sign of the last two confirmed
// swing LOWS (falling back to highs). Choosing k=4 flipped Gold from bullish to bearish on the same bars,
// because a wider window confirmed a LOWER low — which changed the last two lows, and therefore the trend.
// That matters more than any other parameter choice, because `direction` is what selects `protected`, and
// `protected` is what BOS and MSS are defined against. In other words: **`direction` is the entire surface a
// gate would read**, and it is currently flippable by a parameter rather than by the market.
//
// THE CRITERION IS THEREFORE STABILITY — but stability alone is trivially satisfied by a rule that always
// answers "range", so every rule is scored on two axes and neither is allowed to hide the other:
//
//   1. STABILITY   how many DISTINCT directions the rule produces across k = 2..10 on fixed bars.
//                  Ideal is 1. This is the axis the current rule fails.
//   2. COVERAGE    the share of samples that are NOT 'range'. A stable rule that abstains is useless.
//
// …and a third, independent of both:
//
//   3. VENUE AGREEMENT  at a fixed k, do plus500 and plus500_chart give the same answer? If two captures of
//                  the SAME instrument disagree, the output is not a property of the market.
//
// THREE CANDIDATE RULES, all computed from the same swing list so the comparison isolates the RULE:
//
//   A. last2Lows   — the current implementation: sign of the last two confirmed swing lows.
//   B. bothSides   — require the two sides to AGREE: bullish only if the last low is HL *and* the last high
//                    is HH; bearish only if LL *and* LH; otherwise 'range'. Conservative, so it abstains more.
//   C. stickyChoch — a forward, bar-causal STATE MACHINE: direction persists until a CLOSE through the
//                    protected level (i.e. until an MSS). It changes on an EVENT rather than on a
//                    recomputation of the swing list, which is the structural reason it should be stabler
//                    under k: the swing list changing is not by itself an event.
//
// Read-only. Usage (from the repo root): node trading/scripts/repro/structure-direction-sweep.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool, sql } = require('../../../shared/db');
const store = require('../../store');
const { computeStructure } = require('../../agent/structure');

const USER_ID = Number(process.argv[2]) || 1;
const SYMBOLS = ['Gold', 'Oil', 'Silver', 'Bitcoin'];
const VENUES = ['plus500', 'plus500_chart'];
const KS = [2, 3, 4, 5, 6, 8, 10];

const pad = (s, n) => String(s ?? '').padEnd(n);
const med = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(dp));

// B — require both sides to agree, using the HH/HL/LH/LL labels the engine already computes.
function directionBothSides(confirmed) {
  const lows = confirmed.filter((s) => s.kind === 'low');
  const highs = confirmed.filter((s) => s.kind === 'high');
  if (!lows.length || !highs.length) return 'range';
  const ll = lows[lows.length - 1].label;
  const lh = highs[highs.length - 1].label;
  if (ll === 'HL' && lh === 'HH') return 'bullish';
  if (ll === 'LL' && lh === 'LH') return 'bearish';
  return 'range';
}

// C — forward state machine. Direction changes only when a close takes out the protected level, which is
// what §3 calls an MSS. Seeded identically to A so the ONLY difference is the persistence.
function directionSticky(bars, asOf, confirmed) {
  let dir = 'range';
  let lastLow = null; let lastHigh = null;
  let si = 0;
  for (let b = 1; b <= asOf; b++) {
    while (si < confirmed.length && confirmed[si].confirmedAtIndex <= b) {
      const s = confirmed[si++];
      if (s.kind === 'low') lastLow = s; else lastHigh = s;
    }
    if (dir === 'range') {
      const lows = confirmed.filter((s) => s.kind === 'low' && s.confirmedAtIndex <= b);
      const highs = confirmed.filter((s) => s.kind === 'high' && s.confirmedAtIndex <= b);
      if (lows.length >= 2) dir = lows[lows.length - 1].price > lows[lows.length - 2].price ? 'bullish' : 'bearish';
      else if (highs.length >= 2) dir = highs[highs.length - 1].price > highs[highs.length - 2].price ? 'bullish' : 'bearish';
    } else {
      const c = Number(bars[b].closePrice);
      if (dir === 'bullish' && lastLow && c < lastLow.price) dir = 'bearish';
      else if (dir === 'bearish' && lastHigh && c > lastHigh.price) dir = 'bullish';
    }
  }
  return dir;
}

(async () => {
  const pool = await getPool();
  await pool.request().input('userId', sql.Int, USER_ID).query('SELECT 1');

  const samples = []; // { symbol, venue, k, A, B, C }  (+ the raw result for k=4 venue comparison)
  for (const venue of VENUES) {
    for (const symbol of SYMBOLS) {
      const bars = await store.listBars(USER_ID, { timeframe: '1h', symbol, venue, limit: 300 }).catch(() => []);
      if (bars.length < 40) continue;
      const asOf = bars.length - 2;
      for (const k of KS) {
        const r = computeStructure({ bars, asOf, params: { k, minBars: 30 }, basis: { venue, timeframe: '1h', sourceIntervalSec: null } });
        if (r.state !== 'ok') continue;
        const confirmed = r.swings.filter((s) => s.status === 'confirmed');
        samples.push({
          symbol, venue, k,
          A: r.direction,
          B: directionBothSides(confirmed),
          C: directionSticky(bars, asOf, confirmed),
        });
      }
    }
  }

  console.log('\n=== STABILITY: distinct directions across k=2..10 (1 is perfect, lower is better) ===');
  console.log('  ' + pad('symbol', 10) + pad('venue', 16) + pad('A last2Lows', 14) + pad('B bothSides', 14) + 'C stickyChoch');
  const byGroup = [...new Set(samples.map((s) => `${s.symbol}|${s.venue}`))];
  for (const g of byGroup) {
    const [symbol, venue] = g.split('|');
    const rows = samples.filter((s) => s.symbol === symbol && s.venue === venue);
    const distinct = (rule) => new Set(rows.map((r) => r[rule])).size;
    console.log('  ' + pad(symbol, 10) + pad(venue, 16)
      + pad(distinct('A'), 14) + pad(distinct('B'), 14) + distinct('C'));
  }

  console.log('\n=== median across symbols+venues ===');
  for (const rule of ['A', 'B', 'C']) {
    const per = byGroup.map((g) => {
      const [symbol, venue] = g.split('|');
      return new Set(samples.filter((s) => s.symbol === symbol && s.venue === venue).map((r) => r[rule])).size;
    });
    const rangeShare = samples.filter((s) => s[rule] === 'range').length / Math.max(samples.length, 1);
    console.log(`  ${rule}  distinct directions vs k: median ${f(med(per), 1)}   abstains ('range') ${f(rangeShare * 100, 0)}%`);
  }

  console.log('\n=== VENUE AGREEMENT at k=4 (same instrument, two captures — do they agree?) ===');
  for (const rule of ['A', 'B', 'C']) {
    let agree = 0; let total = 0;
    for (const symbol of SYMBOLS) {
      const p = samples.find((s) => s.symbol === symbol && s.venue === 'plus500' && s.k === 4);
      const c = samples.find((s) => s.symbol === symbol && s.venue === 'plus500_chart' && s.k === 4);
      if (!p || !c) continue;
      total++;
      if (p[rule] === c[rule]) agree++;
      else console.log(`  ${rule}: ${symbol} DISAGREES — plus500=${p[rule]} / plus500_chart=${c[rule]}`);
    }
    console.log(`  ${rule}: ${agree}/${total} symbols agree across venues`);
  }

  console.log('\n=== the answers themselves, k=4, plus500 ===');
  for (const s of samples.filter((x) => x.venue === 'plus500' && x.k === 4)) {
    console.log('  ' + pad(s.symbol, 10) + 'A=' + pad(s.A, 10) + 'B=' + pad(s.B, 10) + 'C=' + s.C);
  }
  console.log('');

  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
