// test/venue-levels-parity.test.js — 2026-09-13: reconciliation for the VENUE levels.
//
// WHY. The existing reconciliation test (`live-backtest-parity.test.js`) covers the
// trailing rule — but that decided only 2 of the 7 day-one closes. The venue-native
// stop/TP decided 4 of 7 (3 take-profits + 1 stop-out), so reconciliation that stops
// at the trail leaves the majority exit path unchecked. Report S5, item 3.
//
// WHAT IT PINS
//   1. The desk's level contract: stop = anchor -/+ stopDist, TP = anchor +/- 1.5 x
//      stopDist, hence |TP - stop| = 2.5 x stopDist. Non-circular: it uses only the
//      recorded levels and the decision-time stop distance.
//   2. That the contract, evaluated at the recorded decision prices, reproduces the
//      levels the venue ACTUALLY received on 2026-09-11 — exact equality, not
//      approximate. This is the cross-check that would catch a refactor of the
//      levels (the class of bug that produced S3).
//   3. The geometry the trade ACTUALLY had, measured from the FILL. The levels are
//      anchored to the decision price while orders land 13-142s later, so the
//      intended 1.5:1 became 0.979:1 to 2.138:1 across those seven trades. Without
//      this the desk's own "TP is at 1.5R" is an unchecked assumption.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { entryLimits, realisedRR, levelSpan, LEVEL_RR } = require('../trading/agent/exitLevels');

// The seven day-one closes as RECORDED (Trades) plus the decision-time stop distance
// (TradingEvents kind='decision' -> $.stopDistance). `anchor` is the decision price,
// derived from the contract itself — see the exact-equality assertions below.
const DAY_ONE = [
  { id: 1032, dir: 'buy', stopDist: 1.4270, stop: 98.6680, tp: 102.2355, fill: 99.9000, anchor: 100.0950, rr: 1.896 },
  { id: 1031, dir: 'buy', stopDist: 1.5152, stop: 98.3198, tp: 102.1078, fill: 99.8500, anchor: 99.8350, rr: 1.475 },
  { id: 1030, dir: 'sell', stopDist: 22.5232, stop: 4361.4382, tp: 4305.1302, fill: 4332.9800, anchor: 4338.9150, rr: 0.979 },
  { id: 1028, dir: 'sell', stopDist: 1.7588, stop: 100.7738, tp: 96.3768, fill: 99.2000, anchor: 99.0150, rr: 1.794 },
  { id: 1027, dir: 'sell', stopDist: 27.2654, stop: 4345.7604, tp: 4277.5969, fill: 4324.0400, anchor: 4318.4950, rr: 2.138 },
  { id: 29, dir: 'buy', stopDist: 1.4210, stop: 100.5340, tp: 104.0865, fill: 102.0900, anchor: 101.9550, rr: 1.283 },
  { id: 27, dir: 'sell', stopDist: 26.1764, stop: 4383.4364, tp: 4317.9954, fill: 4355.2100, anchor: 4357.2600, rr: 1.318 },
];

test('the level contract is 1.5:1 from one shared anchor', () => {
  assert.strictEqual(LEVEL_RR, 1.5);
  // Reproduces the exact levels the venue received for trade 1032 (a buy) and 1030 (a sell).
  assert.deepStrictEqual(entryLimits('buy', 1.427, 100.095), { stopPrice: 98.668, takeProfitPrice: 102.2355 });
  assert.deepStrictEqual(entryLimits('sell', 22.5232, 4338.915), { stopPrice: 4361.4382, takeProfitPrice: 4305.1302 });
  // A stop sits BELOW for a buy and ABOVE for a sell; the TP mirrors it.
  assert.ok(entryLimits('buy', 2, 100).stopPrice < 100);
  assert.ok(entryLimits('buy', 2, 100).takeProfitPrice > 100);
  assert.ok(entryLimits('sell', 2, 100).stopPrice > 100);
  assert.ok(entryLimits('sell', 2, 100).takeProfitPrice < 100);
  // No anchor or no stop distance -> no levels (never a guess).
  assert.deepStrictEqual(entryLimits('buy', 0, 100), { stopPrice: null, takeProfitPrice: null });
  assert.deepStrictEqual(entryLimits(null, 2, 100), { stopPrice: null, takeProfitPrice: null });
});

test('the recorded decision price reproduces the venue levels EXACTLY (all seven)', () => {
  for (const t of DAY_ONE) {
    const lv = entryLimits(t.dir, t.stopDist, t.anchor);
    assert.strictEqual(lv.stopPrice, t.stop, `trade ${t.id}: stop level`);
    assert.strictEqual(lv.takeProfitPrice, t.tp, `trade ${t.id}: take-profit level`);
  }
});

test('|TP - stop| = 2.5 x stopDist holds for every recorded trade (non-circular invariant)', () => {
  for (const t of DAY_ONE) {
    const span = +Math.abs(t.tp - t.stop).toFixed(4);
    assert.strictEqual(span, +levelSpan(t.stopDist).toFixed(4), `trade ${t.id}: level span`);
  }
});

test('the geometry the trade ACTUALLY had is not 1.5:1 — slippage re-prices both sides', () => {
  const rrs = [];
  for (const t of DAY_ONE) {
    const r = realisedRR(t.dir, t.fill, t.stop, t.tp);
    assert.ok(Math.abs(r.rr - t.rr) < 0.001, `trade ${t.id}: expected realised R:R ~${t.rr}, got ${r.rr}`);
    assert.notStrictEqual(r.rr, LEVEL_RR, `trade ${t.id}: the realised R:R is not the declared 1.5`);
    rrs.push(r.rr);
  }
  const min = Math.min(...rrs), max = Math.max(...rrs);
  assert.strictEqual(min, 0.979, 'worst day-one geometry: ~1:1, not 1.5:1');
  assert.strictEqual(max, 2.138, 'best day-one geometry: >2:1');
  // The spread is the point: the SAME contract produced both, because the anchor is
  // the decision price and the fill lands up to 142s later.
  assert.ok(max - min > 1.1, 'the realised geometry spans more than one whole R');
});

test('a favourable fill raises R:R and an adverse fill lowers it, for both directions', () => {
  // Buy: anchor 100, stopDist 2 -> stop 98, TP 103.
  assert.ok(realisedRR('buy', 99, 98, 103).rr > LEVEL_RR, 'bought cheaper than the anchor -> more room to the TP');
  assert.ok(realisedRR('buy', 101, 98, 103).rr < LEVEL_RR, 'bought dearer -> the stop is further away');
  // Sell: anchor 100, stopDist 2 -> stop 102, TP 97.
  assert.ok(realisedRR('sell', 101, 102, 97).rr > LEVEL_RR, 'sold higher than the anchor -> more room to the TP');
  assert.ok(realisedRR('sell', 99, 102, 97).rr < LEVEL_RR, 'sold lower -> the stop is further away');
  // And the drift is reported explicitly, not left for a reader to infer.
  const r = realisedRR('sell', 4332.98, 4361.4382, 4305.1302);
  assert.strictEqual(r.driftPct, -34.76, 'trade 1030 lost ~35% of its intended reward:risk to slippage');
});

test('a fill beyond the stop yields no ratio rather than a negative one', () => {
  // Buy filled BELOW its stop (a gap through the level): stopDist would be negative.
  const r = realisedRR('buy', 97, 98, 103);
  assert.strictEqual(r.rr, null);
  assert.strictEqual(r.driftPct, null);
  assert.ok(r.stopDist < 0);
  // A MISSING fill must be rejected, not coerced: Number(null) is 0, so a naive
  // Number.isFinite() guard would compute a geometry from a zero price.
  assert.strictEqual(realisedRR('buy', null, 98, 103), null);
  assert.strictEqual(realisedRR('buy', '', 98, 103), null);
  assert.strictEqual(realisedRR('buy', undefined, 98, 103), null);
  assert.strictEqual(realisedRR('buy', 97, null, 103), null);
  assert.strictEqual(realisedRR('buy', 97, 98, null), null);
});
