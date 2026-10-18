// test/venue-step.test.js — TRD-EXE-3 (2026-09-30): `unitAmount` is the venue's STEP, and the desk must
// record the size the venue will actually hold.
//
// THE MEASUREMENT THIS SUITE PINS. Over every position on the live book that carries an observed venue size
// (`position_pnl.size` — the ONLY venue-side size the desk stores; `Trades.size` is the desk's own number):
//
//   * 32 of 32 held an EXACT integer multiple of `Instruments.unitAmount`, with 0 counterexamples; and
//   * `round(deskSize / floor) * floor` reproduced the venue's held size on 28 of 28 DIVERGENT rows
//     (median error 3.99%, max +100%).
//
// So `docs/INSTRUMENT_MIRROR.md` §9.2's claim that `unitAmount` is "a **minimum, not a step**" is falsified,
// and the divergence it licensed is not cosmetic: `v.size` is what `Trades.size` is written from and what
// `resolvedRiskPct`, the exit tolerance and the cost share of R are all computed on.
//
// THE DECISION PINNED HERE is that the size is snapped onto the venue's step ONCE THE FLOOR VERDICT HAS
// PASSED, and that the snap is RISK-NEUTRAL BY CONSTRUCTION — the venue applies the same function, so the
// size returned is the size the venue would have held anyway. It changes the record, not the position. The
// VETO in `risk.js` is untouched: the snap must never be used to raise a size toward a floor the desk was
// not granted, which is the clamp `acceptVenueFloor` exists to gate.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { snapToVenueStep } = require('../trading/agent/instruments');
const { read, code } = require('./_source');

test('the venue\'s step reproduces every measured divergence', () => {
  // deskSize -> the size the venue actually held, from the live measurement. These are not invented
  // proportions; each pair is a row of `Trades` beside the newest `position_pnl` for its positionId.
  const cases = [
    // [symbol, deskSize, floor, venueHeld]
    ['Gold', 0.1152, 0.025, 0.125],        //  4.608 steps -> 5
    ['Gold', 0.0628, 0.025, 0.075],        //  2.512 steps -> 3
    ['Gold', 0.2281, 0.025, 0.225],        //  9.124 steps -> 9   (rounds DOWN)
    ['Silver', 7.8131, 2.5, 7.5],          //  3.125 steps -> 3   (rounds DOWN)
    ['Silver', 4.8749, 2.5, 5],            //  1.950 steps -> 2
    ['Sugar', 12.905, 15, 15],             //  0.860 steps -> 1   (sub-floor, resolved UP to one step)
    ['Sugar', 647.0551, 15, 645],          // 43.137 steps -> 43
    ['Arabica Coffee', 1.3993, 0.5, 1.5],  //  2.799 steps -> 3
    ['Bitcoin', 0.0025, 0.001, 0.003],     //  2.500 steps -> 3   (EXACT HALF, resolved UP)
    ['SGX', 10, 20, 20],                   //  0.500 steps -> 1   (EXACT HALF, resolved UP) — #1106
    ['Oil', 15.8154, 2.5, 15],             //  6.326 steps -> 6
  ];
  for (const [symbol, deskSize, floor, venueHeld] of cases) {
    const s = snapToVenueStep(deskSize, floor);
    assert.equal(s.size, venueHeld,
      `${symbol}: the venue held ${venueHeld} against a recorded ${deskSize} at a ${floor} step`);
  }
});

test('a size ALREADY on the step is left exactly alone, and reports itself as such', () => {
  // Idempotence is the property that makes the snap safe to apply at two sites: `risk.js` snaps, then the
  // degrade re-snaps, and a second application cannot move what the first one settled.
  for (const [size, floor] of [[0.225, 0.025], [15, 15], [20, 20], [645, 15], [1.5, 0.5]]) {
    const once = snapToVenueStep(size, floor);
    assert.equal(once.size, size);
    assert.equal(once.snapped, false, `${size} is already ${once.steps} x ${floor}`);
    assert.equal(once.reason, 'on_step');
    assert.equal(snapToVenueStep(once.size, floor).size, once.size, 'a second application must not move it');
  }
});

test('THE HALF-UP CASE IS NAMED, not left to `Math.round`\'s implementation', () => {
  // #1106 sent SGX 10 against a 20-Share floor and the venue held 20 — an exact half resolved UPWARD, which
  // is the single case that turned a "50% size" degraded entry into a full-size one, and `#1099`'s Bitcoin
  // 0.0025 -> 0.003 is the same half at a finer step. A reader of the record should not have to know
  // JavaScript's rounding convention to interpret the number.
  const half = snapToVenueStep(10, 20);
  assert.equal(half.steps, 1);
  assert.equal(half.size, 20);
  assert.equal(half.reason, 'half_up');
  assert.equal(snapToVenueStep(0.0025, 0.001).reason, 'half_up');
  // A near-half is NOT a half and must not be reported as one: 10.2 / 20 = 0.51 steps, which rounds to 1
  // but landed there by rounding, not by the half rule.
  const nearHalf = snapToVenueStep(10.2, 20);
  assert.equal(nearHalf.steps, 1);
  assert.equal(nearHalf.size, 20);
  assert.equal(nearHalf.reason, 'snapped', '0.51 steps is not an exact half');
});

test('a size below the step is resolved to ONE step, never to zero', () => {
  // THE TRAP: the nearest multiple of a floor to a sub-floor size is 0, and `Math.round` happily returns it.
  // A zero-unit order is not the venue's behaviour — a sub-floor order comes back at one step, which is
  // exactly what `#1106` (10 of 20) and `#1113` (12.905 of 15) show. Whether a sub-floor size may be SENT is
  // `floorVerdict`'s call; this function only decides what an allowed size settles on.
  for (const [size, floor] of [[10, 20], [12.905, 15], [0.4, 15], [0.0026, 0.01]]) {
    const s = snapToVenueStep(size, floor);
    assert.ok(s.size > 0, `${size} at a ${floor} step must never snap to zero`);
    assert.equal(s.size, floor, `${size} must resolve to exactly one step (${floor})`);
    assert.equal(s.steps, 1);
  }
});

test('an UNKNOWN step leaves the size alone and says so — absence is not a step of one', () => {
  // The same inversion `floorVerdict` guards: `Number(null) === 0` would turn an unread floor into a
  // granularity of zero, and `size / 0` is `Infinity`, whose `Math.round` is `Infinity`. Absence must stay
  // distinguishable from "the step is whatever we computed", or the snap silently becomes the largest
  // possible size change in the desk.
  for (const absent of [null, undefined, '', 0, -5, 'abc', true]) {
    const s = snapToVenueStep(12.905, absent);
    assert.equal(s.size, 12.905, `minUnits=${JSON.stringify(absent)} must not move the size`);
    assert.equal(s.snapped, false);
    assert.equal(s.reason, 'step_unknown');
    assert.equal(s.steps, null);
    assert.equal(s.minUnits, null, 'and it must not report a step of zero');
  }
  const bad = snapToVenueStep(null, 15);
  assert.equal(bad.size, null);
  assert.equal(bad.reason, 'size_unavailable');
  assert.equal(bad.minUnits, 15, 'the step is still reported even when the size is not');
});

test('the snap can never dip below a floor the size already met', () => {
  // This is what makes the placement in `risk.js` safe: it runs only in the branch where `floorVerdict`
  // already PASSED, and `size >= m` implies `round(size/m) >= 1`, so the snap cannot create a second
  // refusal path or contradict the veto that owns sub-floor sizes.
  for (const floor of [0.025, 0.001, 0.5, 2.5, 15, 20]) {
    for (const mult of [1, 1.01, 1.49, 1.5, 1.51, 2, 3.5, 100]) {
      const size = mult * floor;
      const s = snapToVenueStep(size, floor);
      assert.ok(s.size >= floor - 1e-9, `${size} at a ${floor} step snapped to ${s.size}, below the floor`);
    }
  }
});

test('THE WIRING: the snap is in the sizing engine, and the veto still owns the floor', () => {
  const risk = code('trading/agent/risk.js');
  const agg = code('trading/agent/aggregator.js');
  const inst = code('trading/agent/instruments.js');

  assert.match(inst, /function snapToVenueStep\(/);
  assert.match(risk, /snapToVenueStep\(size, floor\.resolved \? floor\.resolved\.minUnits : null\)/);

  // ⚠ ORDER IS THE WHOLE ARGUMENT. The snap must sit INSIDE the branch that the veto does not take, so a
  // sub-floor size cannot be snapped up by the size path and the `acceptVenueFloor` dial cannot be bypassed.
  const vetoAt = risk.indexOf(`veto('venue_minimum'`);
  const unknownAt = risk.indexOf(`floor.reason === 'venue_minimum_unknown'`);
  const snapAt = risk.indexOf('snapToVenueStep(size,');
  assert.ok(vetoAt > 0 && unknownAt > 0 && snapAt > 0, 'all three sites must be present');
  assert.ok(snapAt > unknownAt, 'the snap must be the branch AFTER the unknown/unreadable report');
  assert.ok(snapAt > vetoAt, 'the snap must not pre-empt the veto that owns sub-floor sizes');
  assert.match(risk, /snappedFrom:/);
  assert.match(risk, /snappedTo:/);

  // The degrade applies AFTER the floor was satisfied, so it must re-snap and record the factor achieved.
  const halveAt = agg.indexOf('const halved = Math.round(preDegradeSize * factor * 10000) / 10000;');
  const resnapAt = agg.indexOf('snapToVenueStep(halved,');
  assert.ok(halveAt > 0, 'the degrade must still halve the size');
  assert.ok(resnapAt > halveAt, 'the degrade must re-snap AFTER halving, not before');
  assert.match(agg, /degradedFactorEffective/);
  assert.match(agg, /degradedFloorDefeated/);
  assert.match(agg, /finalSize: execSize/, 'the recorded final size must be the SNAPPED one');
});

test('the correction to the doc that licensed the defect is on the record', () => {
  // The wrong belief was written down and is what let both the divergence and the defeated degrade hide:
  // "no rounding to a multiple is implemented — inventing a granularity the venue never stated".
  const mirror = read('trading/docs/INSTRUMENT_MIRROR.md');
  assert.match(mirror, /unitAmount` is a \*\*minimum, not a step\*\*/);
  assert.match(mirror, /CORRECTED 2026-09-30 \(TRD-EXE-3\)/);
  assert.match(mirror, /32 of 32 were exact integer multiples/);
  assert.match(mirror, /28 of 28/);
  // The veto that §9.2 correctly argues for must survive its own correction.
  assert.match(mirror, /The VETO above is unchanged/);
  assert.match(mirror, /snapToVenueStep/);
});

// -----------------------------------------------------------------------------------------------------------
// TRD-RSK-4: the standing check for "a symbol whose venue floor exceeds the risk budget can never fire".
// -----------------------------------------------------------------------------------------------------------

// THE TEST RSK-4 HAD TO DO BY HAND, as arithmetic: one venue minimum's risk against the dial.
const riskAtFloorPct = (minUnits, expectedLossDist, equity) => (minUnits * expectedLossDist / equity) * 100;

test('the standing check reproduces RSK-4, AND explains why a settings change retired it', () => {
  // RSK-4's own inputs, 2026-09-28: SGX floor 20 Shares, effective stop 0.3390, equity ~4,128.
  const sgx = riskAtFloorPct(20, 0.339, 4127.83);
  assert.ok(Math.abs(sgx - 0.1642) < 0.0002, `one SGX minimum risks ${sgx.toFixed(4)}% of equity`);
  assert.match(String(sgx.toFixed(4)), /^0\.164/, 'the row recorded 0.1640% — the arithmetic agrees to 4dp');

  // THE TEST IS A COMPARISON WITH THE DIAL, and it is the whole finding:
  assert.ok(sgx > 0.07, 'at a 0.07% budget NO size in SGX can satisfy the dial and the venue at once');
  assert.ok(sgx < 3, 'at the live 3% budget the same floor is slack — SGX is reachable');

  // ⇒ the row's premise was a property of the CAP, not of SGX. The settings_write journal records the move
  //    (maxRiskPerTradePct 0.07 -> 5 at 2026-09-28T19:36:38Z) and the first SGX decision after it sizes
  //    148.0699 Shares = 7.4 venue minimums. Both are asserted by the recorder, not restated here.
  assert.ok(riskAtFloorPct(20, 0.339, 4127.83) < 5, 'and it is slack under the cap that replaced it too');
});

test('the standing check is on EVERY decision that clears the floor, not only on the refused ones', () => {
  // RSK-4's complaint was that "nothing on the dashboard says so". The data form of the check has to be
  // recorded where the verdict PASSES too — if it were only in the ``acceptVenueFloor`` branch it would be
  // absent on exactly the healthy symbols, which is where a symbol drifting toward its floor shows up first.
  const risk = code('trading/agent/risk.js');
  assert.match(risk, /floorHeadroomMultiple/);
  assert.match(risk, /riskAtFloorPct/);
  const snapAt = risk.indexOf('snapToVenueStep(size,');
  const headroomAt = risk.indexOf('floorHeadroomMultiple:');
  assert.ok(headroomAt > snapAt, 'the headroom must be measured on the SNAPPED size, which is the size sent');
  // ⚠ A RECORD, NOT A SECOND REFUSAL: `venue_minimum` must still be emitted from exactly one site, or a
  // report attributing the code to one rule would be wrong. `test/risk-veto-codes.test.js` owns that.
  assert.strictEqual((risk.match(/veto\('venue_minimum'/g) || []).length, 1,
    'the standing check must not become a second emission site for venue_minimum');
});
