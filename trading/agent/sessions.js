// trading/agent/sessions.js — MarketSessionGuard (amendment A8).
// Instrument-calendar check BEFORE the waker builds a prompt:
//   closed     -> no wake at all (so no capture, no bars, no exits) — the venue is SHUT;
//   observation-> the 30-minute pre-open / post-close windows: the wake runs, SESSION_LOCK blocks
//                new entries, exits allowed;
//   open       -> normal. A scheduled macro event does NOT change the state: it rides along as
//                `scheduledEvents` and is handed to the deliberating chairs. See the note below.
'use strict';

// Default Plus500 CFD session: closed Fri 21:00 UTC -> Sun 21:00 UTC
// (plus SG/US holidays via CorporateEvents 'halt' rows, and scheduled macro
// events via 'macro' rows).
const DEFAULT_CALENDAR = {
  weekend: { closeDay: 5, closeHour: 21, openDay: 0, openHour: 21 }, // Fri 21:00 -> Sun 21:00 UTC
  observationMinutes: 30,
};

function utcParts(now) {
  return { day: now.getUTCDay(), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
}

// ---------------------------------------------------------------------------------------------------
// A SCHEDULED EVENT IS INFORMATION, NOT A LOCK (revised 2026-09-15).
//
// HISTORY, because the revision matters more than the endpoint. An FOMC meeting day was stored as a
// `halt` row with symbol='*', and this file read that as `state:'closed'` — so the session guard skipped
// the ENTIRE wake. On 2026-09-15 the desk stopped trading from 12:24Z to at least 13:52Z (19 consecutive
// skipped wakes) while the market was open, and recorded the reason as "all venues closed".
//
// The first fix split the meanings and added a `no_entry` state that ran the wake and blocked entries.
// That was still wrong, and the owner asked the right question: WHY should an FOMC day bar entries at
// all? The honest answer is that nobody decided it. The rule came from a comment in `calendar.js`
// asserting "global halt for NEW entries", and it was never measured, never scoped, and — decisively —
// it BLOCKED THE DELIBERATION: with entries removed before the committee was convened, `llmCalled` was
// false, so a signal was dropped with no rationale, no sizing and no risk-gate result. A desk built a
// committee to weigh context and then prevented it from seeing the context.
//
// So the event does not change the state at all. It is attached as `scheduledEvents`, carried through
// the aggregate, and printed into the chair prompt — where an entity that can reason about "FOMC
// statement at ~18:00 UTC" applies it per instrument instead of a wildcard row applying it to
// everything for 48 hours. The `macro` event type and the whole lookup survive; only the veto is gone.
//
// WHAT STILL LOCKS: the `observation` window, which is a different rule with a different justification
// (do not open a position minutes before a weekend close) and was not what the owner questioned.
const ENTRY_LOCK_STATES = ['observation'];
const isEntryLocked = (state) => ENTRY_LOCK_STATES.includes(state);

// The corporate events that can change what the desk may DO today. Fetched in ONE query and split by
// type, because they are two different kinds of fact: a `halt` closes the venue, a `macro` is context.
const DECISION_EVENT_TYPES = ['halt', 'macro'];

async function eventsForToday(userId, symbol, venue, now) {
  const { getPool, sql } = require('../db');
  const pool = await getPool();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const r = await pool.request()
    .input('userId', sql.Int, userId)
    .input('symbol', sql.NVarChar(64), symbol)
    .input('venue', sql.NVarChar(32), venue)
    .input('today', sql.Date, today)
    .query(`SELECT symbol, eventType, note FROM CorporateEvents
            WHERE userId = @userId AND venue = @venue
              AND eventDate = @today
              AND eventType IN ('halt','macro')
              AND (symbol = @symbol OR symbol = '*')`);
  // Within a type a SYMBOL-SPECIFIC row outranks the '*' wildcard, so a real per-instrument halt is
  // never masked by a market-wide note. Across types there is no ranking to do here — `halt` and `macro`
  // answer different questions and are resolved in sessionState, where their precedence is visible.
  const pick = (type) => {
    const of = r.recordset.filter((row) => row.eventType === type);
    return of.find((row) => row.symbol === symbol) || of.find((row) => row.symbol === '*') || null;
  };
  return { halt: pick('halt'), macro: pick('macro') };
}

// closed | open | observation (pre/post open windows)
// CONSTRAINT: the day-arithmetic below is only correct for a CONTIGUOUS
// one-day weekend — openDay === (closeDay + 2) % 7 (shipped default:
// Fri 21:00 -> Sun 21:00 UTC). Any other shape (e.g. a Thursday close with
// Sunday open) would silently treat Fri/Sat as open; generalize the interval
// test before exposing the calendar in config.
function calendarState(now, calendar = DEFAULT_CALENDAR) {
  const { day, minutes } = utcParts(now);
  const { closeDay, closeHour, openDay, openHour } = calendar.weekend;
  const closeMin = closeHour * 60;
  const openMin = openHour * 60;
  const obs = calendar.observationMinutes || 30;

  const inWeekend = (day === closeDay && minutes >= closeMin) || (day === (closeDay + 1) % 7) || (day === openDay && minutes < openMin);
  if (inWeekend) {
    // pre-open: last `obs` minutes before open
    if (day === openDay && minutes >= openMin - obs) return 'observation';
    return 'closed';
  }
  // post-close: first `obs` minutes after Friday close
  if (day === closeDay && minutes >= closeMin - obs) return 'observation';
  return 'open';
}

// Session state for a symbol, in strict order of authority.
//
// ★ THE ORDER IS THE WHOLE DESIGN, and getting it wrong is what produced the 2026-09-15 outage in both
// directions. From most to least authoritative:
//
//   1. the VENUE saying it is closed        — it is the only thing that knows; nothing outranks it
//   2. the CALENDAR being closed            — the weekend, when the venue says nothing
//   3. a corporate HALT row                 — a closure claim, so trusted only when the venue is silent
//   4. open — with any scheduled MACRO events attached as CONTEXT, not as a veto
//
// (3) is deliberately below (1): the venue outranks a halt row. And `macro` is not in this list at all
// — it does not decide the state, so there is no order for it to be in. That is the revision of
// 2026-09-15: a lock that could be out-ranked by the venue was a lock nobody could reason about, and one
// that could not be out-ranked suppressed the deliberation the desk exists to run.
//
// The cost is one extra query per symbol per wake — no cache, deliberately: a cache here would be a
// second clock to be wrong about, and twelve small reads every ten minutes is not a load worth that.
async function sessionState(userId, symbol, venue = 'plus500', now = new Date()) {
  const feed = require('../plus500/sessionFeed');
  const v = feed.get(symbol);
  const ev = await eventsForToday(userId, symbol, venue, now).catch(() => null);

  // The day's scheduled events are attached to EVERY verdict below, so a caller cannot obtain the
  // session state without also obtaining the context that goes with it. A fact about today does not
  // change because the venue happens to be shut.
  const scheduled = (ev && ev.macro)
    ? [{ type: 'macro', note: ev.macro.note || 'scheduled event', scope: ev.macro.symbol || '*', source: 'corporate_event' }]
    : [];
  const done = (session) => (scheduled.length ? { ...session, scheduledEvents: scheduled } : session);

  // 1. The venue is the authority on its own session: it may know about a holiday neither the calendar
  //    nor any event row has heard of.
  if (v && v.isTraded === false) {
    const nextFrom = feed.nextOpenAt(symbol);
    return done({
      state: 'closed',
      detail: nextFrom ? `venue closed — next session ${nextFrom.toISOString()}` : 'venue closed',
      venue: v.current,
      next: v.next,
      now: now.toISOString(),
    });
  }
  // 2. The weekend.
  const cal = calendarState(now);
  if (cal === 'closed' || cal === 'observation') {
    return done({ state: cal, detail: 'plus500 calendar (Fri 21:00-Sun 21:00 UTC)', source: 'calendar', now: now.toISOString() });
  }
  // 3. A `halt` is a CLOSURE CLAIM, so it is only trusted when the venue has said nothing — the venue is
  //    the authority on its own session. When it IS trusted it outranks everything else here: an
  //    instrument the venue has suspended is CLOSED, and reporting a policy note in place of a closure is
  //    how a real halt would go unnoticed.
  const venueSaysOpen = !!(v && v.isTraded === true);
  if (ev && ev.halt && !venueSaysOpen) {
    return done({ state: 'closed', detail: `corporate halt: ${ev.halt.note || 'scheduled halt'}`, source: 'corporate_event', scope: ev.halt.symbol, now: now.toISOString() });
  }
  // 4. Open. A scheduled event is something to weigh, not a veto — see the note on ENTRY_LOCK_STATES.
  if (venueSaysOpen) {
    return done({ state: 'open', detail: 'venue session open', venue: v.current, now: now.toISOString() });
  }
  return done({ state: 'open', detail: 'market open', now: now.toISOString() });
}

// TRD-52: ONE reader for "is this instrument tradeable right now", because the two connectors answer
// in DIFFERENT SHAPES and a guard that reads only one of them is a guard that silently does nothing.
//   browser connector -> sessionFeed.get(): { isTraded: true|false|null, current, next }
//   paper connector   -> sessionState():      { state: 'open'|'closed'|'observation', detail }
// `executor.closeTrade` read `isTraded === false` alone, so on the sim desk the refusal could never
// fire — the exact "guard whose else-branch proceeds" shape this codebase keeps re-finding. Both
// shapes are read here, and an UNKNOWN answer is `closed: false` (allow) rather than a refusal:
// blocking a trade because the desk does not know the session would be a bigger intervention than the
// defect, and the same rule already governs the venue minimum in agent/instruments.js.
function sessionClosed(venue) {
  if (!venue || typeof venue !== 'object') return { closed: false, reason: 'session_unknown' };
  if (venue.isTraded === false) {
    return {
      closed: true,
      reason: 'venue_session_closed',
      nextOpenAt: isoOrNull(venue.next && venue.next.from),
    };
  }
  if (String(venue.state || '').toLowerCase() === 'closed') {
    return { closed: true, reason: 'calendar_session_closed', nextOpenAt: null, detail: venue.detail || null };
  }
  // `closed: false` for anything that is not a closure. The `observation` lock is enforced ONE level up,
  // at the decision (`aggregator`), precisely so that a lock can never trap an exit — and a scheduled
  // event is not a closure at all, so it does not reach this function.
  return { closed: false, reason: venue.isTraded === true ? 'venue_session_open' : 'session_open_or_unknown' };
}

// A guard must not be able to break the thing it guards. `new Date(x).toISOString()` THROWS a
// RangeError on an unparseable value, and the venue's `next.from` is NOT guaranteed to be ISO —
// sessionFeed runs it through its own local-date parser. An unusable timestamp becomes null, which is
// exactly how the caller already reads "open time unknown", so this cannot be mistaken for an answer.
function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------------------------------
// THE AGGREGATE. One verdict for the desk, from twelve per-symbol verdicts.
// ---------------------------------------------------------------------------------------------------
//
// ★ WHY THIS IS A FUNCTION AND NOT FOUR LINES INSIDE THE WAKE (2026-09-15). It used to be inline in
// wakePipeline, and it collapsed every per-symbol detail into the literal string "all venues closed".
// That single sentence is why the 2026-09-15 outage was invisible: the guard knew the reason
// (`corporate halt: FOMC meeting day (federalreserve.gov)`) and recorded something else, so the trail
// contained no evidence contradicting a wrong verdict. Extracted so the rule is testable on its own —
// a summary that discards its evidence is exactly the kind of code that should not sit inside a 900-line
// pipeline where the only way to test it is to run the whole wake.
//
// Precedence: all closed wins (nothing can trade); then an entry lock; then open. `scheduledEvents` are
// attached on EVERY path, because they are context rather than a verdict — the caller that gets the state
// always gets the event with it.
function aggregateSession(states = [], symbols = []) {
  const rows = states || [];
  const detail = (rows2) => [...new Set(rows2.map((s) => s && s.detail).filter(Boolean))].slice(0, 3).join(' · ');
  // Deduplicated by type+note: twelve symbols on one FOMC row are ONE event, and the chairs must not be
  // told about it twelve times any more than they should be told about it zero times.
  const scheduledEvents = [];
  const seen = new Set();
  for (const s of rows) {
    for (const e of (s && s.scheduledEvents) || []) {
      const key = `${e.type}:${e.note}`;
      if (seen.has(key)) continue;
      seen.add(key);
      scheduledEvents.push(e);
    }
  }
  // ★ FILTER-THEN-INDEX IS WRONG, and the first version of this did exactly that: `locked.filter(...)`
  // then `symbols[i]` reads the FIRST symbol, not the locked one. It reported the wrong instrument
  // whenever the locked symbol was not first in the watchlist, and a test passed by luck because the
  // locked symbol happened to be first in both arrays. Predicate over the ORIGINAL array, so the index
  // is the index.
  const symbolsWhere = (pred) => rows
    .map((s, i) => (pred(s) ? ((symbols[i] && symbols[i].symbol) || null) : null))
    .filter(Boolean);
  const withSymbols = (session) => ({
    ...session,
    ...(scheduledEvents.length
      ? { scheduledEvents, scheduledEventSymbols: symbolsWhere((s) => ((s && s.scheduledEvents) || []).length) }
      : {}),
    symbols: rows.map((s, i) => ({
      symbol: (symbols[i] && symbols[i].symbol) || null,
      state: (s && s.state) || 'unknown',
      detail: (s && s.detail) || null,
      source: (s && s.source) || null,
    })),
  });
  if (!rows.length) return withSymbols({ state: 'open', detail: 'no watchlist symbols' });

  const closed = rows.filter((s) => s.state === 'closed');
  const locked = rows.filter((s) => isEntryLocked(s.state));
  if (closed.length === rows.length) {
    // A single venue that names itself keeps its own sentence; several collapse to a summary that still
    // names them, rather than the bare assertion this used to be.
    return withSymbols({
      state: 'closed',
      detail: closed.length === 1 ? closed[0].detail : `all ${rows.length} venues closed — ${detail(closed)}`,
    });
  }
  if (locked.length) {
    return withSymbols({
      state: 'observation',
      detail: `${detail(locked)} — entries locked on ${locked.length} of ${rows.length} symbols, exits allowed`,
      lockedSymbols: symbolsWhere((s) => isEntryLocked(s.state)),
    });
  }
  return withSymbols({ state: 'open', detail: 'market open' });
}

module.exports = { calendarState, sessionState, aggregateSession, DEFAULT_CALENDAR, sessionClosed, ENTRY_LOCK_STATES, isEntryLocked, DECISION_EVENT_TYPES };
