// trading/agent/unconfirmed.js — TRD-52: the state between "sent" and "filled".
//
// WHY THIS EXISTS. Trades 1033 (2026-09-13T17:14:46Z): a size-1 Gold buy whose submit took 31.5 s and
// came back "position row did not appear after submit (order may have failed)". The classifier was
// RIGHT — `ambiguous` — and then four separate layers rounded "I do not know" down to "it did not
// happen":
//   * the event kind was `order_rejected`,
//   * the Trades row was `status = 'rejected'`,
//   * `maybeTripBreaker` counted it toward the 5-in-30-min soft kill, and
//   * self-health's rejection check reported it.
// And it had NOT failed. The order was submitted into a CLOSED session — the wakes either side of it
// both logged `market_closed / all venues closed` — and the venue queued it, filling it at the session
// open five hours later. The desk then met its own order as a stranger (Trades 1034, origin 'venue'),
// adopted it, and its ~107% notional vetoed every entry for the next 45 minutes.
//
// THE RULE, in one line: an unknown outcome is not a failure, and it must not be spent as evidence of
// one. `unconfirmed` is a first-class state with a resolution path, not a rejection with a nicer name.
//
// PURE ON PURPOSE. `require('./executor')` from a unit test attaches to the desk's LIVE Chrome on
// :9224 (it did once, and the test took 31.6 s), so the matching and expiry rules live here where they
// can be tested directly and the executor stays a thin caller.
'use strict';

// How long a submit may stay unresolved before the desk concludes it failed. SHORT, deliberately: with
// the closed-session guard in place (executor.openTrade) the remaining sources of an unknown outcome
// are a venue hiccup or a dead bridge, and both resolve within a couple of mirror cycles (~60 s each).
// What matters is that it is BOUNDED — a row that is never resolved is a position the desk may be
// holding without knowing it, which is the entire defect.
const UNCONFIRMED_TTL_MIN = 30;

// The venue does not always report the size we sent (units, rounding, a partial fill). Treat a match
// as "this is the same order" only within a small relative tolerance: a genuinely different position
// in the same symbol and direction must NOT be claimed as a recovery of this one, or the desk would
// relabel someone else's position as its own.
const SIZE_TOLERANCE_PCT = 2;

function sizeMatches(sent, seen) {
  const a = Number(sent);
  const b = Number(seen);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / a <= SIZE_TOLERANCE_PCT / 100;
}

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Does this venue position correspond to that unconfirmed submit?
// Symbol case-insensitively, direction exactly when both sides state one, size within tolerance.
// Returns the matching local row (so the caller can resolve THAT row into a real position) or null.
function matchVenuePosition(rows, venueItem) {
  if (!Array.isArray(rows) || !venueItem) return null;
  const name = norm(venueItem.name);
  if (!name) return null;
  return rows.find((u) => norm(u.symbol) === name
    && (!norm(venueItem.direction) || !norm(u.direction) || norm(u.direction) === norm(venueItem.direction))
    && sizeMatches(u.size, venueItem.size)) || null;
}

// Which unconfirmed rows are old enough to give up on. `now` is injectable so the rule is testable
// without touching the clock, and an unparseable timestamp is treated as NOT expired: giving up on a
// row whose age cannot be established is the one direction that can lose a live position.
function expiredRows(rows, { now = Date.now(), ttlMin = UNCONFIRMED_TTL_MIN } = {}) {
  const cutoff = Number(now) - Number(ttlMin) * 60000;
  return (Array.isArray(rows) ? rows : []).filter((u) => {
    const t = new Date(u.openAt || u.createdAt || 0).getTime();
    return Number.isFinite(t) && t > 0 && t <= cutoff;
  });
}

// ★ TRD-EXE-1 (2026-09-28): which unconfirmed submit, if any, BLOCKS a new submit for this symbol.
//
// A row with `status='unconfirmed'` means the desk sent an order and does not know whether the venue
// took it. It therefore cannot reason about its own position in that symbol, and a second submit is a
// second unmanaged position. Measured 2026-09-28: seven Arabica/Sugar submits in 100 minutes, all
// `ambiguous`, all of them actually sitting in the venue's order book — one stale order became seven,
// and the owner cancelled them by hand.
//
// Two decisions worth naming. It is per SYMBOL (a submit in Gold says nothing about Silver), and an
// absent or unreadable symbol returns null rather than blocking everything: a guard that fails closed
// on a missing field is a guard that can stop the whole desk from trading on a bad row.
function pendingFor(rows, symbol) {
  const want = norm(symbol);
  if (!want) return null;
  return (Array.isArray(rows) ? rows : []).find((u) => u && norm(u.symbol) === want) || null;
}

// How long ago a submit was made, in whole minutes — or null when the row carries no readable time.
// NOT `Number(row.openAt || 0)`: a missing timestamp becomes 0, i.e. the epoch, and the same rule that
// reports "0m" for a fresh row would report ~29 million minutes against a 30-minute TTL. A number that
// does not mean what it says is the defect class this module exists to avoid, so the unknown is null.
function ageMinutes(row, { now = Date.now() } = {}) {
  if (!row) return null;
  const t = new Date(row.openAt || row.createdAt || 0).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.round((Number(now) - t) / 60000);
}

// ★ TRD-RSK-9 (2026-09-28): THE SIZE THAT MADE THE MATCHER MISS. A position in the SAME symbol and
// direction as an unresolved submit, whose size is too far off to match it.
//
// WHY THIS IS NOT `matchVenuePosition` WITH A WIDER TOLERANCE. Widening the tolerance would make the
// matcher claim the position, and claiming means writing our `stopPrice`/`decisionId` onto it. If the
// position is NOT ours — a manual trade the owner placed in the same instrument — that attaches our
// stop and our bookkeeping to somebody else's exposure, which is a worse error than the one being
// fixed. So this function does not decide ownership. It returns the evidence and lets the caller make
// the ambiguity durable instead of silent.
//
// THE CASE, measured: #1110 Sugar buy 11.9862, submitted 2026-09-28T07:09:21Z into a CLOSED session,
// classified `ambiguous`, queued by the venue and filled at the open. The venue held 15 contracts.
// 15 against 11.9862 is 25% — far outside the 2% match window — so the desk adopted its own fill as a
// stranger and expired its own submit as `failed` 22 minutes later. Two records, one position, and the
// stop lived only on the record it threw away.
//
// `maxRatio` bounds the claim in the honest direction: a position three times the size we sent is not
// the order we sent (it is that order plus something else, or not our order at all), and reporting it
// as a near-miss would be the same overconfidence in a new place. Outside the bound it still reports,
// with `beyondRatio` set, so the caller can say WHICH kind of mismatch it is.
const SUSPECT_MAX_RATIO = 3;

function suspectedOwn(rows, venueItem, { maxRatio = SUSPECT_MAX_RATIO } = {}) {
  if (!Array.isArray(rows) || !venueItem) return null;
  const name = norm(venueItem.name);
  if (!name) return null;
  const sent = Number(venueItem.size);
  if (!Number.isFinite(sent) || sent <= 0) return null;
  for (const u of rows) {
    if (!u || norm(u.symbol) !== name) continue;
    // Direction may be unstated on either side; when both state one they must agree.
    if (norm(u.direction) && norm(venueItem.direction) && norm(u.direction) !== norm(venueItem.direction)) continue;
    const s = Number(u.size);
    if (!Number.isFinite(s) || s <= 0) continue;
    // If the size DOES match, the exact matcher owns this case and must run instead.
    if (sizeMatches(s, sent)) continue;
    const ratio = sent / s;
    return {
      row: u,
      // Signed and one decimal: "the venue holds 25.1% more than we sent" is actionable in a way that
      // "mismatch" is not. Relative to what we SENT, so a +25% and a -25% are different facts.
      deltaPct: Math.round(((sent - s) / s) * 1000) / 10,
      ratio: +ratio.toFixed(4),
      beyondRatio: ratio > maxRatio || ratio < 1 / maxRatio,
    };
  }
  return null;
}

module.exports = { UNCONFIRMED_TTL_MIN, SIZE_TOLERANCE_PCT, SUSPECT_MAX_RATIO, sizeMatches, matchVenuePosition, suspectedOwn, expiredRows, pendingFor, ageMinutes };
