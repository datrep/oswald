// test/cost-calibration.test.js — TRD-25 pins:
//   - per-instrument cost calibration (costCfgFor: v2 values, v1-flat fallback,
//     override precedence DEFAULTS -> calibration -> caller overrides);
//   - calendar-true nights (UTC day-boundary crossings) in the strategies.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const backtest = require('../trading/agent/backtest');
const { nightsBetween } = require('../trading/agent/time');
const turtle = require('../trading/agent/strategies/turtleUltimate');

test('costCfgFor: calibrated symbol gets v2 spread/slip + version marker', () => {
  const c = backtest.costCfgFor('Gold');
  assert.strictEqual(c.cfdSpreadPct, 0.0097);
  assert.strictEqual(c.cfdSlippagePct, 0.05);
  assert.strictEqual(c.costModelVersion, 'v2');
  const s = backtest.costCfgFor('SGX');
  assert.strictEqual(s.cfdSpreadPct, 0.2507);
});

test('costCfgFor: unlisted symbol falls back to v1-flat (no cost keys)', () => {
  const c = backtest.costCfgFor('NotASymbol');
  assert.deepStrictEqual(c, { costModelVersion: 'v1-flat' });
  assert.strictEqual(c.cfdSpreadPct, undefined);
});

test('cost precedence: explicit caller override wins over calibration', () => {
  const cfg = { ...backtest.DEFAULTS, ...backtest.costCfgFor('Gold'), ...{ cfdSpreadPct: 0.2 } };
  assert.strictEqual(cfg.cfdSpreadPct, 0.2);
  assert.strictEqual(cfg.cfdSlippagePct, 0.05, 'slip stays calibrated when only spread overridden');
});

test('nightsBetween: UTC day-boundary crossings', () => {
  const D = 86400000;
  const base = Date.UTC(2026, 8, 11, 0, 0, 0); // 2026-09-11T00:00Z
  assert.strictEqual(nightsBetween(base, base), 0, 'same instant');
  assert.strictEqual(nightsBetween(base, base + 23 * 3600000), 0, 'same UTC day');
  assert.strictEqual(nightsBetween(base, base + 25 * 3600000), 1, 'crosses one midnight');
  assert.strictEqual(nightsBetween(base, base + 3600000), 0, 'one hour inside a day crosses nothing');
  assert.strictEqual(nightsBetween(base, base + 3.2 * D), 3, 'three midnights and change');
  assert.strictEqual(nightsBetween(base, base), 0, 'equal');
  assert.strictEqual(nightsBetween(base + D, base), 0, 'reversed');
});

test('strategies emit calendar-true nights (wiring check on a synthetic round trip)', () => {
  // 200-bar ramp up then a sharp fall -> breakout entry + trailing-stop exit.
  const bars = [];
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0);
  for (let i = 0; i < 260; i++) {
    const close = i < 200 ? 100 + i : 100 + 199 - (i - 199) * 4;
    bars.push({ open: close, high: close + 0.5, low: close - 0.5, close, time: new Date(t0 + i * 3600000) });
  }
  const raw = turtle.backtest(bars, { capital: 10000 });
  assert.ok(raw.trades.length >= 1, `expected at least one trade, got ${raw.trades.length}`);
  for (const t of raw.trades) {
    assert.strictEqual(t.nights, nightsBetween(t.entryTime, t.exitTime), `nights for trade ${t.entryTime} -> ${t.exitTime}`);
  }
});
