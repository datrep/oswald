// ★★ TRD-OPS-3 (2026-10-02) — the circuit breaker must measure BREADTH, not VOLUME.
//
// THE INCIDENT THIS PINS. `maybeTripBreaker` counted RAW `order_rejected` events in a rolling 30 minutes with
// no de-duplication. On 2026-10-01 Natural Gas failed five order attempts inside 30 min — three
// `order ticket did not open` (26.6-27.2 s each) and two `#trade-button` timeouts — and the breaker soft-killed
// the desk for **62 minutes**. One unreachable instrument, reported as a systemic fault, while the desk was
// already scoping that instrument out.
//
// ★ THE LOAD-BEARING ASSERTION IS THE ONE THAT DOES NOT TRIP. A breaker that fires on five failures from a
// single symbol is exactly as broken as one that fires on none, and only the negative case distinguishes them.
// `5 rejects / 1 symbol` MUST NOT trip; `5 rejects / 5 symbols` MUST.
//
// ⚠ AND THE REASON MUST CARRY BOTH NUMBERS. The old message said "5 rejected orders in 30min" — true, and
// useless: it named the volume that was NOT the problem and omitted the breadth that was.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { breakerDecision, CB_WINDOW_MIN, CB_MAX_REJECTS } = require('../trading/agent/killswitch');
const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const executor = nl(code('trading/agent/executor.js'));
const store = nl(code('trading/store.js'));

test('★★ REFUSE TO TRIP: five rejections from ONE symbol is one fault, not five — the 62-minute outage', () => {
  const d = breakerDecision({ raw: 5, symbols: 1, currentTier: 'off' });
  assert.equal(d.tripped, false, 'a single broken instrument must NEVER soft-kill the desk');
  assert.equal(d.reason, null, 'and it must not produce a trip reason');
  // The exact 2026-10-01 shape, at every volume — a symbol that fails 20 times is still one symbol.
  assert.equal(breakerDecision({ raw: 20, symbols: 1, currentTier: 'off' }).tripped, false);
});

test('★★ TRIP: the same five rejections spread across five symbols IS systemic', () => {
  const d = breakerDecision({ raw: 5, symbols: 5, currentTier: 'off' });
  assert.equal(d.tripped, true, 'five different symbols failing is the fault the breaker exists for');
  assert.match(d.reason, /5 different symbols/);
  assert.match(d.reason, /5 order\(s\) in total/, 'and the reason must still carry the volume');
});

test('★ the threshold is BREADTH and it is exact at the boundary', () => {
  const n = CB_MAX_REJECTS;
  assert.equal(breakerDecision({ raw: n, symbols: n - 1, currentTier: 'off' }).tripped, false, 'one short');
  assert.equal(breakerDecision({ raw: n, symbols: n, currentTier: 'off' }).tripped, true, 'exactly at the floor');
  assert.equal(breakerDecision({ raw: 99, symbols: n + 3, currentTier: 'off' }).tripped, true);
});

test('★ a desk that is ALREADY stopped is not re-tripped, and a non-off tier is never a trigger', () => {
  // The old expression also required `tier === 'off'`. Kept: a sweep that runs again while the desk is soft or
  // hard must not rewrite the tier, or the outage's own start time would keep moving.
  for (const tier of ['soft', 'hard']) {
    const d = breakerDecision({ raw: 50, symbols: 9, currentTier: tier });
    assert.equal(d.tripped, false, `tier ${tier} must not re-trip`);
    assert.equal(d.reason, null);
  }
});

test('★ missing or unreadable input does not trip — absence is not a systemic fault', () => {
  // ⚠ `{ symbols: 5 }` is deliberately NOT in this list: five symbols rejecting IS a trip, and raw 0 beside it
  // is an input that cannot occur. The cases below are the ones where the breadth is genuinely UNKNOWN, and an
  // unknown breadth must read as zero rather than as a fault — the same "unmeasurable is not a breach" rule
  // `floorState` already applies to the disaster floor.
  const absent = [
    {},
    { raw: 5 },
    { raw: null, symbols: null },
    { raw: undefined, symbols: undefined },
    { raw: 'x', symbols: '' },
  ];
  for (const bad of absent) {
    const d = breakerDecision({ ...bad, currentTier: 'off' });
    assert.equal(d.tripped, false, `${JSON.stringify(bad)} must not trip`);
    assert.equal(d.symbols, 0, 'an unreadable breadth must normalise to 0, not to NaN');
  }
});

test('★ the window is stated in the reason, so the record says what it measured over', () => {
  const d = breakerDecision({ raw: 7, symbols: 6, currentTier: 'off' });
  assert.match(d.reason, new RegExp(`${CB_WINDOW_MIN}min`));
});

test('★★ the WRITER uses the breadth counter — not the raw one it used before', () => {
  const fn = /async function maybeTripBreaker\(userId, settings\) \{([\s\S]*?)\n\}/.exec(executor);
  assert.ok(fn, 'maybeTripBreaker must still be findable in executor.js');
  assert.match(fn[1], /countRejectedSymbolsSince\(/, 'it must read distinct symbols');
  assert.doesNotMatch(fn[1], /countEventsSince\(/, 'the raw event count must not come back as the input');
  assert.match(fn[1], /breakerDecision\(/, 'and the policy must be the pure one, not an inline comparison');
});

test('★ the reader counts DISTINCT SYMBOLS, and groups unattributable failures into one bucket', () => {
  const fn = /async function countRejectedSymbolsSince\(userId, sinceMinutes = 30\) \{([\s\S]*?)\n\}/.exec(store);
  assert.ok(fn, 'countRejectedSymbolsSince must exist in store.js');
  assert.match(fn[1], /COUNT\(DISTINCT COALESCE\(JSON_VALUE\(payload, '\$\.symbol'\)/, 'symbols must be DISTINCT');
  assert.match(fn[1], /'<unattributed>'/, 'a rejection with no symbol must not vanish from the count');
  assert.match(fn[1], /kind = 'order_rejected'/, 'and it must read the kind the breaker has always read');
});
