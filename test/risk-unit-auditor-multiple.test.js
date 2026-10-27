// test/risk-unit-auditor-multiple.test.js — 2026-10-18: the auditor must read the multiple the ROW was sized by.
//
// WHAT HAPPENED. `risk.atrStopMultiple` was wired into `risk.js` (it had been a dead dial) and then moved 2 -> 4.
// This check kept its own default of 2, and the first sizing event afterwards produced a live `bad`:
//   "sizing arithmetic drifted: baseSize 2.022 vs 4.044 from (equity x riskPct) / (atr x 2 x scale 1.55)"
// The size was correct — exactly half, because the stop doubled.
//
// WHY "READ THE CURRENT SETTING" IS NOT THE FIX. It is wrong in one era whichever way it reads: point it at the
// setting and every historical 2x ticket becomes "drift" the moment the setting moves. The multiple therefore
// travels ON the sizing event (`sizeCalc.atrMultiple`, written by risk.js) and each row is audited against the
// geometry it was actually sized by. Rows predating the field fall back to 2, which is what they were sized at.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { riskUnitArithmetic, riskUnitRealised } = require('../trading/agent/fieldContracts');

const RISK = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');

// (equity * riskPct/100) / (atr * multiple * scale) — the formula the audit re-derives.
const sized = ({ equity = 4000, riskPct = 0.28, atr = 10, multiple = 2, scale = 1 } = {}) => {
  const baseSize = (equity * (riskPct / 100)) / (atr * multiple * scale);
  return { equity, riskPct, atr, baseSize, fx: 1, pointValue: 1, finalSize: 1, atrMultiple: multiple };
};

test('★ the sizer records the multiple it used, so the audit has something to read', () => {
  assert.match(RISK, /^\s*atrMultiple,$/m,
    'risk.js must write atrMultiple into sizeCalc — an auditor cannot infer geometry that was not recorded');
});

test('★ a ticket sized at 4xATR agrees at its own multiple, whatever the caller passes', () => {
  const row = sized({ multiple: 4 });
  assert.deepStrictEqual(riskUnitArithmetic([row], {}).arithmetic, [],
    'a correct 4x ticket must audit clean with no option passed');
  assert.deepStrictEqual(riskUnitArithmetic([row], { stopMultiple: 2 }).arithmetic, [],
    'the ROW wins over a caller-supplied multiple — that is what makes the record era-correct');
});

test('★ and a historical 2xATR ticket still audits clean after the setting moved to 4', () => {
  const legacy = sized({ multiple: 2 });
  delete legacy.atrMultiple;                       // pre-2026-10-18 rows carry no field
  assert.deepStrictEqual(riskUnitArithmetic([legacy], {}).arithmetic, [],
    'absent field falls back to 2, the multiple every such row was sized at');
});

test('★ real drift is still caught in both eras', () => {
  const wrong4 = { ...sized({ multiple: 4 }), baseSize: sized({ multiple: 2 }).baseSize }; // sized as if 2x
  assert.strictEqual(riskUnitArithmetic([wrong4], {}).arithmetic.length, 1,
    'a 4x ticket carrying a 2x size is drift, and must be reported');
  const legacyWrong = { ...sized({ multiple: 2 }), baseSize: 999 };
  assert.strictEqual(riskUnitArithmetic([legacyWrong], {}).arithmetic.length, 1,
    'a legacy row that does not match the legacy formula is still drift');
});

test('★ the realised-risk calculation uses the same per-row multiple', () => {
  // finalSize 1, atr 10, multiple 4, scale 1, equity 4000 -> risk 40/4000 = 1%
  const row = { ...sized({ multiple: 4 }), finalSize: 1 };
  const got = riskUnitRealised(row, {});
  assert.strictEqual(got.source, 'atr');
  assert.strictEqual(got.stopDist, 40);
  assert.ok(Math.abs(got.realisedPct - 1) < 1e-9, `expected 1% realised, got ${got.realisedPct}`);
});

// ★★ THE WINDOW BETWEEN THE SETTINGS MOVE AND THE RELEASE. Rows sized at 4xATR by the PREVIOUS build carry no
// `atrMultiple`, so the strict audit sees "sized at 2, arithmetic says 4" and calls it drift — which is what the
// live check did all through the 2026-10-18 night shift. The size was right; only the record was incomplete.
// That is a RECORDING GAP and it must not be reported as the same finding as real drift.
test('★ a row sized at the CONFIGURED multiple but recording none is a recording gap, not drift', () => {
  const silent = sized({ multiple: 4 });
  delete silent.atrMultiple;
  const { arithmetic, missingMultiple } = riskUnitArithmetic([silent], { configuredMultiple: 4 });
  assert.strictEqual(arithmetic.length, 0, 'this must NOT be reported as drift — the size is correct');
  assert.strictEqual(missingMultiple.length, 1, 'it is reported, as its own finding');
  assert.match(missingMultiple[0], /4xATR/, 'and it names the multiple it was actually sized at');
});

test('★ without the configured multiple it stays strict — no silently widened escape hatch', () => {
  const silent = sized({ multiple: 4 });
  delete silent.atrMultiple;
  const { arithmetic, missingMultiple } = riskUnitArithmetic([silent], {});
  assert.strictEqual(missingMultiple.length, 0, 'no configured value to compare against');
  assert.strictEqual(arithmetic.length, 1, 'the row is still flagged — the check does not weaken by default');
});

test('★ a row matching NEITHER 2 nor the configured value is still drift', () => {
  const odd = { ...sized({ multiple: 4 }), baseSize: sized({ multiple: 3 }).baseSize };
  delete odd.atrMultiple;
  const { arithmetic, missingMultiple } = riskUnitArithmetic([odd], { configuredMultiple: 4 });
  assert.strictEqual(missingMultiple.length, 0, '3xATR is not the configured multiple');
  assert.strictEqual(arithmetic.length, 1, 'so it remains drift');
});
