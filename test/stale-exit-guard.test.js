// test/stale-exit-guard.test.js — TRD-TRL-1 option F, 2026-09-30.
//
// THE INSTANCE THIS PINS, from trading/docs/trailing-stop-2026-09-28.md §2 (fire 3, 2026-09-24):
//
//   16:17:17  trade_closed  — #1094 (Oil buy) recorded CLOSED by reconciliation
//   16:17:21  wake #87073   — the SAME pass emits action:"exit" (the 2xATR trailing stop at 95.195) and all
//                             three chairs vote on it. Committee APPROVES.
//
// Four seconds, three chair calls (~10,279 prompt tokens, ~9.5 s) spent deliberating a position the record
// had already closed. The wake reads `openTrades` once (:330) and every decision in the pass uses it; the
// ENTRY path re-reads for this exact reason and the EXIT path did not.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const { staleExitGuard } = require('../trading/agent/staleExit');

const snap = { id: 1094, symbol: 'Oil', status: 'open', direction: 'buy' };

test('a trade still open in the fresh book passes, and the FRESH row is what comes back', () => {
  const fresh = { id: 1094, symbol: 'Oil', status: 'open', direction: 'buy', mfePct: 0.89 };
  const g = staleExitGuard({ snapshotTrade: snap, freshOpen: [fresh] });
  assert.equal(g.ok, true);
  assert.equal(g.reason, null);
  // The caller's tolerance check and its close must read the state as it is NOW, not as the wake found it.
  assert.strictEqual(g.trade, fresh, 'the guard returns the fresh row, not the snapshot row');
});

test('the measured instance: gone from the book is REFUSED as already_closed', () => {
  const g = staleExitGuard({ snapshotTrade: snap, freshOpen: [] });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'already_closed');
});

test('★ IDENTITY, NOT SYMBOL — a different position in the same instrument must not be closed', () => {
  // This is the non-vacuity pin. The old exit path matched on SYMBOL (`x.symbol === d.symbol`), which would
  // accept any open position in Oil — including one opened between the two reads — and close THAT instead.
  const other = { id: 1200, symbol: 'Oil', status: 'open', direction: 'sell' };
  const g = staleExitGuard({ snapshotTrade: snap, freshOpen: [other] });
  assert.equal(g.ok, false, 'a same-symbol trade with a different id is NOT the trade that was decided on');
  assert.equal(g.reason, 'already_closed');
});

test('a row that is present but no longer open is refused, and names the status', () => {
  const g = staleExitGuard({ snapshotTrade: snap, freshOpen: [{ id: 1094, symbol: 'Oil', status: 'closed' }] });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'not_open');
  assert.equal(g.status, 'closed');
});

test('a snapshot row with no id cannot be shown to be open, and a close is destructive', () => {
  for (const bad of [null, undefined, {}, { id: null }, { id: '' }]) {
    const g = staleExitGuard({ snapshotTrade: bad, freshOpen: [{ id: 1, symbol: 'Oil', status: 'open' }] });
    assert.equal(g.ok, false, `snapshotTrade ${JSON.stringify(bad)} must not be closable`);
    assert.equal(g.reason, 'no_snapshot_trade');
  }
});

test('★ AN UNREADABLE BOOK IS NOT AN EMPTY ONE', () => {
  // `[]` is a genuine statement — "nothing is open" — and refuses. A NON-ARRAY is an absent input: the check
  // did not run, and saying otherwise would silently refuse every exit on a malformed call. Same distinction
  // as `Number(null) === 0`, one level up: absent must not be read as a value.
  const empty = staleExitGuard({ snapshotTrade: snap, freshOpen: [] });
  assert.equal(empty.ok, false, 'an empty book is a fact, not a missing input');

  for (const junk of [null, undefined, 'oops', 42, {}]) {
    const g = staleExitGuard({ snapshotTrade: snap, freshOpen: junk });
    assert.equal(g.ok, true, `a non-array (${JSON.stringify(junk)}) means the check did not run`);
    assert.equal(g.reason, 'book_unreadable_not_checked', 'and it SAYS SO rather than passing silently');
  }
});

test('the id match tolerates the string/number split, as every other position match here does', () => {
  const g = staleExitGuard({ snapshotTrade: { id: 1094, symbol: 'Oil', status: 'open' }, freshOpen: [{ id: '1094', symbol: 'Oil', status: 'open' }] });
  assert.equal(g.ok, true, 'a numeric id on one side and a string on the other is the same trade');
});

test('a row with no status is accepted (there is nothing saying it closed)', () => {
  const g = staleExitGuard({ snapshotTrade: snap, freshOpen: [{ id: 1094, symbol: 'Oil' }] });
  assert.equal(g.ok, true);
});

test('the pipeline guards the EXIT path, before the close, and records the skip', () => {
  const src = code('trading/agent/wakePipeline.js');
  assert.match(src, /require\('\.\/staleExit'\)\.staleExitGuard\(/, 'the exit path must call the guard');
  // ORDER MATTERS: the guard's call must precede `closeTrade` in the same branch, or the guard protects nothing.
  const guardAt = src.indexOf("staleExitGuard(");
  const closeAt = src.indexOf("require('./executor').closeTrade(userId, settings, t.id");
  assert.ok(guardAt > 0 && closeAt > 0, 'both the guard and the close must exist');
  assert.ok(guardAt < closeAt, 'the guard must run BEFORE the close, not after it');
  // A guard that silently does nothing is indistinguishable from a broken desk (the F20 lesson).
  assert.match(src, /stale_position:\s*\$\{guard\.reason\}/, 'a skipped exit must carry its reason on the execution');
  assert.match(src, /stale_position_'?\$?\{?guard\.reason/, 'and must be recorded as an event');
  assert.match(src, /intent: 'close'/, 'recorded against the close intent, so it is countable');
  // `order_blocked`, NOT `order_rejected`: the circuit breaker counts rejections, and a guard working must not
  // look like a broken desk (the TRD-43 asymmetry the F17 gate above cites for the same reason).
  // ⚠ SCOPED TO THE CALL, NOT THE FILE. The first version asserted `doesNotMatch` over the whole file and
  // matched the NOTE inside this very block — which says "not `order_rejected`" — so it failed on its own
  // documentation. That is this repo's documented trap: a negative assertion must pin the call, not the prose.
  const block = src.slice(guardAt, closeAt);
  assert.match(block, /log\.write\(userId, 'order_blocked', \{/, 'the skip is recorded as order_blocked');
  assert.doesNotMatch(block, /log\.write\(userId, 'order_rejected'/, 'and never as order_rejected');
});
