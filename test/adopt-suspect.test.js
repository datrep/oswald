// test/adopt-suspect.test.js — TRD-RSK-9: the venue position that was the desk's OWN, 25% mis-sized.
//
// THE DEFECT. `executor.reconcile` recognises the desk's own queued order by matching it to an
// unresolved submit, and the match is EXACT on size (2% tolerance, `unconfirmed.SIZE_TOLERANCE_PCT`).
// Measured 2026-09-28, that tolerance is what let the defect through:
//
//   #1110 Sugar buy 11.9862, stop 18.414, submitted 07:09:21Z into a CLOSED session -> `ambiguous`
//   the venue queued it and filled it at the open; the venue reported 15 contracts
//   15 against 11.9862 is 25% -> no match -> the desk adopted its own fill as a STRANGER
//   (#1111: no stop, no decisionId, origin 'venue') and expired #1110 as `failed` at 07:40:36Z
//
// One position, two records, and the stop lived only on the record that was thrown away. `#1111` was
// then CLOSED by the desk at 07:34:55Z, which is what proves the desk was holding and trading it.
//
// WHAT THESE TESTS PIN. `suspectedOwn` is evidence, NOT ownership: it must report the near-miss, it
// must never claim the position, and it must stand down wherever the exact matcher applies. The
// alternative — widening the tolerance until the positions match — would write our stopPrice onto a
// position that might be the owner's manual trade in the same instrument, which is a worse error.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { suspectedOwn, SUSPECT_MAX_RATIO, sizeMatches, matchVenuePosition } = require('../trading/agent/unconfirmed');

const pending = (o) => Object.assign({
  id: 1110, symbol: 'Sugar', direction: 'buy', size: 11.9862,
  openAt: '2026-09-28T07:09:21.916Z',
}, o);

test('the measured case: 11.9862 sent, 15 held, reported not claimed', () => {
  const s = suspectedOwn([pending()], { name: 'Sugar', direction: 'buy', size: 15 });
  assert.ok(s, 'a 25% gap must still be reported — this is the case that produced the defect');
  assert.equal(s.row.id, 1110, 'it names the submit, so the adoption is auditable');
  assert.equal(s.deltaPct, 25.1, 'relative to what we SENT: +25.1% is a different fact from -25.1%');
  assert.equal(s.ratio, 1.2514);
  assert.equal(s.beyondRatio, false);
});

test('it STAND DOWN wherever the exact matcher applies — the two are not redundant', () => {
  // Inside tolerance is the normal recovery path's case; reporting it as a suspicion too would make the
  // event mean "we recovered it AND we are unsure", which is worse than either.
  assert.equal(suspectedOwn([pending()], { name: 'Sugar', direction: 'buy', size: 12 }), null);
  assert.equal(sizeMatches(11.9862, 12), true);
  // And the exact matcher really does miss the measured pair, so this is not a second copy of it.
  assert.equal(matchVenuePosition([pending()], { name: 'Sugar', direction: 'buy', size: 15 }), null);
});

test('symbol and direction gate it, case-insensitively, and an unstated side does not block', () => {
  assert.equal(suspectedOwn([pending()], { name: 'Arabica Coffee', direction: 'buy', size: 15 }), null);
  assert.equal(suspectedOwn([pending()], { name: 'Sugar', direction: 'sell', size: 15 }), null);
  // Case is not identity: the venue and the ledger disagree on it all the time.
  assert.equal(suspectedOwn([pending({ symbol: 'sugar' })], { name: 'SUGAR', direction: 'BUY', size: 15 }).row.id, 1110);
  // The same rule as `matchVenuePosition`: a missing direction on either side is not evidence against.
  assert.ok(suspectedOwn([pending({ direction: null })], { name: 'Sugar', direction: 'buy', size: 15 }));
});

test('beyond the ratio bound it still reports, AND says which kind of mismatch it is', () => {
  // 15x is not the order we sent — it is that order plus something else, or not ours at all. Reporting
  // this as a near-miss would be the same overconfidence in a new place, so the caller is told.
  const s = suspectedOwn([pending({ size: 1 })], { name: 'Sugar', direction: 'buy', size: 15 });
  assert.equal(s.beyondRatio, true);
  assert.equal(SUSPECT_MAX_RATIO, 3);
  // The bound is symmetric: far too SMALL is equally not our order.
  assert.equal(suspectedOwn([pending({ size: 100 })], { name: 'Sugar', direction: 'buy', size: 2 }).beyondRatio, true);
  // The real Arabica pair sits inside it: 1.2076 sent, 2 held (session open 08:15:54Z).
  assert.equal(suspectedOwn([pending({ symbol: 'Arabica Coffee', size: 1.2076 })],
    { name: 'Arabica Coffee', direction: 'buy', size: 2 }).beyondRatio, false);
});

test('an absent or unreadable size is NO ANSWER, not a mismatch', () => {
  // `Number(null) === 0` and `Number('') === 0`: an unguarded coercion would accept a MISSING size as a
  // zero one and then report a 100%-of-nothing delta against every position in the symbol.
  assert.equal(suspectedOwn([pending()], { name: 'Sugar', direction: 'buy', size: null }), null);
  assert.equal(suspectedOwn([pending()], { name: 'Sugar', direction: 'buy', size: undefined }), null);
  assert.equal(suspectedOwn([pending({ size: null })], { name: 'Sugar', direction: 'buy', size: 15 }), null);
  assert.equal(suspectedOwn([pending({ size: 0 })], { name: 'Sugar', direction: 'buy', size: 15 }), null);
  // No name means no symbol to compare, so there is nothing to suspect.
  assert.equal(suspectedOwn([pending()], { name: '', direction: 'buy', size: 15 }), null);
  assert.equal(suspectedOwn([], { name: 'Sugar', direction: 'buy', size: 15 }), null);
  assert.equal(suspectedOwn(null, { name: 'Sugar', size: 15 }), null);
  // Junk rows are skipped, not thrown on — a guard that fails closed on a bad row stops the whole desk.
  assert.equal(suspectedOwn([null, undefined, 'x'], { name: 'Sugar', direction: 'buy', size: 15 }), null);
});

test('the reconcile path ASKS BEFORE IT ADOPTS, and records the answer', () => {
  // Source-pinned because the ordering IS the fix: a probe evaluated after `createTrade` would describe
  // an adoption that had already happened, and the whole point is that the assumption is visible.
  const src = require('node:fs').readFileSync(require.resolve('../trading/agent/executor'), 'utf8');
  const ask = src.indexOf('suspectedOwn(unconfirmed, p)');
  const event = src.indexOf("'order_adopt_suspect'");
  const adopt = src.indexOf("origin: 'venue'");

  assert.ok(ask > 0, 'the probe is gone from reconcile');
  assert.ok(event > 0, 'the probe is asked but never recorded — invisible, which is the original defect');
  assert.ok(adopt > ask, 'the stranger row is written before the suspicion is evaluated');
  assert.equal(src.indexOf('suspectedOwn(', ask + 1), -1, 'asked once, not once per branch');
});
