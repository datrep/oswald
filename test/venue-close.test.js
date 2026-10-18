// test/venue-close.test.js — 2026-09-12: venue-close reconciliation.
// The desk sets venue-native SL/TP, so Plus500 closes most positions itself
// ("Profit call" / "Loss call", or "Market closed" at session end). The mirror
// used to only flag those `phantom`, throwing the real close away — 4 of 7 real
// closes on 2026-09-11 were lost that way (+2.67, -5.05, +20.17, +8.28) and the
// Past table rendered rows with no price and no P&L.
// Matching must be exact-first, and must never attach a close that happened
// before the trade opened, nor let two trades claim the same fill.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { matchVenueClose, reasonLabel } = require('../trading/agent/venueClose');

// Shape returned by webtrader.readClosedPositions (venue /closed-positions).
const row = (o) => ({
  positionId: '1885750397', symbol: 'Gold', direction: 'sell', amountText: '0.075 Troy Ounces',
  netPnl: 2.67, closeValue: 322.85, openRate: 4333.03, closeRate: 4304.69,
  adjustments: 0, funding: 0, closedAtText: '9/11/2026 8:30 PM',
  closedAt: '2026-09-11T12:30:00.000Z', reason: 'Profit call', ...o,
});

test('exact plus500PositionId match wins, even when the venue symbol differs in case', () => {
  const t = { id: 1030, symbol: 'GOLD', direction: 'sell', plus500PositionId: '1885750397', openAt: '2026-09-11T04:34:00.000Z' };
  const m = matchVenueClose(t, [row({ symbol: 'gold' })]);
  assert.ok(m);
  assert.strictEqual(m.netPnl, 2.67);
});

test('a trade with a positionId never falls back to symbol matching', () => {
  // Our id is absent from the venue list -> no close (never guess a neighbour's fill).
  const t = { id: 9, symbol: 'Gold', direction: 'sell', plus500PositionId: '999', openAt: '2026-09-11T04:34:00.000Z' };
  assert.strictEqual(matchVenueClose(t, [row()]), null);
});

test('no positionId: matches symbol + direction, earliest close after the open wins', () => {
  const t = { id: 5, symbol: 'Bitcoin', direction: 'buy', plus500PositionId: null, openAt: '2026-09-09T08:00:00.000Z' };
  const rows = [
    row({ positionId: 'a', symbol: 'Bitcoin', direction: 'buy', closedAt: '2026-09-10T02:00:00.000Z' }),
    row({ positionId: 'b', symbol: 'Bitcoin', direction: 'buy', closedAt: '2026-09-09T12:00:00.000Z' }),
  ];
  assert.strictEqual(matchVenueClose(t, rows).positionId, 'b');
});

test('a close BEFORE the open is never attached', () => {
  const t = { id: 7, symbol: 'Oil', direction: 'buy', plus500PositionId: null, openAt: '2026-09-11T10:00:00.000Z' };
  const rows = [row({ positionId: 'a', symbol: 'Oil', direction: 'buy', closedAt: '2026-09-11T09:00:00.000Z' })];
  assert.strictEqual(matchVenueClose(t, rows), null);
});

test('direction mismatch is rejected on the symbol fallback', () => {
  const t = { id: 8, symbol: 'Oil', direction: 'buy', plus500PositionId: null, openAt: '2026-09-11T00:00:00.000Z' };
  const rows = [row({ positionId: 'a', symbol: 'Oil', direction: 'sell', closedAt: '2026-09-11T05:00:00.000Z' })];
  assert.strictEqual(matchVenueClose(t, rows), null);
});

test('an already-claimed fill is not handed to a second trade', () => {
  const used = new Set(['1885750397']);
  const t = { id: 1030, symbol: 'Gold', direction: 'sell', plus500PositionId: '1885750397', openAt: '2026-09-11T04:34:00.000Z' };
  assert.strictEqual(matchVenueClose(t, [row()], used), null);
});

test('venue reasons are labelled in plain language', () => {
  assert.match(reasonLabel('Profit call'), /take-profit/);
  assert.match(reasonLabel('Loss call'), /stop-loss/);
  assert.match(reasonLabel('Market closed'), /session closed/);
  assert.strictEqual(reasonLabel('Something else'), 'Something else');
  assert.match(reasonLabel(null), /unknown/);
});

// --- the missing await (2026-09-14) ---------------------------------------
// An 11:19-11:22 UTC telemetry stream read
//   venue_close_sync_error: "Cannot read properties of undefined (reading 'length')"
// about ten times an hour. The sync itself was fine: mirrorPoller called
// syncVenueCloses WITHOUT await, so `sync` was a Promise, `sync.venueRows` and
// `sync.checked` read as undefined, and `sync.healed.length` threw. The catch
// logged it as a sync FAILURE and — because the throttle reset sits after the
// field reads — never ran `cyclesSinceCloseSync = 0`, so the sync fired every
// cycle instead of every CLOSE_SYNC_EVERY.
//
// These pins read the SOURCE through the comment-stripping helper on purpose:
// the explanation above contains the words `await` and `syncVenueCloses(`, so a
// naive grep of the raw file would pass even with the await deleted.

test('★ mirrorPoller awaits the venue-close sync before reading its result', () => {
  const { code } = require('./_source');
  const src = code('trading/agent/mirrorPoller.js');
  const calls = src.split(/\r?\n/).filter((l) => /syncVenueCloses\s*\(/.test(l));
  assert.strictEqual(calls.length, 1, 'exactly one call site expected');
  assert.match(calls[0], /await\s+require\(/, 'the call must be awaited');
  // And the awaited result must actually be consumed, or the await is theatre.
  assert.match(src, /sync\.healed\.length/);
});

test('★ the sync throttle re-arms after the awaited result, not before it', () => {
  const { code } = require('./_source');
  const lines = code('trading/agent/mirrorPoller.js').split(/\r?\n/);
  const call = lines.findIndex((l) => /await\s+require\([^)]*\)\.syncVenueCloses\s*\(/.test(l));
  const reset = lines.findIndex((l, i) => i > call && /cyclesSinceCloseSync\s*=\s*0/.test(l));
  const caught = lines.findIndex((l, i) => i > call && /catch\s*\(\s*e\s*\)/.test(l));
  assert.ok(call > -1 && reset > call, 'the reset must follow the call');
  // If the reset were inside the guarded region it could be skipped by the very
  // throw it is meant to survive — which is what happened.
  assert.ok(caught === -1 || reset < caught, 'the reset must precede the catch');
});

test('an undefined venue read cannot become a TypeError', () => {
  const { code } = require('./_source');
  const src = code('trading/agent/mirrorPoller.js');
  assert.match(src, /closed\s*&&\s*closed\.items/);
});
