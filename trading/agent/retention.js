// trading/agent/retention.js — TRD-92 (2026-09-21): the tick retention window, resolved in ONE place.
//
// WHAT WAS WRONG. `agent/bars.js` carried `{ tickDays = 7 }` as an options default and `store/bars.js`
// carried `Math.max(1, Number(days) || 7)` as a second one — two silent sevens, in two files, and every
// caller passed nothing. `0`, `'abc'`, `NaN` and `null` each became "7 days" with nothing recorded, which
// is the same defect class TRD-109 (a fail-open chain) and TRD-111 (`undefined` is not `null` on a safety
// path) were closed for: a control that is not doing what it says, silently.
//
// WHY IT MATTERS HERE. Retention is not housekeeping. The 2026-09-19 excursion work was bounded by it
// ("measure now or lose it"), and TRD-108's backfill had to leave 21 autopsies on a level-derived number
// because the tick path behind them had aged out. A window that is silently not the window you configured
// is how that stays invisible.
//
// SO THIS MODULE NEVER SUBSTITUTES SILENTLY. It returns the value it used, the value it was ASKED for, and
// why they differ — `refused: true` marks the "a value was present and unusable" case, which is reported
// rather than repaired in the dark. The distinction is deliberate: `undefined` means UNSET (the default is
// the answer), while `0` / `'abc'` / `-3` mean MISCONFIGURED (the default is a fallback that must be said
// out loud). Collapsing those two into one branch is exactly the bug this file exists to end.
//
// THE WINDOW IS BOUNDED ON PURPOSE. Measured 2026-09-21: 19,761 rows / ~1.9 MB over exactly 7 days, so 90
// days is ~25 MB and a long window is genuinely cheap. But an unbounded one is a way to fill a disk from a
// settings field — `MAX_TICK_DAYS` is wide enough to hold that arithmetic and narrow enough that no value
// can be a typo for "forever".
'use strict';

const DEFAULT_TICK_DAYS = 7;
const MIN_TICK_DAYS = 1;
// 10 years. The point is not that anyone wants it; the point is that a value above it is a typo, not a policy.
const MAX_TICK_DAYS = 3650;

function refuse(asked, why) {
  return {
    days: DEFAULT_TICK_DAYS,
    asked: asked === undefined ? null : asked,
    source: 'refused',
    refused: true,
    note: `retention.tickDays = ${JSON.stringify(asked)} was REFUSED (${why}) — using ${DEFAULT_TICK_DAYS} days. A window is the only safe direction to fall back on: not pruning grows the table, and 0 would delete the ticks every reader depends on.`,
  };
}

// `asked` is whatever the settings blob held (or an explicit override), `origin` says which of those it was
// — a settings value reported as an `override` would be one more number that does not mean what it says.
// Returns: { days, asked, source, refused, note }
// source: 'default' (nothing configured) | 'settings' | 'override' | 'refused'
function resolveTickDays(asked, origin = 'settings') {
  if (asked === undefined || asked === null) {
    return { days: DEFAULT_TICK_DAYS, asked: null, source: 'default', refused: false, note: null };
  }
  const src = origin === 'settings' ? 'settings' : 'override';
  if (typeof asked === 'string') {
    if (asked.trim() === '') return refuse(asked, 'an empty string is present but carries no value');
    const n = Number(asked.trim());
    if (!Number.isFinite(n)) return refuse(asked, `"${asked}" is not a number`);
    return fromNumber(n, asked, src);
  }
  if (typeof asked !== 'number') return refuse(asked, `a ${typeof asked} is not a number of days`);
  if (!Number.isFinite(asked)) return refuse(asked, `${String(asked)} is not a finite number`);
  return fromNumber(asked, asked, src);
}

function fromNumber(n, asked, source) {
  if (n < MIN_TICK_DAYS) {
    return refuse(asked, n === 0
      ? '0 would delete every tick including the ones the current wake is reading'
      : `${n} is below the ${MIN_TICK_DAYS}-day minimum`);
  }
  const days = Math.floor(n);
  if (days > MAX_TICK_DAYS) {
    return {
      days: MAX_TICK_DAYS, asked, source: 'refused', refused: true,
      note: `retention.tickDays = ${n} exceeded the ${MAX_TICK_DAYS}-day ceiling — clamped. Above this a value is a typo, not a policy.`,
    };
  }
  return {
    days, asked, source, refused: days !== n,
    note: days !== n ? `retention.tickDays = ${n} was floored to ${days} (whole days).` : null,
  };
}

module.exports = { resolveTickDays, DEFAULT_TICK_DAYS, MIN_TICK_DAYS, MAX_TICK_DAYS };
