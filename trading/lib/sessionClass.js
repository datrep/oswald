'use strict';
// trading/lib/sessionClass.js — 2026-10-18 (owner: "pooling, it is a separate class, we can separate it,
// while still being in the same era").
//
// THE RULE: weekend crypto trades are a SEPARATE SAMPLE CLASS inside the SAME era. No re-anchor, no erased
// window — just a stamp on every trade so any study can split the two cohorts on one column.
//
// THE BOUNDARY is the desk's own venue calendar (Fri 21:00 -> Sun 21:00 UTC, plus its observation windows),
// NOT a generic "Saturday/Sunday", because that is the calendar `sessionState` uses to decide when the desk
// may act. This module implements that window independently and a pin asserts it agrees with
// agent/sessions#calendarState across a full week of hourly samples — drift fails a test rather than
// silently inventing a different cohort.
const DEFAULT_WEEKEND = { closeDay: 5, closeHour: 21, openDay: 0, openHour: 21 };

/** 'weekend' when `now` falls inside the venue weekend window (incl. its observation minutes), else 'weekday'. */
function sessionClassOf(now = new Date(), weekend = DEFAULT_WEEKEND) {
  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const closeMin = weekend.closeHour * 60;
  const openMin = weekend.openHour * 60;
  const inWeekend = (day === weekend.closeDay && minutes >= closeMin)
    || day === (weekend.closeDay + 1) % 7
    || (day === weekend.openDay && minutes < openMin);
  return inWeekend ? 'weekend' : 'weekday';
}

module.exports = { sessionClassOf, DEFAULT_WEEKEND };
