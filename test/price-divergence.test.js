'use strict';
// TRD-FED-1: cross-source divergence — DETECTED here, so it can be LOGGED.
//
// The row's acceptance item: *"a divergence that is DETECTED and not LOGGED is still invisible to the next
// investigation."* It was not logged because it was not detected: `pickTick` chose ONE candidate and never
// compared them, so the 09-24 Oil spike (2.293%) and the worse 2026-09-18 one (5.124%) were only findable by
// post-hoc analysis of `PriceTicks` — which is the state the item forbids.
//
// ⚠ THE ASSERTION THAT MATTERS MOST is the one about what is NOT compared. A stale quote is EXPECTED to
// disagree, so folding stale candidates in would report every ordinary outage as a divergence and drown the
// signal the row is actually about.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const quant = require(path.join(__dirname, '..', 'trading', 'agent', 'quant'));

const FRESH = (venue, mid) => ({ venue, mid, capturedAt: new Date().toISOString(), ageMs: 1000 });
const STALE = (venue, mid) => ({ venue, mid, capturedAt: new Date(Date.now() - 3600000).toISOString(), ageMs: 3600000 });

test('★ divergence is measured across the FRESH candidates that pickTick already holds', () => {
  // Two fresh venues 2.3% apart — the shape of the 09-24 Oil event.
  const r = quant.pickTick([FRESH('plus500', 95.0), FRESH('yahoo', 97.2)], { primary: 'plus500' });
  assert.ok(r.divergence, 'a divergence must be reported');
  assert.equal(r.divergence.maxSpreadPct, +(((97.2 - 95.0) / 95.0) * 100).toFixed(4));
  assert.deepEqual(r.divergence.venues, ['plus500', 'yahoo']);
  assert.deepEqual(r.divergence.mids, [95.0, 97.2]);
  assert.equal(r.divergence.compared, 1, 'one pair was compared');
  assert.equal(r.divergence.freshVenues, 2);
});

test('★★ A STALE venue is NOT counted as a divergence — a stale quote is EXPECTED to disagree', () => {
  // same 2.3% gap, but the second venue is an hour old. That is an OUTAGE, not a divergence, and it is
  // already carried in `staleVenues`. Reporting it here would make every ordinary outage look alarming.
  const r = quant.pickTick([FRESH('plus500', 95.0), STALE('yahoo', 97.2)], { primary: 'plus500' });
  assert.equal(r.divergence, null, 'a stale candidate must not create a divergence');
  assert.equal(r.staleVenues.length, 1, 'and it is still reported as stale, so the fact is not lost');
  assert.equal(r.staleVenues[0].venue, 'yahoo');
});

test('★ divergence is null when there is nothing to compare, and says how many pairs it compared', () => {
  // A single fresh venue is not "no divergence" — it is "no comparison possible". The `compared` count is what
  // lets a reader tell those apart, so a lone venue must yield null rather than 0.
  const one = quant.pickTick([FRESH('plus500', 95.0)], { primary: 'plus500' });
  assert.equal(one.divergence, null, 'one venue cannot diverge from anything');
  const none = quant.pickTick([], { primary: 'plus500' });
  assert.equal(none.divergence, null);
  assert.equal(none.mid, null);
});

test('★ the MAXIMUM pair is reported, and `compared` counts every pair (non-vacuity)', () => {
  // Three fresh venues: 3 pairs. The max is 3-1 (2%), not 1-2 (1%) nor 2-3 (1.01%).
  const r = quant.pickTick([FRESH('a', 100), FRESH('b', 101), FRESH('c', 102)], { primary: 'a' });
  assert.equal(r.divergence.compared, 3, 'three pairs, not one');
  assert.equal(r.divergence.freshVenues, 3);
  assert.equal(r.divergence.maxSpreadPct, 2, 'the widest pair wins: 100 -> 102');
  assert.deepEqual(r.divergence.venues, ['a', 'c']);
});

test('divergence is null on a stale-only set, and the mid is STILL the least-stale substitute', () => {
  // ⚠ MY FIRST VERSION OF THIS TEST ASSERTED `mid === null` AND WAS WRONG. `pickTick` deliberately falls back
  // to the LEAST STALE substitute rather than refusing, so a stale-only candidate set returns a real price
  // (here `10`, the first of two identically-aged venues) — the `mid: null` path is only reached when there
  // are NO usable candidates at all. The code was right; the expectation was not, and it was the assertion
  // that failed rather than the behaviour. Both halves are pinned here so neither can drift silently.
  const r = quant.pickTick([STALE('x', 10), STALE('y', 20)], {});
  assert.equal(r.mid, 10, 'the least-stale substitute is used, not refused');
  assert.equal(r.substituted, true, 'and it is marked as a substitution');
  assert.equal(r.stale, true, 'and as stale');
  assert.ok('divergence' in r, 'the field exists on every return shape');
  assert.equal(r.divergence, null, 'null because NOTHING was fresh — not because nothing disagreed');
  assert.equal(r.staleVenues.length, 2, 'both stale venues are still named');
});

test('a genuinely empty candidate list is the ONLY way to get mid null', () => {
  const r = quant.pickTick([], {});
  assert.equal(r.mid, null);
  assert.equal(r.divergence, null);
  assert.equal(r.staleVenues.length, 0);
});

test('a NON-POSITIVE mid is excluded from the comparison, as it is from selection', () => {
  const r = quant.pickTick([FRESH('a', 100), { venue: 'b', mid: 0, capturedAt: new Date().toISOString(), ageMs: 5 }], { primary: 'a' });
  assert.equal(r.divergence, null, 'a zero mid is not a price and cannot be a divergence');
});
