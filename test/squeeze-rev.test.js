// test/squeeze-rev.test.js — TRD-16 candidate gate checks.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const strat = require('../trading/agent/strategies/squeezeMeanRev');
const lab = require('../trading/agent/lab');

// 200 volatile bars (bandwidth high), then 40 constant bars (compression),
// then a trigger bar at 98 (below the compressed lower band).
function compressedSeries(triggerClose = 98) {
  const closes = [];
  for (let i = 0; i < 200; i++) closes.push(100 + (i % 2 === 0 ? 3 : -3));
  for (let i = 0; i < 40; i++) closes.push(100);
  closes.push(triggerClose);
  return closes;
}

function flag(closes, regime = 'range') {
  return { closes, highs: closes.map((c) => c + 0.1), lows: closes.map((c) => c - 0.1), atr14: 1, price: closes[closes.length - 1], prevPrice: closes[closes.length - 2], params: {}, openTrade: null, lab: { regime: { adx: 20, regime, dir: null } } };
}

test('liveSignal: entry requires range regime + pre-trigger compression + band overshoot', () => {
  const ok = strat.liveSignal(flag(compressedSeries()));
  assert.strictEqual(ok.type, 'entry', 'compressed range + overshoot should fire');
  assert.strictEqual(ok.direction, 'buy');

  const trend = strat.liveSignal(flag(compressedSeries(), 'trend'));
  assert.strictEqual(trend.type, null, 'trend regime must block the fade');

  // No compression: fully volatile series with an overshoot -> no entry.
  const volatile = [];
  for (let i = 0; i < 240; i++) volatile.push(100 + (i % 2 === 0 ? 3 : -3));
  volatile.push(90);
  const noSqueeze = strat.liveSignal(flag(volatile));
  assert.strictEqual(noSqueeze.type, null, 'uncompressed conditions must block the fade');
});

test('liveSignal: fail-secure without harness regime', () => {
  const ctx = flag(compressedSeries());
  delete ctx.lab;
  assert.strictEqual(strat.liveSignal(ctx).type, null);
});

test('backtest: compressed range fires; uncompressed does not; entries respect the regime', () => {
  const mk = (closes) => closes.map((c, i) => ({ time: i, open: c, high: c + 0.1, low: c - 0.1, close: c }));
  const bars = mk(compressedSeries());
  const ctx = lab.labContext(bars, { k: 4 });
  const raw = strat.backtest(bars, { capital: 10000 }, ctx);
  assert.ok(raw.trades.length >= 1, 'compressed range series should trade');

  const vol = [];
  for (let i = 0; i < 240; i++) vol.push(100 + (i % 2 === 0 ? 3 : -3));
  vol.push(90);
  const noTrade = strat.backtest(mk(vol), { capital: 10000 }, lab.labContext(mk(vol), { k: 4 }));
  assert.strictEqual(noTrade.trades.length, 0, 'uncompressed series must not trade');
});
