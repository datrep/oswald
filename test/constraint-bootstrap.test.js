'use strict';
// constraint-bootstrap.test.js — the pure half of Phase 6.
const { test } = require('node:test');
const assert = require('node:assert');
const boot = require('../trading/agent/constraintBootstrap');

const gold = {
  symbol: 'Gold', venueInstrumentId: '11', instrumentClass: 'spot',
  unitAmount: 0.025, unitKind: 'Troy Ounces', initialMarginPct: 20,
  fundingBuyPct: -0.0319, fundingSellPct: -0.012, fundingTime: '5:00 AM',
};
const field = (patches, f) => patches.find((p) => p.constraintKey.endsWith(`.${f}`));

test('an instrument yields one patch per populated field', () => {
  const p = boot.patchesForInstrument(gold);
  assert.deepStrictEqual(p.map((x) => x.constraintKey.split('.').pop()).sort(),
    ['funding_buy_pct', 'funding_sell_pct', 'funding_time', 'initial_margin_pct', 'minimum_trade_size']);
});

test('⚠ LEVERAGE IS NOT CAPTURED — it is a rounded rendering of the margin', () => {
  // Measured 2026-10-27: 1/5 = 20%, 1/10 = 10%, and the venue's 60% renders as 1:1.67. Storing both would be two
  // producers of one fact, and they disagree in the third case (59.88 vs 60).
  const p = boot.patchesForInstrument({ ...gold, leverageRaw: '1:5' });
  assert.strictEqual(p.some((x) => /leverage/.test(x.constraintKey)), false);
});

test('⚠ A NEGATIVE FUNDING RATE IS A COST, NOT AN ABSENCE — the sign survives', () => {
  // The classic `Number(null) === 0` family: a naive truthiness test would drop a 0 rate AND mangle a negative one.
  const p = boot.patchesForInstrument(gold);
  assert.strictEqual(Number(field(p, 'funding_buy_pct').valueNumeric), -0.0319);
  assert.strictEqual(Number(field(p, 'funding_sell_pct').valueNumeric), -0.012);
  // A ZERO rate is a real value and must still be captured.
  const zero = boot.patchesForInstrument({ ...gold, fundingBuyPct: 0 });
  assert.strictEqual(Number(field(zero, 'funding_buy_pct').valueNumeric), 0);
});

test('an ABSENT source value produces NO patch rather than a zero', () => {
  const p = boot.patchesForInstrument({ ...gold, initialMarginPct: null, unitAmount: null });
  assert.strictEqual(field(p, 'initial_margin_pct'), undefined);
  assert.strictEqual(field(p, 'minimum_trade_size'), undefined);
});

test('the minimum size carries the venue unit label, not a bare number', () => {
  const m = field(boot.patchesForInstrument(gold), 'minimum_trade_size');
  assert.strictEqual(m.valueUnit, 'Troy Ounces');
  assert.strictEqual(Number(m.valueNumeric), 0.025);
});

test('every patch is UNDATED and only `observed` — a capture is not a claim', () => {
  for (const p of boot.patchesForInstrument(gold)) {
    assert.strictEqual(p.effectiveFrom, null, `${p.constraintKey} must be undated: Instruments cannot supply history`);
    assert.strictEqual(p.verificationState, 'observed', `${p.constraintKey} must not claim to be confirmed`);
  }
});

test('keys are per-instrument, so two instruments never share one', () => {
  // The unique index and the overlap rule are both per KEY, so a shared key would make two instruments' versions
  // collide the moment either is dated.
  const a = boot.patchesForInstrument({ ...gold, venueInstrumentId: '11' }).map((p) => p.constraintKey);
  const b = boot.patchesForInstrument({ ...gold, symbol: 'Oil', venueInstrumentId: '10' }).map((p) => p.constraintKey);
  assert.strictEqual(a.some((k) => b.includes(k)), false);
  assert.ok(a.every((k) => k.startsWith('plus500.11.')));
});

test('a row with no venueInstrumentId produces nothing — the key would be unaddressable', () => {
  assert.deepStrictEqual(boot.patchesForInstrument({ ...gold, venueInstrumentId: null }), []);
});

test('the venue prohibition is ONE asserted row, not one per instrument', () => {
  // ⚠ `asserted`, not `observed`: it is a measured OPERATIONAL fact (a second tab caused a sign-out and a 4h45m
  // entry block), not something read off the venue page. Calling it observed would overstate its origin.
  const p = boot.venueProhibition();
  assert.strictEqual(p.constraintType, 'prohibition');
  assert.strictEqual(p.verificationState, 'asserted');
  assert.strictEqual(p.venueInstrumentId, null, 'a venue-wide rule must not be bound to one instrument');
  assert.strictEqual(/\./.test(p.constraintKey.split('.').slice(1).join('.')), false);
});

test('alreadyPresent: an identical undated candidate counts as present', () => {
  const p = field(boot.patchesForInstrument(gold), 'initial_margin_pct');
  const existing = [{ effectiveFrom: null, constraintType: 'numeric_limit', valueNumeric: 20, valueUnit: 'percent' }];
  assert.strictEqual(boot.alreadyPresent(existing, p), true);
  assert.strictEqual(boot.alreadyPresent([{ ...existing[0], valueNumeric: 25 }], p), false);
  // A DATED row does not count: re-running the bootstrap must not be silenced by a historical version.
  assert.strictEqual(boot.alreadyPresent([{ ...existing[0], effectiveFrom: '2026-01-01T00:00:00Z' }], p), false);
});
