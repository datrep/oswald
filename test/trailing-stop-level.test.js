// test/trailing-stop-level.test.js — TRD-TRL-4 (2026-10-01): the trail's LEVEL against the stop, not just its SIZE.
//
// WHY THIS EXISTS. `verifyReadback` asks "did the venue hold the distance we asked for?". It cannot ask "is the
// trail on the correct SIDE of the stop?", and on trade #1164 those two questions had different answers.
//
// THE MEASUREMENT. Oil, 1 contract, buy, 2026-10-01T00:34:52Z. Requested distance 0.875, read back 0.8688,
// drift 0.709% — INSIDE the 2% tolerance, so the bridge reported `placed: true` at level `info`. The recorded
// stop was 89.595; the trail landed at 89.6312. For a buy a HIGHER stop is a TIGHTER one, so the trail was
// 0.0362 tighter — about 4% of the 0.905 stop distance — and because the venue fires the tighter level first it
// silently REPLACED the stop that every R multiple on this desk divides by.
//
// The cause is not a bad request. The venue snapped 87.5 pips down to 80 AND applied that count to its own price
// (90.50) rather than the price the desk had read (90.47). A one-pip snap and a three-tick price gap are each
// harmless; together they crossed a level. Neither is visible from the distance, which is why the check here is
// on the realised LEVEL.
'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  plan, verifyStopRelationship, verifyReadback,
} = require('../trading/agent/trailingStop');

// The #1164 numbers, verbatim.
const CASE = {
  direction: 'buy',
  stopPrice: 89.595,
  trailLevel: 89.6312,
  multiple: 1,
  stopDistFromEntry: 90.5 - 89.595, // 0.905 — the R denominator
  tolerancePct: 2,
};

test('THE #1164 CASE: the distance check passes while the trail is tighter than the stop', () => {
  // ⚠ THIS IS THE DEFECT, PINNED. The old gate is reproduced here and it says OK — on the very reading that had
  // already crossed the stop. If this assertion ever fails, the observed numbers have been altered and the
  // evidence in the comment above no longer describes them.
  const distanceCheck = verifyReadback({
    distanceRead: 0.8688, distanceTarget: 0.875, tolerancePct: 2,
  });
  assert.equal(distanceCheck.ok, true, 'the size was inside tolerance, which is why nothing complained');
  assert.equal(distanceCheck.driftPct, 0.7086);

  const levelCheck = verifyStopRelationship(CASE);
  assert.equal(levelCheck.ok, false, 'the trail is ABOVE the stop on a buy, so it fires first');
  assert.equal(levelCheck.reason, 'trail_tighter_than_stop');
  assert.equal(levelCheck.tighter, true);
  assert.equal(levelCheck.tighterBy, 0.0362);
  assert.equal(levelCheck.tighterPctOfStopDist, 4.0);
});

test('a trail exactly ON the stop is the multiple-1 intent and passes', () => {
  const r = verifyStopRelationship({ ...CASE, trailLevel: 89.595 });
  assert.equal(r.ok, true);
  assert.equal(r.tighter, false);
  assert.equal(r.margin, 0);
});

test('a trail WIDER than the stop adds the ratchet without changing the exit', () => {
  const r = verifyStopRelationship({ ...CASE, trailLevel: 89.4 });
  assert.equal(r.ok, true);
  assert.equal(r.tighter, false);
  assert.equal(r.margin, 0.195);
});

test('the sell side mirrors: tighter means a LOWER level, not a higher one', () => {
  const base = { direction: 'sell', stopPrice: 90.9, multiple: 1, stopDistFromEntry: 0.9, tolerancePct: 2 };
  assert.equal(verifyStopRelationship({ ...base, trailLevel: 90.86 }).ok, false, 'lower than the stop = tighter');
  assert.equal(verifyStopRelationship({ ...base, trailLevel: 90.94 }).ok, true, 'higher than the stop = wider');
  assert.equal(verifyStopRelationship({ ...base, trailLevel: 90.9 }).ok, true, 'on the stop');
});

test('a tighter trail is legitimate ONLY with the explicit opt-in, and says so', () => {
  const tighter = { ...CASE, trailLevel: 89.7 };
  const refused = verifyStopRelationship(tighter);
  assert.equal(refused.ok, false, 'multiple 1 with no opt-in: refuse');
  const optedIn = verifyStopRelationship({
    ...tighter, multiple: 0.5, allowTighterThanStop: true,
  });
  assert.equal(optedIn.ok, true, 'the desk asked for tighter and the desk gets tighter');
  assert.equal(optedIn.optIn, true);
  assert.equal(optedIn.tighter, true);
  // ⚠ the opt-in is about the MULTIPLE, so it must NOT rescue a multiple-1 crossing
  assert.equal(verifyStopRelationship({ ...tighter, multiple: 1, allowTighterThanStop: true }).ok, false);
});

test('a sub-tolerance crossing is reported as tighter but not a refusal', () => {
  const r = verifyStopRelationship({ ...CASE, trailLevel: 89.5955 }); // 0.0005 tighter = 0.055% of 0.905
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'tighter_within_tolerance');
  assert.equal(r.tighter, true, 'still reported, so the record never reads as if it sat on the stop');
});

test('an unreadable level refuses rather than defaulting to safe', () => {
  assert.equal(verifyStopRelationship({ ...CASE, trailLevel: null }).reason, 'level_unknown');
  assert.equal(verifyStopRelationship({ ...CASE, stopPrice: undefined }).reason, 'level_unknown');
  assert.equal(verifyStopRelationship({ ...CASE, direction: 'long' }).reason, 'bad_direction');
});

test('plan() states the target level WITHOUT reference to the price', () => {
  const settings = { risk: { trailingStop: { enabled: true, distanceMultiple: 1, verifyTolerancePct: 2 } } };
  // Two plans differing only in the PRICE must agree on where the trail should END UP, because at multiple 1 the
  // answer is the stop's own level and the price has nothing to do with it.
  const a = plan({ settings, direction: 'buy', entry: 90.5, size: 1, price: 90.47, stopPrice: 89.595 });
  const b = plan({ settings, direction: 'buy', entry: 90.5, size: 1, price: 91.20, stopPrice: 89.595 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.trailLevelTarget, 89.595, 'on the stop, exactly');
  assert.equal(b.trailLevelTarget, 89.595, 'and the price moving does NOT move the target level');
  // ⚠ while the REQUESTED distance does move with the price — which is the gap the venue closes with its own
  // price, and the reason the level has to be verified rather than assumed.
  assert.notEqual(a.distanceTarget, b.distanceTarget);
});

test('plan() at a wider multiple moves the target one stop-distance per multiple', () => {
  const settings = { risk: { trailingStop: { enabled: true, distanceMultiple: 2, verifyTolerancePct: 2 } } };
  const p = plan({ settings, direction: 'buy', entry: 90.5, size: 1, price: 90.47, stopPrice: 89.595 });
  assert.equal(p.trailLevelTarget, 89.595 - 0.905, 'one stop distance BELOW the stop for a buy');
  const s = plan({ settings, direction: 'sell', entry: 89.0, size: 1, price: 89.03, stopPrice: 89.9 });
  // 89.9 + 0.9 is 90.80000000000001 in IEEE754; the module rounds its levels to 8dp, so the answer is 90.8.
  assert.equal(s.trailLevelTarget, 90.8, 'and mirrored above it for a sell');
});
