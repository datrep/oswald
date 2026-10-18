// trading/scripts/repro/gate-predicate-screen.js
//
// READ-ONLY. S3's gate predicate is a design choice, and this script turns it into a measurement instead of
// a preference. The question a filter has to survive BEFORE it is worth testing:
//
//   HOW OFTEN DOES IT BIND?
//
// A gate that blocks 2% of entries cannot show an effect on the sample this desk will have (n >= 50, and the
// ungated sibling is the control). A gate that blocks 70% of them has thrown away most of the signal and is
// testing a different strategy. So binding rate is the first-order fact, and it is measurable today.
//
// It is measured against the REAL signal, not a reconstruction: each bar's decision comes from
// `strategies.get('survgold').liveSignal(...)`, so the entries are exactly the ones the desk's own frozen
// survivor would have produced (dc20, adxGate 0 — i.e. a fresh Donchian-20 breakout with no trend filter).
//
// ★ NO LOOKAHEAD, and it is structural rather than promised: the signal at bar `i` is built from
// `bars[0..i]` and `computeStructure` is called with `asOf = i`, which confines its own view to the same
// slice. A predicate is then asked what it WOULD have said at that bar, having seen nothing later.
//
// Usage (from the repo root): node trading/scripts/repro/gate-predicate-screen.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { getPool } = require('../../../shared/db');
const store = require('../../store');
const strategies = require('../../agent/strategies');
const { computeStructure } = require('../../agent/structure');
const { atr, adx } = require('../../agent/indicators');

const USER_ID = Number(process.argv[2]) || 1;
const SYMBOL = 'Gold';                 // survgold's only instrument (track-bound)
const VENUE = 'plus500_chart';         // the venue of record resolved in S2 (survgold supplies its own
                                       // frozen dc20, so this script never re-declares the strategy's params)

const pad = (s, n) => String(s ?? '').padEnd(n);
const lpad = (s, n) => String(s ?? '').padStart(n);
const f = (v, dp = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(dp));
const pctS = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

async function main() {
  await getPool();
  const bars = await store.listBars(USER_ID, { timeframe: '1h', symbol: SYMBOL, venue: VENUE, limit: 2000 });
  if (bars.length < 100) { console.log(`${bars.length} bars — not enough to screen anything.`); return; }

  const strat = strategies.get('survgold');
  const highs = bars.map((b) => Number(b.high));
  const lows = bars.map((b) => Number(b.low));
  const closes = bars.map((b) => Number(b.closePrice));

  const entries = [];
  for (let i = 61; i < bars.length; i++) {
    const h = highs.slice(0, i + 1);
    const l = lows.slice(0, i + 1);
    const c = closes.slice(0, i + 1);
    const r = strat.liveSignal({
      highs: h, lows: l, closes: c,
      atr14: atr(h, l, c, 14),
      adx14: adx(h, l, c, 14),
      price: closes[i],
      prevPrice: closes[i - 1],
      params: {},          // survgold spreads its own FROZEN set — passing {} is the honest "no override"
      openTrade: null,     // entries only; a trailing stop would suppress some, and that is the same for
      lab: null,           // every predicate, so it cancels rather than biases
    });
    if (!r || r.type !== 'entry') continue;
    const structure = computeStructure({ bars, asOf: i, basis: { venue: VENUE, venueWhy: 'chart_series_faithful', timeframe: '1h', sourceIntervalSec: 3600 } });
    entries.push({ i, barStart: bars[i].barStart, direction: r.direction, structure });
  }

  console.log(`\n=== ${SYMBOL} · ${VENUE} · ${bars.length} bars ===`);
  console.log(`survgold entries found: ${entries.length}`);
  if (!entries.length) return;
  const buys = entries.filter((e) => e.direction === 'buy').length;
  console.log(`  buys ${buys} / sells ${entries.length - buys}`);

  const st = entries.map((e) => e.structure);
  const tally = (fn) => st.filter(fn).length;
  console.log(`\nstructure state at those entries:`);
  console.log(`  ok ${tally((s) => s.state === 'ok')} · insufficient_history ${tally((s) => s.state !== 'ok')}`);
  console.log(`  direction: bullish ${tally((s) => s.direction === 'bullish')} · bearish ${tally((s) => s.direction === 'bearish')} · range ${tally((s) => s.direction === 'range')}`);
  console.log(`  zone:      premium ${tally((s) => s.position && s.position.zone === 'premium')} · equilibrium ${tally((s) => s.position && s.position.zone === 'equilibrium')} · discount ${tally((s) => s.position && s.position.zone === 'discount')}`);
  console.log(`  bos present at the entry bar: ${tally((s) => !!s.bos)} · a sweep within 10 bars: ${tally((s) => (s.sweeps || []).some((w) => w.lagBars <= 10))}`);

  // ── THE SCREEN. Each predicate is asked "would you have allowed this entry?" ───────────────────────
  const want = (e) => (e.direction === 'buy' ? 'bullish' : 'bearish');
  const against = (e) => (e.direction === 'buy' ? 'bearish' : 'bullish');

  const predicates = [
    ['(a) direction agrees, any state', (e) => e.structure.direction === want(e)],
    ['(a) direction agrees, not range', (e) => e.structure.direction === want(e) && e.structure.state === 'ok'],
    ['(a-soft) not against', (e) => e.structure.direction !== against(e)],
    ['(b) BOS agrees, seen at all', (e) => !!e.structure.bos && e.structure.bos.direction === want(e)],
    ['(b) BOS agrees, lag <= 3', (e) => !!e.structure.bos && e.structure.bos.direction === want(e) && e.structure.bos.lagBars <= 3],
    ['(b) BOS agrees, lag <= 10', (e) => !!e.structure.bos && e.structure.bos.direction === want(e) && e.structure.bos.lagBars <= 10],
    ['(c) no sweep AGAINST in 3 bars', (e) => !(e.structure.sweeps || []).some((w) => w.swingKind === (e.direction === 'buy' ? 'high' : 'low') && w.lagBars <= 3)],
    ['(c) no sweep AGAINST in 10 bars', (e) => !(e.structure.sweeps || []).some((w) => w.swingKind === (e.direction === 'buy' ? 'high' : 'low') && w.lagBars <= 10)],
    ['(d) not buying premium / selling discount', (e) => !(e.structure.position && e.structure.position.zone === (e.direction === 'buy' ? 'premium' : 'discount'))],
  ];

  console.log('\n=== BINDING RATE — how much of the signal each predicate removes ===');
  console.log('  ' + pad('predicate', 40) + lpad('allowed', 9) + lpad('blocked', 9) + lpad('blocked %', 11));
  for (const [label, keep] of predicates) {
    const allowed = entries.filter(keep).length;
    const blocked = entries.length - allowed;
    console.log('  ' + pad(label, 40) + lpad(allowed, 9) + lpad(blocked, 9) + lpad(pctS(blocked / entries.length), 11));
  }

  // ── OVERLAP: is a predicate ADDING anything, or re-testing one already in place? ───────────────────
  console.log('\n=== OVERLAP — of the entries (b) allows, how many would (a) also have allowed? ===');
  const A = new Set(entries.filter(predicates[1][1]).map((e) => e.i));
  const B = new Set(entries.filter(predicates[5][1]).map((e) => e.i));
  const D = new Set(entries.filter(predicates[8][1]).map((e) => e.i));
  const inter = (x, y) => [...x].filter((v) => y.has(v)).length;
  console.log(`  (a)strict allows ${A.size}, (b)lag<=10 allows ${B.size}, (d) zone allows ${D.size}`);
  console.log(`  (a)&(b) ${inter(A, B)} → (b) allows ${B.size - inter(A, B)} that (a) would have blocked`);
  console.log(`  (a)&(d) ${inter(A, D)} → (d) allows ${D.size - inter(A, D)} that (a) would have blocked`);

  // ── THE 2x2 for (a): is it a STRUCTURE filter or just a trend proxy? ─────────────────────────────
  // If the gate only ever blocked SELLS in an up-market it would be a directional bias rather than a
  // structure read; if it blocks breakouts on BOTH sides equally it is reading the instrument.
  console.log('\n=== (a) IN DETAIL — which entries it removes, by trade side ===');
  const cell = (dir, agree) => entries.filter((e) => e.direction === dir
    && ((e.structure.direction === want(e)) === agree)).length;
  for (const dir of ['buy', 'sell']) {
    const allowed = cell(dir, true);
    const blocked = cell(dir, false);
    const tot = allowed + blocked;
    console.log(`  ${dir}s: ${tot} total · allowed ${allowed} (${pctS(allowed / (tot || 1))}) · blocked ${blocked} (${pctS(blocked / (tot || 1))})`);
  }
  console.log('  (a buy blocked = structure read bearish at a breakout UP; a sell blocked = structure bullish at a breakout DOWN)');

  // ── D. SIGNALS vs TRADES, on the FULL series ───────────────────────────────────────────────────────
  // The screen counted 110 entry SIGNALS. A backtest holds a position until its trailing stop, so signals
  // arriving while a position is open are skipped — the trade count can be a small fraction of the signal
  // count. That ratio decides whether the Lab can ever judge this candidate: if ~10 trades is the whole
  // population, then A/B/CONTROL/LOCKBOX are all INSUFFICIENT-DATA and no release will change that.
  const bt = require('../../agent/backtest');
  const ungated = strategies.get('survgold');
  const gated = strategies.get('survgoldstruct');
  // The Lab's own shape (`backtest.loadSeries`): { open, high, low, close, time }. Not cosmetics — the
  // backtest reads `b.close`, and the gate's normaliser translates back for the engine.
  const labBars = bars.map((b) => ({ open: b.openPrice, high: b.high, low: b.low, close: b.closePrice, time: b.barStart }));
  const cfg = { ...bt.DEFAULTS, ...bt.costCfgFor(SYMBOL) };
  const pfOf = (tr) => {
    const w = tr.filter((t) => t.pnlMid > 0).reduce((s, t) => s + t.pnlMid, 0);
    const l = Math.abs(tr.filter((t) => t.pnlMid <= 0).reduce((s, t) => s + t.pnlMid, 0));
    return l > 0 ? w / l : (w > 0 ? Infinity : 0);
  };
  console.log('\n=== D. signals vs TRADES on the full series ===');
  console.log(`  entry signals counted: ${entries.length}  ·  bars: ${labBars.length}`);
  console.log('  ' + pad('arm', 22) + lpad('trades', 8) + lpad('PF', 8) + lpad('net', 10) + lpad('win%', 7)
    + lpad('signals/trade', 15));
  for (const [label, strat] of [['survgold (control)', ungated], ['survgoldstruct (gated)', gated]]) {
    const r = strat.backtest(labBars, cfg, null);
    const tr = r.trades || [];
    const wins = tr.filter((t) => t.pnlMid > 0).length;
    const net = tr.reduce((s, t) => s + t.pnlMid, 0);
    console.log('  ' + pad(label, 22) + lpad(tr.length, 8) + lpad(f(pfOf(tr), 2), 8) + lpad(f(net, 2), 10)
      + lpad(tr.length ? `${((wins / tr.length) * 100).toFixed(0)}%` : '—', 7)
      + lpad(tr.length ? f(entries.length / tr.length, 1) : '—', 15));
  }
  console.log('  -> if the trade count is a small fraction of the signals, that ratio — not the gate — is what');
  console.log('     sets how much evidence the Lab can ever have here.');

  // ── E. THE SERIES CHOICE DECIDES THE POWER, and the Lab can only load ONE ──────────────────────────
  // The Lab loads a single series per candidate. The candidate's SIGNAL comes from the indicator series
  // (yahoo for Gold), while its GATE reads the VENUE OF RECORD (plus500_chart). Registering with one venue
  // matches the signal and mismatches the gate; the other does the reverse. And the two differ enormously in
  // how much history exists — which is what decides whether A/B/LOCKBOX can reach n>=20 at all.
  console.log('\n=== E. sample size available per venue (the Lab loads ONE series) ===');
  console.log('  ' + pad('venue', 16) + lpad('bars', 7) + lpad('span d', 8) + lpad('ctrl trades', 12)
    + lpad('gated', 8) + lpad('lockbox ~10%', 13));
  for (const venue of ['plus500_chart', 'plus500', 'yahoo']) {
    const b = await store.listBars(USER_ID, { timeframe: '1h', symbol: SYMBOL, venue, limit: 20000 });
    if (b.length < 100) { console.log('  ' + pad(venue, 16) + lpad(b.length, 7) + '  too few bars'); continue; }
    const span = b.length > 1 ? (new Date(b[b.length - 1].barStart) - new Date(b[0].barStart)) / 86400000 : 0;
    const lb = b.map((x) => ({ open: x.openPrice, high: x.high, low: x.low, close: x.closePrice, time: x.barStart }));
    const c = ungated.backtest(lb, cfg, null).trades.length;
    const g = gated.backtest(lb, cfg, null).trades.length;
    console.log('  ' + pad(venue, 16) + lpad(b.length, 7) + lpad(f(span, 1), 8) + lpad(c, 12) + lpad(g, 8)
      + lpad(f(c * 0.10, 1), 13) + (c * 0.10 < 20 ? '   <-- W4 would be under n>=20' : '   (W4 can reach n>=20)'));
  }
  console.log('  * "lockbox ~10%" is a rough upper bound: W4 is [90,100%) of the series, and a stage takes');
  console.log('    FEWER trades than its bar share implies because positions span bars.');

  await getPool().then((p) => p.close());
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
