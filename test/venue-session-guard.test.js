// test/venue-session-guard.test.js — 2026-09-28: "it is buying Arabica Coffee even though the market is closed."
//
// THE DEFECT. `executor.openTrade`'s guard asks "is this instrument closed?" and the session feed answers from
// `OPositionsList` — the desk's OWN OPEN POSITIONS. So `sessionFeed.get(symbol)` is null for every instrument
// the desk does not already hold, `sessionState` reads null as `open` (the documented "unknown -> allow" rule),
// and the guard therefore protected exactly the symbols that were already open while waving through the new
// ones. Measured the day the owner raised it: every submit for a HELD symbol succeeded (Gold/Silver/SGX,
// ok:true) and every submit for a symbol with no position failed `ambiguous` after ~45 s (Arabica x4, Sugar x3),
// each leaving a venue order the desk could not see.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { sessionClosed } = require('../trading/agent/sessions');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const EXEC = 'trading/agent/executor.js';

const guardSlice = () => {
  const src = code(EXEC);
  const start = src.indexOf('const feed = require(\'../plus500/sessionFeed\')');
  const end = src.indexOf('const open = await store.getOpenTrades(userId);', start);
  assert.ok(start > -1 && end > start, 'the venue-session guard must be locatable in openTrade');
  return src.slice(start, end);
};

test('an ENTRY requires the venue to say OPEN, not merely "not closed"', () => {
  const g = guardSlice();
  assert.match(g, /feed\.isOpen\(symbol\) !== true/, 'the guard must demand a POSITIVE verdict');
  assert.match(g, /reason: 'venue_session_unconfirmed'/);
  assert.match(g, /order_blocked/, 'a policy refusal logs order_blocked');
  assert.doesNotMatch(g, /order_rejected/, 'it must NOT log order_rejected — the breaker and self-health read that');
  assert.match(g, /\{ placed: false, blocked: true, reason: 'venue_session_unconfirmed'/, 'blocked:true keeps it out of the drift count');
});

test('the guard runs BEFORE the order is submitted, or it guards nothing', () => {
  const src = code(EXEC);
  const fn = src.indexOf('async function openTrade');
  const session = src.indexOf('sessionClosed(venueSession)', fn);
  const guard = src.indexOf('feed.isOpen(symbol) !== true', fn);
  const send = src.indexOf('connector.placeOrder(', fn);
  assert.ok(fn > -1 && session > -1 && guard > -1 && send > -1);
  assert.ok(session < guard, 'the closed-session guard still runs first');
  assert.ok(guard < send, 'the positive-verdict guard must precede placeOrder');
});

test('★ the guard is gated on the feed being USABLE — a dead feed must not freeze the desk', () => {
  const g = guardSlice();
  assert.match(g, /feedStatus\.attached/, 'must require the feed to be attached');
  assert.match(g, /!feedStatus\.silent/, 'must require the feed not to be silent');
  assert.match(g, /feed\.summary\(\)\.length > 0/, 'must require the feed to actually know SOME session');
  assert.match(g, /if \(feedUsable && feed\.isOpen\(symbol\) !== true\)/, 'the gate and the test must be one condition');
});

test('★★ the guard is PER-SYMBOL and must NOT become an aggregate ENTRY_LOCK_STATES entry', () => {
  // The obvious-looking fix is to add a lock state, and it is WRONG: `aggregator.js` derives its lock from the
  // AGGREGATE state and `pickProposal` then blocks EVERY proposal — so ONE unheld symbol would stop the whole
  // desk trading. This pin exists so that "simplification" cannot happen quietly.
  const sessions = code('trading/agent/sessions.js');
  assert.match(sessions, /const ENTRY_LOCK_STATES = \['observation'\]/,
    'ENTRY_LOCK_STATES must still hold ONLY observation — the new guard is per-symbol, not aggregate');
});

test('★★ unknown is still ALLOWED at the session layer, so an exit can never be trapped', () => {
  // The new guard deliberately does not change `sessionClosed`: a lock that could trap an exit is worse than the
  // defect, and this asymmetry predates it. Only the ENTRY path was tightened.
  assert.deepEqual(sessionClosed(null), { closed: false, reason: 'session_unknown' });
  assert.equal(sessionClosed(undefined).closed, false);
  assert.equal(sessionClosed({}).closed, false);
  assert.equal(sessionClosed({ isTraded: null }).closed, false, 'an unknown venue verdict is not a closure');
  // and the closures it DOES report are unchanged
  assert.equal(sessionClosed({ isTraded: false }).closed, true);
  assert.equal(sessionClosed({ state: 'closed' }).closed, true);
});

test('the refusal names WHY, so a session-coverage gap is diagnosable', () => {
  const g = guardSlice();
  assert.match(g, /venueSaysOpen: verdict/, 'the raw verdict travels with the refusal');
  assert.match(g, /UNKNOWN/, 'the unknown case must be distinguishable in the prose from the closed case');
  assert.match(g, /feed\.summary\(\)\.length/, 'the refusal must say how many sessions the desk CAN see');
});

test('the feed exposes the three things the guard depends on', () => {
  const feed = code('trading/plus500/sessionFeed.js');
  assert.match(feed, /function isOpen\s*\(/, 'isOpen must exist');
  assert.match(feed, /function summary\s*\(/, 'summary must exist');
  assert.match(feed, /function status\s*\(/, 'status must exist');
  // and `get()` must still be what decides the verdict — an entry is fresh or it is not an answer
  assert.match(feed, /function get\(symbol\)[\s\S]{0,120}isFresh\(e\)/, 'get must still filter on freshness');
});
