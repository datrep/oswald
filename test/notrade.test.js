// test/notrade.test.js — TRD-23 no-trade convention checks.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { counterfactual } = require('../trading/agent/lab/notrade');

test('counterfactual: net = losses avoided - gains forgone', () => {
  const r = counterfactual([{ pnl: -100 }, { pnl: 40 }, { pnl: -60 }, { pnl: 10 }], 20);
  assert.strictEqual(r.lossesAvoided, 160);
  assert.strictEqual(r.gainsForgone, 50);
  assert.strictEqual(r.net, 110);
  assert.strictEqual(r.pass, true);
});

test('counterfactual: coverage cap blocks the "stand down everywhere" trick', () => {
  // Huge avoided losses but 100% coverage -> FAIL on coverage.
  const r = counterfactual([{ pnl: -1000 }], 100);
  assert.strictEqual(r.net, 1000);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.verdict, 'FAIL (coverage > 40%)');
});

test('counterfactual: negative net fails regardless of coverage', () => {
  const r = counterfactual([{ pnl: 500 }, { pnl: -100 }], 10);
  assert.strictEqual(r.net, -400);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.verdict, 'FAIL (net <= 0)');
});

test('counterfactual: boundary at exactly 40% coverage passes when net > 0', () => {
  const r = counterfactual([{ pnl: -10 }], 40);
  assert.strictEqual(r.pass, true);
});
