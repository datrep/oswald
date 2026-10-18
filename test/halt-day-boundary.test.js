// test/halt-day-boundary.test.js — L5 (rev 5, 2026-09-29): which DAY a daily-loss halt belongs to.
//
// ★ THE DEFECT THIS PINS. `dayStartEquity` keyed the halt on `new Date().toISOString().slice(0, 10)` — the UTC
// calendar date — and **UTC midnight falls INSIDE a live session.** So one session spans two halt-days, and the
// halt RESETS MID-SESSION: a desk can take its day's loss at 23:00 UTC, be handed a fresh baseline at 00:00 UTC,
// and carry on trading the same session with the control lifted. The desk's trading day is the VENUE's, which
// opens and closes at 21:00 UTC (Fri 21:00 close → Sun 21:00 open).
//
// ★ AND WHY THE DEFAULT DOES NOT MOVE. `minuteOfDayUtc = 0` reproduces the existing behaviour EXACTLY, so this
// change makes the anchor a STATED value rather than a silent one. Which anchor the halt uses is a risk
// decision — measured, the two differ only between 21:00 UTC and midnight, so the session anchor is stricter
// for 21 hours of the day and looser for the three after the venue's close. That belongs to the owner.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { dayKeyAt, DEFAULT_FUNDING_MINUTE_UTC } = require('../trading/agent/time');
const store = require('../trading/store');
const { code } = require('./_source');

const VENUE = DEFAULT_FUNDING_MINUTE_UTC; // 21:00 UTC

test('minute 0 IS the legacy behaviour — the anchor is made explicit, not changed', () => {
  // Every assertion here is the old `toISOString().slice(0, 10)`, including both sides of a midnight.
  const at = (iso) => dayKeyAt(new Date(iso), 0);
  assert.equal(at('2026-09-29T00:00:00Z'), '2026-09-29');
  assert.equal(at('2026-09-29T23:59:59Z'), '2026-09-29');
  assert.equal(at('2026-09-29T04:18:18Z'), '2026-09-29');
  // And the signature default is 0, so a caller that forgets the argument gets the old behaviour.
  assert.equal(dayKeyAt(new Date('2026-09-29T04:18:18Z')), '2026-09-29');
});

test('★★ THE DEFECT AND THE FIX, on one pair of instants straddling UTC midnight', () => {
  const before = new Date('2026-09-28T23:30:00Z');
  const after = new Date('2026-09-29T00:30:00Z');
  // THE DEFECT: two instants an hour apart, IN THE SAME SESSION, land in different halt-days. The baseline the
  // desk was halted against is discarded and a fresh one is taken while the market is open.
  assert.notEqual(dayKeyAt(before, 0), dayKeyAt(after, 0), 'UTC midnight splits a live session in two');
  // THE FIX: anchored to the venue's own boundary they are the SAME halt-day, because no session boundary has
  // been crossed between them.
  assert.equal(dayKeyAt(before, VENUE), dayKeyAt(after, VENUE));
  assert.equal(dayKeyAt(after, VENUE), '2026-09-28', 'the day is named by the session it opened, not the date it ran into');
});

test('★ the session anchor changes EXACTLY at the venue boundary, and nowhere else in the day', () => {
  // Walk from the boundary over 24h INCLUSIVE of the next boundary — 49 steps of 30 minutes — and require exactly
  // two keys, changing only on the final step. A 48-step walk would be one whole halt-day and must NOT change at
  // all, which is the stronger claim and is asserted first.
  const start = Date.parse('2026-09-28T21:00:00Z');
  const within = [];
  for (let i = 0; i < 48; i += 1) within.push(dayKeyAt(new Date(start + i * 1800000), VENUE));
  assert.deepEqual([...new Set(within)], ['2026-09-28'],
    'a full halt-day must be ONE key — that is what "one session, one halt-day" means');
  // Including the next boundary: exactly one change, on the last step.
  const across = [...within, dayKeyAt(new Date(start + 48 * 1800000), VENUE)];
  assert.deepEqual([...new Set(across)], ['2026-09-28', '2026-09-29']);
  assert.equal(across[47], '2026-09-28', 'unchanged one step before the boundary');
  assert.equal(across[48], '2026-09-29', 'and changed ON it');
  // The instant either side of 21:00 UTC.
  assert.equal(dayKeyAt(new Date('2026-09-28T20:59:59Z'), VENUE), '2026-09-27');
  assert.equal(dayKeyAt(new Date('2026-09-28T21:00:00Z'), VENUE), '2026-09-28');
});

test('and the UTC anchor crosses 24 times a day by contrast — which is the point', () => {
  // Non-vacuity for the test above: the same walk on the legacy anchor also crosses once (it is a daily boundary
  // too), but it crosses at MIDNIGHT, i.e. mid-session. Pin the instant, not just the count.
  assert.equal(dayKeyAt(new Date('2026-09-28T23:59:59Z'), 0), '2026-09-28');
  assert.equal(dayKeyAt(new Date('2026-09-29T00:00:00Z'), 0), '2026-09-29');
  // ...whereas the venue anchor is unmoved at both.
  assert.equal(dayKeyAt(new Date('2026-09-28T23:59:59Z'), VENUE), '2026-09-28');
  assert.equal(dayKeyAt(new Date('2026-09-29T00:00:00Z'), VENUE), '2026-09-28');
});

test('★ an unusable instant or minute gives a SAFE answer, never a random boundary', () => {
  // An unusable MINUTE falls back to midnight — the long-standing behaviour — never to an arbitrary hour.
  for (const k of [0, -1, 1440, 5000, NaN, null, undefined, 'abc']) {
    assert.equal(dayKeyAt(new Date('2026-09-29T04:18:18Z'), k), '2026-09-29', `minute ${JSON.stringify(k)}`);
  }
  // An unusable INSTANT is null, never today's date: a silent "today" would hand the halt a baseline it never read.
  for (const bad of ['not a date', null, undefined, NaN, '']) {
    assert.equal(dayKeyAt(bad, VENUE), null, `instant ${JSON.stringify(bad)}`);
  }
  // ⚠ AND THE ONE THAT NEEDS ITS OWN GUARD: `new Date(null)` IS 1970-01-01 — a finite timestamp — so an
  // `isFinite(getTime())` check cannot see it, and a null instant would become a halt-day at the EPOCH rather than
  // an unknown. This is the repo's oldest trap (`Number(null) === 0`) wearing a second coat.
  assert.equal(new Date(null).getTime(), 0, 'precondition: the trap is real, and finite');
  assert.equal(dayKeyAt(null, 0), null, 'a null instant is UNKNOWN, not the epoch');
  assert.notEqual(dayKeyAt(null, VENUE), '1970-01-01');
});

test('★ the anchor resolver defaults to the LEGACY behaviour, and only one value moves it', () => {
  assert.match(code('trading/agent/risk.js'), /return r\.dailyHaltAnchor === 'venue_session' \? DEFAULT_FUNDING_MINUTE_UTC : 0;/);
  assert.equal(DEFAULT_FUNDING_MINUTE_UTC, 1260, 'the venue boundary is 21:00 UTC');
  // The setting is PRESENT in the defaults, and it is the legacy value — an absent key must not be able to move a
  // risk boundary, and a reader must be able to see which anchor is in force without opening the code.
  assert.equal(store.DEFAULT_SETTINGS.risk.dailyHaltAnchor, 'utc_midnight');
});

test('★ the baseline RECORDS which anchor produced it', () => {
  // A baseline without its anchor cannot be re-derived, and a study comparing two eras could not tell which
  // boundary produced which halt-day. The row carries it.
  const src = code('trading/agent/risk.js');
  assert.match(src, /logEvent\(userId, 'day_start', \{[^}]*anchorMinuteUtc/s);
  // And `dayStartEquity` must not compute its own date any more — the boundary has exactly one home.
  const fn = src.slice(src.indexOf('async function dayStartEquity'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(body),
    'the inline UTC-midnight date is what made the anchor invisible; it must not come back');
  assert.match(body, /dayKeyAt\(new Date\(\), anchorMinuteUtc\)/);
});
