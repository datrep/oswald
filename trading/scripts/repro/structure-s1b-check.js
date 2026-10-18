// trading/scripts/repro/structure-s1b-check.js — S1b end-to-end proof.
//
// Proves the WIRING, not just the unit tests: calls the real `quant.evaluateSymbol` against the real
// database and prints what `structure` came out as, for a symbol whose venue of record has depth (Gold)
// and one whose does not (China Shenhua).
//
// Read-only in intent — evaluateSymbol is the desk's own read path and is called on every wake.
//
// Usage (from the repo root): node trading/scripts/repro/structure-s1b-check.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');
const store = require('../../store');
const quant = require('../../agent/quant');

const USER_ID = Number(process.argv[2]) || 1;
const SYMBOLS = ['Gold', 'Oil', 'Silver', 'China Shenhua', 'Gasoline'];

(async () => {
  await getPool();
  const settings = await store.getSettings(USER_ID);

  for (const symbol of SYMBOLS) {
    const w = (settings.watchlist?.symbols || []).find((s) => s.symbol === symbol);
    const venue = (w && w.venue) || 'plus500';
    try {
      const r = await quant.evaluateSymbol(USER_ID, { symbol, venue }, [], [], settings, {});
      const s = r.structure || {};
      const confirmed = (s.swings || []).filter((x) => x.status === 'confirmed');
      const provisional = (s.swings || []).filter((x) => x.status === 'provisional');
      console.log(`${symbol.padEnd(16)} status=${String(r.status).padEnd(18)} venue=${venue.padEnd(10)}`
        + ` structure.state=${String(s.state).padEnd(20)}`
        + ` basis=${JSON.stringify(s.basis)}`
        + ` dir=${s.direction || '—'}`
        + ` swings=${confirmed.length}c/${provisional.length}p`
        + (s.reason ? ` reason="${s.reason}"` : '')
        + (s.protected ? ` protected=${s.protected.side}@${s.protected.price}` : '')
        + (s.bos ? ` bos=${s.bos.index}@${s.bos.close}` : '')
        + (s.dealingRange ? ` range=${s.dealingRange.low}..${s.dealingRange.high} zone=${s.position ? s.position.zone : '—'}` : ''));
    } catch (e) {
      console.log(`${symbol.padEnd(16)} THREW  ${e.message}`);
    }
  }
  // ── venue comparison: is the venue-of-record series STRUCTURE or NOISE? ──
  // 51 confirmed swings in 163 bars (Gold, k=2) is ~1 swing per 3.2 bars, which for a 5-bar window means
  // the series nearly alternates every bar. Tick-derived mids are built from discrete captures at slightly
  // different prices, so candle-to-candle jitter can become a "swing". Compare against the broker's own
  // chart bars, which come from the venue's feed rather than from the desk's sampling.
  console.log('\n=== venue comparison for Gold: swings found vs bar size ===');
  const { computeStructure } = require('../../agent/structure');
  for (const venue of ['plus500', 'plus500_chart', 'yahoo']) {
    const bars = await store.listBars(USER_ID, { timeframe: '1h', symbol: 'Gold', venue, limit: 300 });
    if (bars.length < 12) { console.log(`${venue.padEnd(16)} ${bars.length} bars — too few`); continue; }
    const meanRange = bars.reduce((s, b) => s + (Number(b.high) - Number(b.low)), 0) / bars.length;
    const r = computeStructure({ bars, asOf: bars.length - 2, basis: { venue, timeframe: '1h', sourceIntervalSec: null } });
    const c = (r.swings || []).filter((x) => x.status === 'confirmed');
    console.log(`${venue.padEnd(16)} bars=${String(bars.length).padEnd(5)} swings=${String(c.length).padEnd(4)}`
      + ` per-bar=${r.state === 'ok' ? (bars.length / Math.max(c.length, 1)).toFixed(1) : '—'}`
      + ` meanRange=${meanRange.toFixed(3)} state=${r.state}`);
  }

  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
