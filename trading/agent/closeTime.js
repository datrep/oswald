// trading/agent/closeTime.js — TRD-118: what a close TIME actually IS, as opposed to the instant stored.
//
// THE DEFECT THIS REMOVES. `Trades.closeAt` means two different facts depending on who closed the trade, and
// on 45% of closed rows it is not an observation at all. MEASURED 2026-09-24 on 80 closed rows:
//
//   closePriceSource = 'venue_rate'   -> 36 of 36 land EXACTLY on a minute boundary (second = 0, ms = 0)
//   closePriceSource = '(null)'       ->  0 of 36
//   closePriceSource = 'fill'         ->  0 of  8
//   and the control: `openAt` is on a minute boundary on 0 of 94 rows — opens NEVER look like this.
//
//   by reason:  "venue closed — Loss call"    17/17      "venue closed — Profit call"  11/11
//               "venue closed — Market closed"  8/8       "executor close"               0/44
//
// So the separation is TOTAL and it is not a coincidence: the venue-close path stores the venue's own
// closed-positions DISPLAY, which carries MINUTE resolution. A time whose seconds and milliseconds are both
// zero is not a measurement of an instant; it is a display rounded to the minute, and its uncertainty is up
// to 60 seconds in one direction (mean 30s) where a real capture is sub-second.
//
// WHY IT MATTERS. The excursion window IS `[openAt, closeAt]` — `autopsy.js` reads it to compute
// `mfePct`/`maePct`, and every window-based replay (TRD-118's own harness, TRD-117) inherits it. A window
// closed by a rounded instant samples the price path against a guessed end. It does NOT invalidate
// `grossPnl`-derived metrics (`expectancy.rMultiple` uses openPrice/stopPrice/pnl) — which is why TRD-38's
// counterfactual does not inherit the error — but it does invalidate anything that reads the PATH.
//
// THE FIX IS "STORE BOTH", the TRD-108 shape one column over: the timestamp stays as the venue gave it, and
// a second column names WHICH KIND of time it is, so a reader can tell a measured close from a rounded one
// and a window-based metric can refuse the rounded class instead of silently sampling against it.
//
// Pure: no store, no venue, no clock. Pinned by test against the measured shape.
'use strict';

// Which kind of time a row's `closeAt` is. Written EVERY TIME `closeAt` is written — the same discipline
// migrations 036 and 041 imposed on their pairs, and for the same reason: a timestamp with no provenance is
// the ambiguous value this column exists to eliminate.
//
// ★ `venueUiMinute` is the one the DATA shows, and it is why the enum is not the four values TRD-118 first
// proposed. The row named `venue_event | venue_schedule | reconcile | synthesised`; measurement says the
// dominant real case is narrower and more specific than any of them — the venue's display, at minute
// resolution — and calling it `venue_schedule` would have been wrong for the 28 profit/loss calls, which are
// EVENTS the venue merely displays coarsely. `venue_schedule` is kept for the 8 "market closed" rows, where
// the close really is a session boundary rather than a fill.
const CLOSE_AT_SOURCE = {
  venueUiMinute: 'venue_ui_minute', // the venue's closed-positions display — MINUTE resolution (measured)
  venueSchedule: 'venue_schedule',  // a session/settlement boundary rather than a fill ("market closed")
  venueEvent: 'venue_event',        // a venue timestamp at second-or-better resolution (none observed yet)
  deskObserved: 'desk_observed',    // the desk closed it and stamped its own clock
  reconcile: 'reconcile',           // assigned by a reconciler rather than observed
  synthesised: 'synthesised',       // derived from something else; nothing observed (last resort)
};

// Reasons the venue gives. Kept here so the venue-close write site maps them in ONE place.
const VENUE_CLOSE_REASON = { lossCall: 'loss call', profitCall: 'profit call', marketClosed: 'market closed' };

function asDate(at) {
  if (at == null) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isFinite(d.getTime()) ? d : null;
}

// A time whose seconds AND milliseconds are both zero is the signature of a minute-resolution SOURCE, not of
// a tidy event. Read in UTC, because that is how `closeAt` is stored (EVIDENCE_THRESHOLDS.md §clock).
function minuteRounded(at) {
  const d = asDate(at);
  if (!d) return false;
  return d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

// A lower bound on how wrong a close instant can be, in seconds. Rounded to the minute => up to 60s early
// (mean 30s); anything measured => 0. Used to state the error a window inherits rather than hand-waving it.
function closeTimeUncertaintySec(source, at) {
  if (source === CLOSE_AT_SOURCE.deskObserved || source === CLOSE_AT_SOURCE.venueEvent) return 0;
  if (source === CLOSE_AT_SOURCE.venueUiMinute || source === CLOSE_AT_SOURCE.venueSchedule) return 60;
  return minuteRounded(at) ? 60 : 0; // unknown provenance: fall back to the shape
}

// ★ THE GUARD A WINDOW-BASED METRIC CALLS. `[openAt, closeAt]` is only a measurement of the position's life
// when the END is observed. This is deliberately expressed as "is it safe", not "is it bad", so a caller that
// forgets to pass a source still gets the shape-based answer rather than an accidental pass.
function isWindowSafe(source, at) {
  if (source === CLOSE_AT_SOURCE.deskObserved || source === CLOSE_AT_SOURCE.venueEvent) return true;
  if (source === CLOSE_AT_SOURCE.venueUiMinute || source === CLOSE_AT_SOURCE.venueSchedule
    || source === CLOSE_AT_SOURCE.reconcile || source === CLOSE_AT_SOURCE.synthesised) return false;
  return !minuteRounded(at); // no source recorded: trust the shape, and the shape is what caught this
}

// The source for a venue-reported close, from the reason the venue gave. Kept as a function so the mapping
// has exactly one home.
function sourceForVenueClose(reason) {
  const key = String(reason == null ? '' : reason).trim().toLowerCase();
  return key === VENUE_CLOSE_REASON.marketClosed
    ? CLOSE_AT_SOURCE.venueSchedule
    : CLOSE_AT_SOURCE.venueUiMinute;
}

module.exports = {
  CLOSE_AT_SOURCE,
  VENUE_CLOSE_REASON,
  minuteRounded,
  closeTimeUncertaintySec,
  isWindowSafe,
  sourceForVenueClose,
};
