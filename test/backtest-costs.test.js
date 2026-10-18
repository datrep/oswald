// test/backtest-costs.test.js — pins the CFD worksheet cost arithmetic.
// Context: 2026-09-10 erratum fix — spread+slippage used to be charged twice
// (price shift + costs line). These tests pin the single-charge basis:
//   spread+slip = entryPrice × (cfdSpreadPct + cfdSlippagePct)% × size × 2
//   swap        = size × entryPrice × cfdSwapDailyPct% × nights
//   net         = midPnl − costs
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const backtest = require('../trading/agent/backtest');

const trade = (over = {}) => ({
  direction: 'buy', size: 1, entryPrice: 100, exitPrice: 110,
  entryTime: '2026-01-01T00:00:00Z', exitTime: '2026-01-02T00:00:00Z',
  nights: 2, pnlMid: 10, reason: 'x', ...over,
});

test('cfd worksheet: spread+slippage charged once per side; swap per night; rows stay at mid', () => {
  const { rows, metrics } = backtest.worksheet([trade()], {}, 'cfd');
  const r = rows[0];
  // spread+slip = 100 × 0.15% × 2 sides = 0.30 ; swap = 100 × 0.02% × 2 nights = 0.04
  assert.strictEqual(r.costs, 0.34);
  assert.strictEqual(r.grossPnl, 10);
  assert.strictEqual(r.netPnl, 9.66);
  assert.strictEqual(r.entryPrice, 100);
  assert.strictEqual(r.exitPrice, 110);
  assert.strictEqual(metrics.netPnl, 9.66);
  assert.strictEqual(metrics.profitFactor, null); // single winning trade -> no losses
});

test('cfd worksheet: sell symmetric; losing trade carries the same cost load', () => {
  const win = backtest.worksheet([trade({ direction: 'sell', exitPrice: 90, nights: 0 })], {}, 'cfd').rows[0];
  assert.strictEqual(win.grossPnl, 10);
  assert.strictEqual(win.costs, 0.3);
  assert.strictEqual(win.netPnl, 9.7);

  const loss = backtest.worksheet([trade({ exitPrice: 98, nights: 0 })], {}, 'cfd').rows[0];
  assert.strictEqual(loss.grossPnl, -2);
  assert.strictEqual(loss.costs, 0.3);
  assert.strictEqual(loss.netPnl, -2.3);
});

test('spot worksheet: fee only, prices at mid', () => {
  const { rows } = backtest.worksheet([trade()], {}, 'spot');
  assert.strictEqual(rows[0].costs, 0.2); // 100 × 0.1% × 2
  assert.strictEqual(rows[0].grossPnl, 10);
  assert.strictEqual(rows[0].netPnl, 9.8);
});

test('cfd worksheet: total round-trip charge equals parameters once (0.30% at defaults), not twice', () => {
  // 100 units at price 10 → notional 1000. Round trip should cost 0.30% × 1000 = 3.00.
  const t = trade({ size: 100, entryPrice: 10, exitPrice: 12, nights: 0, pnlMid: 200 });
  const r = backtest.worksheet([t], {}, 'cfd').rows[0];
  assert.strictEqual(r.grossPnl, 200);
  assert.strictEqual(r.costs, 3);
  assert.strictEqual(r.netPnl, 197);
});
