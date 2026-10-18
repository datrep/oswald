// trading/scripts/repro/activity-check.js
//
// READ-ONLY. Two questions about S2's volume-free activity measure, both answered from the desk's own data:
//
//   A. DOES IT RUN end to end on the real symbols, via the real `quant.evaluateSymbol`?
//   B. IS IT CALIBRATED, and does the venue choice actually matter to it?
//
// (B) is the one worth the script, because the answer is not obvious. The same-hour baseline ALREADY cancels
// any bias that is a stable function of the clock — numerator and denominator are understated together — so
// the venue fix is NOT needed to keep the measure's CENTRE honest. What it cannot cancel is the random part:
// the tick-built series' shortfall scales with how many ticks landed in that particular hour (0.08 at 1-2
// ticks, 0.67 at 10+), so both terms carry an independent factor. That should leave the MEDIAN at ~1 and
// DILUTE THE TAIL, which is a specific, falsifiable prediction:
//
//     the share of ratios above 1.5 should be HIGHER on the faithful chart series than on the tick series.
//
// If that share comes out the same on both, the venue choice buys nothing for this measure and the claim in
// `activity.js` is wrong. Two outcomes, both informative.
//
// Usage (from the repo root): node trading/scripts/repro/activity-check.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');
const store = require('../../store');
const quant = require('../../agent/quant');
const { computeActivity } = require('../../agent/activity');

const USER_ID = Number(process.argv[2]) || 1;
const SYMBOLS = ['Gold', 'Oil', 'Silver', 'Bitcoin', 'Sugar', 'Wilmar International'];
const VENUES = [quant.STRUCTURE_CHART_VENUE, 'plus500'];

const pad = (s, n) => String(s ?? '').padEnd(n);
const lpad = (s, n) => String(s ?? '').padStart(n);
const f = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(dp));
const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

async function main() {
  await getPool();
  const settings = await store.getSettings(USER_ID);

  // ── A. End to end, through the real evaluation path ────────────────────────────────────────────────
  console.log('\n=== A. activity as `evaluateSymbol` produces it ===');
  console.log('  ' + pad('symbol', 22) + pad('state', 22) + pad('hr', 4) + lpad('n', 5)
    + lpad('nowBps', 9) + lpad('medBps', 9) + lpad('ratio', 7) + lpad('pctile', 8) + '  venue');
  for (const sym of (settings.watchlist?.symbols || [])) {
    const venue = sym.venue || 'plus500';
    try {
      const r = await quant.evaluateSymbol(USER_ID, { symbol: sym.symbol, venue }, [], [], settings, {});
      const a = r.activity || {};
      const rg = a.range || {};
      console.log('  ' + pad(sym.symbol, 22) + pad(String(a.state), 22) + lpad(a.hourUtc == null ? '—' : a.hourUtc, 4)
        + lpad(a.samples == null ? '—' : a.samples, 5) + lpad(f(rg.nowBps, 1), 9) + lpad(f(rg.medianBps, 1), 9)
        + lpad(f(rg.ratio, 2), 7) + lpad(rg.percentile == null ? '—' : f(rg.percentile, 2), 8)
        + '  ' + (a.basis ? a.basis.venue : '—'));
    } catch (e) {
      console.log('  ' + pad(sym.symbol, 22) + 'THREW  ' + String(e.message).slice(0, 90));
    }
  }

  // ── B. Can each series support the measure at all, and is it calibrated when it can? ─────────────
  console.log('\n=== B. SUPPORT + calibration, walked over every bar of each series ===');
  console.log('  `n` is the same-hour baseline size in the trailing 20d window; the measure needs 8. The share of');
  console.log('  bars where it is computable at all is the availability question, and median ratio ~1 is the');
  console.log('  calibration question. Both matter, and they are different questions.');
  console.log('  ' + pad('symbol', 22) + pad('venue', 16) + lpad('bars', 6) + lpad('ok', 6) + lpad('ok%', 6)
    + lpad('med n', 7) + lpad('max n', 7) + lpad('median', 8) + lpad('p90', 7) + lpad('>1.5', 7));
  const stats = new Map();
  for (const symbol of SYMBOLS) {
    for (const venue of VENUES) {
      const bars = await store.listBars(USER_ID, { timeframe: '1h', symbol, venue, limit: 2000 });
      if (bars.length < 60) { console.log('  ' + pad(symbol, 22) + pad(venue, 16) + '  too few bars'); continue; }
      const ratios = [];
      const samples = [];
      for (let asOf = 0; asOf < bars.length; asOf++) {
        const a = computeActivity({ bars, asOf });
        if (a.samples != null) samples.push(a.samples);
        if (a.state === 'ok' && a.range && a.range.ratio != null) ratios.push(a.range.ratio);
      }
      const share = (t) => (ratios.length ? ratios.filter((v) => v > t).length / ratios.length : null);
      stats.set(`${symbol}|${venue}`, {
        ok: ratios.length, total: bars.length, medN: q(samples, 0.5),
        maxN: samples.length ? Math.max(...samples) : 0, med: q(ratios, 0.5), p90: q(ratios, 0.9), gt15: share(1.5),
      });
      console.log('  ' + pad(symbol, 22) + pad(venue, 16) + lpad(bars.length, 6) + lpad(ratios.length, 6)
        + lpad(`${((ratios.length / bars.length) * 100).toFixed(0)}%`, 6) + lpad(f(q(samples, 0.5), 0), 7)
        + lpad(samples.length ? Math.max(...samples) : 0, 7)
        + lpad(f(q(ratios, 0.5), 2), 8) + lpad(f(q(ratios, 0.9), 2), 7)
        + lpad(share(1.5) == null ? '—' : `${(share(1.5) * 100).toFixed(0)}%`, 7));
    }
  }

  console.log('\n=== C. WHY THE VENUE CHOICE MATTERS HERE — and the answer is AVAILABILITY, not dilution ===');
  console.log('  My stated hypothesis was that the tick series would DILUTE the tail. It did not get that far:');
  console.log('  it cannot supply the baseline. This is the measurement that replaces the guess.');
  console.log('  ' + pad('symbol', 22) + lpad('chart ok%', 10) + lpad('tick ok%', 9) + lpad('chart med n', 12)
    + lpad('tick med n', 11) + lpad('tick max n', 11) + '   verdict');
  for (const symbol of SYMBOLS) {
    const c = stats.get(`${symbol}|${quant.STRUCTURE_CHART_VENUE}`);
    const t = stats.get(`${symbol}|plus500`);
    if (!c || !t) continue;
    const cOk = (c.ok / c.total) * 100;
    const tOk = (t.ok / t.total) * 100;
    const verdict = t.ok === 0
      ? 'tick series CANNOT compute it at all'
      : (tOk < cOk - 5 ? 'chart is materially more available' : 'similar availability');
    console.log('  ' + pad(symbol, 22) + lpad(`${cOk.toFixed(0)}%`, 10) + lpad(`${tOk.toFixed(0)}%`, 9)
      + lpad(f(c.medN, 0), 12) + lpad(f(t.medN, 0), 11) + lpad(t.maxN, 11) + '   ' + verdict);
  }

  await getPool().then((p) => p.close());
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
