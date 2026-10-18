// test/trail-tolerance-single.test.js — TRD-TRL-7 (2026-10-01): one quantity, one tolerance.
//
// THE INCOHERENCE. The trail's size is checked TWICE, against the same quantity (`readDistance` vs `expected`),
// with two different tolerances:
//   * the LANDING check ("did the count reach the venue?")  — a hard-coded `Math.max(0.05, |expected| x 0.05)`
//   * the VERIFICATION (`verifyReadback`)                   — `risk.trailingStop.verifyTolerancePct`, i.e. 2
//
// A write landing 2-5% out therefore PASSES the landing check, so the code commits to it, and then FAILS the
// verification, so the entry drops into the fail-safe or aborts. The abort message names the 5% check while the
// decision came from the 2% one — a tolerance mismatch presenting itself as an unexplained miss.
//
// The fix makes the configured tolerance the ONLY knob, and keeps the absolute floor.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const WEB = 'trading/plus500/webtrader.js';

test('★ the landing check no longer hard-codes its own 5%', () => {
  const src = code(WEB);
  // ⚠ THE DEFECT ITSELF. A second, independent tolerance is what created the dead zone; if this line comes back,
  // the two checks can disagree again and the abort will once more name a tolerance it did not use.
  assert.ok(!/\* 0\.05\)/.test(src),
    'the hard-coded 0.05 PERCENTAGE band must be gone — it was the second tolerance');
});

test('★ the band is derived from the CONFIGURED tolerance', () => {
  const src = code(WEB);
  assert.match(src, /Math\.max\(0\.05, Math\.abs\(expected\) \* \(tolPct \/ 100\)\)/,
    'the band must scale by the configured tolerance');
  assert.match(src, /risk\.trailingStop\s*\n?\s*&& settings\.risk\.trailingStop\.verifyTolerancePct|risk\.trailingStop\.verifyTolerancePct/,
    'read from the same setting verifyReadback is given');
  assert.match(src, /const tolPct = Number\.isFinite\(configuredTol\)/,
    'with the same default (2) when the setting is absent, so the two cannot diverge on a missing key');
});

test('★ the absolute floor is KEPT, deliberately', () => {
  const src = code(WEB);
  // Without it the check would be stricter than the venue can render: a few cents of distance is below the
  // display's own resolution, and tightening that would abort entries the control cannot do better on.
  assert.match(src, /Math\.max\(0\.05,/, 'the 0.05 absolute floor must survive the change');
});

test("the verification's tolerance and the landing tolerance come from ONE setting", () => {
  const src = code(WEB);
  // verifyReadback is handed `trailPlan.tolerancePct`, and plan() derives that from the same verifyTolerancePct.
  assert.match(src, /tolerancePct: trailPlan\.tolerancePct/, 'the verification still takes its tolerance from the plan');
  const ts = code('trading/agent/trailingStop.js');
  assert.match(ts, /cfg\.verifyTolerancePct/, 'and the plan derives it from the settings key');
  assert.match(ts, /DEFAULT_TOLERANCE_PCT = 2/, 'whose default is 2 in exactly one place');
});
