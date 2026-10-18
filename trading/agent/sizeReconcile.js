// trading/agent/sizeReconcile.js — the post-submit READ-BACK for `Trades.size` (TRD-EXE-3 residual).
//
// WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM THE SNAP.
//
// `risk.js` now snaps a size onto the venue's own increment BEFORE the order leaves (`instruments.snapToVenueStep`,
// 2026-09-30). That makes the desk's number and the venue's number agree AT SUBMIT — which is the case every one
// of the 32 measured positions falls into. It is not a read-back, and row #1463 says so in its own residual:
//
//   "the desk records `Trades.size` at submit time and never reconciles it to the venue's size afterwards ...
//    a venue that resolves differently from the measured rule would still diverge silently."
//
// Both halves are needed because they fail differently. The snap states what the venue WILL do from a rule
// derived from 32 observations; this states what the venue DID, from the venue's own report. A rule whose input
// drifts (a stale floor, a venue that changes its increment, a symbol whose minimum was mis-read) is invisible
// to the snap and immediately visible here.
//
// WHY IT MATTERS THAT THE TWO AGREE. `Trades.size` is the denominator under every risk number the desk
// publishes: `resolvedRiskPct`, the exit tolerance, the cost share of R, and the R multiple of the outcome.
// Measured 2026-09-30: they disagreed on 28 of 32 rows, median 3.99%, max 100%. On the live book right now,
// Oil #1134 recorded 15.8154 against a venue-held 15 (5.4% over) and Bitcoin #1131 recorded 0.0072 against
// 0.007 (2.9% over). The positions were SENT before the snap existed, so only a read-back can correct them.
//
// ⚠ WHAT CHANGING THIS MOVES, stated because it is not nothing. `Trades.size` is not only an analytic input:
// the exposure budget sums open notional from it, so correcting a row that was OVER-recorded FREES budget the
// desk did not really have, and correcting an UNDER-recorded row spends budget it did. The write is therefore
// NOT free of consequence — it is the correction of a false statement, and the event below records which
// direction each correction ran so a reader can see exactly what the budget was told. The size itself is never
// changed at the venue: this writes the desk's RECORD, and the venue's report is the authority it is written from.
'use strict';

const store = require('../store');

// The one rule, pure, so it can be pinned without a database.
//
// Returns a DECISION rather than a number: whether the two agree, by how much, and whether the venue's number
// may be written onto the desk's row. `write` is computed here rather than at the call site so no caller can
// invent its own tolerance — the venue's report is exact, and a tolerance would reintroduce the 2% predicate
// that `TRD-EXE-4` shows failing on precisely the rows that matter.
function sizeVerdict({ deskSize, venueSize, units = null } = {}) {
  const out = { ok: false, reason: null, desk: null, venue: null, delta: null, deltaPct: null, direction: null, write: false, units };
  // ⚠ ABSENCE IS CHECKED BEFORE COERCION. `Number(null) === 0` would read "the venue did not report a size"
  // as a confident ZERO and produce a −100% correction — which, on a live position, would rewrite its recorded
  // risk to nothing. The same trap is guarded in `exitLevels.num`, `budget.pricingOf` and `instruments.floorVerdict`.
  if (deskSize == null || deskSize === '' || venueSize == null || venueSize === '') {
    return { ...out, reason: 'size_absent' };
  }
  const d = Number(deskSize);
  const v = Number(venueSize);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(v) || v <= 0) {
    return { ...out, reason: 'size_unreadable', desk: Number.isFinite(d) ? d : null, venue: Number.isFinite(v) ? v : null };
  }
  const delta = Math.round((v - d) * 1e9) / 1e9;
  if (Math.abs(delta) <= 1e-9) {
    return { ...out, ok: true, reason: 'agrees', desk: d, venue: v, delta: 0, deltaPct: 0, direction: 'same' };
  }
  const deltaPct = Math.round(((delta / d) * 100) * 10000) / 10000;
  return {
    ok: true,
    reason: 'divergent',
    desk: d,
    venue: v,
    delta,
    deltaPct,
    // Named explicitly, because this is the direction the EXPOSURE BUDGET moves: `venue_above` records more
    // notional than the desk had (spends budget), `venue_below` records less (frees it).
    direction: v > d ? 'venue_above' : 'venue_below',
    write: true,
  };
}

// The thin DB wrapper. `deps` is injectable so the whole path can be exercised without a database.
//
// `venueRows` are the venue's own rows as read by the position poll — objects carrying `positionId` and `size`.
// They are matched by that id and NEVER by size, which is the whole point: the ids are equal when the numbers
// are not, and that is the case this exists for.
async function reconcileAt(userId, venueRows, { st = store, at = null } = {}) {
  const rows = Array.isArray(venueRows) ? venueRows : [];
  const summary = { checked: 0, corrected: 0, skipped: 0, unmatched: 0 };
  if (!rows.length) return summary;

  const open = await st.listOpenTradesWithPositionIds(userId);
  const byPosition = new Map();
  for (const t of (Array.isArray(open) ? open : [])) {
    if (t && t.plus500PositionId != null && String(t.plus500PositionId) !== '') {
      byPosition.set(String(t.plus500PositionId), t);
    }
  }

  const stamp = at || new Date().toISOString();
  for (const r of rows) {
    // ⚠ AN EMPTY ID IS A MISSING ID, NOT A KEY. `'' != null` is TRUE, so the first version of this loop sent
    // `positionId: ''` into the map lookup and counted it as "the venue reported a position the desk has no row
    // for" — the same absent-read-as-present sloppiness the rest of this module guards against at the NUMBER
    // level. It is `skipped` here for the same reason a null size is: nothing was compared.
    if (!r || r.positionId == null || String(r.positionId).trim() === '') { summary.skipped += 1; continue; }
    const t = byPosition.get(String(r.positionId));
    if (!t) { summary.unmatched += 1; continue; }
    summary.checked += 1;
    const verdict = sizeVerdict({ deskSize: t.size, venueSize: r.size, units: r.units != null ? r.units : t.units });
    if (!verdict.ok) { summary.skipped += 1; continue; }
    if (!verdict.write) continue;

    await st.updateTrade(userId, t.id, { size: verdict.venue });
    summary.corrected += 1;
    // ⚠ TWO DIRECTIONS MEET ON THIS ROW AND THEY ARE NOT THE SAME THING: the TRADE'S side (buy/sell) and the
    // DIRECTION OF THE CORRECTION (whether the venue held more or less than the desk recorded). The first
    // version emitted both under `direction`, so the trade's own side was silently overwritten by the
    // correction's — one key carrying two meanings, which is the defect class this register is full of. They
    // are named apart now, and eslint's `no-dupe-keys` is what caught it.
    await st.logEvent(userId, 'size_reconciled', {
      tradeId: t.id, positionId: String(r.positionId), symbol: t.symbol, tradeDirection: t.direction,
      deskSize: verdict.desk, venueSize: verdict.venue,
      delta: verdict.delta, deltaPct: verdict.deltaPct, correctionDirection: verdict.direction,
      units: verdict.units != null ? verdict.units : null,
      venue: 'plus500', source: 'position_poll', at: stamp,
      note: 'the venue reported a size the desk had not recorded, so Trades.size was corrected to the VENUE\'S '
        + 'number — the only statement of what is actually held. The order was not changed; the RECORD was. '
        + (verdict.direction === 'venue_below'
          ? 'This row was OVER-recorded, so the exposure budget is now told LESS notional than before.'
          : 'This row was UNDER-recorded, so the exposure budget is now told MORE notional than before.')
        + ' Every R computed on this trade before now used the old number (TRD-EXE-3).',
    }).catch(() => {});
  }
  return summary;
}

// Read-only twin, for a check or a report that must not write.
function driftOnly(userId, venueRows, { st = store } = {}) {
  return reconcileAt(userId, venueRows, { st: { ...st, updateTrade: async () => {}, logEvent: async () => {} } });
}

module.exports = { sizeVerdict, reconcileAt, driftOnly };
