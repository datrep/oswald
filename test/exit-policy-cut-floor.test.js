// test/exit-policy-cut-floor.test.js — TRD-EXI-1 (#1490).
//
// The floor exists because a rule that is RIGHT 14 times in 16 still loses money, and the reason is arithmetic
// rather than opinion. These tests pin the arithmetic and the two behaviours that must not change: a review with
// no gate still closes exactly as before, and a price the desk cannot read must not manufacture a suppression.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { cutSavingR, gateNearStopCut, DEFAULT_MIN_CUT_SAVING_R } = require('../trading/agent/exitPolicy');
const { decideClose, pr } = require('../trading/agent/review');

// The trade that started the investigation: Gold #1137, sell, entry 4,169.81, stop 4,184.7868, cut at 4,181.55.
const GOLD_1137 = { entry: 4169.81, stopPrice: 4184.7868 };

test('the saving is the distance from the price to the stop, in R - and #1137 banked 0.216R', () => {
  const s = cutSavingR({ ...GOLD_1137, price: 4181.55 });
  assert.ok(Math.abs(s - 0.2161) < 1e-4);
  // the identity that makes this the SAVING and not merely a distance: cutting here takes 0.784R where letting
  // the stop have it costs 1.000R, and the gap is exactly the distance to the stop
  const pnlR = ((4181.55 - 4169.81) * -1) / Math.abs(4169.81 - 4184.7868);
  assert.ok(Math.abs((1 + pnlR) - s) < 1e-4);
});

test('the 0.20 floor now PERMITS #1137 (0.216R - refused under the old 0.30) and still refuses below 0.20', () => {
  // TRD-EXI-1c Sec 3.1 (2026-10-08): floor 0.3 -> 0.20. The desk cut #1137 at 0.216R; under the old floor it was
  // refused (0.216 < 0.30) - exactly the inert-control behaviour the change corrects.
  const g = gateNearStopCut({ ...GOLD_1137, price: 4181.55 });
  assert.strictEqual(g.refuse, false);
  assert.strictEqual(g.reason, null);
  assert.strictEqual(g.minSavingR, DEFAULT_MIN_CUT_SAVING_R);
  assert.ok(Math.abs(g.savingR - 0.2161) < 1e-4);
  // a cut inside the old observed band but BELOW the new floor is still refused: 0.158R from the stop
  const gb = gateNearStopCut({ ...GOLD_1137, price: 4184.7868 - 0.158 * 14.9768 });
  assert.strictEqual(gb.refuse, true);
  assert.strictEqual(gb.reason, 'saving_below_floor');
  assert.ok(Math.abs(gb.savingR - 0.158) < 1e-3);
});

test('a cut that saves enough still passes - the review keeps its judgement', () => {
  // 0.50R from the stop: 4,184.7868 - 0.5 x 14.9768 = 4,177.2984
  const g = gateNearStopCut({ ...GOLD_1137, price: 4177.2984 });
  assert.strictEqual(g.refuse, false);
  assert.strictEqual(g.reason, null);
  assert.ok(Math.abs(g.savingR - 0.5) < 1e-3);
  // and the break-even arithmetic that set the floor, stated as a test rather than a comment:
  // a cut saving s needs a hit rate of tpR/(tpR+s); at 0.158R that is 94% (observed 87.5%, so it loses) and at
  // 0.50R it is 81% (so it wins). Nothing below the floor can pay at the observed hit rate.
  const breakEven = (s) => 2.7 / (2.7 + s);
  assert.ok(breakEven(0.158) > 0.875); // 0.944 - loses
  assert.ok(breakEven(0.5) < 0.875); // 0.844 - wins
});

test('an unreadable price is UNJUDGED, never a suppression', () => {
  for (const price of [null, undefined, '', NaN]) {
    const g = gateNearStopCut({ ...GOLD_1137, price });
    assert.strictEqual(g.refuse, false, `price ${String(price)} must not manufacture a refusal`);
    assert.strictEqual(g.savingR, null);
    assert.strictEqual(g.reason, 'unjudged');
  }
});

test('a missing stop is unjudged too - Number(null) is 0 and must never classify', () => {
  // the coercion class this workstream has now hit three times: a null that arrives as a plausible zero
  for (const stopPrice of [null, undefined, '']) {
    const g = gateNearStopCut({ entry: 4169.81, stopPrice, price: 4181.55 });
    assert.strictEqual(g.refuse, false);
    assert.strictEqual(g.savingR, null);
  }
  // and a zero-distance stop cannot be turned into an R at all
  assert.strictEqual(cutSavingR({ entry: 100, stopPrice: 100, price: 99 }), null);
});

test('a floor of ZERO is an explicit OFF switch, not a missing value', () => {
  const g = gateNearStopCut({ ...GOLD_1137, price: 4181.55, minSavingR: 0 });
  assert.strictEqual(g.refuse, false);
  assert.strictEqual(g.reason, 'disabled');
  assert.strictEqual(g.minSavingR, 0);
});

test('decideClose suppresses a near-stop cut, and REPORTS the number behind it', () => {
  const verdict = { action: 'close', confidence: 0.9 };
  // below the 0.20 floor (0.158R) - the suppression path
  const gate = gateNearStopCut({ ...GOLD_1137, price: 4184.7868 - 0.158 * 14.9768 });
  const d = decideClose({ verdict, mirrored: false, closeMirrored: false, minConfidence: 0.7, authority: 'decider', cutGate: gate });
  assert.strictEqual(d.shouldClose, true); // the review still WANTED to close
  assert.strictEqual(d.canClose, true); // and was allowed to
  assert.strictEqual(d.close, false); // and the floor stopped it
  assert.strictEqual(d.cutSuppressed, true);
  assert.ok(Math.abs(d.cutGate.savingR - 0.158) < 1e-3); // the number the floor is tuned by
  // a permitted cut closes normally
  const ok = decideClose({
    verdict, mirrored: false, closeMirrored: false, minConfidence: 0.7, authority: 'decider',
    cutGate: gateNearStopCut({ ...GOLD_1137, price: 4177.2984 }),
  });
  assert.strictEqual(ok.close, true);
  assert.strictEqual(ok.cutSuppressed, false);
});

test('WITHOUT a gate every existing behaviour is untouched', () => {
  // the regression pin: the floor is opt-in at the call site, so the pre-existing truth table cannot drift
  const v = { action: 'close', confidence: 0.9 };
  const base = { verdict: v, mirrored: false, closeMirrored: false, minConfidence: 0.7 };
  assert.strictEqual(decideClose({ ...base, authority: 'decider' }).close, true);
  assert.strictEqual(decideClose({ ...base, authority: 'decider' }).cutSuppressed, false);
  assert.strictEqual(decideClose({ ...base, authority: 'decider' }).cutGate, null);
  // confidence gate still holds
  assert.strictEqual(decideClose({ ...base, verdict: { action: 'close', confidence: 0.5 }, authority: 'decider' }).close, false);
  // advisory authority still suppresses, and says which reason it was
  const adv = decideClose({ ...base, authority: 'advisory' });
  assert.strictEqual(adv.close, false);
  assert.strictEqual(adv.advisory, true);
  assert.strictEqual(adv.advisoryReason, 'strategy_policy');
  // a mirrored position with closeMirrored false still suppresses
  const mir = decideClose({ ...base, mirrored: true, authority: 'decider' });
  assert.strictEqual(mir.close, false);
  assert.strictEqual(mir.advisoryReason, 'mirrored_position');
});

test('the setting defaults to the floor and an explicit 0 survives the config read', () => {
  assert.strictEqual(pr({}).minCutSavingR, DEFAULT_MIN_CUT_SAVING_R);
  assert.strictEqual(pr({ deliberation: { positionReview: { minCutSavingR: 0 } } }).minCutSavingR, 0);
  assert.strictEqual(pr({ deliberation: { positionReview: { minCutSavingR: 0.6 } } }).minCutSavingR, 0.6);
  // a non-numeric is not a value: fall back rather than coerce
  assert.strictEqual(pr({ deliberation: { positionReview: { minCutSavingR: 'x' } } }).minCutSavingR, DEFAULT_MIN_CUT_SAVING_R);
});
