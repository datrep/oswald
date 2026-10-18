// ★★ TRD-EXE-19b (2026-10-02) — THE AUDITOR IS A CALL SITE OF THE FORMULA IT AUDITS.
//
// THE DEFECT, AND HOW IT SURFACED. Adding `notionalK` to `baseSize` in `risk.js` made `fieldContracts.riskUnit`
// disagree with its own independent re-derivation of that same number — on EVERY decision, by exactly `fx`.
// Measured live the morning after: `baseSize 3.937 vs 6.102`, ratio **1.5500**. It fired a `bad` self-health
// check within hours. No test caught it, because the test suite pins `risk.js` and the auditor separately and
// nobody had asked them to agree.
//
// ⚠ SO THIS FILE'S JOB IS THE AGREEMENT, NOT THE ARITHMETIC. It asserts that the checker's re-derivation moves
// with the same scales the writer divides by — and, equally, that it does NOT move for rows written before the
// change, which were sized without a scale and must keep being audited against the formula they used.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fc = require('../trading/agent/fieldContracts');
const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const contracts = nl(code('trading/agent/fieldContracts.js'));
const riskSrc = nl(code('trading/agent/risk.js'));

// A row shaped exactly as `risk.js` writes `sizeCalc` around the change.
const base = { equity: 3943.23, riskPct: 3.6, atr: 2.9667, finalSize: 10 };

test('★ a scaled row is audited WITH its scale — the 1.5500 discrepancy that fired live', () => {
  const plain = fc.riskUnitRealised({ ...base }, { stopMultiple: 2 });
  const scaled = fc.riskUnitRealised({ ...base, fx: 1.55, pointValue: 1 }, { stopMultiple: 2 });
  assert.equal(plain.source, 'atr');
  assert.equal(scaled.source, 'atr');
  // The realised risk of the SAME size is 1.55x larger once the instrument's currency is converted — which is
  // precisely what the checker was failing to see.
  assert.ok(Math.abs(scaled.realisedPct / plain.realisedPct - 1.55) < 1e-9,
    `expected exactly fx (1.55), got ${scaled.realisedPct / plain.realisedPct}`);
});

test('★ TRADING ROSE: fx AND pointValue COMPOSE — the Soybeans-shaped row (0.01 x 1.55)', () => {
  const plain = fc.riskUnitRealised({ ...base }, { stopMultiple: 2 });
  const soy = fc.riskUnitRealised({ ...base, fx: 1.55, pointValue: 0.01 }, { stopMultiple: 2 });
  assert.ok(Math.abs(soy.realisedPct / plain.realisedPct - 0.0155) < 1e-9,
    'the two scales multiply, and a cents-quoted instrument divides the realised risk by 100');
});

test('★★ ERA RULE: a row written BEFORE the change carries no scales and must audit UNCHANGED', () => {
  // This is the assertion that makes a historic verdict safe. `1` is both the identity and the era rule; if a
  // missing key were treated as anything but 1, every back-catalogue row would silently change verdict.
  const plain = fc.riskUnitRealised({ ...base }, { stopMultiple: 2 });
  for (const absent of [{}, { fx: undefined, pointValue: undefined }, { fx: null, pointValue: null }, { fx: 0, pointValue: 0 }]) {
    const row = fc.riskUnitRealised({ ...base, ...absent }, { stopMultiple: 2 });
    assert.equal(row.realisedPct, plain.realisedPct, `${JSON.stringify(absent)} must be the identity`);
  }
});

test('★ the `stop widened` branch carries the scale too — it is the same product, one branch over', () => {
  // The sweep that fixed `baseSize` would have missed this the same way, so it is pinned by value: the branch's
  // denominator is the REASON string's stop, and its numerator is still `finalSize x stopDist`.
  const row = { ...base, finalSize: 10, reasons: ['stop widened to 3x spread (0.3390 > 2xATR 0.0556)'] };
  const plain = fc.riskUnitRealised(row, { stopMultiple: 2 });
  const scaled = fc.riskUnitRealised({ ...row, fx: 2, pointValue: 1 }, { stopMultiple: 2 });
  assert.equal(plain.source, 'reason:widened');
  assert.equal(scaled.source, 'reason:widened');
  assert.ok(Math.abs(scaled.realisedPct / plain.realisedPct - 2) < 1e-9, 'the widened branch must scale as well');
});

test('the figure risk.js itself wrote is still preferred, and is ALREADY scaled', () => {
  // So it must NOT be multiplied again — double-scaling here would be a new defect introduced by this fix.
  const row = fc.riskUnitRealised({ ...base, fx: 1.55, pointValue: 1, resolvedRiskPct: 1.8 }, { stopMultiple: 2 });
  assert.equal(row.source, 'resolvedRiskPct');
  assert.equal(row.realisedPct, 1.8, 'the value risk.js wrote is used verbatim, never re-scaled');
});

test('★ WRITER and CHECKER are pinned together: both name the scales, and only one owns each factor', () => {
  // The writer emits the INPUTS; the checker consumes them. Pinned as a pair so a future change to one that is
  // not made to the other fails here rather than live.
  assert.match(riskSrc, /fx: Number\(fx\) > 0 \? Number\(fx\) : 1,/, 'risk.js must emit fx');
  assert.match(riskSrc, /pointValue: Number\(pointValue\) > 0 \? Number\(pointValue\) : 1,/, 'risk.js must emit pointValue');
  assert.match(contracts, /function scaleOf\(row\)/, 'the checker must derive the scale from those inputs');
  assert.match(contracts, /\/ \(stopDist \* scaleOf\(s\)\)/, 'and apply it to the baseSize it re-derives');
  const scaled = (contracts.match(/scaleOf\(/g) || []).length;
  assert.ok(scaled >= 4, `expected the definition plus three uses, found ${scaled} occurrences of scaleOf(`);
});
