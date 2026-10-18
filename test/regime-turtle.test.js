// test/regime-turtle.test.js — TRD-15 candidate gate checks.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const strat = require('../trading/agent/strategies/regimeTurtle');
const lab = require('../trading/agent/lab');

// --- liveSignal gate permutations --------------------------------------------
function sigCtx({ regime, dir, breakUp = true, breakDown = false }) {
  // 25 bars flat at 100, then the latest price breaks the channel.
  const highs = Array(25).fill(100.5);
  const lows = Array(25).fill(99.5);
  const closes = Array(25).fill(100);
  const price = breakUp ? 101 : breakDown ? 99 : 100;
  const prevPrice = 100;
  return { highs, lows, closes, atr14: 1, price, prevPrice, params: {}, openTrade: null, lab: { regime: { adx: regime == null ? null : 30, regime, dir } } };
}

test('liveSignal: entry only on trend regime + direction agreement', () => {
  const up = strat.liveSignal(sigCtx({ regime: 'trend', dir: 'up' }));
  assert.strictEqual(up.type, 'entry');
  assert.strictEqual(up.direction, 'buy');

  const range = strat.liveSignal(sigCtx({ regime: 'range', dir: 'up' }));
  assert.strictEqual(range.type, null);

  const disagreed = strat.liveSignal(sigCtx({ regime: 'trend', dir: 'down' }));
  assert.strictEqual(disagreed.type, null);

  const down = strat.liveSignal(sigCtx({ regime: 'trend', dir: 'down', breakUp: false, breakDown: true }));
  assert.strictEqual(down.type, 'entry');
  assert.strictEqual(down.direction, 'sell');
});

test('liveSignal: fail-secure without harness regime', () => {
  const ctx = sigCtx({ regime: 'trend', dir: 'up' });
  delete ctx.lab;
  assert.strictEqual(strat.liveSignal(ctx).type, null);
  assert.strictEqual(strat.liveSignal({ ...ctx, lab: { regime: null } }).type, null);
});

// --- backtest: causality + direction agreement of every entry ----------------
function trendSeries() {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push({ time: i, open: 100, high: 100.5, low: 99.5, close: 100 });
  for (let i = 30; i < 90; i++) {
    const c = 100 + (i - 29);
    bars.push({ time: i, open: c - 1, high: c + 0.5, low: c - 0.5, close: c });
  }
  return bars;
}

test('backtest: trades only where the bar-causal regime says TREND and direction agrees', () => {
  const bars = trendSeries();
  const ctx = lab.labContext(bars, { k: 4 });
  const raw = strat.backtest(bars, { capital: 10000 }, ctx);
  assert.ok(raw.trades.length >= 1, 'trend series should produce at least one trade');
  const idxByTime = new Map(bars.map((b, i) => [b.time, i]));
  for (const t of raw.trades) {
    const i = idxByTime.get(t.entryTime);
    const flag = ctx.regime[i];
    assert.strictEqual(flag.regime, 'trend', `entry at bar ${i} used a ${flag.regime} regime`);
    assert.strictEqual(flag.dir, t.direction === 'buy' ? 'up' : 'down', 'direction must agree with the regime flag');
  }
});

test('backtest: without lab context the candidate takes no trades (fail-secure)', () => {
  const raw = strat.backtest(trendSeries(), { capital: 10000 }, null);
  assert.strictEqual(raw.trades.length, 0);
});
