// test/session-class.test.js — 2026-10-18 (feature `weekend-session-class`).
//
// Owner rule: weekend crypto is a SEPARATE SAMPLE CLASS inside the SAME era. The separator must be the
// desk's own venue calendar, not a generic weekend — otherwise a study splits cohorts by one rule while the
// desk gates trading by another, and the two drift silently.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sessionClassOf } = require('../trading/lib/sessionClass');
const sessions = require('../trading/agent/sessions');
const { code } = require('./_source');

test('the boundaries: Fri 21:00 UTC in, Sun 21:00 UTC out, observation included', () => {
  assert.equal(sessionClassOf(new Date('2026-10-16T20:59:00Z')), 'weekday', 'Friday just before the close');
  assert.equal(sessionClassOf(new Date('2026-10-16T21:00:00Z')), 'weekend', 'the close instant itself');
  assert.equal(sessionClassOf(new Date('2026-10-17T12:00:00Z')), 'weekend', 'Saturday');
  assert.equal(sessionClassOf(new Date('2026-10-18T20:45:00Z')), 'weekend', 'inside the pre-open observation window');
  assert.equal(sessionClassOf(new Date('2026-10-18T21:00:00Z')), 'weekday', 'the open instant');
  assert.equal(sessionClassOf(new Date('2026-10-19T09:00:00Z')), 'weekday', 'Monday');
});

test('★ agreement with the DESK calendar across a whole week — drift fails here, not in a study', () => {
  // 7 days, every 15 minutes. The relationship is an IMPLICATION PAIR, not equality with 'open': the
  // calendar's `observation` state is a LOCK, not a closure — the Friday 20:30-21:00 window is still
  // WEEKDAY time (entries are blocked, but the desk is inside the trading week), while the Sunday
  // 20:30-21:00 window is inside the weekend. Equality with 'open' would wrongly demand that the Friday
  // lock count as weekend.
  const start = new Date('2026-10-12T00:00:00Z'); // a Monday
  for (let i = 0; i < 7 * 24 * 4; i += 1) {
    const at = new Date(start.getTime() + i * 15 * 60 * 1000);
    const cal = sessions.calendarState(at);
    const cls = sessionClassOf(at);
    if (cal === 'closed') {
      assert.equal(cls, 'weekend', `calendar closed but class ${cls} at ${at.toISOString()}`);
    }
    if (cls === 'weekend') {
      assert.ok(cal === 'closed' || cal === 'observation',
        `weekend class outside the calendar's weekend at ${at.toISOString()} (calendar=${cal})`);
    }
    if (cal === 'open') {
      assert.equal(cls, 'weekday', `calendar open but class ${cls} at ${at.toISOString()}`);
    }
  }
});

test('★ the trade writer stamps the class at the ONE choke point', () => {
  const src = code('trading/store.js');
  assert.match(src, /sessionClassOf\(fields\.openAt \?\? new Date\(\)\)/,
    'createTrade must derive the class from the ENTRY time when the caller does not state it');
  assert.match(src, /INSERT INTO Trades \([^)]*sessionClass\)/s, 'the column is in the INSERT');
  assert.match(src, /@sessionClass\)/, 'and bound in the VALUES list');
});

test('the stamp is entry-time only — closing must not rewrite a trade into another cohort', () => {
  const src = code('trading/store.js');
  const updatable = /const updatable = \[([\s\S]*?)\];/.exec(src);
  assert.ok(updatable, 'updatable list present');
  assert.ok(!/sessionClass/.test(updatable[1]),
    'sessionClass must NOT be updatable: a close that re-stamped it would move trades between cohorts after the fact');
});
