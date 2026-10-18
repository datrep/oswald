// trading/agent/time.js — TRD-25: calendar-true swap nights. TRD-49: whose calendar.
// The venue bills overnight funding per NIGHT CROSSED — but the crossing is of the "Overnight
// funding time" it publishes per instrument (5:00 AM for the Gold chain), NOT of UTC midnight. Both
// counts live here so a caller can only be wrong on purpose:
//   nightsBetween()            UTC midnights, the original TRD-25 model. Still the legacy count, and
//                              still what an unseeded symbol gets on a backtest.
//   crossingsOfDailyInstant()  the venue's real rule, given the clock as a UTC minute.
//   nightsFor()                the one callers should use: the clock when they have it, midnight
//                              only when they say they do not.
// The historical strategy formula (round(barsHeld/24)) was a THIRD model and assumed 24 bars per day:
// wrong on any other timeframe (24x undercharge on daily bars) and approximate even on 1h for non-24h
// markets (Gold ~15.6 bars/day => ~35% undercharge).
'use strict';

const DAY_MS = 86400000;

// Number of UTC day boundaries crossed between entry and exit.
// Same-day holds -> 0. 10 full days -> 10. Reversed/equal times -> 0.
function nightsBetween(entryTime, exitTime) {
  const e = new Date(entryTime).getTime();
  const x = new Date(exitTime).getTime();
  if (!Number.isFinite(e) || !Number.isFinite(x) || x <= e) return 0;
  return Math.max(0, Math.floor(x / DAY_MS) - Math.floor(e / DAY_MS));
}

// CROSSINGS OF A DAILY INSTANT — the venue's actual billing rule.
//
// 2026-09-14 (TRD-45 Phase 3). `nightsBetween` above counts UTC MIDNIGHTS, and the funding validator
// caught it being wrong on the very first real row it could test: Trades #29 (Oil buy, opened
// 2026-09-10 18:02 UTC, closed 22:00 UTC) is charged 0.31, but crosses ZERO UTC midnights, so the
// model predicted a free hold and reported a defect that was not there.
//
// The venue does not bill at midnight. It publishes an "Overnight funding time" per instrument
// (5:00 AM for the Gold chain; a fact Phase 1 captured and nothing consumed) and charges once per
// crossing of THAT clock time. Re-scored against it, all eleven venue-charged rows agree, including
// the two that are impossible under the midnight rule:
//   #29   02:02 -> 06:00 SGT crosses 05:00 once -> charged 0.31
//   #1027 03:10 -> 13:46 SGT crosses 05:00 once -> charged 0.12   (midnight rule coincidentally
//                                                                  also gave 1)
// and the option #1 crosses 05:00 once but is charged nothing, because the venue states 0.0000%
// funding on BOTH sides of an option — which is why a night count alone can never be the whole test.
//
// `minuteOfDayUtc` is the funding instant expressed in UTC minutes (05:00 Singapore = 21:00 UTC =
// 1260). Passing it in rather than a timezone keeps this function pure and testable; the caller owns
// the local-to-UTC conversion, because THAT is the assumption worth stating out loud.
function crossingsOfDailyInstant(entryTime, exitTime, minuteOfDayUtc) {
  const e = new Date(entryTime).getTime();
  const x = new Date(exitTime).getTime();
  if (!Number.isFinite(e) || !Number.isFinite(x) || x <= e) return 0;
  const k = Number(minuteOfDayUtc);
  if (!Number.isFinite(k) || k < 0 || k >= 1440) return nightsBetween(entryTime, exitTime);
  const offset = k * 60000;
  // The first instant at or after entry that sits on the daily instant.
  const first = Math.ceil((e - offset) / DAY_MS) * DAY_MS + offset;
  if (first >= x) return 0;
  return Math.floor((x - 1 - first) / DAY_MS) + 1;
}

// Local clock time -> UTC minutes-of-day. Separate from the counter above so the timezone assumption
// has exactly one home, and so a wrong assumption is one number to change rather than a formula.
function fundingMinuteUtc({ hourLocal = 5, minuteLocal = 0, utcOffsetMinutes = 480 } = {}) {
  const total = hourLocal * 60 + minuteLocal - utcOffsetMinutes;
  return ((total % 1440) + 1440) % 1440;
}

// The venue's DEFAULT overnight-funding clock, as the argument defaults above define it: 05:00
// Singapore = 21:00 UTC = 1260. Lives here as a named constant so "we did not know this instrument's
// own funding time" is a value a caller can point at and a provenance line can print, rather than a
// silent fall-through to the argument defaults.
const DEFAULT_FUNDING_MINUTE_UTC = fundingMinuteUtc(); // 1260

// ★ L5 (2026-09-29) — WHICH "DAY" AN INSTANT BELONGS TO, when a day does not start at midnight.
//
// `dayStartEquity` keyed the daily-loss halt on `new Date().toISOString().slice(0, 10)` — the UTC calendar
// date — and **UTC midnight falls INSIDE a live session.** So one session spanned two halt-days and the halt
// RESET MID-SESSION: the desk could take its day's loss at 23:00 UTC, be handed a fresh baseline an hour later,
// and keep trading the same session with the control lifted. The desk's trading day is the VENUE's, which opens
// and closes at 21:00 UTC (Fri 21:00 close to Sun 21:00 open) — the same clock `DEFAULT_FUNDING_MINUTE_UTC`
// names, and the same instant the venue bills carry by.
//
// ⚠ `minuteOfDayUtc = 0` reproduces the EXISTING behaviour EXACTLY, and that is why 0 is the default: this
// function makes the anchor a STATED value rather than silently changing it. Which anchor the halt uses is a
// risk decision (§L5 iii), and it is carried by `risk.dailyHaltAnchor`.
function dayKeyAt(instant, minuteOfDayUtc = 0) {
  // ⚠ REJECT NULLISH BEFORE CONSTRUCTING THE DATE. `new Date(null)` is **1970-01-01** — a FINITE timestamp — so an
  // `isFinite(getTime())` guard cannot see it, and an absent instant would be filed as a halt-day at the epoch
  // rather than as UNKNOWN. This is the repo's own oldest trap (`Number(null) === 0` wearing a second coat);
  // `new Date(undefined)` and `new Date('')` are genuinely Invalid, so `null` is the only one needing the guard.
  if (instant == null || instant === '') return null;
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(t)) return null;
  const k = Number(minuteOfDayUtc);
  // An unusable minute is MIDNIGHT rather than a throw, matching `crossingsOfDailyInstant` above: the fallback
  // is the long-standing behaviour, so a bad value cannot quietly move the boundary to an arbitrary hour.
  const offset = (Number.isFinite(k) && k > 0 && k < 1440 ? k : 0) * 60000;
  return new Date(t - offset).toISOString().slice(0, 10);
}

// The venue publishes the funding time as display text ('5:00 AM'; '--' when an instrument carries
// none). This parser used to live in funding.js, which left the cost model unable to read the same
// text without importing the validator. It moved here because BOTH the validator (does this match what
// was charged?) and the cost model (what will this cost to hold?) are answering questions about one
// clock, and two parsers of one format is how they drift. funding.js re-exports it so its own
// consumers are unchanged.
function parseFundingTimeLocal(text) {
  const m = String(text == null ? '' : text).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) hh += 12;
  return { hour: hh, minute: Number(m[2]) };
}

// Display text -> UTC minutes-of-day, or null when the venue states no time (which is UNKNOWN, and is
// not midnight — the distinction `--` exists to protect).
function fundingMinuteFromText(text, { utcOffsetMinutes = 480 } = {}) {
  const p = parseFundingTimeLocal(text);
  if (!p) return null;
  return fundingMinuteUtc({ hourLocal: p.hour, minuteLocal: p.minute, utcOffsetMinutes });
}

// THE COUNT EVERY COST PATH SHOULD USE. One function so the question "how many nights is this hold
// charged for?" has one answer, instead of the four that were in the tree (midnight in the seven
// strategies, midnight in paper.js, midnight in the two close writers, the clock in the validator).
//
//   swapClockMinuteUtc = a number -> the venue's clock (the only rule the venue actually bills by).
//   null / undefined             -> the legacy UTC-midnight count, chosen DELIBERATELY by a caller
//                                   that has no venue clock (an unseeded or non-venue symbol).
//
// The legacy branch is not a fallback for a bug: it is what keeps an unseeded backtest numerically
// identical to the run that produced any stored number, which is why `costModelBasis.swapClock`
// records which branch was taken and the swaps are versioned in backtest.js. `== null` catches both
// null and undefined on purpose — "no clock" is one idea, and an absent field and an explicit null
// must not mean two different things (the failure mode this codebase keeps re-learning).
function nightsFor(entryTime, exitTime, swapClockMinuteUtc) {
  if (swapClockMinuteUtc == null) return nightsBetween(entryTime, exitTime);
  const k = Number(swapClockMinuteUtc);
  if (!Number.isFinite(k)) return nightsBetween(entryTime, exitTime);
  return crossingsOfDailyInstant(entryTime, exitTime, k);
}

module.exports = {
  nightsBetween,
  crossingsOfDailyInstant,
  fundingMinuteUtc,
  DEFAULT_FUNDING_MINUTE_UTC,
  dayKeyAt,
  parseFundingTimeLocal,
  fundingMinuteFromText,
  nightsFor,
};
