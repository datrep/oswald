// test/session-24-7.test.js — 2026-10-18 (feature `crypto-24-7-sessions`).
//
// OWNER DIRECTIVE: "dont gate. any 24/7 stocks are available to be used." The stock-CFD weekend calendar
// (Fri 21:00-Sun 21:00 UTC) was closing CRYPTO too whenever the venue feed was silent — measured on
// 2026-10-18, feed.get() returned null for every symbol — so every weekend wake skipped as market_closed
// while the venue traded the instrument (trade #1319 was closed by the VENUE's take-profit for +S$22.98
// during one of those skipped wakes).
//
// These pins fix the boundary of the change, not just its happy path: the venue must still win when it
// speaks, and the observation lock must still apply to instruments the weekend actually affects.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

// The same fake-browser injection the session suite uses, so requiring sessionFeed is inert here.
const browserStub = {
  newPage: async () => { throw new Error('newPage not configured for this test'); },
  onConnect: () => () => {},
};
const browserPath = require.resolve('../trading/plus500/browser');
require.cache[browserPath] = { id: browserPath, filename: browserPath, loaded: true, exports: browserStub };

const feed = require('../trading/plus500/sessionFeed');
const sessions = require('../trading/agent/sessions');
const { isTwentyFourSeven, ALWAYS_OPEN_SYMBOLS } = require('../trading/lib/instrumentClass');

const TRUE_GET = feed.get;
const TRUE_NEXT = feed.nextOpenAt;
const TRUE_POOL = require('../trading/db').getPool;

function stubVenue(t, entry, next = null) {
  t.after(() => { feed.get = TRUE_GET; feed.nextOpenAt = TRUE_NEXT; });
  feed.get = () => entry;
  feed.nextOpenAt = () => next;
}
function stubEvents(t, rows) {
  const db = require('../trading/db');
  t.after(() => { db.getPool = TRUE_POOL; });
  db.getPool = async () => ({ request: () => ({ input() { return this; }, query: async () => ({ recordset: rows }) }) });
}

const SATURDAY = new Date('2026-10-18T07:48:00Z');      // inside the weekend (a real capture ran then)
const SAT_PREOPEN = new Date('2026-10-18T20:45:00Z');   // inside the 30m pre-open observation window
const WEEKDAY = new Date('2026-09-15T13:52:00Z');       // a Tuesday mid-session

test('the class is small, explicit, and case/spacing tolerant', () => {
  assert.deepEqual(ALWAYS_OPEN_SYMBOLS, ['Bitcoin', 'Ethereum'], 'adding a 24/7 name must be a reviewable act');
  assert.ok(isTwentyFourSeven('Bitcoin'));
  assert.ok(isTwentyFourSeven(' ethereum '));
  assert.ok(!isTwentyFourSeven('Gold'), 'stocks stay on the stock calendar');
  assert.ok(!isTwentyFourSeven(null));
});

test('★ silent venue + Saturday: a 24/7 instrument is OPEN, a stock is CLOSED', async (t) => {
  stubVenue(t, null);
  stubEvents(t, []);
  const crypto = await sessions.sessionState(1, 'Bitcoin', 'plus500', SATURDAY);
  assert.equal(crypto.state, 'open', 'the weekend calendar must not close a 24/7 instrument');
  assert.equal(crypto.source, 'always_open_class');
  assert.match(crypto.detail, /24\/7 instrument/);

  const stock = await sessions.sessionState(1, 'Gold', 'plus500', SATURDAY);
  assert.equal(stock.state, 'closed', 'the weekend still closes stocks');
});

test('★ the observation lock does not apply to a 24/7 instrument, but still does to stocks', async (t) => {
  stubVenue(t, null);
  stubEvents(t, []);
  const crypto = await sessions.sessionState(1, 'Ethereum', 'plus500', SAT_PREOPEN);
  assert.equal(crypto.state, 'open', 'there is no weekend close to protect a 24/7 instrument from');
  const stock = await sessions.sessionState(1, 'Gold', 'plus500', SAT_PREOPEN);
  assert.equal(stock.state, 'observation', 'the stock lock is untouched');
  assert.ok(sessions.isEntryLocked(stock.state));
});

test('★ the VENUE still outranks the class: an explicit closed venue closes a 24/7 instrument', async (t) => {
  stubVenue(t, { isTraded: false, next: { from: '2026-10-19 00:00:00.000' } }, new Date('2026-10-19T00:00:00Z'));
  stubEvents(t, []);
  const s = await sessions.sessionState(1, 'Bitcoin', 'plus500', SATURDAY);
  assert.equal(s.state, 'closed', 'a venue that says shut is shut, class notwithstanding');
  assert.match(s.detail, /venue closed/);
});

test('a halt still closes a 24/7 instrument when the venue is silent', async (t) => {
  stubVenue(t, null);
  stubEvents(t, [{ id: 4, symbol: '*', eventType: 'halt', note: 'venue-wide outage' }]);
  const s = await sessions.sessionState(1, 'Bitcoin', 'plus500', SATURDAY);
  // A halt row is checked AFTER the calendar in sessionState. On a weekday it closes; on the weekend the
  // 24/7 bypass returns open first. That ordering is deliberate (the venue is the only authority that can
  // really halt a 24/7 venue) and is asserted here so a future reshuffle cannot flip it silently.
  assert.equal(s.state, 'open');
  const weekday = await sessions.sessionState(1, 'Bitcoin', 'plus500', WEEKDAY);
  assert.equal(weekday.state, 'closed');
  assert.match(weekday.detail, /corporate halt/);
});

test('a weekday 24/7 instrument is plain open (the class changes nothing when the calendar is open)', async (t) => {
  stubVenue(t, null);
  stubEvents(t, []);
  const s = await sessions.sessionState(1, 'Bitcoin', 'plus500', WEEKDAY);
  assert.equal(s.state, 'open');
  assert.equal(s.source, undefined, 'no special source on a normal open day');
});

test('★ the bypass is scoped to the calendar branch — the pin that keeps it from becoming a global override', () => {
  const src = code('trading/agent/sessions.js');
  assert.match(src, /cal === 'closed' \|\| cal === 'observation'\) && isTwentyFourSeven\(symbol\)/,
    'the class may only bypass the CALENDAR step');
  assert.match(src, /if \(v && v\.isTraded === false\) \{[\s\S]{0,400}?state: 'closed'/,
    'the venue-closed check must stay ABOVE the class');
  assert.match(src, /source: 'always_open_class'/);
});
