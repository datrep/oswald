'use strict';
// slipDerivation.test.js — TRD-114. The slippage term was a flat 0.05% charged per side on every symbol, and it is
// 84% of Gold's modelled round-trip budget. These tests pin the two ways the replacement could go wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../trading/agent/slipDerivation');
const backtest = require('../trading/agent/backtest');

const fill = (symbol, slippagePct, spreadRoundTripPct) => ({ symbol, slippagePct, spreadRoundTripPct });

test('residualPct: subtracts the HALF spread, because spreadSubmitPct is a round trip', () => {
  // The measured 0.0100 for Gold against a 0.0194 round trip is 0.0003 beyond the touch.
  assert.ok(Math.abs(d.residualPct({ slippagePct: 0.0100, spreadRoundTripPct: 0.0194 }) - 0.0003) < 1e-9);
});

test('residualPct: an absent or non-positive spread is not a zero', () => {
  assert.strictEqual(d.residualPct({ slippagePct: 0.01, spreadRoundTripPct: null }), null);
  assert.strictEqual(d.residualPct({ slippagePct: null, spreadRoundTripPct: 0.02 }), null);
  assert.strictEqual(d.residualPct({ slippagePct: 0.01, spreadRoundTripPct: 0 }), null);
});

test('deriveSlipBasis: a fill inside the spread yields a ZERO cost, and keeps the negative on the record', () => {
  // A negative cost is the most permissive budget this codebase can express. The raw median is retained so the
  // zeroing is visible rather than silent.
  const rows = Array.from({ length: 25 }, () => fill('Gold', 0.0100, 0.0300)); // slip < half (0.0150)
  const out = d.deriveSlipBasis(rows);
  assert.equal(out.basis.Gold.pct, 0);
  assert.ok(out.basis.Gold.rawMedianPct < 0, `raw median should stay negative, got ${out.basis.Gold.rawMedianPct}`);
});

test('deriveSlipBasis: refuses a thin symbol BY NAME rather than pricing it from six fills', () => {
  const rows = Array.from({ length: 6 }, () => fill('Soybeans', 0.0700, 0.0952));
  const out = d.deriveSlipBasis(rows);
  assert.strictEqual(out.basis.Soybeans, undefined);
  assert.deepStrictEqual(out.refused.below_min_fills, ['Soybeans']);
  assert.equal(out.results[0].reason, 'below_min_fills');
});

test('deriveSlipBasis: the measured majors price at approximately zero beyond the touch', () => {
  // The live 120-day medians: Gold 0.0100/0.0097, Silver 0.0600/0.0592, Ethereum 0.1100/0.1250.
  const rows = [
    ...Array.from({ length: 21 }, () => fill('Gold', 0.0100, 0.0194)),
    ...Array.from({ length: 37 }, () => fill('Silver', 0.0600, 0.1184)),
    ...Array.from({ length: 30 }, () => fill('Ethereum', 0.1100, 0.2500)),
  ];
  const out = d.deriveSlipBasis(rows);
  for (const s of ['Gold', 'Silver', 'Ethereum']) {
    assert.ok(out.basis[s].pct <= 0.001, `${s} residual should be <= 0.001, got ${out.basis[s].pct}`);
  }
});

test('costCfgFor: the flat placeholder is used ONLY where nothing was measured, and says so', () => {
  const seeded = backtest.setSlipDerivation({ derived: { Gold: { pct: 0.0003, n: 21 } }, provenance: { days: 120 } });
  assert.equal(seeded, 1);
  const gold = backtest.costCfgFor('Gold');
  assert.equal(gold.cfdSlippagePct, 0.0003);
  assert.equal(gold.costModelBasis.slippage, 'derived_fill_telemetry');
  assert.equal(gold.costModelBasis.slippageSample, 21);

  // Silver was not measured: it keeps the placeholder AND its label. Two runs must never look alike.
  const silver = backtest.costCfgFor('Silver');
  assert.equal(silver.cfdSlippagePct, backtest.CALIBRATED_SLIP_PCT);
  assert.equal(silver.costModelBasis.slippage, 'calibrated_placeholder');

  // ⚠ AND THE ROUND TRIP SHRINKS TO THE SPREAD, which is the whole point of TRD-114.
  const before = 2 * (backtest.CALIBRATED_SPREAD_HALF_PCT.Gold + backtest.CALIBRATED_SLIP_PCT) * 100;
  const after = 2 * (gold.cfdSpreadPct + gold.cfdSlippagePct) * 100;
  assert.ok(after < before * 0.25, `Gold's budget should collapse from ${before} bps, got ${after}`);

  backtest.setSlipDerivation({});   // leave the module as it was found
});
