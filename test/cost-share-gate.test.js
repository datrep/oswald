// TRD-114 — the venue round trip as a share of the risk unit is now gated.
//
// THREE THINGS ARE PINNED HERE, and the third is the one that protects an earlier fix from being undone:
//   1. The ceiling names the quantity it controls. `maxAdverseCostMultiple: 1.5` was ALWAYS a cost-share
//      ceiling (cap >= 1.5 x costPct is the same inequality as costPct/stopPct <= 66.7%) — it just never
//      said so, and nobody chose 66.7%. The new dial reports which source supplied the number.
//   2. The share is INVARIANT TO SIZE, so a breach cannot be resized away; the only honest action is a
//      refusal, and the verdict is a pure function so its truth table is pinned rather than inferred.
//   3. ⚠ THE CEILING MUST NEVER CHANGE THE STOP THE VENUE RECEIVES. Tightening a stop RAISES the share (the
//      round trip is a fixed % of price, so it is a larger % of a smaller R), so a ceiling that "fixed" a
//      breach by tightening would push the share the wrong way — and one that widened the stop would undo
//      TRD-98's cap, the measured-best lever (-28.89 net at 0.30% vs -46.93 at 0.40%). This is the
//      regression pin: setting or removing the ceiling must leave `stopDist` bit-identical.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { costCeiling, costShareOf, costShareCheck, cappedStopDistance } =
  require('../trading/agent/stopPolicy');

// Gold's real numbers, 2026-09-21: round trip 11.94 bps (0.1194%), price 4400, declared 2xATR 18.078
// DOLLARS (0.411% of price), live cap 0.30% of price = 13.2 dollars. NOTE THE UNITS: `declaredStopDist`
// is a PRICE distance, `maxAdversePct` is a percentage of price, and `costShareCheck` takes a percentage.
// Getting that wrong is how the first version of this file produced a 1014% cost share.
const GOLD = { risk: { maxAdversePct: 0.3, maxCostShareOfR: 0.65 } };
const PX = 4400;
const pctOf = (dollars) => (dollars / PX) * 100;

// ---------------------------------------------------------------------------------------------
// 1. The ceiling, and where it came from
// ---------------------------------------------------------------------------------------------
test('the ceiling is the dial that names the quantity, with its source reported', () => {
  assert.deepEqual(costCeiling({ risk: { maxCostShareOfR: 0.25 } }), { share: 0.25, from: 'maxCostShareOfR' });
  const legacy = costCeiling({ risk: { maxAdverseCostMultiple: 1.5 } });
  assert.equal(legacy.from, 'maxAdverseCostMultiple (legacy)');
  assert.ok(Math.abs(legacy.share - 2 / 3) < 1e-9,
    '1.5x cost IS a 66.7% ceiling — the number nobody chose, now nameable');
});

test('the named dial wins over the legacy multiple, and junk falls back rather than disabling the rule', () => {
  const both = costCeiling({ risk: { maxCostShareOfR: 0.2, maxAdverseCostMultiple: 10 } });
  assert.equal(both.share, 0.2);
  for (const bad of [0, -1, 'abc', NaN, null, undefined]) {
    const r = costCeiling({ risk: { maxCostShareOfR: bad } });
    assert.ok(Math.abs(r.share - 2 / 3) < 1e-9, `${String(bad)} must fall back to the legacy ceiling`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. The share, and the verdict
// ---------------------------------------------------------------------------------------------
test('the share is costPct/stopPct and does NOT depend on size', () => {
  assert.equal(costShareOf({ costPct: 0.1194, stopPct: 0.3 }), 0.1194 / 0.3);
  // Oil's live number, from the row: the round trip was 60.8% of the risk unit.
  assert.ok(Math.abs(costShareOf({ costPct: 0.1728, stopPct: 0.284 }) - 0.6084) < 0.001);
});

test('a missing cost basis yields NO verdict rather than a pass', () => {
  assert.equal(costShareOf({ costPct: null, stopPct: 0.4 }), null);
  assert.equal(costShareOf({ costPct: 0.1, stopPct: 0 }), null);
  assert.equal(costShareCheck({ costPct: null, stopPct: 0.4, settings: GOLD }), null,
    'the rule cannot run on an unknown basis — it must say so, never assume a cost of zero');
});

test('the ceiling is a CEILING: at it is fine, over it is not', () => {
  const s = { risk: { maxCostShareOfR: 0.65 } };
  assert.equal(costShareCheck({ costPct: 0.1194, stopPct: 0.3, settings: s }).over, false, 'Gold at the cap (39.8%)');
  assert.equal(costShareCheck({ costPct: 0.1728, stopPct: 0.288, settings: s }).over, false, 'Oil at the cap (~60%)');
  assert.equal(costShareCheck({ costPct: 0.1194, stopPct: 0.1837, settings: s }).over, false, 'exactly at the ceiling is not over');
  assert.equal(costShareCheck({ costPct: 0.1194, stopPct: 0.175, settings: s }).over, true, '#1067: 68.3% of R in cost');
  assert.equal(costShareCheck({ costPct: 0.25, stopPct: 0.43, settings: s }).over, false, 'BTC #1058 at 58.1% — under a 65% ceiling');
});

// ---------------------------------------------------------------------------------------------
// 3. ⚠ The regression pin: the ceiling may not move the stop
// ---------------------------------------------------------------------------------------------
test('setting or removing the ceiling leaves the venue stop BIT-IDENTICAL', () => {
  const withCeiling = GOLD;
  const withoutCeiling = { risk: { maxAdversePct: 0.3 } };
  // Dollars, as the real call passes them: 0.175% .. 1.478% of a 4400 price.
  for (const dollars of [7.7, 13.2, 17.5, 18.078, 22.79, 56.1, 65.0]) {
    const a = cappedStopDistance({ declaredStopDist: dollars, price: PX, settings: withCeiling, symbol: 'Gold' });
    const b = cappedStopDistance({ declaredStopDist: dollars, price: PX, settings: withoutCeiling, symbol: 'Gold' });
    assert.equal(a.stopDist, b.stopDist,
      `a cost ceiling must not resize the stop (declared ${dollars}) — widening it would undo TRD-98's cap and tightening it would raise the share it is trying to lower`);
    assert.equal(a.cappedBy, b.cappedBy);
  }
});

test('the share and the ceiling travel with the distance, whether or not the cap bound', () => {
  const capped = cappedStopDistance({ declaredStopDist: 18.078, price: PX, settings: GOLD, symbol: 'Gold' });
  assert.equal(capped.cappedBy, 'max_adverse_pct', 'the live Gold case: the 0.30% cap binds');
  assert.equal(Math.round(pctOf(capped.stopDist) * 1000) / 1000, 0.3, 'the stop lands on the cap');
  assert.equal(capped.ceiling, 0.65);
  assert.equal(capped.ceilingFrom, 'maxCostShareOfR');
  assert.ok(Math.abs(capped.costShare - 0.398) < 0.002, `Gold at the cap is ~39.8% of R, got ${capped.costShare}`);

  // Un-capped: the declared distance is already tighter than the cap, so the share is reported from it.
  // #1067's real case — a quiet-Gold 2xATR of 0.175% of price is 7.7 dollars, and the round trip is
  // then 68.3% of the risk unit.
  const uncapped = cappedStopDistance({ declaredStopDist: 7.7, price: PX, settings: GOLD, symbol: 'Gold' });
  assert.equal(uncapped.cappedBy, null, 'nothing tightened it — the cap did not bind');
  assert.ok(Math.abs(uncapped.costShare - 0.6823) < 0.002, `#1067's real share, got ${uncapped.costShare}`);
});

test('an unknown cost basis still reports the ceiling, and reports no share', () => {
  const r = cappedStopDistance({ declaredStopDist: 22, price: PX, settings: GOLD, symbol: 'NoSuchInstrument' });
  assert.equal(r.ceiling, 0.65, 'the ceiling is a setting, not a function of the instrument');
  assert.equal(r.costShare, null, 'and with no basis there is no share — null, not 0');
  assert.match(r.note, /no round-trip cost basis/, 'the absence must be REPORTED, never assumed to be zero');
});

// ---------------------------------------------------------------------------------------------
// 4. The gate refuses; it does not resize
// ---------------------------------------------------------------------------------------------
test('the risk gate REFUSES on a breach and never resizes around it (source pin)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');
  const at = src.indexOf('cost ceiling: the venue round trip');
  assert.ok(at > 0, 'the reason must name the ceiling and both numbers');
  // ⚠ RE-SCOPED 2026-09-30 (TRD-EXE-10). This slice used to END at `let size =`, which holds only while nothing
  // sits between the ceiling check and the sizing. TRD-EXE-10 inserted the measured-loss-distance block there, the
  // slice grew past the length bound, and the pin failed on code that had not changed its behaviour — the sign of
  // a pin on layout rather than on the branch. The branch's OWN `return v;` is the honest end: it is the statement
  // that makes the veto final, so the slice now covers exactly what runs when the ceiling is breached.
  const start = src.lastIndexOf('const shareCheck', at);
  const endAt = src.indexOf('return v;', start);
  const branch = src.slice(start, endAt > 0 ? endAt + 'return v;'.length : -1);
  assert.ok(branch.length > 0 && branch.length < 1200, 'the branch must be scoped to the ceiling block');
  // ⚠ UPDATED 2026-09-27 (TRD-RSK-2): the flag is no longer set here directly. Every veto site now calls a helper
  // that sets the flag AND records a machine-readable CODE, so this pin asserts the STRONGER form — a breach is
  // still a veto, and it is now an attributable one. Asserting the old literal would have failed on a change that
  // strictly improved the gate, which is the sign of a pin on wording rather than on behaviour.
  assert.match(branch, /veto\('cost_ceiling'/, 'a breach is a veto, and it must carry its code');
  assert.match(branch, /return v;/, 'and it must STOP — a resize would leave the ratio exactly as it was');
  assert.doesNotMatch(branch, /size =/, 'the ceiling must never touch size');
  assert.match(src, /v\.costShareOfR = shareCheck \? shareCheck\.share : null/,
    'no basis is recorded as null, never omitted and never zero');
});

test('the live default is the level the measurement supports, and the setting documents why', () => {
  const { DEFAULT_SETTINGS } = require('../trading/store');
  assert.equal(DEFAULT_SETTINGS.risk.maxCostShareOfR, 0.65);
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
  assert.match(src, /BOUNDED BY THE MEASURED OPTIMUM/, 'a dial whose level is evidence-derived must say so where it is set');
});
