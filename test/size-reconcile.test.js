// test/size-reconcile.test.js — 2026-09-30: `Trades.size` must BE the size the venue holds.
//
// WHY THIS EXISTS. `risk.js` snaps a size onto the venue's increment before the order leaves, so the desk's
// number and the venue's number agree AT SUBMIT. That is a RULE derived from 32 observations, not a read-back,
// and row #1463 names the gap in its own residual: "a venue that resolves differently from the measured rule
// would still diverge silently". This pins the read-back that closes it.
//
// THE NUMBER THAT MAKES IT MATTER. `Trades.size` is the denominator under `resolvedRiskPct`, the exit
// tolerance, the cost share of R and the R multiple of the outcome. Measured on the live book: the desk's
// number and the venue's disagreed on 28 of 32 rows, median 3.99%, max 100%. Live right now, Oil #1134
// recorded 15.8154 against a venue-held 15, and Bitcoin #1131 recorded 0.0072 against 0.007 — both sent
// before the snap existed, so only a read-back can correct them.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { sizeVerdict, reconcileAt } = require('../trading/agent/sizeReconcile');

// --- the pure rule ------------------------------------------------------------------
test('an ABSENT size is never read as zero — the whole point of the guard', () => {
  // `Number(null) === 0`. Without the absence check, a venue row that did not carry a size would compute a
  // delta of (0 − desk) and rewrite a LIVE position's recorded risk to zero. The repo has this trap recorded
  // in three modules; this is the fourth place it would have bitten.
  for (const venueSize of [null, undefined, '']) {
    const v = sizeVerdict({ deskSize: 15.8154, venueSize });
    assert.equal(v.ok, false, `venueSize ${JSON.stringify(venueSize)} must not be usable`);
    assert.equal(v.reason, 'size_absent');
    assert.equal(v.write, false, 'and must never authorise a write');
  }
  // ...and the desk's own side is guarded the same way, because a trade row whose size was never written
  // is not a trade whose size is zero.
  assert.equal(sizeVerdict({ deskSize: null, venueSize: 15 }).reason, 'size_absent');
});

test('a size that cannot be read is reported, not corrected', () => {
  for (const bad of [0, -1, 'abc', NaN, Infinity]) {
    const v = sizeVerdict({ deskSize: 15, venueSize: bad });
    assert.equal(v.ok, false, `venueSize ${String(bad)} must not be corrected from`);
    assert.equal(v.write, false);
  }
});

test('agreement writes nothing, and says so as `agrees` rather than as a zero delta', () => {
  const v = sizeVerdict({ deskSize: 15, venueSize: 15 });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'agrees');
  assert.equal(v.write, false);
  assert.equal(v.direction, 'same');
});

test('a divergence names its direction, because that is the direction the EXPOSURE BUDGET moves', () => {
  // The live case: the desk over-recorded, so correcting it tells the budget LESS than it was told.
  const over = sizeVerdict({ deskSize: 15.8154, venueSize: 15 });
  assert.equal(over.write, true);
  assert.equal(over.direction, 'venue_below');
  assert.ok(Math.abs(over.deltaPct - -5.1556) < 0.01, `delta ${over.deltaPct}% must match the live 15.8154 -> 15`);
  // The mirror: an under-recorded row spends budget when corrected.
  const under = sizeVerdict({ deskSize: 0.1152, venueSize: 0.125 });
  assert.equal(under.direction, 'venue_above');
  assert.ok(Math.abs(under.deltaPct - 8.5069) < 0.01, `delta ${under.deltaPct}% must match the TRD-EXE-3 Gold case`);
});

test('★ THE 2% TOLERANCE THAT BROKE TRD-EXE-4 IS NOT REINTRODUCED', () => {
  // `unconfirmed.SIZE_TOLERANCE_PCT = 2` is exact-on-size, and on the row that lost a stop the venue held
  // 15 against a submitted 11.9862 — +25.1%. A read-back that inherited that predicate would refuse to
  // correct exactly the rows it exists for, so a 25% divergence must still write.
  const v = sizeVerdict({ deskSize: 11.9862, venueSize: 15 });
  assert.equal(v.write, true, 'a 25% divergence is the case, not an exclusion from it');
  assert.ok(v.deltaPct > 25 && v.deltaPct < 25.2, `delta ${v.deltaPct}%`);
});

// --- the wrapper ---------------------------------------------------------------------
const venueRow = (positionId, size, units = 'Contracts') => ({ positionId, size, units, name: 'Sugar' });
const deskRow = (id, positionId, size) => ({ id, symbol: 'Sugar', direction: 'buy', size, units: 'Contracts', plus500PositionId: positionId, strategyId: 'survcsugar' });

function stubStore(openRows) {
  const written = [];
  const logged = [];
  return {
    written, logged,
    listOpenTradesWithPositionIds: async () => openRows,
    updateTrade: async (userId, id, fields) => { written.push({ userId, id, fields }); },
    logEvent: async (userId, kind, payload) => { logged.push({ userId, kind, payload }); },
  };
}

test('the correction matches by the VENUE\'S ID and writes only the rows that disagree', async () => {
  const st = stubStore([deskRow(1134, '1888867834', 15.8154), deskRow(1131, '1888822799', 0.0072), deskRow(999, '111', 15)]);
  const r = await reconcileAt(1, [
    venueRow('1888867834', 15),          // divergent: 15.8154 -> 15
    venueRow('1888822799', 0.007),       // divergent: 0.0072 -> 0.007
    venueRow('111', 15),                 // already correct
    venueRow('222', 5),                  // a position the desk has no row for
  ], { st });

  assert.equal(r.corrected, 2, 'only the two divergent rows are written');
  assert.equal(r.unmatched, 1, 'a venue position with no desk row is counted, not silently dropped');
  assert.deepEqual(st.written.map((w) => [w.id, w.fields.size]), [[1134, 15], [1131, 0.007]]);
  assert.equal(st.logged.length, 2);
  const e = st.logged[0];
  assert.equal(e.kind, 'size_reconciled');
  assert.equal(e.payload.deskSize, 15.8154);
  assert.equal(e.payload.venueSize, 15);
  // The trade's SIDE and the CORRECTION's direction are two different facts and must not share a key: an
  // earlier version emitted both as `direction`, so the trade's side was overwritten and lost.
  assert.equal(e.payload.tradeDirection, 'buy', 'the trade\'s own side survives');
  assert.equal(e.payload.correctionDirection, 'venue_below', 'and is not the same field as the correction');
  assert.equal(e.payload.direction, undefined, 'a bare `direction` must not exist on this event');
  // The event has to say what the correction MOVED, because the exposure budget reads the same column.
  assert.match(e.payload.note, /exposure budget is now told LESS notional/);
  assert.match(e.payload.note, /venue/i);
});

test('a row that already agrees is neither written nor logged (non-vacuity)', async () => {
  const st = stubStore([deskRow(1134, '1888867834', 15)]);
  const r = await reconcileAt(1, [venueRow('1888867834', 15)], { st });
  assert.equal(r.checked, 1);
  assert.equal(r.corrected, 0);
  assert.equal(st.written.length, 0, 'no write when the numbers already agree');
  assert.equal(st.logged.length, 0, 'and no event — an event per poll would bury the ones that matter');
});

test('a venue row with no readable size cannot zero a live position', async () => {
  const st = stubStore([deskRow(1134, '1888867834', 15.8154)]);
  const r = await reconcileAt(1, [venueRow('1888867834', null), venueRow('', 3), null], { st });
  assert.equal(st.written.length, 0, 'none of these may authorise a write');
  // A null SIZE (nothing to compare), an EMPTY id (no key, so no comparison happened) and a missing row are all
  // `skipped`: each one is a case where nothing was compared, which is not the same as "no position found".
  assert.equal(r.skipped, 3, 'every row is accounted for as skipped rather than as an unmatched position');
  assert.equal(r.unmatched, 0, 'an empty id must not be read as a position the desk has no row for');
});

test('the id match is exact and type-tolerant, because the venue returns it as a string', async () => {
  const st = stubStore([deskRow(7, 1888867834, 15.8154)]);   // numeric on the desk's row
  const r = await reconcileAt(1, [venueRow('1888867834', 15)], { st });   // string from the venue
  assert.equal(r.corrected, 1, 'a numeric/string id pair is the same position, not two rows');
  assert.equal(st.written[0].id, 7);
});

test('an empty poll is a no-op, not an error', async () => {
  const st = stubStore([]);
  assert.deepEqual(await reconcileAt(1, [], { st }), { checked: 0, corrected: 0, skipped: 0, unmatched: 0 });
  assert.deepEqual(await reconcileAt(1, null, { st }), { checked: 0, corrected: 0, skipped: 0, unmatched: 0 });
});

test('the poller wires the read-back to the SAME rows it samples for P/L, and never awaits it', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'trading/agent/accountPoller.js'), 'utf8');
  assert.match(src, /require\('\.\/sizeReconcile'\)\.reconcileAt\(userId, pnlPlan\.due\.map\(\(d\) => d\.row\)/,
    'the read-back must ride the rows already read, so it costs no extra navigation');
  // The hot path must not be able to block on a record correction, and must not be able to throw from one.
  assert.doesNotMatch(src, /await\s+require\('\.\/sizeReconcile'\)/, 'the call must not be awaited');
  assert.match(src, /reconcileAt\(userId, pnlPlan\.due\.map\(\(d\) => d\.row\), \{ at: new Date\(\)\.toISOString\(\) \}\)[\s\S]{0,200}?\.catch\(\(\) => \{\}\)/,
    'and it must swallow its own failure');
});
