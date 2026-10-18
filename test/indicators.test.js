// test/indicators.test.js — offline unit checks for trading indicators (TRD-9 H).
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ind = require('../trading/agent/indicators');

test('sma: exact value + short-series null', () => {
  assert.strictEqual(ind.sma([1, 2, 3, 4, 5], 3), 4);
  assert.strictEqual(ind.sma([1, 2], 3), null);
  assert.strictEqual(ind.sma(null, 3), null);
});

test('ema: seeded from first bar', () => {
  assert.ok(Math.abs(ind.ema([1, 2, 3], 3) - 2.25) < 1e-9);
});

test('rsi: monotonic series hit the bounds', () => {
  const up = Array.from({ length: 20 }, (_, i) => i + 1);
  const down = Array.from({ length: 20 }, (_, i) => 20 - i);
  assert.strictEqual(ind.rsi(up), 100);
  assert.strictEqual(ind.rsi(down), 0);
  assert.strictEqual(ind.rsi([1, 2]), null); // needs period+1 bars
});

test('bollinger: ordering and bandwidth', () => {
  const bb = ind.bollinger([1, 2, 3, 4, 5], 5, 2);
  assert.ok(bb);
  assert.ok(bb.upper > bb.mid && bb.mid > bb.lower);
  assert.ok(bb.bandwidth > 0);
  assert.strictEqual(ind.bollinger([1, 2], 5), null);
});

test('macd: constant series = 0 line and signal', () => {
  const mc = ind.macd(Array(40).fill(100), 12, 26, 9);
  assert.ok(mc);
  assert.ok(Math.abs(mc.macd) < 1e-9);
  assert.ok(Math.abs(mc.signal) < 1e-9);
  assert.ok(Math.abs(mc.hist) < 1e-9);
});

test('stochastic: flat series = 50/50', () => {
  const st = ind.stochastic(Array(20).fill(10), Array(20).fill(0), Array(20).fill(5), 14, 3);
  assert.ok(st);
  assert.strictEqual(st.k, 50);
  assert.strictEqual(st.d, 50);
});

test('legacy indicators still exported', () => {
  for (const fn of ['trueRange', 'atr', 'adx', 'donchian', 'correlation']) {
    assert.strictEqual(typeof ind[fn], 'function', `${fn} missing`);
  }
});
