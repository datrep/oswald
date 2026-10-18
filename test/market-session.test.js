// test/market-session.test.js — the 2026-09-15 "market_closed while the market is open" outage.
//
// WHAT HAPPENED, in one line: an FOMC meeting day was stored as a venue HALT, the venue feed went silent
// when Chrome reconnected and the session listener stayed bound to a dead page, and the session guard
// then closed all twelve symbols and skipped every wake for hours — recording the whole time that "all
// venues closed", a sentence that discarded the one fact that explained it.
//
// So there are three things to pin here, and they are separate:
//   1. A scheduled macro event locks ENTRIES. It must never be reported as a closed venue, because
//      `closed` skips the entire wake — no capture, no bars, no exits.
//   2. The venue's own feed outranks the corporate-event fallback, and the fallback must be the most
//      conservative thing in the file about asserting a closure.
//   3. The listener must SURVIVE a reconnect, and a summary must not throw away its evidence.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

// ---------------------------------------------------------------------------------------------------
// A fake bridge browser, injected BEFORE the session feed is required.
// `plus500/sessionFeed` holds the browser module and calls through it at call time, so substituting
// `newPage`/`onConnect` here is enough to drive the reconnect path with no Chrome and no CDP.
// ---------------------------------------------------------------------------------------------------
function fakePage(url = 'https://app.plus500.com/trade/gold') {
  const listeners = {};
  return {
    listeners,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    off(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); return this; },
    url: () => url,
  };
}

const browserStub = {
  newPage: async () => { throw new Error('newPage not configured for this test'); },
  onConnect: () => () => {},
};
const browserPath = require.resolve('../trading/plus500/browser');
require.cache[browserPath] = { id: browserPath, filename: browserPath, loaded: true, exports: browserStub };

const feed = require('../trading/plus500/sessionFeed');
const sessions = require('../trading/agent/sessions');
const calendar = require('../trading/agent/calendar');

const settle = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));

// A stand-in for the DB, so `sessionState` can be driven without SQL Server. It answers the one query
// that matters: the corporate events for today.
function stubEvents(t, rows) {
  const db = require('../trading/db');
  t.after(() => { db.getPool = TRUE_POOL; });
  db.getPool = async () => ({
    request: () => ({
      input() { return this; },
      query: async () => ({ recordset: rows }),
    }),
  });
}

// ★ THE STUBS RESTORE THE TRUE ORIGINALS, NOT WHATEVER WAS INSTALLED WHEN THEY WERE CALLED.
// Capturing `feed.get` per call looked fine and leaked: a test that stubs twice runs its `after` hooks
// in order, so the second hook reinstated the FIRST stub and the stub outlived the test — silently, for
// every test after it in the file. Three unrelated tests failed as a result, none of them where the bug
// was. Restoring one immutable original makes the hooks order-independent.
const TRUE_GET = feed.get;
const TRUE_NEXT = feed.nextOpenAt;
const TRUE_POOL = require('../trading/db').getPool;

function stubVenue(t, entry, next = null) {
  t.after(() => { feed.get = TRUE_GET; feed.nextOpenAt = TRUE_NEXT; });
  feed.get = () => entry;
  feed.nextOpenAt = () => next;
}

const TODAY = new Date('2026-09-15T13:52:00Z');   // a Tuesday, mid-session — the moment of the outage
const FOMC = [{ id: 1, symbol: '*', eventType: 'macro', note: 'FOMC meeting day (federalreserve.gov)' }];

// ---------------------------------------------------------------- 1. the clock was never the problem

test('★ the calendar is NOT what closed the desk: a Tuesday mid-session is open', () => {
  // Asserted first because it is the thing the owner was told, and the thing that was false. The four
  // defects below only matter because the market really was open.
  assert.equal(sessions.calendarState(TODAY), 'open');
});

test('the weekend rules still hold (Fri 21:00 UTC -> Sun 21:00 UTC)', () => {
  assert.equal(sessions.calendarState(new Date('2026-09-18T20:00:00Z')), 'open', 'Friday evening, before the close');
  assert.equal(sessions.calendarState(new Date('2026-09-18T20:45:00Z')), 'observation', 'inside the 30m pre-close window');
  assert.equal(sessions.calendarState(new Date('2026-09-18T21:05:00Z')), 'closed', 'after Friday close');
  assert.equal(sessions.calendarState(new Date('2026-09-19T12:00:00Z')), 'closed', 'Saturday');
  assert.equal(sessions.calendarState(new Date('2026-09-20T20:45:00Z')), 'observation', 'inside the 30m pre-open window');
  assert.equal(sessions.calendarState(new Date('2026-09-20T21:05:00Z')), 'open', 'Sunday open');
});

// ---------------------------------------------------------------- 2. the fourth state

test('★ the ONLY thing that locks entries is the observation window — and it never blocks exits', () => {
  // REVISED 2026-09-15. A scheduled macro event used to produce `no_entry` and block new entries for the
  // whole day. The owner asked why an FOMC day should bar entries at all; nobody had decided it, and the
  // lock silenced the deliberation it should have informed. The event is context now, and the
  // observation window — a different rule with a different justification — is the only lock left.
  assert.ok(sessions.isEntryLocked('observation'), 'do not open a position minutes before a weekend close');
  assert.ok(!sessions.isEntryLocked('open'));
  assert.ok(!sessions.isEntryLocked('closed'), "'closed' skips the wake entirely; it is not a lock");
  assert.deepEqual(sessions.ENTRY_LOCK_STATES, ['observation'], 'nothing else may quietly become a veto');
  assert.equal(sessions.sessionClosed({ state: 'observation' }).closed, false, 'a lock must never trap an exit');
  assert.equal(sessions.sessionClosed({ state: 'closed' }).closed, true);
});

test('★ an FOMC meeting day is INFORMATION: not a closure, not a lock', async (t) => {
  stubVenue(t, null);           // the venue says nothing — the path that once shut the whole desk
  stubEvents(t, FOMC);
  const s = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.equal(s.state, 'open', 'the venue is open on an FOMC day, and the desk trades it');
  assert.equal(s.state !== 'closed' && s.state !== 'no_entry', true, 'the two ways this went wrong before');
  assert.equal(s.scheduledEvents.length, 1, 'and the event is still REPORTED, which is the point');
  assert.equal(s.scheduledEvents[0].type, 'macro');
  assert.match(s.scheduledEvents[0].note, /FOMC meeting day/, 'so it can be quoted to the chairs');
});

test('★ the scheduled event rides along whatever the venue says', async (t) => {
  // Earlier versions of this rule were conditionally applied — once only when the venue was silent, then
  // unconditionally as a lock. Now it is neither: it is attached to every verdict, so a caller cannot get
  // the session state without the context that belongs with it.
  stubEvents(t, FOMC);
  stubVenue(t, { isTraded: true, current: { from: 'now', to: 'later' } });
  const open = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.equal(open.state, 'open');
  assert.equal(open.scheduledEvents.length, 1, 'a live venue feed must not hide the event');

  stubVenue(t, { isTraded: false, next: { from: '2026-09-20 21:00:00.000' } }, new Date('2026-09-20T21:00:00Z'));
  const shut = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.equal(shut.state, 'closed', 'a shut venue is still shut');
  assert.equal(shut.scheduledEvents.length, 1, 'and a fact about today does not stop being one');
});

test('★ a venue HALT is still closed, and now says WHY', async (t) => {
  stubVenue(t, null);
  stubEvents(t, [{ id: 9, symbol: '*', eventType: 'halt', note: 'exchange-wide outage' }]);
  const s = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.equal(s.state, 'closed');
  assert.match(s.detail, /corporate halt: exchange-wide outage/);
});

test('★ the guard exposes the event type the importer writes, and understands both', () => {
  const src = code('trading/agent/sessions.js');
  assert.match(src, /eventType IN \('halt','macro'\)/, 'the guard and the importer must agree on the vocabulary');
  assert.match(src, /const ENTRY_LOCK_STATES = \['observation'\]/, 'one lock, and it is not the event');
  assert.ok(!/no_entry/.test(src), 'the state the veto was built on must be GONE, not merely unused');
});

test('the event lookup answers in ONE query and splits by type', () => {
  // Two rows of different types on the same day must both survive the read: the type is what decides
  // which question they answer, and a `TOP (1)` with an ORDER BY would silently drop one of them.
  const src = code('trading/agent/sessions.js');
  const q = src.slice(src.indexOf('SELECT symbol, eventType, note FROM CorporateEvents'));
  assert.ok(q.length > 100, 'slice guard');
  assert.ok(!/TOP \(1\)/.test(q.slice(0, 400)), 'a TOP (1) here would throw away one of the two event types');
  assert.match(q, /WHERE userId = @userId AND venue = @venue/);
  assert.match(q, /eventType IN \('halt','macro'\)/);
});

test('★ the DESK\'S OWN LOCK applies even when the venue reports the instrument OPEN', async (t) => {
  // THE PRECEDENCE FIX, kept for the lock that survived the revision. The observation window used to be
  // resolved after the venue-feed early return, so whether it applied to an instrument depended on
  // whether that instrument appeared in the venue's last payload.
  const saturday = new Date('2026-09-20T20:45:00Z');   // inside the 30m pre-open window
  stubVenue(t, { isTraded: true, current: { from: 'now', to: 'later' } });
  stubEvents(t, []);
  const s = await sessions.sessionState(1, 'Gold', 'plus500', saturday);
  assert.equal(s.state, 'observation', 'our window applies regardless of what the venue reported');
  assert.ok(sessions.isEntryLocked(s.state));
});

test('★ but a SHUT VENUE still wins, and so does the weekend', async (t) => {
  stubEvents(t, FOMC);
  stubVenue(t, { isTraded: false, next: { from: '2026-09-20 21:00:00.000' } }, new Date('2026-09-20T21:00:00Z'));
  assert.equal((await sessions.sessionState(1, 'Gold', 'plus500', TODAY)).state, 'closed');

  stubVenue(t, null);
  assert.equal((await sessions.sessionState(1, 'Gold', 'plus500', new Date('2026-09-19T12:00:00Z'))).state, 'closed', 'Saturday');
});

test('a real HALT still closes the venue when the two event types sit side by side', async (t) => {
  stubVenue(t, null);
  stubEvents(t, [
    ...FOMC,
    { id: 3, symbol: 'Gold', eventType: 'halt', note: 'single-instrument suspension' },
  ]);
  const s = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.equal(s.state, 'closed');
  assert.match(s.detail, /single-instrument suspension/);
});

test('within a type, a symbol-specific row outranks the wildcard', async (t) => {
  stubVenue(t, null);
  stubEvents(t, [
    { id: 1, symbol: '*', eventType: 'halt', note: 'venue-wide halt' },
    { id: 2, symbol: 'Gold', eventType: 'halt', note: 'Gold only' },
  ]);
  const s = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.match(s.detail, /Gold only/, 'a per-instrument halt must not be masked by a market-wide note');
});

test('★ the venue feed still outranks the corporate-event FALLBACK — which is why the defect was latent', async (t) => {
  // `halt` is the fallback, and the venue is the authority on its own session, so a live `isTraded:true`
  // must beat a halt row. That precedence is correct, AND it is the reason the bad FOMC rows did nothing
  // for hours and then shut the desk the moment the feed went silent. Pinned in both directions: `halt`
  // is outranked here, `macro` is not (see the lock test above).
  stubVenue(t, { isTraded: true, current: { from: 'now', to: 'later' } });
  stubEvents(t, [{ id: 9, symbol: '*', eventType: 'halt', note: 'exchange-wide outage' }]);
  const s = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.equal(s.state, 'open', 'a live venue feed wins over a halt row');
});

test('a genuinely closed venue reports its own next session, not the calendar', async (t) => {
  stubVenue(t, { isTraded: false, next: { from: '2026-09-20 21:00:00.000' } }, new Date('2026-09-20T21:00:00Z'));
  stubEvents(t, []);
  const s = await sessions.sessionState(1, 'Gold', 'plus500', TODAY);
  assert.equal(s.state, 'closed');
  assert.match(s.detail, /next session/);
});

// ---------------------------------------------------------------- 3. the aggregate must keep its evidence

test('★ an all-closed desk NAMES the reason instead of asserting "all venues closed"', () => {
  const symbols = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}` }));
  const states = symbols.map(() => ({ state: 'closed', detail: 'corporate halt: FOMC meeting day (federalreserve.gov)' }));
  const s = sessions.aggregateSession(states, symbols);
  assert.equal(s.state, 'closed');
  assert.match(s.detail, /FOMC meeting day/, 'the summary must still contain the fact that explained it');
  assert.match(s.detail, /all 12 venues closed/);
});

test('a single closed venue keeps its own sentence verbatim', () => {
  const s = sessions.aggregateSession([{ state: 'closed', detail: 'venue closed — next session X' }], [{ symbol: 'Gold' }]);
  assert.equal(s.detail, 'venue closed — next session X');
});

test('★ a scheduled event aggregates as CONTEXT, and one open symbol keeps the desk running', () => {
  const s = sessions.aggregateSession(
    [
      { state: 'open', detail: 'market open', scheduledEvents: [{ type: 'macro', note: 'FOMC meeting day', scope: '*' }] },
      { state: 'open', detail: 'market open', scheduledEvents: [{ type: 'macro', note: 'FOMC meeting day', scope: '*' }] },
    ],
    [{ symbol: 'Gold' }, { symbol: 'Sugar' }],
  );
  assert.equal(s.state, 'open', 'the event does not change the state — that was the whole revision');
  assert.equal(s.scheduledEvents.length, 1, 'and one event across twelve symbols is ONE event');
  assert.equal(s.scheduledEvents[0].note, 'FOMC meeting day');
  assert.deepEqual(s.scheduledEventSymbols, ['Gold', 'Sugar'], 'the symbols it was read from, so scope is visible');
  assert.equal(s.symbols.length, 2, 'every per-symbol verdict travels with the session');
});

test('★ lockedSymbols names the LOCKED symbols, not the first ones in the watchlist', () => {
  // Filter-then-index read `symbols[i]` off a FILTERED array, so it reported the first symbol rather than
  // the locked one, and a test passed by luck because the locked symbol was first in both arrays. The
  // locked symbol is deliberately NOT first here.
  const s = sessions.aggregateSession(
    [{ state: 'open', detail: 'x' }, { state: 'observation', detail: 'pre/post-open window' }],
    [{ symbol: 'Gold' }, { symbol: 'Sugar' }],
  );
  assert.equal(s.state, 'observation');
  assert.deepEqual(s.lockedSymbols, ['Sugar'], 'the second symbol is the locked one and must be named');
});

test('★ an empty state list is OPEN, not closed', () => {
  // `[].every(...)` is TRUE. The old inline aggregate was guarded by `if (symbols.length)`, but the
  // guard lived at the call site — one refactor away from a desk that closes itself on an empty watchlist.
  assert.equal(sessions.aggregateSession([], []).state, 'open');
  assert.equal(sessions.aggregateSession(undefined, undefined).state, 'open');
});

test('the observation window aggregates to a lock, and names every symbol it covers', () => {
  const s = sessions.aggregateSession(
    [{ state: 'observation', detail: 'pre/post-open window' }, { state: 'open', detail: 'market open' }],
    [{ symbol: 'Gold' }, { symbol: 'Oil' }],
  );
  assert.equal(s.state, 'observation');
  assert.match(s.detail, /pre\/post-open window/);
  assert.deepEqual(s.lockedSymbols, ['Gold']);
});

// ---------------------------------------------------------------- 4. the listener must survive a reconnect

test('★ the feed re-arms on a reconnect instead of dying with the dead page', async () => {
  const pages = [];
  let connectCb = null;
  browserStub.newPage = async () => pages[pages.length - 1];
  browserStub.onConnect = (fn) => { connectCb = fn; return () => {}; };

  const p1 = fakePage();
  pages.push(p1);
  await feed.startTracking();
  assert.equal(p1.listeners.response.length, 1, 'boot attaches once');
  assert.ok(connectCb, 'startTracking MUST subscribe to the browser connect event — the old one-shot guard is the defect');

  // Chrome blips: ensureBrowser() discards the old Browser, so the next page is a DIFFERENT object.
  const p2 = fakePage('https://app.plus500.com/trade/oil');
  pages.push(p2);
  connectCb();
  await settle();
  assert.equal(p2.listeners.response.length, 1, 'the listener must move to the new page');
  assert.equal(p1.listeners.response.length, 0, 'and be removed from the dead one');

  // A duplicate announce (or a redundant attach) must not stack handlers.
  connectCb();
  await settle();
  assert.equal(p2.listeners.response.length, 1, 'attach is idempotent');
});

test('★ the handler is live end-to-end: a venue payload reaches the registry', async () => {
  // The reconnect test above only proves a function was registered. This drives the real handler with a
  // real CometAsyncHandler-shaped body, so a page that is attached but inert cannot pass.
  const page = fakePage();
  browserStub.newPage = async () => page;
  await feed.attach('test');
  const handler = page.listeners.response[page.listeners.response.length - 1];
  await handler({
    url: () => 'https://trade.plus500.com/CometAsyncHandler.ashx?x=1',
    text: async () => JSON.stringify({ OPositionsList: [{ InstrumentName: 'Gold', IsTraded: true, PID: 42, CurrentTradingInterval: { DateTime: '2026-09-15 21:00:00.000', EndDateTime: '2026-09-15 21:05:00.000' } }] }),
  });
  const entry = feed.get('Gold');
  assert.ok(entry, 'the payload must land in the registry');
  assert.equal(entry.isTraded, true);
  assert.equal(feed.status().responses > 0, true);
});

test('a silent feed is VISIBLE, which is what it was not', () => {
  const s = feed.status();
  assert.equal(typeof s.silent, 'boolean');
  assert.ok(Object.prototype.hasOwnProperty.call(s, 'silentForMs'));
  assert.ok(Object.prototype.hasOwnProperty.call(s, 'attached'));
  assert.ok(s.attachments >= 1, 'attachments are counted, so "never attached" is distinguishable from "attached and quiet"');
  // One constant, so "the feed is stale" and "the feed is silent" cannot drift apart.
  assert.equal(feed.SILENT_AFTER_MS, feed.STALE_MS);
});

test('the old one-shot guard is gone, and a closed page unbinds', () => {
  const src = code('trading/plus500/sessionFeed.js');
  assert.match(src, /onConnect/, 'the feed must re-arm through the browser connect event');
  assert.match(src, /page\.on\('close'/, 'a closed page must unbind, or the silence watch reports a healthy quiet feed');
  assert.match(src, /function detach\(\)/);
  assert.ok(!/if \(state\.tracking\) return;\s*\n\s*const page = await/.test(src), 'the body of startTracking must not be a one-shot attach');
});

// ---------------------------------------------------------------- 4b. why the fallback was reachable at all

test('★ the feed only knows about instruments the venue payload MENTIONS', async (t) => {
  // THE FRAGILITY UNDERNEATH THE WHOLE OUTAGE. `harvest` reads `OPositionsList` (OPEN POSITIONS) and
  // `SingleTradeInstrument` (whichever page is focused) — nothing else. So on a twelve-symbol watchlist
  // the desk has live session knowledge for roughly the symbols it ALREADY HOLDS; for the rest `get()`
  // returns null on every wake. Its knowledge of whether it is allowed to trade therefore depends on it
  // already having a position, and a STALE feed is indistinguishable from a SHUT venue — both produce
  // `null`, which is the value that reaches the corporate-event fallback.
  //
  // Driven through the real handler, not asserted structurally: a payload listing only Gold must leave
  // Oil unknown, and Oil's verdict must then come from the fallback.
  const page = fakePage();
  browserStub.newPage = async () => page;
  await feed.attach('test');
  const handler = page.listeners.response[page.listeners.response.length - 1];
  await handler({
    url: () => 'https://trade.plus500.com/CometAsyncHandler.ashx?x=2',
    text: async () => JSON.stringify({ OPositionsList: [{ InstrumentName: 'Gold', IsTraded: true, PID: 7 }] }),
  });
  assert.ok(feed.get('Gold'), 'a held instrument the venue mentioned is known');
  assert.equal(feed.get('Oil'), null, 'an instrument the venue did not mention is UNKNOWN — not open, not closed');

  stubVenue(t, null);
  stubEvents(t, []);
  const oil = await sessions.sessionState(1, 'Oil', 'plus500', TODAY);
  assert.equal(oil.state, 'open', 'with no event row the fallback says open — silence must not become a closure');
  assert.equal(oil.source, undefined, 'and the venue verdict is absent, which is what the fallback is reacting to');
});

test('★ and the per-symbol verdicts travel with the session, so a fallback is visible', () => {
  const venue = sessions.aggregateSession([{ state: 'open', detail: 'venue session open' }], [{ symbol: 'Gold' }]);
  assert.equal(venue.symbols[0].source, null, 'a venue verdict carries no fallback label');
  const fallback = sessions.aggregateSession([{ state: 'no_entry', detail: 'FOMC', source: 'corporate_event' }], [{ symbol: 'Sugar' }]);
  assert.equal(fallback.symbols[0].source, 'corporate_event', 'and a fallback verdict names itself as one');
});

// ---------------------------------------------------------------- 5. the importer writes what it means

test('★ an FOMC meeting day is imported as `macro`, never as a venue `halt`', () => {
  assert.equal(calendar.EVENT_TYPE, 'macro');
  const rows = calendar.fomcRows(1, [{ eventDate: '2026-09-15', note: 'FOMC meeting day (federalreserve.gov)' }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [1, '*', 'plus500', 'macro', '2026-09-15', 'FOMC meeting day (federalreserve.gov)', 'federalreserve']);
});

test('★ the import clears rows of ANY type, or the old halts outlive the fix', () => {
  // A delete restricted to the type being written would leave the 2026-09-15 `halt` rows in place
  // forever, still closing the venue, beside new `macro` rows that look correct.
  const src = code('trading/agent/calendar.js');
  const at = src.indexOf('DELETE FROM CorporateEvents');
  assert.ok(at > -1, 'the idempotent delete must exist');
  const del = src.slice(at, at + 300);
  assert.ok(!/eventType/.test(del), 'the delete must not be restricted by eventType');
  assert.match(del, /source = 'federalreserve'/, 'but it MUST stay scoped to the imported rows — a genuine halt is not ours to touch');
});

// ---------------------------------------------------------------- 6. the pipeline, structurally

test('★ the wake pipeline no longer invents a session reason', () => {
  const src = code('trading/agent/wakePipeline.js');
  assert.ok(!/'all venues closed'/.test(src), 'the literal that hid the reason for hours');
  assert.match(src, /aggregateSession/, 'the tested aggregate, not four inline lines');
  assert.match(src, /skipped: 'market_closed', detail: session\.detail/, 'the skip must carry the real reason');
});

test('one decision function for "is entry allowed", used by every consumer', () => {
  for (const f of ['trading/agent/wakePipeline.js', 'trading/agent/aggregator.js', 'trading/agent/promptBuilder.js']) {
    const src = code(f);
    assert.ok(!/state === 'observation'/.test(src), `${f} must not re-derive the lock from the state token`);
  }
  assert.match(code('trading/agent/aggregator.js'), /isEntryLocked\(session\.state\)/);
  assert.match(code('trading/agent/promptBuilder.js'), /isEntryLocked\(session\.state\)/);
});

test('★ the prompt no longer asserts a reason that may be false, and carries the event instead', () => {
  const src = code('trading/agent/promptBuilder.js');
  assert.ok(!/'SESSION_LOCK: pre\/post-open observation window/.test(src), 'the chairs read this text; a false reason is worse than none');
  assert.match(src, /SESSION_LOCK: \$\{session\.detail/);
  // ★ THE REVISION ITSELF, asserted where it lands: the event reaches the chairs and the prompt says in
  // as many words that entries are NOT blocked for it. A model told to weigh something while a hidden
  // lock discards its answer is the failure this replaced.
  assert.match(src, /SCHEDULED EVENT TODAY: \$\{e\.note\}/);
  assert.match(src, /Entries are NOT blocked for it/);
  assert.match(code('trading/agent/sessions.js'), /scheduledEvents/, 'and the event has to get there from the guard');
});

// ---------------------------------------------------------------- 7. self-health, so silence is not invisible

test("★ self-health notices a desk that is running and doing nothing", () => {
  const src = code('trading/agent/selfHealth.js');
  assert.match(src, /'Wake progress'/, 'a skip IS a wake event, so the wake-loop check says "alive" while the desk does nothing');
  assert.match(src, /calendarState/, 'and the check must be gated on the calendar, or it pages every weekend');
  assert.match(src, /'Venue session feed'/);
  assert.match(src, /require\('\.\.\/plus500\/sessionFeed'\)/);
});

test("★ and it can tell a scheduled event apart from a fault", () => {
  // The check began life as an "Entry lock". A `macro` event no longer locks anything, so `Entry lock`
  // would be a lie — but the INFORMATION is still worth a line on the dashboard. A `macro` day is `ok`;
  // only a genuine venue `halt` pages.
  const src = code('trading/agent/selfHealth.js');
  assert.match(src, /'Scheduled events'/);
  assert.ok(!/'Entry lock'/.test(src), 'nothing locks entries on a scheduled event any more');
  const at = src.indexOf("'Scheduled events'");
  const block = src.slice(at - 400, at + 500);
  assert.match(block, /const macro = /, 'it distinguishes the two event types');
  assert.ok(/check\('schedule', 'Scheduled events', 'ok', `today: /.test(block), 'a scheduled event is context, so it must not warn or page');
  assert.ok(/halt\.length\) checks\.push\(check\('schedule', 'Scheduled events', 'bad'/.test(block), 'a real halt still does');
});
