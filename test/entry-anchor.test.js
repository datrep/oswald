'use strict';
// F20 (18/09): anchor at SUBMIT, not at the snapshot.
//
// The levels are absolute prices derived from the decision snapshot, and the venue fills at whatever
// price it finds. Shifting BOTH levels by (fresh - decision) makes the geometry that reaches the venue
// the geometry that was intended — exactly, because the span is preserved and the risk distance is
// unchanged. Past one full stop distance the desk refuses instead of re-anchoring, because at that point
// the trade is no longer the one that was deliberated.
//
// NOT replayed here: #1046's actual anchor. The ledger records that it WAS 1.561% from the fill, not
// which side of it — an inferred anchor would be a number this file invented, and asserting against an
// invented number is how the F17 threshold went wrong the first time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { reanchorLevels, realisedRR, LEVEL_RR } = require('../trading/agent/exitLevels');

// A sell with a declared 1.5R geometry: stop above, target below, risk distance 1.5.
const SELL = { stopPrice: 101.5, takeProfitPrice: 97.75, decisionPrice: 100 }; // stopDist 1.5, tpDist 2.25

test('the shift preserves the span and restores the declared R:R at the submit price', () => {
  const fresh = 100.4;
  const r = reanchorLevels({ ...SELL, freshPrice: fresh });
  assert.equal(r.ok, true, r.reason || '');
  // the span is untouched — the shift moves the geometry, it does not reshape it
  assert.ok(Math.abs(Math.abs(r.takeProfitPrice - r.stopPrice) - Math.abs(SELL.takeProfitPrice - SELL.stopPrice)) < 1e-9);
  // and the geometry measured from the price the order is submitted at is the DECLARED ratio again
  const realised = realisedRR('sell', fresh, r.stopPrice, r.takeProfitPrice);
  assert.ok(Math.abs(realised.rr - LEVEL_RR) < 1e-9, `rr=${realised.rr} expected ${LEVEL_RR}`);
  assert.equal(realised.driftPct, 0);
});

test('the same holds for a buy, and for a shift the other way', () => {
  const buy = { stopPrice: 98.5, takeProfitPrice: 102.25, decisionPrice: 100 };
  for (const fresh of [98.75, 99.2, 100.6, 101.4]) {
    const r = reanchorLevels({ ...buy, freshPrice: fresh });
    assert.equal(r.ok, true, `fresh ${fresh}: ${r.reason}`);
    const realised = realisedRR('buy', fresh, r.stopPrice, r.takeProfitPrice);
    assert.ok(Math.abs(realised.rr - LEVEL_RR) < 1e-9, `fresh ${fresh}: rr=${realised.rr}`);
  }
});

test('a no-op shift returns the levels unchanged', () => {
  const r = reanchorLevels({ ...SELL, freshPrice: SELL.decisionPrice });
  assert.equal(r.ok, true);
  assert.equal(r.shift, 0);
  assert.equal(r.stopPrice, SELL.stopPrice);
  assert.equal(r.takeProfitPrice, SELL.takeProfitPrice);
});

test('one full stop distance is the refusal boundary, and it is refused rather than clamped', () => {
  const stopDist = Math.abs(SELL.decisionPrice - SELL.stopPrice); // 1.5
  // just inside: re-anchor
  const inside = reanchorLevels({ ...SELL, freshPrice: SELL.decisionPrice - stopDist * 0.999 });
  assert.equal(inside.ok, true);
  // exactly at the boundary: refuse (>=, so the boundary belongs to refusal)
  const at = reanchorLevels({ ...SELL, freshPrice: SELL.decisionPrice - stopDist });
  assert.equal(at.ok, false);
  assert.equal(at.reason, 'anchor_stale');
  assert.equal(at.shiftInStops, 1);
  // beyond: refuse
  const past = reanchorLevels({ ...SELL, freshPrice: SELL.decisionPrice - stopDist * 3 });
  assert.equal(past.reason, 'anchor_stale');
});

test('a refusal returns NO levels, so a caller cannot use them by accident', () => {
  const r = reanchorLevels({ ...SELL, freshPrice: SELL.decisionPrice - 5 });
  assert.equal(r.ok, false);
  assert.equal(r.stopPrice, null);
  assert.equal(r.takeProfitPrice, null);
  assert.equal(r.shiftInStops, 3.3333333333333335);
});

test('the guards name themselves instead of guessing', () => {
  assert.equal(reanchorLevels({ ...SELL, stopPrice: null, freshPrice: 100 }).reason, 'levels_missing');
  assert.equal(reanchorLevels({ ...SELL, takeProfitPrice: null, freshPrice: 100 }).reason, 'levels_missing');
  assert.equal(reanchorLevels({ ...SELL, freshPrice: null }).reason, 'prices_missing');
  assert.equal(reanchorLevels({ ...SELL, decisionPrice: null, freshPrice: 100 }).reason, 'prices_missing');
  assert.equal(reanchorLevels({ ...SELL, freshPrice: 'abc' }).reason, 'prices_missing');
  // a stop ON the decision price has no risk distance to preserve — refuse rather than divide by zero
  assert.equal(reanchorLevels({ stopPrice: 100, takeProfitPrice: 102, decisionPrice: 100, freshPrice: 100.1 }).reason, 'stop_dist_zero');
});

test('a shift that would drive a level non-positive is refused, not returned', () => {
  // A cheap instrument where the stop sits just above zero: a large-but-legal shift crosses it.
  const r = reanchorLevels({ stopPrice: 0.01, takeProfitPrice: 0.03, decisionPrice: 0.035, freshPrice: 0.001 });
  assert.equal(r.ok, false);
  assert.ok(['levels_non_positive', 'anchor_stale'].includes(r.reason), r.reason);
});

test('direction is not a parameter, so the rule cannot be applied the wrong way round', () => {
  // The shift is symmetric: a buy and a sell with mirrored levels get mirrored shifts.
  const long = reanchorLevels({ stopPrice: 98.5, takeProfitPrice: 102.25, decisionPrice: 100, freshPrice: 100.5 });
  const short = reanchorLevels({ stopPrice: 101.5, takeProfitPrice: 97.75, decisionPrice: 100, freshPrice: 100.5 });
  assert.equal(long.shift, short.shift);
  assert.equal(long.shiftInStops, short.shiftInStops);
});

const EXECUTOR = path.join(__dirname, '..', 'trading', 'agent', 'executor.js');

// Source with `//` comments removed — several pins below assert on ABSENCE, and this file's comments
// deliberately spell out the bad accessor they document. A comment must never be what fails a code pin.
function code() {
  return fs.readFileSync(EXECUTOR, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l)) // drop comment-only lines (CRLF-safe: filter, do not anchor with $)
    .join('\n');
}

test('the executor re-anchors BEFORE it places the order, and posts the shifted levels', () => {
  const src = code();
  const reanchorAt = src.indexOf('const ra = reanchorLevels({');
  const placeAt = src.indexOf('connector.placeOrder(settings,');
  assert.ok(reanchorAt > 0, 'executor no longer calls reanchorLevels');
  assert.ok(placeAt > 0, 'executor no longer calls placeOrder');
  assert.ok(reanchorAt < placeAt, 'the re-anchor must run BEFORE the order — the ordering is the fix');
  // and the order must carry the SHIFTED levels, not the snapshot ones
  const call = src.slice(placeAt, placeAt + 220);
  assert.match(call, /stopPrice: levels\.stop/, `the order posts the wrong stop: ${call}`);
  assert.match(call, /takeProfitPrice: levels\.tp/, `the order posts the wrong target: ${call}`);
});

test('the re-anchor is gated on the venue, and every outcome is written down', () => {
  const src = code();
  // no venue => no comparison => the original levels stand (never a cross-venue one: TRD-69).
  // ⚠ TRD-EXE-11 (#1489) renamed the variable but deliberately kept this OUT of the new gate: the venue stop
  // protects the position without a tick source, so a missing venue still skips the comparison rather than
  // refusing the order.
  assert.match(src, /if \(!priceVenue\) reanchorNote = 'price_venue_missing'/, 'a missing venue must SKIP the comparison, not cross it');
  // and every outcome is recorded, so a working fix is distinguishable from an inert one
  assert.match(src, /'entry_reanchored'/);
  assert.match(src, /'reanchor_skipped'/);
  assert.match(src, /'anchor_stale'/);
});

// The bug this file did not catch on 2026-09-18, now pinned: the first version read `fresh.mid`, and
// PriceTicks has no `mid` column. `Number(undefined)` is NaN, so the whole block no-opped SILENTLY for
// eleven consecutive agent entries — a fix for a silent-failure finding that was itself silent.
test('the fresh price is read through midOf, never a non-existent .mid column', () => {
  // Comments are stripped: a comment that DOCUMENTS this bug must never be what fails the pin (it did,
  // the first time this test ran, because the comment spells the bad accessor out).
  const src = code();
  assert.match(src, /ticks\.midOf\(fresh\)/, 'the tick mid must be computed (PriceTicks stores bid/ask only)');
  assert.doesNotMatch(src, /fresh\.mid\b/, 'PriceTicks has NO mid column — fresh.mid is undefined and silently disables the re-anchor');
});

test('a skipped re-anchor names WHY, so it cannot be inert and silent at once', () => {
  const src = code();
  for (const r of ['levels_missing', 'decision_price_missing', 'price_venue_missing', 'no_fresh_tick', 'fresh_tick_has_no_price']) {
    assert.ok(src.includes(`'${r}'`), `skip reason ${r} is not named in the source`);
  }
  // and the skip is written down, not inferred
  assert.match(src, /'reanchor_skipped'/);
  assert.match(src, /reason: reanchorNote/);
});

// TRD-EXE-11 (#1489): `skipReason` was one variable doing two jobs that need OPPOSITE behaviour, under a name
// that described neither. Two of its conditions mean the order is not fit to place; the rest mean the re-anchor
// did not run. The first family now gates the entry.
test('the two unfit-order conditions REFUSE, and are not merely recorded', () => {
  const src = code();
  // `levels_missing` is the one that had to change: with both levels null the venue carries **NO STOP AT ALL**,
  // and until this split that went out as a re-anchor note.
  assert.match(src, /if \(stop\.value == null \|\| tp\.value == null\) blockReason = 'levels_missing'/);
  assert.match(src, /else if \(!\(dp > 0\)\) blockReason = 'decision_price_missing'/);
  assert.match(src, /if \(blockReason\) \{/);
  assert.match(src, /return \{ placed: false, reason: blockReason, priceVenue: priceVenue \|\| null \};/);
  // and the refusal is LOGGED, so that the FIRST occurrence is visible rather than silent
  assert.match(src, /await store\.logEvent\(userId, 'order_blocked', \{/);
  // ⚠ the re-anchor note must NOT become a gate. The venue tick series is frozen during entries, so
  // `no_fresh_tick` is the COMMON case and gating on it would stop the desk trading altogether.
  assert.match(src, /if \(!reanchorNote\) \{/);
});
