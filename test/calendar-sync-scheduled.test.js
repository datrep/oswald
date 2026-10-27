// test/calendar-sync-scheduled.test.js — 2026-10-25.
//
// The defect this pins is not a wrong value. `agent/calendar.js` was CORRECT for six weeks and simply never
// ran: `importCalendar` had no scheduled caller, only a UI button and a route, so `CorporateEvents` still held
// two rows from 2026-09-15/16 when this was written. A test that only exercises the importer would have been
// green the whole time it was dead — which is exactly what happened, because the existing calendar tests all
// call `fomcRows` and `fetchFomcEvents` directly.
//
// So the assertions here are deliberately about two things a unit test can actually reach:
//   1. the SCHEDULE is wired into the boot block — checked on the raw source, the same way this repo pins
//      "the never-disconnect rule stays stated", because comments are stripped before the search;
//   2. the throttle's OFF switch short-circuits BEFORE any database call, so `enabled: false` is a real
//      opt-out rather than a flag that still costs a query every 30 minutes.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const cal = require('../trading/agent/calendar');
const REPORT_FILE = path.join(__dirname, '..', 'trading', 'server.js');

test('the calendar sync is started from the boot block (the exact thing that was missing)', () => {
  const raw = fs.readFileSync(REPORT_FILE, 'utf8');
  // Comments carry the rationale and must not be able to satisfy this on their own.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(/agent\/calendar'\)\.syncScheduled\(/.test(code),
    'server.js must call agent/calendar.syncScheduled from a timer — without it the importer is dead code, '
    + 'which is the state it was in from 2026-09-15 to 2026-10-25');
});

test('the throttle clock is its own event kind, so the schedule survives a restart', () => {
  assert.strictEqual(cal.SYNC_KIND, 'calendar_sync');
  // Named, not derived: a reader looking at TradingEvents has to be able to tell this row from news_digest.
  assert.ok(/^[a-z_]+$/.test(cal.SYNC_KIND));
  assert.notStrictEqual(cal.SYNC_KIND, 'halt');
});

test('enabled:false short-circuits before any database work', async () => {
  // If this touched the DB the test would need a connection; the point is that it returns immediately.
  const r = await cal.syncScheduled(1, { calendar: { enabled: false } });
  assert.deepStrictEqual(r, { skipped: 'disabled' });
});

test('a macro row is CONTEXT, not a lock — the meaning sessions.js was revised to', () => {
  // `halt` closes the venue; `macro` is information for the chairs. Writing the wrong one here is a
  // 2026-09-15 outage this file's header documents, so the value is pinned rather than assumed.
  assert.strictEqual(cal.EVENT_TYPE, 'macro');
  const rows = cal.fomcRows(1, [{ eventDate: '2026-10-28', note: 'FOMC meeting day' }]);
  assert.strictEqual(rows.length, 1);
  // [userId, symbol, venue, eventType, eventDate, note, source]
  assert.strictEqual(rows[0][1], '*');
  assert.strictEqual(rows[0][3], 'macro');
  assert.strictEqual(rows[0][4], '2026-10-28');
});
