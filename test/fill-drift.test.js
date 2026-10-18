// test/fill-drift.test.js — TRD-ANC-1 (observe half), 2026-09-25.
//
// The row says: the F20 re-anchor has never fired. Measured — 30 of 30 `entry_reanchored` events carry
// `shift: 0` — because it compares the desk's own latest tick against a decision price taken from that
// same series. The venue's FILL is what actually moves the levels relative to two ABSOLUTE prices, and
// the mechanism is structurally blind to it.
//
// The repair is deliberately split in two, and this file tests only the FIRST half:
//   (1) OBSERVE — measure the drift from the fill and record it, changing no level. These levels belong
//       to a FROZEN forward-validation candidate (TRD-29, params: []); moving them voids the track.
//   (2) ENFORCE — re-anchor on the fill. Requires an owner ruling and a declared split date.
//
// ★ THE SIGN IS THE WHOLE BALLGAME AND IT WAS GOT WRONG TWICE WHILE BUILDING THIS. `driftPct` is signed on
// PRICE so its meaning flips with direction; a favourable SELL is a HIGHER fill. The normalised
// `betterThanDecided` must be POSITIVE for a favourable fill in BOTH directions, and there is a
// non-vacuity test below that fails if the multiplier is `dir` instead of `-dir`.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const { fillDrift, anchorAgeSec, anchorAgeGate, LEVEL_RR } = require('../trading/agent/exitLevels');

// A real measured ticket: trade 1092, Gold sell. The desk decided at 4265.125 and the venue filled at
// 4271.700 — 6.575 HIGHER, which is favourable for a sell and lands the fill much closer to the stop.
const GOLD_1092 = {
  direction: 'sell', anchorPrice: 4265.125, fillPrice: 4271.7,
  stopPrice: 4277.9204, takeProfitPrice: 4241.4115, intendedStopDist: 12.7954,
};

test('★ a favourable SELL is a HIGHER fill, and reads POSITIVE', () => {
  const d = fillDrift(GOLD_1092);
  assert.strictEqual(d.ok, true);
  assert.ok(d.driftPct > 0, 'the fill was above the anchor, so the raw price drift is positive');
  assert.ok(d.betterThanDecided > 0, 'and for a SELL that is favourable — the normalised sign must be positive');
  assert.strictEqual(d.worseEntry, false);
});

test('★ non-vacuity: flipping only the direction flips the sign of the normalised drift', () => {
  // If the multiplier were `dir` instead of `-dir`, these two would have the SAME sign and the test above
  // would pass by construction. This is the assertion that makes it capable of failing.
  const sell = fillDrift(GOLD_1092);
  const asBuy = fillDrift({ ...GOLD_1092, direction: 'buy' });
  assert.ok(sell.betterThanDecided > 0, 'sell filled higher is favourable');
  assert.ok(asBuy.betterThanDecided < 0, 'buy filled higher is ADVERSE');
  assert.strictEqual(Math.sign(sell.betterThanDecided), -Math.sign(asBuy.betterThanDecided));
});

test('★ a favourable fill TIGHTENS the realised stop — the cost the drift actually imposes', () => {
  const d = fillDrift(GOLD_1092);
  // The stop is absolute at 4277.9204, so selling 6.575 higher leaves only 6.22 of room where the ticket
  // was sized for 12.80.
  assert.ok(Math.abs(d.realisedStopDist - 6.2204) < 0.001, `expected ~6.22, got ${d.realisedStopDist}`);
  assert.ok(d.realisedStopDist < d.intendedStopDist, 'less room than was sized for');
  assert.ok(Math.abs(d.stopDistRatio - 0.4862) < 0.001, `expected ~0.486x, got ${d.stopDistRatio}`);
  assert.ok(d.realisedRR > LEVEL_RR, `reward:risk rises above the declared ${LEVEL_RR}: got ${d.realisedRR}`);
  assert.ok(Math.abs(d.realisedRR - 4.87) < 0.01, `the measured value was 4.87, got ${d.realisedRR}`);
});

test('an adverse fill WIDENS the stop, which is the expensive direction', () => {
  // A buy decided at 100 that filled at 101, stop 98, target 103: it risks 3 where it sized for 2, and the
  // reward shrank from 3 to 2.
  const d = fillDrift({ direction: 'buy', anchorPrice: 100, fillPrice: 101, stopPrice: 98,
    takeProfitPrice: 103, intendedStopDist: 2 });
  assert.strictEqual(d.worseEntry, true);
  assert.ok(d.betterThanDecided < 0);
  assert.strictEqual(d.realisedStopDist, 3);
  assert.strictEqual(d.realisedTpDist, 2);
  assert.ok(Math.abs(d.realisedRR - 0.6667) < 0.001);
  assert.strictEqual(d.stopDistRatio, 1.5, '1.5x the risk it sized for');
});

test('★ the WARN band is the codebase own 0.05%, so the two agree on what "drifted" means', () => {
  const small = fillDrift({ ...GOLD_1092, fillPrice: 4265.125 * 1.0004 });  // +0.04%
  const big = fillDrift(GOLD_1092);                                          // +0.154%
  assert.strictEqual(small.beyondWarn, false);
  assert.strictEqual(big.beyondWarn, true);
  assert.strictEqual(big.driftWarnPct, 0.05);
});

test('★ no levels -> the geometry is ABSENT, not zero', () => {
  const d = fillDrift({ direction: 'sell', anchorPrice: 100, fillPrice: 101 });
  assert.strictEqual(d.ok, true, 'the drift itself is still measurable');
  assert.ok(d.driftPct > 0);
  // `0` would read as "no room to the stop" — a specific and alarming claim the read never made.
  assert.strictEqual(d.realisedStopDist, null);
  assert.strictEqual(d.realisedRR, null);
  assert.strictEqual(d.stopDistRatio, null);
});

test('★ a stop on the WRONG SIDE of the fill yields null, not a meaningless ratio', () => {
  // A buy whose stop sits ABOVE the fill: the position is not the one that was decided on at all.
  const d = fillDrift({ direction: 'buy', anchorPrice: 100, fillPrice: 99, stopPrice: 99.5,
    takeProfitPrice: 103, intendedStopDist: 1 });
  assert.strictEqual(d.stopOnWrongSide, true);
  assert.strictEqual(d.realisedRR, null);
  assert.strictEqual(d.stopDistRatio, null);
});

test('absent prices are refused rather than coerced (the Number(null) === 0 trap)', () => {
  assert.strictEqual(fillDrift({ direction: 'buy', anchorPrice: null, fillPrice: 100 }).ok, false);
  assert.strictEqual(fillDrift({ direction: 'buy', anchorPrice: 100, fillPrice: null }).ok, false);
  assert.strictEqual(fillDrift({ direction: null, anchorPrice: 100, fillPrice: 100 }).ok, false);
  assert.strictEqual(fillDrift({ direction: 'buy', anchorPrice: 100, fillPrice: 100 }).reason, null,
    'a zero drift is a VALID measurement — equal prices are a real outcome');
});

// --- the wiring, pinned structurally ----------------------------------------- -

const src = code('trading/agent/executor.js');

test('★ the measurement runs AFTER the fill — it has to, or it is measuring the decision against itself', () => {
  const fillAt = src.indexOf('const fill = await connector.placeOrder');
  const geoAt = src.indexOf('const geometry = fillDrift(');
  assert.ok(fillAt !== -1 && geoAt !== -1, 'both must be present to compare their order');
  assert.ok(geoAt > fillAt, 'measuring before the fill is exactly the F20 defect being fixed');
});

test('★ OBSERVE ONLY: the measurement must not write back into the levels', () => {
  assert.match(src, /fillDrift\(\{/, 'it must use the shared pure helper');
  assert.ok(!/levels\.(stop|tp)\s*=/.test(src),
    'the geometry is recorded, never assigned back — these levels are a frozen candidate (TRD-29)');
  assert.match(src, /stopPrice: levels\.stop, takeProfitPrice: levels\.tp/, 'the venue still receives the declared levels');
});

test('★ the drift and the realised geometry ride with fill_telemetry', () => {
  assert.match(src, /logEvent\(userId, 'fill_telemetry'/);
  assert.match(src, /realisedRR:/);
  assert.match(src, /stopDistRatio:/);
  assert.match(src, /reanchorInert/);
});

test('★ an inert re-anchor with a drifted fill is recorded as its own fact', () => {
  assert.match(src, /logEvent\(userId, 'reanchor_inert'/);
  assert.match(src, /Number\(reanchor\.shift\) === 0 && geometry\.ok && geometry\.beyondWarn/,
    'the condition is the whole point: success reported AND the fill diverged');
});

test('★ the re-anchor note no longer claims the levels were shifted when they were not', () => {
  assert.match(src, /Number\(reanchor\.shift\) === 0\s*\n\s*\? 're-anchor ran but shifted NOTHING/,
    'on 30 of 30 events shift is 0, so an unconditional "levels shifted" note asserts what did not happen');
});

// --- the anchor-age gate (option (c), which the measurement validated) ----------------------

test('anchorAgeSec measures seconds, and refuses to guess when there is no timestamp', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  assert.strictEqual(anchorAgeSec({ asOf: '2026-09-25T11:59:58.000Z', nowMs: now }), 2);
  assert.strictEqual(anchorAgeSec({ asOf: '2026-09-25T11:58:00.000Z', nowMs: now }), 120);
});

test('★ absence is guarded BEFORE coercion — no timestamp must not read as a ZERO-age anchor', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  for (const bad of [null, undefined, '', 'nonsense']) {
    assert.strictEqual(anchorAgeSec({ asOf: bad, nowMs: now }), null,
      `asOf=${JSON.stringify(bad)} would otherwise report the FRESHEST possible price for a trade that has no timestamp`);
  }
});

test('a future timestamp is a clock disagreement, not a fresh anchor', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z');
  assert.strictEqual(anchorAgeSec({ asOf: '2026-09-25T12:00:30.000Z', nowMs: now }), null);
});

test('★ the gate is OFF unless a positive cap is set — a flag that is off changes nothing', () => {
  for (const off of [null, undefined, '', 0, -1, 'nonsense']) {
    const g = anchorAgeGate({ anchorAgeSec: 9999, maxAgeSec: off });
    assert.strictEqual(g.gated, false, `maxAgeSec=${JSON.stringify(off)} must not gate`);
    assert.strictEqual(g.refuse, false);
  }
});

test('★ the gate REFUSES above the cap and passes below it (non-vacuity: it can refuse)', () => {
  const refuse = anchorAgeGate({ anchorAgeSec: 524, maxAgeSec: 120 });
  assert.strictEqual(refuse.gated, true);
  assert.strictEqual(refuse.refuse, true);
  assert.strictEqual(refuse.reason, 'anchor_too_old');
  assert.strictEqual(anchorAgeGate({ anchorAgeSec: 65, maxAgeSec: 120 }).refuse, false);
  // exactly at the cap is not over it
  assert.strictEqual(anchorAgeGate({ anchorAgeSec: 120, maxAgeSec: 120 }).refuse, false);
});

test('an UNKNOWN age is gated but not refused, and says so', () => {
  const g = anchorAgeGate({ anchorAgeSec: null, maxAgeSec: 120 });
  assert.strictEqual(g.gated, true, 'the gate is configured');
  assert.strictEqual(g.refuse, false, 'but an unmeasured age cannot justify a refusal');
  assert.strictEqual(g.reason, 'age_unknown');
});

test('★★ THE MEASURED THRESHOLD CHOICE — the numbers the owner would be choosing between', () => {
  // From the 30 recorded asOf->fill lags: 120s would have refused 4 (incl. #1082 at 524s, the largest
  // drift at 0.455%); 300s would have refused 1. Pinned so the trade-off cannot be restated from memory.
  const lags = [35, 58, 71, 90, 149, 180, 90, 55, 62, 217, 89, 524, 85, 37, 111, 77, 43, 48, 116, 65,
    36, 71, 49, 50, 89, 58, 49, 55, 44, 46];
  const refuseAt = (cap) => lags.filter((x) => x > cap).length;
  assert.strictEqual(refuseAt(120), 4, `120s refuses 4 of ${lags.length}`);
  assert.strictEqual(refuseAt(300), 1, `300s refuses 1 of ${lags.length}`);
  assert.strictEqual(refuseAt(600), 0, 'a cap above every observed lag refuses nothing — i.e. it is off in effect');
});

// --- the wiring of the gate ----------------------------------------------------------------

test('★ the gate is a VETO placed BEFORE the order — after it, it would be decoration', () => {
  const gateAt = src.indexOf('const ageGate = anchorAgeGate(');
  const orderAt = src.indexOf('const fill = await connector.placeOrder');
  assert.ok(gateAt !== -1 && orderAt !== -1, 'both must be present to compare their order');
  assert.ok(gateAt < orderAt, 'a refusal after the order has been placed is not a refusal');
  assert.match(src, /reason: 'anchor_too_old'/);
  assert.match(src, /placed: false, reason: 'anchor_too_old'/, 'and it must return placed:false, not throw');
});

test('★ the anchor age is recorded whether or not the gate is on', () => {
  assert.match(src, /anchorAgeSec: anchorAge,/);
  assert.match(src, /anchorAgeWouldRefuse: ageGate\.gated \? ageGate\.refuse : null/,
    'recording only when the gate is on would make the threshold unchosen-able from the data');
});

test('★ the gate default is OFF in the settings block', () => {
  const settings = require('./_source').code('trading/store.js');
  assert.match(settings, /maxAnchorAgeSec: null/, 'a default cap would silently change every entry');
});
