// test/tick-freshness-grading.test.js — TRD-67, 2026-09-19.
//
// THE ROW: "tick staleness is graded warn, so a 2h26m dead feed never paged". Confirmed live the same day
// — every market feed in `PriceTicks` measured **702 minutes** dead (the Plus500 weekend close) and the
// board still said `warn`, with a detail whose worst-named symbol was a *different* feed entirely
// ("Brent Oil 3547m") and whose first bucket ("1 ≤15m") was the position-rate poll, not a market feed.
//
// THE TRAP IN THE OBVIOUS FIX: raise the grade and the desk pages every weekend, because silence is
// CORRECT when the venue is shut. The desk reads its own calendar (`sessionFeed.isOpen`), so the grade is
// decided per symbol against the venue, and an UNKNOWN session is not called dead — "we cannot tell" and
// "it is broken" are different facts, and only one of them should page at 3am.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const { deadFeedVerdict, tickSeverity, TICK_SLA_MIN } = require('../trading/agent/selfHealth');

test('★ the live case: a feed hours dead while the venue trades is DEAD, not warn', () => {
  assert.strictEqual(deadFeedVerdict({ mins: 702, open: true }), 'dead');
  assert.strictEqual(deadFeedVerdict({ mins: 146, open: true }), 'dead', 'the 2h26m case in the row');
  assert.strictEqual(tickSeverity(['dead']), 'bad');
});

test('stale-but-recent still warns — the grade was not raised for everything', () => {
  assert.strictEqual(deadFeedVerdict({ mins: 20, open: true }), 'stale');
  assert.strictEqual(tickSeverity(['stale']), 'warn');
  assert.strictEqual(deadFeedVerdict({ mins: 44, open: true }), 'stale', 'just under 3x the 15m line');
  assert.strictEqual(deadFeedVerdict({ mins: 45, open: true }), 'dead', 'at exactly 3x it flips');
});

test('★ a closed venue is neither stale nor dead — otherwise every weekend pages', () => {
  assert.strictEqual(deadFeedVerdict({ mins: 702, open: false }), 'venue_closed');
  assert.strictEqual(tickSeverity(['venue_closed', 'fresh']), 'ok');
  assert.strictEqual(tickSeverity(['venue_closed', 'venue_closed']), 'ok');
});

test('★ an UNKNOWN session is not called dead, and is not called healthy either', () => {
  assert.strictEqual(deadFeedVerdict({ mins: 702, open: null }), 'stale_unknown_session');
  assert.notStrictEqual(deadFeedVerdict({ mins: 702, open: null }), 'dead',
    'with no fresh session entry we cannot claim the venue is trading');
  assert.strictEqual(tickSeverity(['stale_unknown_session']), 'warn');
  assert.notStrictEqual(tickSeverity(['stale_unknown_session']), 'ok',
    'and it must not be silently healthy — that is how the original report went four days unnoticed');
});

test('never-captured is its own verdict and cannot dilute a dead feed', () => {
  assert.strictEqual(deadFeedVerdict({ mins: null, open: true }), 'never_captured');
  assert.strictEqual(tickSeverity(['never_captured']), 'warn');
  assert.strictEqual(tickSeverity(['never_captured', 'dead']), 'bad');
});

test('fresh is fresh whatever the venue says', () => {
  assert.strictEqual(deadFeedVerdict({ mins: 1, open: false }), 'fresh');
  assert.strictEqual(deadFeedVerdict({ mins: TICK_SLA_MIN, open: true }), 'fresh', 'the SLA boundary is inclusive');
  assert.strictEqual(tickSeverity(['fresh', 'fresh']), 'ok');
});

test('no input can throw, and an unreadable age is never graded a fault', () => {
  for (const bad of [undefined, {}, { mins: 'x' }, { mins: NaN, open: true }, { mins: Infinity }]) {
    const v = deadFeedVerdict(bad);
    assert.strictEqual(typeof v, 'string');
    assert.notStrictEqual(v, 'dead', `${JSON.stringify(bad)} must not be called dead`);
  }
  assert.strictEqual(tickSeverity(null), 'ok');
  assert.strictEqual(tickSeverity([]), 'ok');
});

test('the check consults the venue per symbol rather than grading the age alone', () => {
  const src = code('trading/agent/selfHealth.js');
  assert.match(src, /sessionFeed\.isOpen\(s\.symbol\)/);
  assert.match(src, /rows\.map\(\(r\) => deadFeedVerdict\(r\)\)/);
  assert.match(src, /tickSeverity\(verdicts\)/);
  assert.match(src, /venue-closed \(silence expected\)/, 'the detail must say why silence was not a fault');
});
