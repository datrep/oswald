// test/analytics-window.test.js — "this week" has to mean one thing, and the parameter that says so has to
// actually be used.
//
// ★ TWO DEFECTS THIS PINS, and the second is the one that was silently wrong for weeks:
//
//   1. `analytics.drift(userId)` took NO WINDOW and hardcoded `strategyStats(userId, { days: 30 })`, while
//      `routes.js` computed `days` from the query string and passed it in. So `/analytics/strategies?days=N`
//      validated N, clamped it, and then THREW IT AWAY — the dashboard card showed 30 days whatever was
//      requested, and every caller believed it had chosen. A parameter that is accepted and discarded is
//      worse than one that does not exist, because it reads like control.
//
//   2. `days` CANNOT EXPRESS A WEEK, and that is why `since` exists rather than a new default. `days` is a
//      rolling count and an INT all the way into SQL: on a Wednesday the elapsed part of the week is 2.02
//      days, and 2.02 truncates to 2 — a different window that still looks like a plausible number. The
//      failure mode of an absolute instant is a wrong instant, which is visible; the failure mode of a
//      rounded count is a number nobody can date.
//
// ★ AND WHY THE DEFINITION LIVES ON THE SERVER. A browser computing its own week boundary would disagree
//   with the desk's own weekly rhythms the moment a timezone or a clock differed, and both answers would
//   look right. `weekStartUtc` is the single definition, and it is pinned here against real dates.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { weekStartUtc } = require('../trading/agent/analytics');

// Comments stripped: a pin must match CODE, not the comment that explains the code (the TRD-68 lesson).
// `split(/\r?\n/)` — see the note in `activity.test.js`; splitting on `\n` alone leaves `\r` and the
// stripper silently does nothing on a CRLF checkout.
function codeOnly(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

// ── 1. The definition. Dates are checked against the calendar, not against the implementation. ────────
test('week-to-date starts MONDAY 00:00 UTC', () => {
  // 2026-09-23 is a Wednesday (2026-01-01 is a Thursday; 23 Sep is day 266, and 265 % 7 = 6).
  assert.equal(weekStartUtc(new Date('2026-09-23T00:28:34Z')).toISOString(), '2026-09-21T00:00:00.000Z');
  // ...and it truncates the TIME, not just the date.
  assert.equal(weekStartUtc(new Date('2026-09-23T23:59:59Z')).toISOString(), '2026-09-21T00:00:00.000Z');
});

test('a Monday maps to itself, and a Sunday maps BACK to the Monday of the week it closes', () => {
  assert.equal(weekStartUtc(new Date('2026-09-21T00:00:00Z')).toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(weekStartUtc(new Date('2026-09-21T12:00:00Z')).toISOString(), '2026-09-21T00:00:00.000Z');
  // Sunday 2026-09-27 belongs to the week that BEGAN Mon 21 Sep — which is the whole reason Monday-start was
  // chosen: the desk's pre-open runbook runs Sunday evening for the week that is about to trade.
  assert.equal(weekStartUtc(new Date('2026-09-27T23:00:00Z')).toISOString(), '2026-09-21T00:00:00.000Z');
  // ...and the following Monday starts a new one.
  assert.equal(weekStartUtc(new Date('2026-09-28T00:00:00Z')).toISOString(), '2026-09-28T00:00:00.000Z');
});

test('the boundary is UTC, not local — a local-midnight boundary would move with the machine', () => {
  // Whatever the machine's offset, 00:00Z on a Monday is the boundary. Asserted on the UTC fields the
  // function is documented to use, so this holds on any host clock.
  const ws = weekStartUtc(new Date('2026-09-23T00:28:34Z'));
  assert.equal(ws.getUTCDay(), 1, 'Monday');
  assert.equal(ws.getUTCHours(), 0);
  assert.equal(ws.getUTCMinutes(), 0);
  assert.equal(ws.getUTCSeconds(), 0);
  assert.equal(ws.getUTCMilliseconds(), 0);
});

test('every day of a week resolves to the same Monday', () => {
  const starts = ['21', '22', '23', '24', '25', '26', '27'].map((d) =>
    weekStartUtc(new Date(`2026-09-${d}T13:00:00Z`)).toISOString());
  assert.equal(new Set(starts).size, 1, `all seven days must share one start, got ${[...new Set(starts)].join(', ')}`);
  assert.equal(starts[0], '2026-09-21T00:00:00.000Z');
});

// ── 2. The window is a parameter and it is actually used. ─────────────────────────────────────────────
test('★ drift takes a window instead of hardcoding one', () => {
  const src = codeOnly('trading/agent/analytics.js');
  assert.match(src, /async function drift\(userId, \{ days = 30, since = null \} = \{\}\)/,
    'the window must arrive as a parameter');
  assert.match(src, /const stats = await strategyStats\(userId, \{ days, since \}\);/,
    'and it must be PASSED DOWN — the original defect was that it was accepted and then discarded');
  // The exact shape of the old bug, pinned as a negative so a regression is a named failure.
  assert.doesNotMatch(src, /strategyStats\(userId, \{ days: 30 \}\)/,
    'a hardcoded window here makes every caller a liar about what it measured');
});

test('★ the route resolves the window and reports which one it ran', () => {
  const src = codeOnly('trading/routes.js');
  assert.match(src, /analytics\.drift\(req\.user\.userID, \{ days, since \}\)/,
    'the route must forward the resolved window rather than a bare days count');
  assert.match(src, /analytics\.weekStartUtc\(\)/, 'week-to-date must use the single server-side definition');
  // The response carries the mode, so a number can never be read against the wrong window.
  assert.match(src, /mode: wantWeek \? 'week_to_date'/);
});

test('★ the store prefers an absolute `since` over a rolling count', () => {
  const src = codeOnly('trading/store.js');
  assert.match(src, /if \(since\) \{/, 'since must win when provided');
  assert.match(src, /where \+= ' AND closeAt >= @since'/, 'and it must be an absolute bound, not a count');
});

test('★ the dashboard asks for the week, and NAMES the window on the card', () => {
  const src = codeOnly('trading/public/js/app.js');
  assert.match(src, /apiGet\('\/api\/trading\/analytics\/strategies\?week=1'\)/,
    'the card must request the week window');
  assert.match(src, /win rate — \$\{esc\(winLabel\)\}/,
    'and it must PRINT the window: a win rate with no window attached is read as whatever the reader assumed');
});
