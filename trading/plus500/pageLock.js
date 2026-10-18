// trading/plus500/pageLock.js — 2026-09-11: REAL mutual exclusion for the ONE
// shared Plus500 bridge tab (in-process; every desk flow lives in the service
// process). The wakePipeline `bridge` registry is telemetry only — it never
// prevented two flows from navigating the same tab. That race killed an Oil
// entry ticket mid set-limits (order_rejected 6289: the mirror's 60s cycle
// navigated to /open-positions while the venue SL/TP cards were expanding, so
// #close-at-loss-rate never enabled; the entry only filled on a later wake).
// Flow policy:
//   ticket      (place/close) — WAITS (bounded): must never be interrupted;
//   capture     (wake quotes) — WAITS (bounded): wakes keep fresh quotes;
//   mirror      (60s cycle)   — SKIPS if held : opportunistic, retries next tick.
//   watchdog    (login ping)  — SKIPS if held.
//   maintenance (TRD-46 tab reload) — WAITS (bounded), and SKIPS when its budget runs out: it is
//       owner-triggered, so being asked is a decision to proceed, but a reload is never worth
//       interrupting a ticket for — the caller asks again later.
// NOTE, stated rather than hidden: `sessionFeed.forceRefresh` and the alert routes in routes.js drive
// the shared tab WITHOUT this lock. Reloading is the flow that most needs to know that.
'use strict';

let holder = null; // null | 'ticket' | 'capture' | 'mirror' | 'watchdog' | 'close-sync' | 'maintenance'
let since = null;

function status() { return { holder, since }; }
function held() { return holder != null; }

// Parked-wait acquire: polls every 150ms; throws when the budget runs out.
// There is no await between the check and the set, so claiming is atomic.
//
// TRD-83 (2026-09-19): `waitedOn` is the list of holders this caller actually observed while parked.
// It exists because the wake record's `capture 121325ms` was read for two weeks as "the capture is
// slow", when 120 of those seconds are this loop — and the holder is the only actionable part of that
// number (a `ticket` is worth waiting for; a stuck `mirror` or `maintenance` is not). Reporting it from
// the lock rather than guessing it at the call site keeps the two in step.
async function acquire(name, { waitMs = 120000 } = {}) {
  const t0 = Date.now();
  const waitedOn = [];
  while (holder != null) {
    if (!waitedOn.includes(holder)) waitedOn.push(holder);
    if (Date.now() - t0 >= waitMs) throw new Error(`bridge busy (${holder}) — lock wait exceeded for ${name}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  holder = name;
  since = new Date().toISOString();
  return { acquired: true, waitedMs: Date.now() - t0, waitedOn };
}

// Non-blocking claim: false when someone else holds the tab.
function tryAcquire(name) {
  if (holder != null) return false;
  holder = name;
  since = new Date().toISOString();
  return true;
}

// Owner-checked release: a foreign name can never free someone else's claim.
function release(name) {
  if (holder === name) {
    holder = null;
    since = null;
  }
}

module.exports = { acquire, tryAcquire, release, held, status };
