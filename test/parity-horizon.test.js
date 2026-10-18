// test/parity-horizon.test.js — the fixed point, and the fact that the SIGN decides the destination.
//
// The two load-bearing assertions here are invariants, not arithmetic:
//   1. a positive mean can never be RETIRED by this scan, and a negative mean can never be ACCEPTED,
//      at any n — because the interval collapses onto the mean as se -> 0;
//   2. the coupled (looks-growing) answer is never SOONER than the snapshot, and never for a
//      smaller target — the snapshot can only understate the wait.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ratePerDay, horizon } = require('../trading/agent/parityHorizon');
const { requiredSample } = require('../trading/agent/expectancy');

test('ratePerDay states its denominator and refuses to invent one', () => {
  // Fewer than two closes has no span at all. This must be null, not 0 and not a default speed.
  assert.equal(ratePerDay(['2026-09-10T00:00:00Z']).perDay, null);
  assert.equal(ratePerDay([]).perDay, null);
  assert.equal(ratePerDay(null).perDay, null);

  // 4 closes over 3 elapsed days: the FIRST is the origin, so 3 intervals / 3 days = 1/day.
  const four = ['2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z', '2026-09-13T00:00:00Z'];
  const r = ratePerDay(four);
  assert.equal(r.n, 4);
  assert.equal(r.spanDays, 3);
  assert.equal(Number(r.perDay.toFixed(6)), 1);
  assert.equal(r.reason, null);

  // Dates are SORTED before the span is taken, so an unordered ledger cannot yield a nonsense rate.
  const jumbled = ['2026-09-13T00:00:00Z', '2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z'];
  assert.equal(Number(ratePerDay(jumbled).perDay.toFixed(6)), 1);

  // Undated rows are dropped, and dropping them changes the answer — so the count is reported.
  const partial = ratePerDay(['2026-09-10T00:00:00Z', null, 'garbage', '2026-09-12T00:00:00Z']);
  assert.equal(partial.n, 2);
  assert.equal(Number(partial.perDay.toFixed(6)), 0.5);
});

test('the SIGN decides the destination — volume only decides when', () => {
  // A positive mean over a huge sample, stepped for a century: accept eventually, retire never.
  const pos = horizon({ n: 10, meanR: 0.30, sdR: 1.00 }, { looks: 1, ratePerDay: 1, maxWeeks: 5200 });
  assert.equal(pos.coupled.retired, false, 'a positive observed mean must never retire in this scan');

  // A negative mean is the mirror: retire eventually, accept NEVER — at any n.
  const neg = horizon({ n: 10, meanR: -0.30, sdR: 1.00 }, { looks: 1, ratePerDay: 1, maxWeeks: 5200 });
  assert.equal(neg.coupled.accepted, false, 'a negative observed mean must never accept in this scan');
  assert.equal(neg.coupled.retired, true);
  assert.equal(neg.naive.acceptAt, null);
  assert.equal(neg.naive.retireAt != null, true, 'the snapshot already shows retirement is the direction');
  assert.ok(neg.notes.some((x) => /UNREACHABLE/.test(x)), 'the unreachable case must be stated, not implied by a null');
});

test('the coupled answer is never sooner than the snapshot, and never for a smaller target', () => {
  // The live survgold shape: n=5, mean +0.4179, sd 1.3939, at 3 looks.
  const h = horizon({ n: 5, meanR: 0.4179, sdR: 1.3939 }, { looks: 3, ratePerDay: 1.3 });
  assert.ok(h.naive.acceptAt > 0, 'the snapshot should find a target');
  assert.equal(h.coupled.accepted, true);
  assert.ok(h.coupled.days >= h.naive.days, `coupled ${h.coupled.days}d must not be sooner than snapshot ${h.naive.days}d`);
  assert.ok(h.coupled.targetAtAccept >= h.naive.acceptAt, `target at accept ${h.coupled.targetAtAccept} must be >= snapshot ${h.naive.acceptAt}`);
  assert.ok(h.coupled.inflation > 1, 'the inflation factor exists precisely because the two differ');

  // The fixed point is self-consistent: at the looks it was reached with, the snapshot target is
  // the same number (both call the real verdict).
  const t = requiredSample({ meanR: 0.4179, sdR: 1.3939 }, { looks: h.coupled.looks, minTrades: 10 }).acceptAt;
  assert.equal(h.coupled.targetAtAccept, t);
});

test('a rate that cannot be measured produces NO calendar claim, rather than a guessed one', () => {
  const h = horizon({ n: 5, meanR: 0.4, sdR: 1.3 }, { looks: 3, ratePerDay: null });
  assert.equal(h.coupled, null, 'no rate => no fixed point');
  assert.ok(h.naive.acceptAt > 0, 'the snapshot still works without a rate');
  assert.equal(h.naive.days, null, 'and it must not convert trades into days it cannot measure');
  assert.ok(h.notes.some((x) => /unmeasurable rate is not a slow rate/.test(x)));
});

test('undefined dispersion is reported, not treated as zero', () => {
  const h = horizon({ n: 5, meanR: 0.4, sdR: NaN }, { looks: 3, ratePerDay: 1 });
  assert.equal(h.coupled, null);
  assert.ok(h.notes.some((x) => /dispersion is undefined or zero/.test(x)));
  // A single trade has no sd at all (macd, live) — that is the same refusal, one layer down.
  const single = horizon({ n: 1, meanR: -0.0764, sdR: NaN }, { looks: 3, ratePerDay: 1 });
  assert.equal(single.coupled, null);
  assert.equal(single.naive.acceptAt, null);
});

test('a genuine edge is certified quickly — the model does not manufacture a long wait', () => {
  // mean 1R on sd 1R is a large edge; it should cross inside a few dozen trades, not hundreds.
  const h = horizon({ n: 5, meanR: 1.0, sdR: 1.0 }, { looks: 3, ratePerDay: 2 });
  assert.equal(h.coupled.accepted, true);
  assert.ok(h.coupled.targetAtAccept < 40, `expected a small target, got ${h.coupled.targetAtAccept}`);
  assert.ok(h.coupled.weeks <= 3, `expected a short wait, got ${h.coupled.weeks} weeks`);
});

test('a tiny edge against its own dispersion is effectively uncertifiable, and says so', () => {
  // The live survoil shape: +0.091R against sd 0.855 — 9% of one R, and 10.7% of its own sd.
  const h = horizon({ n: 7, meanR: 0.091, sdR: 0.8546 }, { looks: 3, ratePerDay: 1.8 });
  assert.ok(h.naive.acceptAt > 300, `snapshot should already be large, got ${h.naive.acceptAt}`);
  assert.ok(h.coupled.days > 365, `the fixed point should exceed a year, got ${h.coupled.days} days`);
  assert.ok(h.coupled.targetAtAccept > h.naive.acceptAt, 'and it should be larger than the snapshot');
});
