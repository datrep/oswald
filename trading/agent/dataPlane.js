// trading/agent/dataPlane.js — F32 (2026-09-18): is the desk's DATA still arriving?
//
// WHY THIS EXISTS. The 2026-09-17 audit found the desk had run ~16 HOURS on market data frozen at
// `2026-09-16T21:18:52Z` while the header chip on every screen read `Data: fresh`. Every fact needed to
// know that was already on the page — the health banner's tick list, the `captured: 0` telemetry rows,
// the capture step's own `121325ms` — but all of it was PROSE or TELEMETRY, and the one glanceable
// summary was computed from whether the UI's own API calls had succeeded. So the chip was true and
// useless: it answered "did my panels load?" while the operator was asking "is this desk trading on live
// prices?". Worse, the surfaces that could have shown the outage as a STATE showed a dash — the scripts
// card's liveness column was blank for the five processes whose liveness mattered most.
//
// This module answers the second question, and it is deliberately:
//   - DB-ONLY. A health check that needs the thing it is checking is not a check: while the bridge was
//     starved, every bridge-touching probe hung, which is exactly when a verdict is most needed.
//   - PURE AT ITS CORE. `assess(facts)` takes the facts and returns the verdict, so the thresholds are
//     testable without a desk, and the gather step (`status`) is the only part that reads anything.
//   - THRESHOLDED BY DERIVATION, never by taste. Each number below states the cadence it is a multiple of
//     and why that multiple, because "stale" is meaningless without "stale relative to what".
'use strict';

const store = require('../store');

// The capture runs on EVERY wake, so the wake interval IS the feed's expected cadence. Read from settings
// with this fallback so a desk with a malformed setting is still measurable rather than silently exempt.
const DEFAULT_WAKE_INTERVAL_MIN = 10;

// How many missed cycles before the feed counts as STOPPED rather than slow. Derived: the capture already
// tolerates one or two busy cycles BY DESIGN (its lock wait can consume a whole wake — that is the budget
// the watchdog fix restored), so flagging at 1× would cry wolf every time the bridge is busy. At 3× the
// signature is a trend rather than an incident. For scale, the outage this exists to catch ran 96 cycles.
const FEED_STALE_CYCLES = 3;

// The same factor for a floor read that timed out: the floor step is ALLOWED to time out once (the wake
// continues by design), so only a run of them is a state worth naming.
const FLOOR_UNREAD_CYCLES = 3;

const SEVERITY = { ok: 0, degraded: 1, bad: 2 };

// The registers, ordered by how loudly they should be said.
function assess(facts) {
  const f = facts || {};
  const cadence = Number(f.cadenceMin) > 0 ? Number(f.cadenceMin) : DEFAULT_WAKE_INTERVAL_MIN;
  const reasons = [];

  // 1. THE VENUE FEED. Absence of ticks at all is its own fact and must not read as "old".
  if (f.feedAgeMin == null) {
    reasons.push({ id: 'feed', status: 'bad', detail: 'no venue ticks at all — the capture has never stored one' });
  } else if (f.feedAgeMin > cadence * FEED_STALE_CYCLES) {
    reasons.push({
      id: 'feed', status: 'bad',
      detail: `venue feed ${fmtAge(f.feedAgeMin)} old — ${Math.floor(f.feedAgeMin / cadence)} missed capture cycles (${fmtAge(cadence)} cadence)`
        + (f.feedSymbol ? `; newest tick is ${f.feedSymbol}` : ''),
    });
  }

  // 2. THE CAPTURE'S OWN REPORT. A `captured: 0` row NEWER than the newest tick means the capture ran and
  // stored nothing — the starvation signature, and the one that names its cause (usually the lock holder).
  if (f.lastCapture && f.lastCapture.captured === 0 && f.lastCapture.atMs > (f.feedAtMs || 0)) {
    reasons.push({
      id: 'capture', status: 'bad',
      detail: `last capture stored 0 ticks${f.lastCapture.reason ? ` — ${f.lastCapture.reason}` : ''}`,
    });
  }

  // 3. THE DISASTER FLOOR. The desk's only automatic drawdown guard, and one that fails OPEN (the wake
  // continues). It is a telemetry row today; a run of them means the desk is unprotected right now.
  if (f.floorUnreadAgeMin != null && f.floorUnreadAgeMin <= cadence * FLOOR_UNREAD_CYCLES) {
    reasons.push({
      id: 'floor', status: 'degraded',
      detail: `disaster floor unreadable ${fmtAge(f.floorUnreadAgeMin)} ago — the wake continued without it (equity is NOT being monitored)`,
    });
  }

  // 4. DECLARED CADENCE. Processes that report their own schedule and then stop are the quietest failure
  // on the desk: nothing errors, a gate simply never opens again.
  for (const s of (Array.isArray(f.stoppedProcesses) ? f.stoppedProcesses : [])) {
    reasons.push({ id: 'cadence', status: 'degraded', detail: `${s.name} has not run since ${s.ageText} (declared ${s.cadence})` });
  }

  const state = reasons.reduce((acc, r) => (SEVERITY[r.status] > SEVERITY[acc] ? r.status : acc), 'ok');
  return { state, reasons, cadenceMin: cadence, feedAgeMin: f.feedAgeMin == null ? null : f.feedAgeMin };
}

function fmtAge(min) {
  if (min == null) return '?';
  if (min < 1) return '<1m';
  if (min < 90) return `${Math.round(min)}m`;
  if (min < 60 * 36) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

// The VERDICT as one word for the header chip. `fresh` is only reachable from `state: 'ok'`, which is the
// whole point of F32: the chip must not be able to say "fresh" about a desk that is not updating.
function chipText(verdict) {
  if (!verdict || verdict.state === 'ok') return null; // null = "no objection" — the caller keeps its own label
  const first = verdict.reasons[0];
  if (first && first.id === 'feed') {
    // An age that is not known must not be rendered as a number: "never captured a tick" and "16 hours
    // behind" are different facts, and a fabricated `0m` would be the reassurance F32 exists to remove.
    const age = verdict.feedAgeMin == null ? null : fmtAge(verdict.feedAgeMin);
    return age ? `STALE ${age}` : 'STALE';
  }
  return verdict.reasons.length ? `${verdict.reasons.length} data fault${verdict.reasons.length === 1 ? '' : 's'}` : 'DEGRADED';
}

// --- the facts (the only part that reads anything) ---------------------------

// F17 (2026-09-18, second pass): THE THRESHOLD IS NOT OURS TO INVENT.
//
// The first version derived its limit as 3 × the wake interval — a SCHEDULING number answering a question
// about DATA. The desk already owns the right number and states its meaning: `quant.js` exports
// `TICK_SLA_MS = 15 min` with the comment "a series older than this is NOT TRADABLE", and it is the SLA
// `pickTick` uses to decide whether a tick may price a decision at all. So the gate no longer carries a
// number of its own: it asks the ONE question quant already answers — how old is the price this decision
// used? — and measures it against that same line. The wake interval does not appear here at all now: a
// 15-minute-old price is too old to anchor an entry whether the desk wakes every 10 minutes or every hour.
//
// `risk.maxEntryTickAgeMin` stays as an OVERRIDE (a deliberate tightening or loosening by the owner), and
// an unset/malformed/zero value means "use quant's line", never an accidental zero that would disable the
// gate that exists to refuse exactly the entries F17 is about.
function entryFeedLimitMin(settings) {
  const named = Number(settings && settings.risk && settings.risk.maxEntryTickAgeMin);
  if (Number.isFinite(named) && named > 0) return named;
  return require('./quant').TICK_SLA_MS / 60000;
}

// The feed the desk reads to decide. Live/demo entries are Plus500 orders, so the VENUE feed is the one that
// matters — a fresh `yahoo_rest` fallback can mask a frozen venue and is exactly the state F1 described.
// The sim desk fills synthetically, so its "feed" is every source it has.
async function venueFeedAgeMin(userId, { venue = 'plus500' } = {}) {
  const t = await require('../store/ticks').newestTick(userId, { venue }).catch(() => null);
  return t ? ageMinOf(t.capturedAt || t.createdAt) : null;
}

// The gate's verdict, with the reason and the DETAIL an operator needs to act on it.
//
// TWO CHECKS, and the order is the point:
//   1. THE PRICE THE DECISION USED (per symbol, handed in by the caller). This is the sharp fact: the entry
//      is anchored to whatever price quant put in the snapshot, and `priceAgeSec` is that price's own age —
//      a tick's, or a BAR CLOSE's, which is why the gate needs no branch on the source. A fresh sibling
//      symbol cannot vouch for it.
//   2. THE VENUE FEED as a backstop, for a caller with no price facts and for a symbol quant never
//      evaluated. Deliberately coarser, and therefore deliberately second.
// A close is never gated: a position you cannot exit is worse than one you cannot enter.
async function entryGate(userId, settings, { symbol = null, priceSource = null, priceAgeSec = null } = {}) {
  const limitMin = entryFeedLimitMin(settings);
  const limitSec = limitMin * 60;

  if (priceAgeSec != null && priceAgeSec !== '') {
    const age = Number(priceAgeSec);
    if (!Number.isFinite(age) || age > limitSec) {
      const from = priceSource === 'bar_close' ? 'a bar close' : 'a tick';
      return {
        ok: false, reason: 'stale_price', ageSec: Number.isFinite(age) ? age : null, limitMin, priceSource,
        detail: `${symbol || 'the decision'} was priced from ${from} ${Number.isFinite(age) ? `${Math.round(age / 60)}m` : 'an unknown time'} old — over the ${limitMin}m not-tradable line (quant.TICK_SLA_MS)`,
      };
    }
    return { ok: true, ageSec: age, limitMin, priceSource };
  }

  const venue = (settings && settings.paper && settings.paper.enabled) ? null : 'plus500';
  const age = await venueFeedAgeMin(userId, { venue });
  if (age != null && age <= limitMin) return { ok: true, ageMin: age, limitMin };
  return {
    ok: false,
    reason: age == null ? 'no_feed' : 'stale_feed',
    ageMin: age,
    limitMin,
    detail: age == null
      ? `no ${venue || 'venue'} tick has ever been captured (limit ${limitMin}m)`
      : `${venue || 'newest'} feed is ${Math.round(age)}m old (limit ${limitMin}m)`,
  };
}

function ageMinOf(dateish) {
  if (!dateish) return null;
  const t = new Date(dateish).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

// `scripts` is optional and passed in by the route (the registry reads settings + a dozen event kinds);
// everything else is read here.
async function status(userId, settings, { scripts = null } = {}) {
  const cadenceMin = Math.max(1, Number(settings?.wake?.intervalMinutes) || DEFAULT_WAKE_INTERVAL_MIN);
  const ticks = require('../store/ticks');

  const [newest, lastCapEv, floorEv] = await Promise.all([
    // The VENUE feed specifically: `yahoo_rest`/`binance_rest` fallbacks can be fresh while the venue the
    // desk actually trades on is frozen — which is precisely the state F1 described, and the one a
    // source-agnostic check would have called healthy.
    ticks.newestTick(userId, { venue: 'plus500' }).catch(() => null),
    // The capture's own report is the only thing that NAMES why it stored nothing.
    store.latestEvent(userId, 'telemetry', { source: 'plus500_frontend' }).catch(() => null),
    store.latestEvent(userId, 'telemetry', { source: 'disaster_floor_unread' }).catch(() => null),
  ]);

  const stoppedProcesses = (Array.isArray(scripts) ? scripts : [])
    .filter((s) => s && s.overdue === true)
    .map((s) => ({ name: s.name, cadence: s.cadence, ageText: fmtAge(s.ageMin) }));

  return assess({
    cadenceMin,
    feedAgeMin: newest ? ageMinOf(newest.capturedAt || newest.createdAt) : null,
    feedAtMs: newest ? new Date(newest.capturedAt || newest.createdAt).getTime() : null,
    feedSymbol: newest ? newest.symbol : null,
    lastCapture: lastCapEv ? {
      captured: lastCapEv.payload && lastCapEv.payload.captured,
      reason: (lastCapEv.payload && lastCapEv.payload.reason) || null,
      atMs: new Date(lastCapEv.createdAt).getTime(),
    } : null,
    floorUnreadAgeMin: floorEv ? ageMinOf(floorEv.createdAt) : null,
    stoppedProcesses,
  });
}

module.exports = {
  assess, status, chipText, fmtAge, entryFeedLimitMin, venueFeedAgeMin, entryGate,
  DEFAULT_WAKE_INTERVAL_MIN, FEED_STALE_CYCLES, FLOOR_UNREAD_CYCLES,
};
