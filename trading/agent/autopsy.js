// trading/agent/autopsy.js — TRD-12 Phase 2: the learning loop.
// On every close: deterministic metrics (MFE/MAE vs entry, holding time,
// slippage vs the close-time mid) written back to Trades. LLM write-up only
// for losses >= settings.learning.autopsyLossPct (default 3%) of equity.
'use strict';

const store = require('../store');
const deepseek = require('./deepseek');
// TRD-118: how trustworthy the excursion WINDOW's end is. See the diagnosis block in computeMetrics.
const closeTime = require('./closeTime');
// TRD-EXI-1b (#1490): the pure arithmetic of a REFUSED cut. `exitPolicy` deliberately requires nothing, so
// this direction is safe and the arithmetic stays testable without a database.
const { refusalIdFor, refusalOutcomes } = require('./exitPolicy');

function midOf(t) {
  const b = Number(t.bid), a = Number(t.ask);
  if (Number.isFinite(b) && Number.isFinite(a)) return (a + b) / 2;
  return Number.isFinite(b) ? b : Number.isFinite(a) ? a : null;
}

// ── TRD-EXI-1 (#1490): make an exit rule JUDGEABLE instead of arguable ───────────────────────────────────────
// WHY. A production exit rule ("close when the price is near the stop, because the stop is about to be hit") was
// judged on FOUR trades, called a genuine defect, and then re-judged over the whole history where the COUNT
// REVERSED (29 helped / 16 hurt / 14 neither). Neither reading was usable: the prose reasons carry ~27 variants and
// cannot be counted, the exit KINDS were never separated (a close near the TARGET being booked was counted as a
// forfeited winner), and the counterfactual was a hand-written query whose horizon had not been fixed in advance.
// Both fields below are DIAGNOSIS-ONLY - no Trades column, per the TRD-OPT-2 constraint on that schema - and
// NEITHER OF THEM CHANGES A RULE. They exist so the rule can be changed on a number that survives being read twice.

// ⚠ THE HORIZON IS DECLARED, NOT CHOSEN AFTER THE NUMBERS ARE SEEN. A 24h window and a 2h window do not agree, so
// the value has to be pinned before it is used or the measurement can be re-cut to suit the answer.
const COUNTERFACTUAL_HORIZON_HOURS = 24;
const AT_LEVEL_R = 0.05; // closed within 5% of R of a level => that level did it
const NEAR_LEVEL_R = 0.5; // closed within half an R of a level => an early exit at that level

// WHICH KIND OF EXIT WAS THIS, derived from the GEOMETRY rather than read from prose.
//   `pnlR`        the outcome in R: -1 is a full stop-out, +1.2 a target, 0 break-even.
//   `stopDistR`   |close - stop| / R: 0 means it closed AT the stop.
//   `targetDistR` |close - target| / R: 0 means it closed AT the target.
// ⚠ `Number(null)` IS 0 and `Number('')` IS 0, so a missing level does NOT arrive as a refusal - it arrives as a
// plausible ZERO, and `entry = 0` against a stop of 102 produces a confident `venue_stop` for a row that has no
// entry at all. This is the coercion class the desk keeps re-finding, and it was caught here by the test for the
// null case rather than by inspection. Every external value goes through this.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function classifyClose({ direction, entry, stopPrice, takeProfitPrice, closePrice }) {
  const e = num(entry);
  const c = num(closePrice);
  const s = num(stopPrice);
  const t = num(takeProfitPrice);
  const dir = direction === 'buy' ? 1 : -1;
  const r = e != null && s != null ? Math.abs(e - s) : null;
  if (e == null || c == null || r == null || !(r > 0)) {
    return { closeClass: 'unclassifiable', pnlR: null, stopDistR: null, targetDistR: null };
  }
  const stopDistR = +(Math.abs(c - s) / r).toFixed(4);
  const targetDistR = t != null ? +(Math.abs(c - t) / r).toFixed(4) : null;
  const pnlR = +(((c - e) * dir) / r).toFixed(4);
  let closeClass;
  if (stopDistR <= AT_LEVEL_R) closeClass = 'venue_stop';
  else if (targetDistR != null && targetDistR <= AT_LEVEL_R) closeClass = 'target_booked';
  else if (stopDistR <= NEAR_LEVEL_R) closeClass = 'near_stop_cut';
  else if (targetDistR != null && targetDistR <= NEAR_LEVEL_R) closeClass = 'near_target_cut';
  else closeClass = 'mid_range_exit';
  return { closeClass, pnlR, stopDistR, targetDistR };
}

// ─ TRD-EXI-2 PROTOTYPE (2026-10-01): THE ADVERSE-EXCURSION CUT ────────────────────────────────────────────────
//
// THE HYPOTHESIS, from the 2026-10-01 loss review: a position that has travelled `threshold` of the way to its
// OWN stop almost never recovers, so cutting it there costs less than letting it run to the stop or to a
// signal-based exit. MEASURED retroactively over the 113 closed trades carrying both a stop and a P&L:
//
//     threshold 0.50 ->  -10.07 S$   (fires on 41, 11 of them winners)   <- LOSES MONEY
//     threshold 0.60 ->  +65.79 S$   (fires on 34,  4 of them winners)   <- the peak
//     threshold 0.70 ->  +36.07 S$   (fires on 31,  3 of them winners)
//
// ⚠⚠ SO "A LITTLE MORE AGGRESSIVE" IS EMPIRICALLY WRONG, WHICH IS THE OPPOSITE OF THE INTUITION THAT PROMPTED
// IT. 0.50 IS the more aggressive cut, and it LOSES: it fires on 11 winners to rescue 41 losers, and the cost of
// being one step too aggressive is ~76 S$ against a book that is itself net -163.65 S$.
//
// ⚠ WHAT THIS IS NOT. Not the stop, and not `exitTolerance`. `settings.risk.exitTolerance` DEFERS an exit while
// the floating loss is inside `maxLossAtR x ATR` - it holds losers a little longer, the OPPOSITE direction. Both
// can be true at once because they answer different questions, and a reader who confuses them would conclude the
// desk already does this.
//
// ⚠⚠ AND IT IS OBSERVE-ONLY, ON PURPOSE, FOR TWO SEPARATE REASONS.
//   1. It records on the EVENT-ONLY channel, following TRD-EXI-1's precedent: no Trades column (TRD-OPT-2 owns
//      that schema). A posture change needs its own row and the owner's signature; accumulating the evidence
//      does not, so this file changes nothing the desk DOES.
//   2. `maePct` IS ONLY KNOWN AT THE CLOSE - it is the path maximum. So this is a POST-HOC counterfactual
//      ("the rule would have fired"), NOT a live trigger. A trigger needs the excursion IN FLIGHT, which the
//      position poll already samples (`position_pnl_range` events carry min/max while a position is open);
//      that is the next step, and it is named here rather than left to be discovered by whoever wires it.
const EXCURSION_THRESHOLD = 0.6;

// The adverse excursion as a FRACTION OF THE TRADE'S OWN STOP DISTANCE: 0 at the entry, 1 at the stop, above 1
// past it. Direction-agnostic on purpose - `maePct` is already the adverse side - and it must NOT fire on a
// winner's benign noise, which is what the real stop distance denominates it against.
function excursionFraction({ entry, stopPrice, maePct }) {
  const e = num(entry);
  const s = num(stopPrice);
  const m = num(maePct);
  const r = e != null && s != null ? Math.abs(e - s) : null;
  if (e == null || m == null || r == null || !(r > 0) || !(e > 0)) {
    return { excursionFraction: null, excursionWouldCut: null, excursionStopDistPct: null };
  }
  const stopDistPct = +((r / e) * 100).toFixed(6);
  const adversePct = Math.abs(m);
  return {
    excursionStopDistPct: stopDistPct,
    excursionFraction: +(adversePct / stopDistPct).toFixed(4),
    excursionWouldCut: adversePct >= EXCURSION_THRESHOLD * stopDistPct,
  };
}

// DID THE LEVELS GET TOUCHED AFTER THE ANCHOR, and WHICH FIRST. Recorded WITH the trade instead of reconstructed
// months later by whoever is arguing about it.
//
// TRD-EXI-1b (#1490): this was `counterfactualAfterClose(userId, trade)` and it only ever anchored on a CLOSE.
// A cut the floor REFUSED has no close to anchor on, so the refusals could not be counterfactualised at all —
// and the floor could only be justified by the cuts that were taken. The window is now general: `fromAt` is the
// anchor, `capAt` is an end that is not the horizon, and `settled` is a level touch known from outside the tick
// feed. The close path calls it through a wrapper that passes none of the new terms, so every verdict already
// written for a closed trade keeps the exact meaning it had.
//
// ⚠ `capAt`: A WINDOW THAT ENDED EARLY IS COMPLETE, NOT TRUNCATED. A position closed three hours after the
// anchor has no further path to wait for — the question was settled by the position ending — so treating it as
// 4% of a horizon would manufacture an `open:` verdict (and therefore a deferral) out of a finished answer.
//
// ⚠ `settled`: THE TICK FEED CANNOT BE TRUSTED TO HAVE SAMPLED A TOUCH. Ticks land on the wake cadence, so a
// stop the venue executed between two of them leaves no crossing in the feed, and a tick-only race then reports
// "the stop was never reached" for a row the venue closed AT the stop. Measured precedent, and the reason this
// term exists: trade 29's venue take-profit sat at 104.0865 while our own ticks peaked at 103.995, so a
// tick-only race stopped out a trade that was actually a take-profit. A settle is a REAL observation (the venue
// said so, at a known instant); it is not an assumption about what happened between samples.
async function counterfactualFrom(userId, {
  symbol, venue, direction, stopPrice, takeProfitPrice,
  fromAt, horizonHours = COUNTERFACTUAL_HORIZON_HOURS, capAt = null, settled = null,
}) {
  const dir = direction === 'buy' ? 1 : -1;
  const s = num(stopPrice);
  const t = num(takeProfitPrice);
  const from = fromAt ? new Date(fromAt) : null;
  const out = {
    horizonHours, verdict: null, windowComplete: null, windowEndedBy: null,
    minutesToStop: null, minutesToTarget: null, ticksAfter: 0, lastMid: null, settledBy: null,
  };
  if (!from || !Number.isFinite(from.getTime()) || (s == null && t == null)) return out;
  const spanMs = horizonHours * 3600000;
  const desiredEnd = from.getTime() + spanMs;
  const capMs = capAt ? new Date(capAt).getTime() : null;
  const hardEnd = capMs != null && Number.isFinite(capMs) ? Math.min(desiredEnd, capMs) : desiredEnd;
  const endedEarly = hardEnd < desiredEnd;
  // ⚠ A WINDOW THAT IS STILL OPEN MUST NOT READ AS "NEVER TOUCHED". A close from an hour ago has not had its
  // horizon yet, and answering from the part that has elapsed is worse than not answering: it manufactures a
  // "the stop was never reached" out of missing data, which is the whole failure mode this field exists to fix.
  const coveredMs = Math.max(0, Math.min(hardEnd, Date.now()) - from.getTime());
  out.windowComplete = endedEarly || coveredMs >= spanMs * 0.95;
  out.windowEndedBy = endedEarly ? 'cap' : 'horizon';
  if (coveredMs <= 0) {
    out.verdict = 'no_window';
    return out;
  }
  const until = new Date(Math.min(hardEnd, Date.now()));
  let ticks = [];
  try {
    ticks = await store.ticksSince(userId, symbol, venue, from, until);
  } catch { /* no ticks */ }
  const ordered = ticks
    .filter((x) => x && x.capturedAt && Number.isFinite(midOf(x)))
    .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  out.ticksAfter = ordered.length;
  if (ordered.length) out.lastMid = midOf(ordered[ordered.length - 1]);
  let firstStop = null;
  let firstTarget = null;
  for (const x of ordered) {
    const m = midOf(x);
    const at = new Date(x.capturedAt);
    if (firstStop == null && s != null && (dir > 0 ? m <= s : m >= s)) firstStop = at;
    if (firstTarget == null && t != null && (dir > 0 ? m >= t : m <= t)) firstTarget = at;
    if (firstStop != null && (firstTarget != null || t == null)) break;
  }
  if (Array.isArray(settled)) {
    for (const ev of settled) {
      const at = ev && ev.at ? new Date(ev.at) : null;
      if (!at || !Number.isFinite(at.getTime())) continue;
      if (ev.level === 'stop' && s != null && (firstStop == null || at < firstStop)) {
        firstStop = at;
        out.settledBy = 'venue_stop';
      }
      if (ev.level === 'target' && t != null && (firstTarget == null || at < firstTarget)) {
        firstTarget = at;
        out.settledBy = 'venue_target';
      }
    }
  }
  out.minutesToStop = firstStop ? Math.round((firstStop - from) / 60000) : null;
  out.minutesToTarget = firstTarget ? Math.round((firstTarget - from) / 60000) : null;
  if (firstStop && firstTarget) {
    out.verdict = firstStop < firstTarget ? 'stop_first' : 'target_first';
  } else if (firstStop) out.verdict = 'stop_only';
  else if (firstTarget) out.verdict = 'target_only';
  else out.verdict = 'neither';
  // only a COMPLETE window can say `neither`; an open one says what it has seen so far and no more
  if (!out.windowComplete) out.verdict = `open:${out.verdict}`;
  return out;
}

// The close-path anchor, unchanged: no cap and no settle, so nothing already on the record moves.
async function counterfactualAfterClose(userId, trade) {
  return counterfactualFrom(userId, {
    symbol: trade.symbol,
    venue: trade.venue,
    direction: trade.direction,
    stopPrice: trade.stopPrice,
    takeProfitPrice: trade.takeProfitPrice,
    fromAt: trade.closeAt,
  });
}

// ── TRD-EXI-1b (#1490): RECORDING AND SETTLING THE CUTS THE FLOOR REFUSED ────────────────────────────────────
// `cut_refused` is written the moment the floor declines a cut; `cut_refusal_resolved` is written once the
// question "what did refusing cost or save" can be answered. Two events rather than one mutable row because the
// log is append-only, and a reader takes the LATEST record per `refusalId` — the same discipline the closed-trade
// counterfactual already uses.
//
// ⚠ WHY THE LEVELS COME FROM THE REFUSAL AND NOT FROM THE TRADE ROW. `resolveOneCutRefusal` re-reads the trade,
// but it measures against `stopPrice`/`takeProfitPrice`/`entry` AS RECORDED ON THE REFUSAL. A trailing stop that
// moved after the decision would otherwise re-aim the very question the refusal was asked: "the stop is about to
// be hit" has to mean the stop that was in force when the desk said so.
const REFUSAL_EVENT = 'cut_refused';
const REFUSAL_RESOLVED_EVENT = 'cut_refusal_resolved';
const REFUSAL_SWEEP_LIMIT = 200;

// ⚠ `Number(null)` IS 0, so a missing level arrives as a plausible zero and every comparison silently succeeds
// against it. Fourth appearance of this class in this workstream.
function sameNum(a, b) {
  const x = num(a);
  const y = num(b);
  return x == null && y == null ? true : x != null && y != null && Math.abs(x - y) < 1e-9;
}

// Write the refusal. Returns the record so the caller can put the SAME `refusalId` on the review event, which is
// what makes "the review that was declined" joinable to "what declining it cost" without a timestamp guess.
async function recordCutRefusal(userId, {
  tradeId, symbol, venue, direction, entry, stopPrice, takeProfitPrice,
  price, savingR, minSavingR, gateReason, at = new Date(),
}) {
  const atIso = new Date(at).toISOString();
  const rec = {
    refusalId: refusalIdFor(tradeId, atIso),
    tradeId, symbol: symbol || null, venue: venue || null, direction: direction || null,
    entry: num(entry), stopPrice: num(stopPrice), takeProfitPrice: num(takeProfitPrice), price: num(price),
    savingR: num(savingR), minSavingR: num(minSavingR), gateReason: gateReason || null,
    horizonHours: COUNTERFACTUAL_HORIZON_HOURS, at: atIso,
  };
  await store.logEvent(userId, REFUSAL_EVENT, rec);
  return rec;
}

// Settle ONE refusal. Returns { resolved } / { deferred } / { skipped } so the sweep can report why a refusal is
// still unmeasured instead of quietly dropping it.
async function resolveOneCutRefusal(userId, p, { resolvedBy = 'sweep' } = {}) {
  const from = new Date(p.at);
  if (!Number.isFinite(from.getTime())) return { skipped: 'bad_instant' };
  const horizon = num(p.horizonHours) > 0 ? num(p.horizonHours) : COUNTERFACTUAL_HORIZON_HOURS;
  const trade = await store.getTradeById(userId, p.tradeId).catch(() => null);
  const direction = (trade && trade.direction) || p.direction;
  const closed = !!(trade && trade.status && trade.status !== 'open');
  const closeAt = closed && trade.closeAt ? new Date(trade.closeAt) : null;
  // the window ends at the HORIZON or at the position's own close, whichever came first
  const capAt = closeAt && Number.isFinite(closeAt.getTime()) && closeAt.getTime() > from.getTime() ? closeAt : null;

  // SETTLE FROM THE VENUE'S OWN CLOSE. `classifyClose` already says whether the venue touched a level and which
  // one, so a stop the tick feed never sampled still lands in the race — but ONLY when the levels have not moved
  // since the refusal. If a trail relocated them, the classification is about a DIFFERENT level and importing it
  // would settle this refusal against a stop that did not exist when it was made.
  let settled = null;
  let settleSkipped = null;
  let closeClass = null;
  if (closed) {
    const cls = classifyClose({
      direction, entry: trade.openPrice, stopPrice: trade.stopPrice,
      takeProfitPrice: trade.takeProfitPrice, closePrice: trade.closePrice,
    });
    closeClass = cls.closeClass;
    if (cls.closeClass === 'venue_stop' || cls.closeClass === 'target_booked') {
      if (!capAt) settleSkipped = 'close_before_refusal';
      else if (!sameNum(trade.stopPrice, p.stopPrice) || !sameNum(trade.takeProfitPrice, p.takeProfitPrice)) settleSkipped = 'levels_moved';
      else settled = [{ level: cls.closeClass === 'venue_stop' ? 'stop' : 'target', at: capAt }];
    }
  }

  const cf = await counterfactualFrom(userId, {
    symbol: p.symbol, venue: p.venue, direction,
    stopPrice: p.stopPrice, takeProfitPrice: p.takeProfitPrice,
    fromAt: from, horizonHours: horizon, capAt, settled,
  });
  if (cf.verdict === 'no_window') return { skipped: cf.verdict };
  // STILL WAITING. Either the horizon has not elapsed, or nothing has been observed inside the part that has —
  // and an empty window must never be allowed to answer "the levels were never reached".
  if (String(cf.verdict).startsWith('open:')) return { deferred: true };
  if (!closed && cf.ticksAfter === 0) return { deferred: true };

  const e = num(p.entry);
  const sP = num(p.stopPrice);
  const r = e != null && sP != null ? Math.abs(e - sP) : null;
  const dir = direction === 'buy' ? 1 : -1;
  let heldOutcomeR = null;
  let heldOutcomeSource = null;
  if (closed) {
    const cp = num(trade.closePrice);
    if (r != null && r > 0 && cp != null) {
      heldOutcomeR = +(((cp - e) * dir) / r).toFixed(4);
      heldOutcomeSource = 'actual_close';
    }
  } else if (r != null && r > 0 && cf.lastMid != null) {
    heldOutcomeR = +(((cf.lastMid - e) * dir) / r).toFixed(4);
    heldOutcomeSource = 'mark_at_window_end';
  }
  const { cutOutcomeR, tpR, refusalValueR } = refusalOutcomes({
    entry: p.entry, stopPrice: p.stopPrice, takeProfitPrice: p.takeProfitPrice,
    savingR: p.savingR, heldOutcomeR,
  });
  const rec = {
    refusalId: p.refusalId, tradeId: p.tradeId, symbol: p.symbol, venue: p.venue, direction,
    savingR: num(p.savingR), minSavingR: num(p.minSavingR), tpR,
    cutOutcomeR, heldOutcomeR, heldOutcomeSource, refusalValueR,
    verdict: cf.verdict, closeClass, windowComplete: cf.windowComplete, windowEndedBy: cf.windowEndedBy,
    settledBy: cf.settledBy, settleSkipped,
    minutesToStop: cf.minutesToStop, minutesToTarget: cf.minutesToTarget,
    ticksAfter: cf.ticksAfter, horizonHours: cf.horizonHours,
    refusedAt: p.at, resolvedAt: new Date().toISOString(), resolvedBy,
  };
  await store.logEvent(userId, REFUSAL_RESOLVED_EVENT, rec);
  return { resolved: true, rec };
}

// Resolve every refusal that can be resolved. Called TWICE over the life of a refusal on purpose: once when the
// position it belongs to closes (the definitive end of the question), and on a standing sweep, because a refusal
// on a position that stays open past its horizon would otherwise never be resolved at all — and this desk is
// about to be left alone with it for nineteen days.
async function resolveCutRefusals(userId, { limit = REFUSAL_SWEEP_LIMIT, tradeId = null, resolvedBy = 'sweep' } = {}) {
  const [refused, resolved] = await Promise.all([
    store.listEventsAll(userId, { kind: REFUSAL_EVENT }),
    store.listEventsAll(userId, { kind: REFUSAL_RESOLVED_EVENT }),
  ]);
  const done = new Set();
  for (const e of resolved.rows) {
    const id = e.payload && e.payload.refusalId;
    if (id) done.add(id);
  }
  // the log is newest-first, so the FIRST payload seen for an id is the latest one
  const latest = new Map();
  for (const e of refused.rows) {
    const p = e.payload;
    if (p && p.refusalId && !latest.has(p.refusalId)) latest.set(p.refusalId, p);
  }
  let pending = [...latest.values()].filter((p) => !done.has(p.refusalId));
  if (tradeId != null) pending = pending.filter((p) => String(p.tradeId) === String(tradeId));
  // OLDEST FIRST: a sweep that worked newest-first would starve its own tail once the log outgrew the limit
  pending.sort((a, b) => new Date(a.at) - new Date(b.at));
  const out = {
    refused: latest.size, alreadyResolved: done.size, pending: pending.length,
    resolved: 0, deferred: 0, skipped: 0,
    // ⚠ a page cap is a FLOOR, not a total: surfaced rather than left for the reader to assume
    truncated: !!(refused.truncated || resolved.truncated),
  };
  for (const p of pending.slice(0, limit)) {
    try {
      const r = await resolveOneCutRefusal(userId, p, { resolvedBy });
      if (r.resolved) out.resolved++;
      else if (r.deferred) out.deferred++;
      else out.skipped++;
    } catch (e) {
      out.skipped++;
      await store.logEvent(userId, 'error', { where: 'resolveCutRefusals', refusalId: p.refusalId, error: String(e.message || e).slice(0, 200) }).catch(() => {});
    }
  }
  return out;
}

// Deterministic metrics from the tick replay between open and close.
async function computeMetrics(userId, trade) {
  const openAt = trade.openAt ? new Date(trade.openAt) : null;
  const closeAt = trade.closeAt ? new Date(trade.closeAt) : null;
  // TRD-117 (2026-09-22): `mfeSource`/`maeSource` are initialised NULL here, not merely left absent, so a
  // forced recompute that can no longer compute an excursion CLEARS a stale source rather than leaving
  // provenance pointing at a number that is gone. Same discipline as the metrics themselves.
  const metrics = { holdingMinutes: null, mfePct: null, maePct: null, slippagePct: null, mfeSource: null, maeSource: null };
  // TRD-106 (2026-09-19): WHY an excursion is missing, recorded rather than left as an ambiguous NULL.
  //
  // `mfePct = NULL` cannot distinguish "never attempted" from "attempted and impossible", and this desk
  // reads NULLs in exactly that place: 15 of 44 closed agent trades carry no excursion, and the split is
  // not random — trades WITH an autopsy average 182.2 minutes held (1 of 29 under 6 minutes), trades
  // WITHOUT average 6.7 (12 of 15 under 6). This function needs `ticks.length >= 3` and ticks are ~10
  // MINUTES APART, so a trade shorter than roughly half an hour is STRUCTURALLY unmeasurable. That is a
  // property of the feed, not a failure of the trade, and the difference has to be on the record.
  const diagnosis = { ticksInWindow: 0, reason: null };
  // TRD-118 (2026-09-24): THE WINDOW'S END IS NOT ALWAYS AN OBSERVED INSTANT. Measured — 36 of 36
  // `venue_rate` closes land EXACTLY on a minute boundary against 0 of 94 opens, because the venue-closed
  // path stores the venue's own DISPLAY, which carries minute resolution. The excursion is computed over
  // `[openAt, closeAt]`, so a rounded end samples the price path against a guessed instant: up to 60s of
  // error (mean 30s) where the capture itself is sub-second.
  // ★ FLAGGED, NOT EXCLUDED. Excluding would drop 45% of closed rows, and the metric is still the best
  // available — but a reader must be able to see WHICH rows have a trustworthy window. Same discipline as
  // TRD-106's `diagnosis.reason`: the LIMIT goes on the record rather than into an ambiguous number.
  if (closeAt) {
    const atSource = trade.closeAtSource || null;
    const unc = closeTime.closeTimeUncertaintySec(atSource, closeAt);
    diagnosis.closeAtSource = atSource;
    if (unc > 0) {
      diagnosis.windowEnd = 'rounded';
      diagnosis.windowEndUncertaintySec = unc;
    }
  }
  if (openAt && closeAt) metrics.holdingMinutes = Math.max(0, Math.round((closeAt - openAt) / 60000));

  const openPrice = Number(trade.openPrice);
  const closePrice = Number(trade.closePrice);
  // TRD-108 (2026-09-21): the FILL, when the row carries one. NaN when it does not, which is a real state
  // (an older row, or a close whose fill could not be derived) and must fall back rather than compare.
  const closeFillPrice = Number(trade.closeFillPrice);
  if (openPrice && openAt) {
    let ticks = [];
    try { ticks = await store.ticksSince(userId, trade.symbol, trade.venue, openAt, closeAt); } catch { /* no ticks */ }
    // Belt and braces: never let an unbounded/replayed tick leak past the close.
    if (ticks.length) ticks = ticks.filter((t) => !t.capturedAt || new Date(t.capturedAt) <= closeAt);
    diagnosis.ticksInWindow = ticks.length;
    diagnosis.reason = ticks.length === 0 ? 'no_ticks_in_window'
      : ticks.length < 3 ? `too_few_ticks:${ticks.length}`
        : 'checked';
    if (ticks.length >= 3) {
      const mids = ticks.map(midOf).filter((v) => Number.isFinite(v));
      if (mids.length >= 3) {
        // Ticks land on the wake cadence (~5 min), so the true extreme can fall
        // between two samples and the sampled MFE reads LOW. Anchor the path with
        // the close fill: without it, a trade can report MFE 1.866% while having
        // achieved 2.145% (id 29, 2026-09-11), which makes "capture efficiency"
        // exceed 100% and reads as nonsense. The close is a real observed price of
        // the thing we held, so it belongs in the path.
        const path = Number.isFinite(closePrice) && closePrice > 0 ? [...mids, closePrice] : mids;
        // TRD-117 (2026-09-22): the close is appended LAST, so an extreme that lands on it can be NAMED.
        // An explicit scan replaces Math.max/Math.min because the INDEX is now the point, and spreading a
        // long tick list into a call is the wrong tool regardless.
        const closeIdx = path.length > mids.length ? mids.length : -1;
        let peakIdx = 0;
        let troughIdx = 0;
        for (let i = 1; i < path.length; i++) {
          if (path[i] > path[peakIdx]) peakIdx = i;
          if (path[i] < path[troughIdx]) troughIdx = i;
        }
        const dir = trade.direction === 'buy' ? 1 : -1;
        // 2026-09-12 BUG FIX: MFE must use the FAVOURABLE extreme and MAE the
        // ADVERSE one — and those SWAP with direction (for a short, the best
        // price seen is the LOW). Signing the raw max/min pair by `dir` inverted
        // the two metrics for every SELL: a short's "MFE" reported its worst
        // adverse excursion and its "MAE" the best favourable one. Half the book
        // is shorts (3 of the 7 day-one trades), so the capture analysis this
        // metric exists for was reading backwards. Recomputed via
        // `backfill({ force: true })`.
        const favourable = dir > 0 ? path[peakIdx] : path[troughIdx];
        const adverse = dir > 0 ? path[troughIdx] : path[peakIdx];
        metrics.mfePct = +((((favourable - openPrice) * dir) / openPrice) * 100).toFixed(4);
        metrics.maePct = +((((adverse - openPrice) * dir) / openPrice) * 100).toFixed(4);
        // TRD-117 (2026-09-22): WHICH observation produced each extreme — because the appended close makes
        // MAE CIRCULAR on a loss-exit row. On a row that exits at its worst point (exactly what a stop-out
        // is) the close dominates min(path), so `maePct` is the close excursion BY CONSTRUCTION and restates
        // where the trade ended instead of measuring how far price ran against it.
        //
        // MEASURED 2026-09-22: 23 of the 39 rows carrying `maePct` had it EXACTLY equal to the close
        // excursion to 4dp, and that set was every row whose close was adverse. It also makes
        // `hitStop: maePct <= -riskPct` (byp1-veto-value.js, chair-override-value.js) TAUTOLOGOUS on a
        // stop-out row, and degenerates the net-edge screen's `avgMfe - |avgMae| - cost`.
        //
        // RECORDED, NOT RECOMPUTED — the TRD-108 `closePriceSource` precedent. No number moves; a reader can
        // now tell a MEASURED excursion from the close restated. An anchored extreme is not wrong (the close
        // IS an observed price of the thing we held), it is just not an EXCURSION.
        const sourceOf = (i) => (i === closeIdx ? 'close' : 'mid');
        metrics.mfeSource = sourceOf(dir > 0 ? peakIdx : troughIdx);
        metrics.maeSource = sourceOf(dir > 0 ? troughIdx : peakIdx);
        // Slippage: the close FILL vs the last mid seen before the close. Uses the raw tick list (not
        // `path`) so the close does not compare against itself.
        //
        // TRD-108 (2026-09-21): THE EXIT PRICE IS `closeFillPrice`, NOT `closePrice`. On a venue-closed row
        // `closePrice` is the venue's stated RATE — the stop on a loss, the take-profit on a win — so this
        // metric was measuring the LEVEL the venue closed at: it read ~0 by construction on exactly the rows
        // where a real fill is most informative. WHICH price was used is recorded, so a slippage computed
        // from a level stays distinguishable from one computed from a fill.
        const lastMid = mids[mids.length - 1];
        const exitPx = Number.isFinite(closeFillPrice) && closeFillPrice > 0 ? closeFillPrice : closePrice;
        if (exitPx && lastMid > 0) {
          metrics.slippagePct = +((((exitPx - lastMid) * dir) / lastMid) * 100).toFixed(4);
          diagnosis.exitPriceSource = exitPx === closeFillPrice ? 'closeFillPrice' : 'closePrice';
        }
      }
    }
  }
  // The reason is DERIVED FROM THE OUTCOME, so it cannot go stale against the branches above: if the
  // excursion exists the answer is `ok` whatever happened on the way, and if it does not, the most
  // specific cause already recorded wins.
  if (metrics.mfePct != null) diagnosis.reason = 'ok';
  else if (diagnosis.reason == null || diagnosis.reason === 'checked') {
    diagnosis.reason = !openPrice ? 'no_open_price' : !openAt ? 'no_open_time' : 'no_computable_path';
  }
  // TRD-EXI-1 (#1490): the exit KIND and the counterfactual, on the EVENT-ONLY channel. Both are diagnosis rather
  // than metrics on purpose - neither is a Trades column and neither may become one (TRD-OPT-2 owns that schema).
  Object.assign(diagnosis, classifyClose({
    direction: trade.direction,
    entry: trade.openPrice,
    stopPrice: trade.stopPrice,
    takeProfitPrice: trade.takeProfitPrice,
    closePrice: trade.closePrice,
  }));
  // TRD-EXI-2 prototype: the adverse-excursion cut, RECORDED and not applied - see the note above the function.
  // `maePct` comes from the metrics computed on this close, with the stored column as the fallback so a row whose
  // path could not be rebuilt still reports what is known about it rather than reporting nothing.
  Object.assign(diagnosis, excursionFraction({
    entry: trade.openPrice,
    stopPrice: trade.stopPrice,
    maePct: metrics.maePct != null ? metrics.maePct : trade.maePct,
  }));
  try {
    diagnosis.counterfactual = await counterfactualAfterClose(userId, trade);
  } catch (e) {
    diagnosis.counterfactual = {
      horizonHours: COUNTERFACTUAL_HORIZON_HOURS,
      verdict: `error:${String(e && e.message).slice(0, 60)}`,
    };
  }
  return { ...metrics, _diagnosis: diagnosis };
}

// Run the autopsy for a just-closed DEMO trade: metrics + optional LLM write-up.
// `llm:false` computes and stores the (free, deterministic) metrics but skips the
// paid write-up — used when healing HISTORICAL closes, where the metrics are what
// we need and a dozen old rows must not spend the day's token budget.
async function runOnClose(userId, settings, trade, { llm = true } = {}) {
  try {
    // TRD-106: `_diagnosis` is NOT a Trades column — it is stripped before the write and recorded on the
    // event, so an unmeasurable close is attributed where a reader will look for it.
    const { _diagnosis, ...metrics } = await computeMetrics(userId, trade);
    await store.updateTrade(userId, trade.id, metrics);

    // TRD-EXI-1b (#1490): the position that just ended is the definitive end of every cut this desk DECLINED on
    // it, so those refusals are settled here rather than waiting for the sweep. ISOLATED ON PURPOSE: measuring a
    // refusal must never be able to cost the metrics of the close it belongs to, and the sweep retries anything
    // this misses.
    try {
      await resolveCutRefusals(userId, { tradeId: trade.id, resolvedBy: 'close' });
    } catch { /* the standing sweep owns the retry */ }

    const lossPct = metrics.maePct != null && metrics.maePct < 0 ? Math.abs(metrics.maePct) : null;
    const threshold = Number(settings.learning?.autopsyLossPct ?? 3);
    const bigLoss = lossPct != null && lossPct >= threshold;
    const grossPnl = Number(trade.grossPnl);
    if (llm && bigLoss && !settings.llm?.stub && grossPnl != null && grossPnl < 0) {
      const r = await deepseek.callChat([
        { role: 'system', content: 'You are the post-trade autopsy writer for a DEMO trading agent. Analyze what went wrong on this losing trade. Max 3 sentences, plain text, no preamble.' },
        { role: 'user', content: JSON.stringify({ symbol: trade.symbol, direction: trade.direction, size: trade.size, openPrice: trade.openPrice, closePrice: trade.closePrice, pnl: grossPnl, ...metrics, note: trade.note, strategyId: trade.strategyId }) },
      ], { model: settings.llm?.model || deepseek.DEFAULT_MODEL, temperature: 0.3, maxTokens: 900, jsonMode: false, timeoutMs: 30000, userId, label: 'autopsy' });
      deepseek.meterUsage(r.model, r.usage, 'autopsy').catch(() => {});
      await store.logEvent(userId, 'autopsy', { tradeId: trade.id, symbol: trade.symbol, metrics, diagnosis: _diagnosis, writeup: (r.text || '').slice(0, 600), actor: `llm:${r.model}` });
      return { ...metrics, writeup: (r.text || '').slice(0, 600) };
    }
    await store.logEvent(userId, 'autopsy', { tradeId: trade.id, symbol: trade.symbol, metrics, diagnosis: _diagnosis });
    return metrics;
  } catch (e) {
    await store.logEvent(userId, 'error', { where: 'autopsy', error: String(e.message || e).slice(0, 200) });
    return null;
  }
}

// Backfill: compute metrics for closed trades that lack them.
// `force` recomputes rows that already have metrics. Needed twice now: once to
// repair the pre-2026-09-12 rows whose short-side MFE/MAE were inverted, and
// again after bounding the tick window at the close (the old values included
// post-close price action).
//
// 2026-09-19 (TRD-106): the old note here said rows with no stored ticks inside their hold window "stay
// NULL — acceptable, and visible as such in the UI". That was wrong in one specific way and it is worth
// keeping the correction: the exclusion is NOT random. It lands almost entirely on the SHORT trades
// (15 of 44 closes, averaging 6.7 minutes against 182.2 for the measurable ones), and short trades are
// where an edge is thinnest relative to the round trip — so "visible as NULL" meant the path-based
// analysis was blind exactly where it was most needed. The reason is now tallied and returned.
async function backfill(userId, { limit = 50, force = false } = {}) {
  const closed = await store.listClosedTradesForStats(userId, { days: 365, limit });
  let done = 0;
  const reasons = {};
  for (const t of closed) {
    if (!force && t.mfePct != null && t.holdingMinutes != null) continue;
    const { _diagnosis, ...metrics } = await computeMetrics(userId, t);
    await store.updateTrade(userId, t.id, metrics);
    // ⚠ TRD-EXI-1 (#1490): THE DIAGNOSIS USED TO BE DISCARDED HERE, and on this path it is the ONLY carrier of
    // the exit class and the post-close counterfactual - neither is a Trades column (TRD-OPT-2 owns that schema).
    // Without this line an exit rule could only ever be judged from trades closed AFTER the change was deployed:
    // the history would stay unmeasurable, which is precisely why the rule was argued about twice on evidence
    // that could not settle it. `backfilled: true` marks provenance, because a counterfactual reconstructed now
    // is not the same record as one written at close time. A reader takes the LATEST autopsy event per tradeId.
    await store.logEvent(userId, 'autopsy', {
      tradeId: t.id, symbol: t.symbol, metrics, diagnosis: _diagnosis, backfilled: true,
    });
    reasons[_diagnosis.reason] = (reasons[_diagnosis.reason] || 0) + 1;
    done++;
  }
  return { scanned: closed.length, computed: done, reasons };
}

module.exports = {
  runOnClose, backfill, computeMetrics, midOf,
  // TRD-EXI-1 (#1490): exported so the classification can be pinned by a test rather than argued about
  classifyClose, counterfactualAfterClose, COUNTERFACTUAL_HORIZON_HOURS,
  // TRD-EXI-2 prototype: the adverse-excursion cut (observe-only) and the threshold its evidence table was
  // measured at. Kept in the MODULE and not in settings while nothing acts on it: a tunable that nothing reads
  // is a second home for a number, and this one has exactly one piece of evidence behind it.
  excursionFraction, EXCURSION_THRESHOLD,
  // TRD-EXI-1b (#1490): the refusal channel. `counterfactualFrom` is exported alongside the close-path wrapper
  // so the window itself can be driven through a stubbed tick feed in a unit test — the race, the cap and the
  // settle were the untested part of the close-path version.
  counterfactualFrom, recordCutRefusal, resolveCutRefusals,
};
