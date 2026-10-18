// test/unconfirmed-retry-guard.test.js — TRD-EXE-1 pins:
//   "one unresolved submit per symbol — the desk will not send a second order into a position it cannot see."
//
// The defect this encodes: on 2026-09-28 the desk wrote SEVEN Arabica/Sugar submits in 100 minutes (4
// Arabica totalling 8.6695 units, 3 Sugar totalling 30.9739), every one recorded `ambiguous` — while the
// venue was holding all of them in its ORDER BOOK. Nothing refused a second submit for a symbol whose
// first submit was unresolved, so one stale order became seven, and the owner cancelled them by hand.
//
// The rules are pinned here as PURE functions. The executor itself is never required from a unit test:
// requiring it loads the connector and attaches to the desk's LIVE Chrome on :9224, so the executor is
// checked structurally instead.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const u = require('../trading/agent/unconfirmed');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Assertions run against CODE, not prose: a `doesNotMatch` that matches the comment explaining why the
// call is absent is a test that fails on its own documentation. `://` is preserved so URLs survive.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const EXEC = 'trading/agent/executor.js';

// ---------------------------------------------------------------------------------------------
// pendingFor — which submit, if any, blocks a new one
// ---------------------------------------------------------------------------------------------

test('a pending submit blocks its OWN symbol, case- and whitespace-insensitively', () => {
  const rows = [{ id: 1104, symbol: 'Arabica Coffee' }, { id: 1105, symbol: 'Sugar' }];
  assert.equal(u.pendingFor(rows, 'Arabica Coffee').id, 1104);
  assert.equal(u.pendingFor(rows, 'arabica coffee').id, 1104);
  assert.equal(u.pendingFor(rows, '  ARABICA COFFEE  ').id, 1104);
  assert.equal(u.pendingFor(rows, 'Sugar').id, 1105);
});

test('a pending submit in one symbol does NOT block a different symbol', () => {
  // This is the whole point of scoping it per symbol: 2026-09-28 had Arabica and Sugar both pending, and
  // Gold/Silver/SGX entries in the same wakes were legitimate. A global block would have stopped the desk.
  const rows = [{ id: 1104, symbol: 'Arabica Coffee' }];
  assert.equal(u.pendingFor(rows, 'Gold'), null);
  assert.equal(u.pendingFor(rows, 'Sugar'), null);
});

test('an absent or unreadable symbol blocks NOTHING, rather than everything', () => {
  // A guard that fails closed on a missing field is a guard that can stop the entire desk from trading
  // on one malformed row — the outcome worse than the one it prevents.
  const rows = [{ id: 1104, symbol: 'Arabica Coffee' }];
  assert.equal(u.pendingFor(rows, null), null);
  assert.equal(u.pendingFor(rows, undefined), null);
  assert.equal(u.pendingFor(rows, ''), null);
  assert.equal(u.pendingFor(rows, '   '), null);
  // A row with no symbol must not match an empty request either.
  assert.equal(u.pendingFor([{ id: 1, symbol: null }], null), null);
  assert.equal(u.pendingFor([{ id: 1, symbol: null }], ''), null);
});

test('pendingFor is defensive about its input', () => {
  assert.equal(u.pendingFor(null, 'Gold'), null);
  assert.equal(u.pendingFor(undefined, 'Gold'), null);
  assert.equal(u.pendingFor([], 'Gold'), null);
  assert.equal(u.pendingFor([null, undefined], 'Gold'), null);
  assert.equal(u.pendingFor([{ id: 7, symbol: 'Gold' }], 'Gold').id, 7);
});

// ---------------------------------------------------------------------------------------------
// ageMinutes — the age named in the refusal, and the TTL it is compared against
// ---------------------------------------------------------------------------------------------

test('ageMinutes reports whole minutes, and an UNREADABLE time is null — never the epoch', () => {
  const now = Date.parse('2026-09-28T06:00:00.000Z');
  const at = (iso) => ({ id: 1, openAt: iso });
  assert.equal(u.ageMinutes(at('2026-09-28T06:00:00.000Z'), { now }), 0);
  assert.equal(u.ageMinutes(at('2026-09-28T05:59:40.000Z'), { now }), 0);
  assert.equal(u.ageMinutes(at('2026-09-28T05:15:00.000Z'), { now }), 45);
  // ★ THE PIN THAT MATTERS: `Number(null)` is 0, which is the epoch, which is ~29 million minutes old.
  // A guard that reports that as an age would treat every unreadable row as 29M minutes past a 30-minute
  // TTL and say "past TTL" about a row it knows nothing about.
  assert.equal(u.ageMinutes(at(null), { now }), null);
  assert.equal(u.ageMinutes(at(undefined), { now }), null);
  assert.equal(u.ageMinutes(at(''), { now }), null);
  assert.equal(u.ageMinutes(at('not a date'), { now }), null);
  assert.equal(u.ageMinutes(at(0), { now }), null);
  assert.equal(u.ageMinutes(null, { now }), null);
  assert.equal(u.ageMinutes(undefined, { now }), null);
});

test('ageMinutes falls back to createdAt, and a zero age is still a real age', () => {
  const now = Date.parse('2026-09-28T06:00:00.000Z');
  assert.equal(u.ageMinutes({ id: 1, createdAt: '2026-09-28T05:30:00.000Z' }, { now }), 30);
  assert.equal(u.ageMinutes({ id: 1, openAt: null, createdAt: '2026-09-28T05:30:00.000Z' }, { now }), 30);
  // 0 is falsy but it is a RESULT, not an absence: the distinction that the `null` returns above exist for.
  assert.equal(u.ageMinutes({ id: 1, openAt: '2026-09-28T06:00:00.000Z' }, { now }), 0);
  assert.notEqual(u.ageMinutes({ id: 1, openAt: '2026-09-28T06:00:00.000Z' }, { now }), null);
});

test('the guard and the expiry share ONE TTL constant', () => {
  // A second literal here would let the refusal's "past TTL" and reconcile's "expired after Nm" disagree.
  assert.equal(u.UNCONFIRMED_TTL_MIN, 30);
  const src = code(EXEC);
  assert.match(src, /UNCONFIRMED_TTL_MIN\s*\}?\s*=\s*require\('\.\/unconfirmed'\)|UNCONFIRMED_TTL_MIN \} = require\('\.\/unconfirmed'\)/,
    'the executor must import the TTL rather than restate it');
  assert.match(src, /ageMin > UNCONFIRMED_TTL_MIN/, 'and must compare against the imported value');
});

// ---------------------------------------------------------------------------------------------
// The executor wiring — structural, because requiring the executor touches live Chrome
// ---------------------------------------------------------------------------------------------

test('the retry guard is INSIDE openTrade, after the session check and BEFORE the order is sent', () => {
  const src = code(EXEC);
  const fn = src.indexOf('async function openTrade');
  const session = src.indexOf('sessionClosed(venueSession)', fn);
  const guard = src.indexOf('const unresolved = pendingFor(pending, symbol)', fn);
  const send = src.indexOf('connector.placeOrder(', fn);
  assert.ok(fn > -1, 'openTrade must exist');
  assert.ok(session > -1 && guard > -1 && send > -1, 'all three anchors must be present in openTrade');
  assert.ok(session < guard, 'the closed-session guard still runs first');
  // ★ THE ORDERING IS THE POINT: a guard placed after the submit would refuse nothing and read as if it had.
  assert.ok(guard < send, 'the retry guard must run BEFORE the order is submitted, or it guards nothing');
});

test('the guard owns ONE implementation — the executor does not re-derive the comparison', () => {
  const src = code(EXEC);
  const start = src.indexOf('const pending = await store.getUnconfirmedTrades(userId)');
  const end = src.indexOf('const open = await store.getOpenTrades(userId);', start);
  assert.ok(start > -1 && end > start, 'the guard block must be locatable');
  const block = src.slice(start, end);
  assert.match(block, /pendingFor\(pending, symbol\)/, 'the rule comes from the pure module');
  assert.match(block, /ageMinutes\(unresolved\)/, 'and so does the age');
  assert.doesNotMatch(block, /toLowerCase\(\)/, 'the symbol comparison must NOT be re-implemented inline');
  assert.doesNotMatch(block, /new Date\(/, 'nor the timestamp parsing — unconfirmed.js owns both');
});

test('the refusal is a POLICY refusal: blocked, order_blocked, and it cannot trip the breaker', () => {
  const src = code(EXEC);
  const start = src.indexOf('const pending = await store.getUnconfirmedTrades(userId)');
  const end = src.indexOf('const open = await store.getOpenTrades(userId);', start);
  const block = src.slice(start, end);
  // blocked: true is what keeps self-health's drift check from reporting a working guard as a broken desk.
  assert.match(block, /\{ placed: false, blocked: true, reason: 'unconfirmed_pending'/, 'the return must be marked blocked');
  assert.match(block, /logEvent\(userId, 'order_blocked'/, 'a policy refusal logs order_blocked');
  assert.doesNotMatch(block, /order_rejected/, 'it must NOT log order_rejected — the breaker and self-health read that');
  assert.doesNotMatch(block, /maybeTripBreaker/, 'and it must not trip the circuit breaker');
});

test('the guard names the AGE and the STALENESS, so a stuck symbol is visible rather than quiet', () => {
  const src = code(EXEC);
  const start = src.indexOf('const pending = await store.getUnconfirmedTrades(userId)');
  const end = src.indexOf('const open = await store.getOpenTrades(userId);', start);
  const block = src.slice(start, end);
  assert.match(block, /ageMin/, 'the age travels with the refusal');
  assert.match(block, /const stale = ageMin != null && ageMin > UNCONFIRMED_TTL_MIN/, 'and staleness is computed from it');
  assert.match(block, /blockingTradeId: unresolved.id/, 'the blocking row is named, so the refusal can be acted on');
  // A refusal that outlives its TTL means reconcile is not running — that has to be sayable.
  assert.match(block, /STUCK here means that cycle is not running/, 'the past-TTL case must name its own cause');
});

test('the guard does NOT nest a mirror cycle — it runs while the wake holds the venue lock', () => {
  const src = code(EXEC);
  const start = src.indexOf('const pending = await store.getUnconfirmedTrades(userId)');
  const end = src.indexOf('const open = await store.getOpenTrades(userId);', start);
  const block = src.slice(start, end);
  assert.doesNotMatch(block, /mirrorPoller/, 'resolution is reconcile\'s job; a nested cycle would contend for the page the wake holds');
});

test('self-health still excludes blocked entries from its drift count', () => {
  // The cross-file half of "blocked: true". If this condition ever loses `!e.blocked`, every policy
  // refusal on the desk starts reporting as an approved entry that never filled.
  const health = code('trading/agent/selfHealth.js');
  assert.match(health, /e\.action === 'entry' && e\.placed === false && !e\.blocked/,
    'the drift check must keep skipping policy refusals');
});

test('an unconfirmed row still consumes no position or trade cap', () => {
  // Why the retry guard is needed at all: `unconfirmed` is invisible to getOpenTrades and to
  // countNewTradesToday, so the caps could never absorb a repeat submit. If that ever changes, this
  // guard becomes redundant — and this test says so rather than letting the two silently overlap.
  const store = code('trading/store.js');
  assert.match(store, /async function getOpenTrades[\s\S]{0,220}AND status = 'open'/);
  assert.match(store, /async function getUnconfirmedTrades[\s\S]{0,300}AND status = 'unconfirmed'/);
  assert.match(store, /async function countNewTradesToday[\s\S]{0,300}status IN \('open','closed'\)/);
});
