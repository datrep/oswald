// trading/agent/staleExit.js — TRD-TRL-1 option F: an exit must be decided against a book that is still there.
//
// THE MEASURED INSTANCE (trading/docs/trailing-stop-2026-09-28.md §2, fire 3, 2026-09-24):
//
//   16:17:17  trade_closed  — #1094 (Oil buy) is recorded CLOSED by reconciliation
//   16:17:21  wake #87073   — the same wake emits action:"exit" for that trade (the 2xATR trailing stop at
//                             95.195) and ALL THREE CHAIRS vote on it. The committee APPROVES.
//
// Four seconds. The desk spent three chair calls (~10,279 prompt tokens, ~9.5 s of latency) deliberating an
// exit for a position the record had already marked closed — and then attempted to close it.
//
// WHY THE SNAPSHOT IS STALE, AND WHY THAT IS STRUCTURAL RATHER THAN A SLIP. The wake reads `openTrades` ONCE
// at wakePipeline.js:330 and every decision in that pass is made against that one read. The venue acts
// continuously in between. The ENTRY path already knows this: wakePipeline.js:966 re-reads the book "for ONE
// purpose — is this symbol already held — the decision was deliberated on a snapshot captured minutes ago".
// The EXIT path has no such read, so the same staleness that is GUARDED on the way in was ACTED ON the way
// out. That asymmetry is the defect; this module is the missing half, not a new precaution.
//
// ★ THE RULE IS ABOUT IDENTITY, NOT PRICE OR SYMBOL. A snapshot row may only be acted on if the trade it NAMES
// is still open in the fresh book. The exit path matches on SYMBOL (`openTrades.find(x => x.symbol === d.symbol
// && x.status === 'open')`), which would happily accept a DIFFERENT position in the same instrument opened
// between the two reads and close that one instead. Matching on the trade id cannot do that. This is why the
// guard is not merely a "did anything change" check.
//
// ⚠ WHAT THIS DOES *NOT* COVER, stated so it is not mistaken for a fix for TRD-EXE-8: this sees the DESK'S
// RECORD. If the venue has closed a position and the desk has not yet reconciled that close, the record still
// says open, this guard passes, and `closeTrade` is attempted against a position that is already gone — which
// is exactly the "already closed at the venue" path that TRD-EXE-8 owns. The two are complementary halves of
// one class (acting on position state that has moved) and neither substitutes for the other.
'use strict';

// Pure. Returns a DECISION, never a boolean, so the caller cannot act on `ok` without also having the reason
// and the row it should use.
function staleExitGuard({ snapshotTrade = null, freshOpen = null } = {}) {
  const snap = snapshotTrade || null;
  // A row with no id cannot be identified in the fresh book, so it cannot be shown to be open. Refusing is the
  // fail-closed direction for a DESTRUCTIVE action (a close), and it cannot strand a live position because a
  // row without an id is not a row the desk could close anyway.
  if (snap == null || snap.id == null || String(snap.id).trim() === '') {
    return { ok: false, reason: 'no_snapshot_trade', trade: null };
  }
  // ⚠ AN UNREADABLE BOOK IS NOT AN EMPTY ONE — the same distinction as `Number(null) === 0`, one level up. A
  // NON-ARRAY is an absent input and means the check did not run, so the exit proceeds on the snapshot and SAYS
  // SO. An empty ARRAY is a genuine statement ("nothing is open") and refuses. Collapsing the two would make
  // every malformed call silently refuse, or every failed read silently close.
  //
  // ★ AND THE DEFAULT IS `null`, NOT `[]`, FOR EXACTLY THIS REASON. The first version defaulted `freshOpen` to
  // `[]`, which meant a caller who OMITTED the argument got the refusal path — absent read as empty, inside the
  // function written to prevent that. This module's own test caught it; the default is the bug, not the test.
  const rows = Array.isArray(freshOpen) ? freshOpen : null;
  if (rows == null) return { ok: true, reason: 'book_unreadable_not_checked', trade: snap };

  const match = rows.find((r) => r && r.id != null && String(r.id) === String(snap.id));
  if (!match) return { ok: false, reason: 'already_closed', trade: snap };
  if (match.status != null && match.status !== 'open') {
    return { ok: false, reason: 'not_open', status: match.status, trade: snap };
  }
  // The FRESH row is returned on purpose: the caller's tolerance check and its close should read the state as
  // it is now, not as it was when the wake began.
  return { ok: true, reason: null, trade: match };
}

module.exports = { staleExitGuard };
