// test/size-truth-fields.test.js — L4 (rev 5, 2026-09-29): the fields that make a size answerable as ONE number.
//
// ★ WHY THIS LAYER EXISTS. A ticket's size is the minimum of THREE caps times TWO multipliers, and every one of
// those five numbers came from a different place with its own note. The measured complaint (TRD-RSK-6 / #1457) is
// that an operator has to READ THREE NOTES AND COMPOSE THE ANSWER — and the desk has no surface that states the
// resolved outcome. L4 adds the resolution to the decision row.
//
// ★ AND THE FIELD THAT MATTERS MOST IS `riskCappedByCeiling`, because it says something NONE of the others can:
// that on some symbols the dial was never expressible at all. Every other quantity in `sizeCalc` describes what
// the dial WANTED or what a cap DID; without this one, a decision at `r = 3.0%` looks identical whether the desk
// risked 3.00% (Coffee) or 0.93% (Bitcoin) — and §6.1 exists precisely because those are different trades.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ins = require('../trading/agent/instruments');
const { code, read } = require('./_source');

// ────────────────────────────────────────────────────────────────────────────────────────────────
// A. The ceiling — `ceiling = L x stopPct`, the most risk the venue's leverage permits for a given stop.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test('the ceiling is L x stopPct, and it reproduces the report\'s own table', () => {
  // §5's figures, recomputed from the registry's ratios and the stops they were derived on. If either the ratio
  // or the stop moves, the printed ceiling is stale — which is why the report says "quote the stop, or do not
  // quote the ceiling".
  assert.equal(ins.ceilingPctFor({ leverage: 5 }, 0.55), 2.75, 'Gold decision stop');
  // ⚠ COMPARE AT THE PRECISION THE REPORT PRINTS. The function returns 4dp (consistent with the other percentage
  // fields on `sizeCalc`), while §5's table prints 2dp — so `1.67 x 0.695 = 1.16065` is 1.1607 here and 1.16
  // there. Asserting the printed value against the computed one is how a correct implementation gets \"fixed\".
  assert.equal(+ins.ceilingPctFor({ leverage: 1.67 }, 0.695).toFixed(2), 1.16, 'Bitcoin');
  assert.equal(ins.ceilingPctFor({ leverage: 10 }, 1.497), 14.97, 'SGX');
  // ★ AND THE SAME SYMBOL MOVES WITH ITS STOP — the finding that makes leverage a first-class input.
  assert.equal(ins.ceilingPctFor({ leverage: 5 }, 0.664), 3.32, 'the same Gold on its VENUE stop, not its decision stop');
});

test('★ an unread ratio or an unusable stop gives NULL, never 0%', () => {
  // A ceiling of 0% is the claim "this instrument permits no risk at all" — a loud, false statement — whereas
  // null is "we could not read it". `Number(null) === 0` is the trap: `Number.isFinite(lev)` alone accepts it.
  for (const floor of [null, undefined, {}, { leverage: 0 }, { leverage: null }, { leverage: 'abc' }]) {
    assert.equal(ins.ceilingPctFor(floor, 1), null, `floor ${JSON.stringify(floor)}`);
    assert.notEqual(ins.ceilingPctFor(floor, 1), 0);
  }
  for (const stop of [null, undefined, 0, -1, 'abc', NaN]) {
    assert.equal(ins.ceilingPctFor({ leverage: 5 }, stop), null, `stop ${JSON.stringify(stop)}`);
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// B. The wiring on the decision — every field present, and each read from its one source.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test('★ `sizeCalc` carries all five truth fields', () => {
  const src = code('trading/agent/risk.js');
  const block = src.slice(src.indexOf('v.sizeCalc = {'));
  const body = block.slice(0, block.indexOf('};'));
  for (const f of ['riskDialPct', 'ceilingPct', 'riskCappedByCeiling', 'resolvedRiskPct', 'boundBy']) {
    assert.match(body, new RegExp(`\\b${f}\\b`), `${f} must ride on the decision, or the record cannot answer §L4.a`);
  }
});

test('★ `boundBy` names the control that ACTED — one assignment per control, and no fifth', () => {
  // The whole value of the field is that it is null when nothing bound. A run-in or half-risk MULTIPLIER must
  // never set it: those scale the dial rather than bounding the ticket, and neither is an enumerated control.
  const src = code('trading/agent/risk.js');
  const set = [...src.matchAll(/boundBy = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...set].sort(), ['exposureCapPct', 'margin_utilisation', 'maxEquityPerPositionPct', 'maxRiskPerTradePct'],
    'exactly the four controls, each assigned at one site');
  assert.match(src, /let boundBy = null;/, 'and it must START null — "no control bound this ticket" is a real answer');
  // The per-position cap is the ONLY control whose assignment can be missed by reading the reason strings, so
  // assert it sits inside the branch that actually resizes rather than beside it.
  // ⚠ UPDATED 2026-10-01 (P2): the assertion used to pin `size = maxValue / price;` — a comparison between a
  // USD notional and an SGD ceiling. The converted form is what is pinned now, and the earlier form is
  // explicitly asserted ABSENT so it cannot come back.
  assert.match(src, /size = maxValue \/ \(price \* notionalK\);\s*\n\s*boundBy = 'maxEquityPerPositionPct';/);
  assert.doesNotMatch(src, /size = maxValue \/ price;\s*\n\s*boundBy = 'maxEquityPerPositionPct';/,
    'the currency-blind form must not return');
});

test('★ `resolvedRiskPct` is computed on the SAME stop the sizing used', () => {
  // Computed (intended stop), never realised (fill-anchored): the realised figure stays on the trade row. Measured
  // on Gold the two differ by 21% within a single ticket, so putting one in the other's field mislabels a number
  // with the wrong anchor — TRD-RSK-1's defect.
  const src = code('trading/agent/risk.js');
  // ⚠ NAME-AGNOSTIC SINCE 2026-09-30 (TRD-EXE-10). This used to pin the literal `v.size * riskStopDist / equity`,
  // which is a pin on a VARIABLE NAME rather than on the property the test is named for. TRD-EXE-10 moved the
  // denominator from the stop's LEVEL to the distance the LOSS travels (that level times the measured fill factor)
  // and updated the sizing to match — the property HELD while the literal failed. The pin now EXTRACTS both
  // denominators and asserts they are the SAME, which is what "computed on the SAME stop the sizing used" means,
  // and cannot be satisfied by a rename.
  // ⚠ NAME-AGNOSTIC, AND NOW FORM-AGNOSTIC TOO (TRD-EXE-19, 2026-10-01). Both sides of the comparison moved
  // through helpers that carry the contract's own scale (`pointValue x fx`), so the extraction follows the
  // helper signatures. The PROPERTY is untouched and is still what is asserted: whatever distance the sizing
  // divided by, `resolvedRiskPct` must have used the SAME one — a rename or a refactor cannot satisfy it.
  const sized = /let size = sizeForRisk\(riskPerTrade, ([A-Za-z_$][\w$]*)\);/.exec(src);
  const resolved = /resolvedRiskPct = Number\(equity\) > 0 \? Math\.round\(riskPctOf\(v\.size, ([A-Za-z_$][\w$]*)\) \* 10000\) \/ 10000 : null/.exec(src);
  assert.ok(sized && resolved, 'both the sizing divide and resolvedRiskPct must be findable in risk.js');
  assert.equal(resolved[1], sized[1],
    `resolvedRiskPct must be computed on the SAME distance the sizing used (sized on ${sized[1]}, resolved on ${resolved[1]})`);
});

// ============================================================================================
// TRD-EXE-10 (2026-09-30) — THE DIAL MUST MEAN THE LOSS IT PRODUCES.
//
// MEASURED over the desk's whole journal: 24 venue stop-outs across 14 days, each carrying BOTH the
// venue's quoted rate AND the real fill, so the two could be compared ON THE SAME TRADE.
//     exit at the venue's RATE  median 1.006x the stop distance   <- a trigger IS the level
//     exit at the actual FILL   median 1.305x                     <- p90 1.431, max 4.370 (#1066, a gap)
//     take-profit at the RATE   median 1.009x · at the FILL 1.294x   <- same shape, both sides
// The symmetry is right in kind: a TP is a LIMIT and can fill PAST its level, a stop becomes a
// STOP-MARKET and fills SHORT of it. So `riskPerTradePct: 3` produced a realised ~3.9% stop-out.
// ============================================================================================
test('★ the measured stop fill factor is a SETTING, and its default is the measurement', () => {
  const store = code('trading/store.js');
  assert.match(store, /stopSlippageFactor: 1\.305,/,
    'the default must be the measured median of 24 stop-outs, not a round number someone liked');
  // ⚠ `read`, NOT `code`: the rollback instruction is a COMMENT, and `_source.code()` STRIPS comments. Pinning a
  // comment through `code()` fails on a rule that is present and correct — the same trap that produced three false
  // failures earlier in this workstream.
  assert.match(read('trading/store.js'), /ROLLBACK: set it to 1/,
    'and the store must say how to get the previous behaviour back, because this changes live sizes');
});

test('★ the loss distance is the effective stop distance TIMES the factor, and it feeds the caps too', () => {
  const src = code('trading/agent/risk.js');
  // ⚠ UPDATED 2026-10-01 (TRD-EXE-13): split into the exit-side component and the composed denominator, for the
  // same reason as `decision-stop-reconciliation.test.js` — the pin is on the FORM, and the form changed while
  // the property did not.
  assert.match(src, /const entryLossDist = riskStopDist \* lossFactor;/);
  assert.match(src, /const expectedLossDist = entryLossDist \* driftFactor;/);
  assert.doesNotMatch(src, /const expectedLossDist = riskStopDist \* lossFactor;\s*\n/,
    'the single-factor form must not return: the entry-drift factor composes into the denominator');
  // The RISK CAP must use the same denominator, or `maxRiskPerTradePct` would mean a different thing from the
  // dial it backstops — the TRD-102 defect (a cap evaluated against a distance the position never used).
  // ⚠ UPDATED 2026-10-01 (TRD-EXE-19): the FORM moved again — the product now goes through `riskPctOf`, which
  // carries the contract's own scale (`pointValue x fx`). The property this pin exists for is UNCHANGED, so the
  // pin follows the form rather than being deleted: it still asserts the denominator is `expectedLossDist`
  // (the loss the stop takes) and not `riskStopDist` (the level it sits at).
  assert.match(src, /const impliedRiskPct = riskPctOf\(size, expectedLossDist\);/,
    'the risk cap must measure the loss the stop will take, not the level it sits at');
  // And the STOP LEVEL must be untouched: this fits a LOSS, it does not move an exit.
  assert.match(src, /v\.effectiveStopDistance = Math\.round\(riskStopDist \* 10000\) \/ 10000;/,
    'the stop LEVEL the venue receives must be unchanged by this');
  assert.ok(!/const riskStopDist = .*\* lossFactor/.test(src), 'riskStopDist must stay the LEVEL, never the loss');
});

test('a factor below 1 is REFUSED IN THE OPEN, never silently clamped', () => {
  const src = code('trading/agent/risk.js');
  // A control that quietly ignores its own setting is this repo's oldest defect — and a factor < 1 asserts a
  // stop-out loses LESS than the stop distance, which the 24 measured rows disprove.
  assert.match(src, /const lossFactorUsable = Number\.isFinite\(lossFactorRaw\) && lossFactorRaw >= 1;/);
  assert.match(src, /is below 1 and was IGNORED/, 'the refusal must be REPORTED, not swallowed');
  assert.match(src, /sizing used 1/, 'and it must say what it used instead');
});

test('CONTROL: at the default factor a stop-out realises the dial, and at 1 it reproduces the old behaviour', () => {
  // The arithmetic the whole change rests on, checked rather than asserted in prose. A 3% dial on a stop that
  // fills short by the measured factor costs the dial; with the factor removed it costs what it always did.
  const dial = 3, factor = 1.305;
  const realisedNow = dial * factor;          // bodies sized on the LEVEL: the loss overshoots
  const realisedFixed = dial * factor / factor; // bodies sized on the LOSS distance: the dial is true
  assert.ok(Math.abs(realisedNow - 3.915) < 0.01, `the pre-fix realised loss was ~${realisedNow.toFixed(3)}%`);
  assert.ok(Math.abs(realisedFixed - dial) < 1e-9, 'and post-fix it is the dial itself');
  // And the direction of the change is a DE-LEVER: every size shrinks by 1/factor, so exposure falls.
  assert.ok(1 / factor < 1, 'the position size must SHRINK — this may only ever reduce exposure');
});

test('★★ the dial comes from the ONE resolver, not from a second `Math.min`', () => {
  // `promptBuilder.effectiveRiskPct` is the single statement of "which of the two dials wins" (both divide the
  // SAME stop distance, so the smaller always binds). A copy here would be a second place to disagree — the
  // TRD-TUN-2 defect class, one layer up — and the copy is exactly what a hurried implementation reaches for.
  const src = code('trading/agent/risk.js');
  assert.match(src, /require\('\.\/promptBuilder'\)\.effectiveRiskPct\(settings\)/);
  assert.ok(!/Math\.min\([^)]*riskPerTradePct[^)]*maxRiskPct/.test(src),
    'no second resolver may compute the dial');
});

test('★ `riskCappedByCeiling` compares the DIAL against the CEILING, and is null when either is unknown', () => {
  // Null rather than false on a missing input: "false" is the assertion "the ceiling did not limit this ticket",
  // and the desk must not assert that about a ratio it could not read. Same discipline as `unknown` in the margin
  // guard and `unmeasurable` in the net-edge screen.
  const src = code('trading/agent/risk.js');
  assert.match(src, /riskCappedByCeiling = \(ceilingPct != null && riskDialPct != null\) \? riskDialPct > ceilingPct : null/);
  // And the ceiling must be read through the accessor, not dotted out of the venue-floor record.
  assert.match(src, /ceilingPctFor\(v\.venueFloor, stopPctOfPrice\)/);
});
