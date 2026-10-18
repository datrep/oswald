// test/mtf-trend.test.js — TRD-19 multi-TF candidate gate checks.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const strat = require('../trading/agent/strategies/mtfTrend');
const lab = require('../trading/agent/lab');

test('dirOfBlocks: direction, null for short/equal/flat', () => {
  const up = Array.from({ length: 6 }, (_, i) => ({ close: 100 + i }));
  assert.strictEqual(strat.dirOfBlocks(up, 5), 'up');
  const down = Array.from({ length: 6 }, (_, i) => ({ close: 100 - i }));
  assert.strictEqual(strat.dirOfBlocks(down, 5), 'down');
  assert.strictEqual(strat.dirOfBlocks(up, 6), null); // not enough blocks
  assert.strictEqual(strat.dirOfBlocks(Array.from({ length: 6 }, () => ({ close: 100 })), 5), null); // flat
});

test('liveSignal: breakout fires only with block-trend agreement', () => {
  const highs = Array(35).fill(100.5);
  const lows = Array(35).fill(99.5);
  const closes = Array(35).fill(100);
  const base = { highs, lows, closes, atr14: 1, price: 101, prevPrice: 100, params: {}, openTrade: null };
  const upBlocks = Array.from({ length: 11 }, (_, i) => ({ close: 100 + i }));
  const downBlocks = Array.from({ length: 11 }, (_, i) => ({ close: 100 - i }));

  const hit = strat.liveSignal({ ...base, lab: { barsK: upBlocks } });
  assert.strictEqual(hit.type, 'entry');
  assert.strictEqual(hit.direction, 'buy');

  const blocked = strat.liveSignal({ ...base, lab: { barsK: downBlocks } });
  assert.strictEqual(blocked.type, null);

  const noBlocks = strat.liveSignal({ ...base, lab: { barsK: [] } });
  assert.strictEqual(noBlocks.type, null);
});

test('backtest: a rising series produces only aligned (buy) entries after warmup', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push({ time: i, open: 100, high: 100.5, low: 99.5, close: 100 });
  for (let i = 40; i < 140; i++) {
    const c = 100 + (i - 39);
    bars.push({ time: i, open: c - 1, high: c + 0.5, low: c - 0.5, close: c });
  }
  const ctx = lab.labContext(bars, { k: 4 });
  const raw = strat.backtest(bars, { capital: 10000 }, ctx);
  assert.ok(raw.trades.length >= 1, 'rising series should trade');
  assert.ok(raw.trades.every((t) => t.direction === 'buy'), 'all entries must agree with the up-trending blocks');
});

test('backtest: without lab context the candidate takes no trades (fail-secure)', () => {
  const bars = Array.from({ length: 140 }, (_, i) => ({ time: i, open: 100 + i, high: 100 + i + 1, low: 100 + i - 1, close: 100 + i }));
  const raw = strat.backtest(bars, { capital: 10000 }, null);
  assert.strictEqual(raw.trades.length, 0);
});
