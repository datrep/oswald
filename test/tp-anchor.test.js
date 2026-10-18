// test/tp-anchor.test.js — TRD-TP-1 route (2): the target anchored to the stop that is PLACED.
//
// THE MEASUREMENT THIS EXISTS FOR (TRD-TP-1, 2026-09-28). Capping the stop while the take-profit kept
// `LEVEL_RR x DECLARED` did not merely shrink the stop — it moved the TARGET. Post-cap on the desk's own trades:
// 24 of 27 tickets carried MORE than the declared 1.5R, and the tickets at 3.0R or wider touched their target
// **0 times in 10**. Replayed on the 25 trades that ran past 1.6R: at their real target (mean 3.63R) 16% touched,
// expectancy **-0.2598R**; at a true 1.5R target 48% touched, expectancy **+0.2000R**.
//
// ⚠ AND THESE TESTS PIN THE DEFAULT AS MUCH AS THE FEATURE. These levels belong to a FROZEN forward-validation
// candidate (TRD-29), so route (2) ships OFF and the switch is the owner's. A test that only checked the new
// branch would pass while the default silently moved, which is the exact failure the whole row is about.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { entryLevels, LEVEL_RR } = require('../trading/agent/exitLevels');

// A SHORT whose 2xATR stop (2.24 = 0.7014% of 319.36) is WIDER than a 0.30% cap, so the cap binds and the two
// anchors are far apart — the case the whole feature is about. Taken from the shape of the live refusals.
const CAPPED = { direction: 'sell', atr14: 1.12, price: 319.36, stopDistance: 2.24, maxAdversePct: 0.3 };

test('★ the DEFAULT is unchanged — a capped ticket still keeps the declared target', () => {
  const lv = entryLevels(CAPPED);
  assert.strictEqual(lv.takeProfitAnchor, 'declared', 'route (2) must not become the default by accident');
  assert.strictEqual(lv.cappedBy, 'max_adverse_pct');
  // The target distance is LEVEL_RR x DECLARED, untouched by the cap — the historic geometry.
  assert.strictEqual(lv.takeProfitDist, +(LEVEL_RR * 2.24).toFixed(4));
  assert.ok(lv.effectiveRR > 2, `the cap still RAISES the reward:risk under the default (got ${lv.effectiveRR})`);
});

test('★ under `placed` the target is anchored to the capped stop, so the ticket carries exactly LEVEL_RR', () => {
  const lv = entryLevels({ ...CAPPED, takeProfitAnchor: 'placed' });
  assert.strictEqual(lv.takeProfitAnchor, 'placed');
  assert.strictEqual(lv.cappedBy, 'max_adverse_pct', 'the cap still tightens the stop — route (2) changes the TARGET only');
  assert.strictEqual(lv.takeProfitDist, +(LEVEL_RR * lv.stopDist).toFixed(4));
  assert.strictEqual(lv.effectiveRR, LEVEL_RR, 'which is the whole point: the declared reward:risk, on every ticket');
  // and the stop the venue receives is identical either way — this must not quietly resize the position
  assert.strictEqual(lv.stopDist, entryLevels(CAPPED).stopDist);
  assert.strictEqual(lv.stopPrice, entryLevels(CAPPED).stopPrice);
});

test('on an UNCAPPED ticket the two anchors agree, so the switch is a no-op where it should be', () => {
  const wide = { direction: 'buy', atr14: 1, price: 100, stopDistance: 2, maxAdversePct: 5 }; // cap never binds
  const d = entryLevels(wide);
  const p = entryLevels({ ...wide, takeProfitAnchor: 'placed' });
  assert.strictEqual(d.cappedBy, null);
  assert.strictEqual(d.takeProfitPrice, p.takeProfitPrice, 'no cap means no difference — and no silent divergence');
  assert.strictEqual(p.effectiveRR, LEVEL_RR);
});

test('the offset composes on top of EITHER anchor, and neither is switched off by the other', () => {
  // ⚠ The offset exists because the cap pushed the target out. Turning the anchor on must NOT turn the offset off
  // — a silent change is the failure both settings guard against — so they are independent, and the tests say so.
  const placedOffset = entryLevels({ ...CAPPED, takeProfitAnchor: 'placed', takeProfitOffsetPct: 5 });
  assert.strictEqual(placedOffset.takeProfitAnchor, 'placed');
  assert.strictEqual(placedOffset.takeProfitOffsetPct, 5, 'the offset is still applied');
  // ⚠ Compared with a tolerance rather than by equality: `takeProfitDist` is published to 4dp while `stopDist`
  // is exact, so an exact comparison here is a test of the ROUNDING, not of the anchor.
  assert.ok(Math.abs(placedOffset.takeProfitDist - LEVEL_RR * placedOffset.stopDist * 0.95) < 1e-3,
    `expected the placed anchor with a 5% offset (got ${placedOffset.takeProfitDist})`);
  assert.ok(placedOffset.effectiveRR < LEVEL_RR, 'and it still lowers the reward:risk, as it always has');
  const declaredOffset = entryLevels({ ...CAPPED, takeProfitOffsetPct: 5 });
  assert.strictEqual(declaredOffset.takeProfitAnchor, 'declared');
  assert.ok(declaredOffset.takeProfitDist > placedOffset.takeProfitDist, 'the default target is further away — the defect, made visible');
});

test('★ the ANCHOR TRAVELS on the result, or the forward track cannot be split', () => {
  // TRD-29: survgold/survoil are frozen forward-validation candidates and any retuning VOIDS them. The track is
  // the only reason they are trusted, so the date this setting moved has to be recoverable from the record — the
  // same argument that put `cappedBy` on this result.
  const lv = entryLevels({ ...CAPPED, takeProfitAnchor: 'placed' });
  assert.strictEqual(lv.takeProfitAnchorDist, lv.stopDist, 'the distance the target was actually measured from');
  assert.ok(lv.takeProfitAnchorDist < lv.declaredStopDist, 'and it is NOT the declared one on a capped ticket');
});

test('an unrecognised anchor falls back to `declared` rather than to the new behaviour', () => {
  // A typo must never retune a frozen candidate. Anything not exactly 'placed' is the historic geometry.
  for (const bad of [null, undefined, '', 'PLACED', 'placed ', 'capped', 0, 1, {}, true]) {
    const lv = entryLevels({ ...CAPPED, takeProfitAnchor: bad });
    assert.strictEqual(lv.takeProfitAnchor, 'declared', `anchor ${JSON.stringify(bad)} must not enable route (2)`);
    assert.strictEqual(lv.takeProfitDist, +(LEVEL_RR * 2.24).toFixed(4));
  }
});
