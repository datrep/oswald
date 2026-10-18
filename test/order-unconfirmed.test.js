// test/order-unconfirmed.test.js — TRD-52 pins:
//   "an unknown order outcome is not a failure, and it must not be spent as evidence of one."
//
// The defect this encodes: Trades 1033 was a size-1 Gold buy submitted into a CLOSED session, written
// off as `rejected`, counted toward the circuit breaker, and filled at the session open five hours
// later — where the desk adopted its own order as a stranger (Trades 1034) and let its 107% notional
// veto every entry for 45 minutes.
//
// The rules are pinned here as PURE functions. The executor itself is never required from a unit test:
// requiring it loads the connector and attaches to the desk's LIVE Chrome on :9224 (that happened once
// and the test took 31.6 s), so the executor is checked structurally instead.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const u = require('../trading/agent/unconfirmed');
const { sessionClosed } = require('../trading/agent/sessions');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Assertions run against CODE, not prose: a `doesNotMatch` that matches the comment explaining why the
// call is absent is a test that fails on its own documentation. `://` is preserved so URLs survive.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ---------------------------------------------------------------------------------------------
// Session state — the guard that stops the order being submitted at all
// ---------------------------------------------------------------------------------------------

test('BOTH connector session shapes are read, because reading one makes the guard dead', () => {
  // The venue feed (browser connector): { isTraded }.
  assert.deepEqual(sessionClosed({ isTraded: false, next: { from: '2026-09-14T05:00:00Z' } }),
    { closed: true, reason: 'venue_session_closed', nextOpenAt: '2026-09-14T05:00:00.000Z' });
  assert.equal(sessionClosed({ isTraded: true }).closed, false);
  // The paper connector reports { state } from sessions.sessionState and has NO isTraded field. The old
  // inline check read isTraded alone, so on the sim desk the refusal could never fire — a guard that
  // reads as coverage while doing nothing.
  assert.equal(sessionClosed({ state: 'closed', detail: 'weekend' }).closed, true);
  assert.equal(sessionClosed({ state: 'closed' }).reason, 'calendar_session_closed');
  assert.equal(sessionClosed({ state: 'open' }).closed, false);
  assert.equal(sessionClosed({ state: 'observation' }).closed, false, 'observation is not closed');
});

test('an UNKNOWN session allows the order, and says that it was unknown', () => {
  // Refusing on ignorance would be a bigger intervention than the defect, and it is the same rule that
  // already governs the venue minimum (agent/instruments.floorVerdict). But the ignorance is NAMED.
  assert.deepEqual(sessionClosed(null), { closed: false, reason: 'session_unknown' });
  assert.equal(sessionClosed(undefined).closed, false);
  assert.equal(sessionClosed({}).closed, false);
  assert.equal(sessionClosed({ isTraded: null }).closed, false);
  assert.equal(sessionClosed({ isTraded: null }).reason, 'session_open_or_unknown');
  // A Promise (the paper connector is async and its callers pass the symbol first) must not be read as
  // a closed session — it is an object with neither field, so it allows.
  assert.equal(sessionClosed(Promise.resolve({ isTraded: false })).closed, false);
});

test('a closed session with an UNPARSEABLE open time still refuses, and does not throw', () => {
  // The venue does not guarantee an ISO `next.from`, and `new Date(x).toISOString()` throws a RangeError
  // on garbage — inside the OPEN path, before the order try/catch, so it would abort a trade instead of
  // guarding one. The guard now degrades the timestamp to null and still refuses.
  const r = sessionClosed({ isTraded: false, next: { from: 'Thu 9:00 AM' } });
  assert.equal(r.closed, true);
  assert.equal(r.nextOpenAt, null, 'unusable open time reads as unknown, not as a bogus date');
  assert.doesNotThrow(() => sessionClosed({ isTraded: false, next: { from: {} } }));
  assert.doesNotThrow(() => sessionClosed({ isTraded: false, next: { from: 'not a date' } }));
  assert.equal(sessionClosed({ isTraded: false, next: null }).nextOpenAt, null);
  assert.equal(sessionClosed({ isTraded: false }).nextOpenAt, null);
});

// ---------------------------------------------------------------------------------------------
// Matching a venue position back to the submit that caused it
// ---------------------------------------------------------------------------------------------

const ROWS = [
  { id: 1033, symbol: 'Gold', direction: 'buy', size: 1, openAt: '2026-09-13T17:14:46.120Z' },
  { id: 2000, symbol: 'Oil', direction: 'sell', size: 7.8476, openAt: '2026-09-13T17:20:00.000Z' },
];

test('a venue position that IS our unconfirmed order is matched, so it is recovered not adopted', () => {
  const own = u.matchVenuePosition(ROWS, { name: 'Gold', direction: 'buy', size: 1 });
  assert.equal(own.id, 1033, 'same symbol + direction + size is the order that came back');
  // Case and whitespace come off the venue DOM, so they must not defeat the match.
  assert.equal(u.matchVenuePosition(ROWS, { name: ' gold ', direction: 'buy', size: 1 }).id, 1033);
  assert.equal(u.matchVenuePosition(ROWS, { name: 'GOLD', direction: 'BUY', size: 1 }).id, 1033);
  // The venue reporting a slightly different size (rounding, units) still counts.
  assert.equal(u.matchVenuePosition(ROWS, { name: 'Gold', direction: 'buy', size: 1.01 }).id, 1033);
});

test('a DIFFERENT position in the same symbol is never claimed as our recovery', () => {
  // This is the failure that would be worse than the original bug: relabelling someone else's position
  // as the desk's own order, with the desk's own stop attached to it.
  assert.equal(u.matchVenuePosition(ROWS, { name: 'Gold', direction: 'buy', size: 4 }), null, 'size is not a match');
  assert.equal(u.matchVenuePosition(ROWS, { name: 'Gold', direction: 'sell', size: 1 }), null, 'direction is not a match');
  assert.equal(u.matchVenuePosition(ROWS, { name: 'Silver', direction: 'buy', size: 1 }), null, 'symbol is not a match');
  assert.equal(u.matchVenuePosition(ROWS, { name: '', direction: 'buy', size: 1 }), null, 'an unnamed venue row matches nothing');
  assert.equal(u.matchVenuePosition([], { name: 'Gold', direction: 'buy', size: 1 }), null);
  assert.equal(u.matchVenuePosition(null, { name: 'Gold', direction: 'buy', size: 1 }), null);
  assert.equal(u.matchVenuePosition(ROWS, null), null);
});

test('sizeMatches refuses absent and nonsense sizes rather than coercing them to zero', () => {
  // Number(null) === 0 has bitten this codebase five times; here a null size compared as 0 would match
  // every other 0 and pair two unrelated rows.
  assert.equal(u.sizeMatches(null, 1), false);
  assert.equal(u.sizeMatches(1, null), false);
  assert.equal(u.sizeMatches(undefined, undefined), false);
  assert.equal(u.sizeMatches(0, 0), false, 'a zero-size position is not a fill of anything');
  assert.equal(u.sizeMatches('1', 1), true);
  assert.equal(u.sizeMatches(1, 1.015), true, 'inside the tolerance');
  assert.equal(u.sizeMatches(1, 1.03), false, 'outside it');
  // NOTE: the tolerance EDGE itself is deliberately not asserted. `1.02 - 1` is 0.020000000000000018, so
  // the exact boundary is decided by float representation rather than by the rule, and a test pinned on
  // it would be asserting a rounding artefact. The contract is "small relative difference", not a
  // specific last digit.
});

// ---------------------------------------------------------------------------------------------
// Bounding the state
// ---------------------------------------------------------------------------------------------

test('the TTL is bounded, and only rows OLDER than it expire', () => {
  const now = Date.parse('2026-09-14T05:00:00Z');
  const rows = [
    { id: 1, openAt: new Date(now - (u.UNCONFIRMED_TTL_MIN + 5) * 60000).toISOString() },
    { id: 2, openAt: new Date(now - (u.UNCONFIRMED_TTL_MIN - 5) * 60000).toISOString() },
  ];
  const gone = u.expiredRows(rows, { now });
  assert.deepEqual(gone.map((r) => r.id), [1]);
  assert.ok(u.UNCONFIRMED_TTL_MIN > 0 && u.UNCONFIRMED_TTL_MIN <= 120, 'the window must be finite and short');
});

test('a row whose age cannot be established is NEVER expired', () => {
  // Giving up on a row whose timestamp is unreadable is the one direction that can lose a live
  // position, so it is the one direction that is refused.
  const now = Date.now();
  assert.deepEqual(u.expiredRows([{ id: 1, openAt: null }], { now }), []);
  assert.deepEqual(u.expiredRows([{ id: 1, openAt: 'not a date' }], { now }), []);
  assert.deepEqual(u.expiredRows([{ id: 1 }], { now }), []);
  assert.deepEqual(u.expiredRows(null, { now }), []);
  // createdAt is the fallback when openAt is missing (createTrade always sets openAt, but a legacy or
  // hand-written row may not).
  const old = new Date(now - 999 * 60000).toISOString();
  assert.deepEqual(u.expiredRows([{ id: 1, createdAt: old }], { now }).map((r) => r.id), [1]);
});

// ---------------------------------------------------------------------------------------------
// The executor wiring — structural, because requiring the executor touches live Chrome
// ---------------------------------------------------------------------------------------------

const EXEC = 'trading/agent/executor.js';

test('the open path refuses a closed session, and refuses it as a BLOCK not a REJECTION', () => {
  const src = code(EXEC);
  assert.match(src, /sessionClosed\(venueSession\)/, 'openTrade must consult the session');
  assert.match(src, /reason: 'market_closed'/, 'and say why');
  assert.match(src, /logEvent\(userId, 'order_blocked'/, 'a policy refusal logs order_blocked');
  assert.doesNotMatch(src, /reason: 'market_closed'[\s\S]{0,400}order_rejected/,
    'a closed-market refusal must NOT log order_rejected — that feeds the breaker and self-health');
});

test('an unknown outcome is split out of the rejection path, and cannot trip the breaker', () => {
  const src = code(EXEC);
  assert.match(src, /const unconfirmed = NEEDS_RECONCILIATION\.has\(cls\)/);
  assert.match(src, /\.write\(userId, 'order_unconfirmed'/, 'it gets its own event kind');
  // The breaker call must sit on the NON-unconfirmed branch. Anchor on the structure rather than the
  // ordering of the file: everything between the split and the createTrade must not break the circuit.
  const split = src.indexOf('const unconfirmed = NEEDS_RECONCILIATION.has(cls)');
  const breaker = src.indexOf('await maybeTripBreaker(userId, settings);', split);
  const unconfBranch = src.indexOf("'order_unconfirmed'", split);
  assert.ok(split > -1 && breaker > -1 && unconfBranch > -1);
  assert.ok(unconfBranch < breaker, 'the unconfirmed event is written BEFORE the breaker is reached');
  assert.match(src, /\} else \{[\s\S]*?order_rejected[\s\S]*?maybeTripBreaker/, 'the breaker is inside the else');
});

test('the unconfirmed row is its own state, excluded from open AND from the close sync', () => {
  const src = code(EXEC);
  assert.match(src, /status: unconfirmed \? 'unconfirmed' : 'rejected'/);
  // getOpenTrades filters status='open' and getUnresolvedTrades takes phantom / closed-with-no-P&L, so
  // an unconfirmed row can neither consume a cap nor be "healed" by the venue-CLOSE path.
  const store = code('trading/store.js');
  assert.match(store, /AND status = 'open'/);
  assert.match(store, /AND \(status = 'phantom' OR \(status = 'closed' AND grossPnl IS NULL\)\)/);
  assert.match(store, /async function getUnconfirmedTrades[\s\S]{0,300}AND status = 'unconfirmed'/);
});

test('reconcile RECOVERS the desks own queued order instead of adopting a stranger', () => {
  const src = code(EXEC);
  // Assert ORDER, not character distance: the recovery block and the stranger-adoption are separated by
  // a long journalling call, so any {0,N} window is a brittle proxy for "which comes first".
  const match = src.indexOf('const own = matchVenuePosition(unconfirmed, p)');
  const recover = src.indexOf('updateTrade(userId, own.id', match);
  const stranger = src.indexOf('await store.createTrade(userId, {', match);
  assert.ok(match > -1, 'reconcile must try a venue fill against our own unconfirmed submits');
  assert.ok(recover > match, 'a match resolves the ORIGINAL row — keeping its decisionId and stop intent');
  assert.ok(stranger > recover, 'and only a NON-match falls through to adopting a stranger');
  assert.match(src.slice(match, stranger), /continue;/, 'the recovery must not also create a second row');
  assert.match(src, /logEvent\(userId, 'order_recovered'/);
});

test('expiry is gated on a venue read somebody vouched for, and is journaled', () => {
  const src = code(EXEC);
  assert.match(src, /emptyTrusted = false/, 'the caller must OPT IN to trusting an empty read');
  assert.match(src, /const venueReadable = venueItems\.length > 0 \|\| emptyTrusted === true/);
  assert.match(src, /if \(venueReadable\) \{[\s\S]{0,600}expiredRows\(/);
  assert.match(src, /logEvent\(userId, 'order_unconfirmed_expired'/);
  // And the mirror cycle is the caller that vouches, because it is where the empty-read trust check lives.
  assert.match(code('trading/agent/mirrorPoller.js'), /emptyTrusted: true/);
});

test('the outcome is visible without reading the database', () => {
  assert.match(code('trading/agent/log.js'), /order_unconfirmed: 'act'[\s\S]{0,200}order_recovered: 'act'/);
  assert.match(code('trading/agent/log.js'), /order_unconfirmed'[\s\S]{0,120}WARN_KINDS|WARN_KINDS = new Set\(\['order_rejected', 'order_unconfirmed'/);
  assert.match(code('trading/public/js/app.js'), /'order_unconfirmed'/);
  assert.match(read('trading/public/index.html'), /value="order_unconfirmed"/);
  assert.match(code('trading/agent/selfHealth.js'), /check\('unconfirmed', 'Unconfirmed orders'/);
});
