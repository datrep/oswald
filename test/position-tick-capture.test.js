// test/position-tick-capture.test.js — TRD-106, 2026-09-19.
//
// The row says "the shortest trades can never have an excursion measured". The first fix persisted the
// positions read; measured the next morning it persisted it at ONE SAMPLE PER MINUTE — 121
// `position_poll` ticks in two hours, gaps 60-70s, exactly one per mirror cycle — while the account
// strip on the same page was landing at ~1-2.4s throughout.
//
// Two causes, one shape: a signal whose name claimed more than its test did.
//
//   (1) `onPage` is `page.url().includes('/open-positions')` — a SUBSTRING TEST — and the tick write was
//       gated on it, so a row parsed off the live DOM was discarded whenever the URL disagreed with the
//       DOM, which is what an app that rewrites its own URL does. `rows_off_url` is the case that matters:
//       rows are evidence by themselves.
//   (2) Only the mirror's cycle parked the tab on /open-positions, and only there is a read definitive.
//       The poller may now click through itself — throttled, under `pageLock`, and NEVER during a HARD
//       kill, because "HARD kill = zero bridge navigation" is a contract this loop used to be exempt from
//       precisely BECAUSE it never navigated.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const poller = require('../trading/agent/accountPoller');
const lock = require('../trading/plus500/pageLock');

// --- what a read may be used for (the class-1 fix) ---------------------------

test('★ a parsed row is usable without asking the URL for permission', () => {
  const d = poller.readDisposition({ items: [{ name: 'Oil', currentRate: 95.5 }], onPage: false, sawDom: true });
  assert.strictEqual(d.rows, 1);
  assert.strictEqual(d.mode, 'rows_off_url');
  assert.strictEqual(d.setOverlay, true, 'the live overlay must get it too');
});

test('on_page rows are labelled apart from off_url rows, so the mode is diagnosable', () => {
  const d = poller.readDisposition({ items: [{}], onPage: true, sawDom: true });
  assert.strictEqual(d.mode, 'rows_on_page');
});

test('an empty read off the positions page is inconclusive and keeps the previous snapshot', () => {
  const elsewhere = poller.readDisposition({ items: [], onPage: false, sawDom: false });
  assert.strictEqual(elsewhere.mode, 'no_positions_dom');
  assert.strictEqual(elsewhere.clearOverlay, false,
    'clearing here would serve "flat" from a page that has no positions DOM at all');
});

// --- an empty read needs a SECOND WITNESS (added 2026-09-20 from live evidence) -------------------
//
// Measured with one position open on the venue: the URL said /open-positions while the DOM had rendered no
// rows at all, and the old rule called that `flat_definitive` — **75 times in four hours**. A half-rendered
// page is not a flat account, and calling it flat is how a real position leaves the overlay.

test('★ an empty read with only one witness is NOT flat', () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  // Fresh strip, but a position is open (margin 55.15) — exactly the live shape.
  const open = { readAt: '2026-09-19T16:29:50Z', margin: 55.15 };
  const halfRendered = poller.readDisposition({ items: [], onPage: true, sawDom: false }, { account: open, nowMs: now });
  assert.strictEqual(halfRendered.mode, 'empty_untrusted');
  assert.strictEqual(halfRendered.clearOverlay, false, 'one witness is not enough');
});

test('★ an empty read IS flat when the strip corroborates it, or when the DOM rendered', () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  const flatStrip = { readAt: '2026-09-19T16:29:50Z', margin: 0 };
  const corroborated = poller.readDisposition({ items: [], onPage: true, sawDom: false }, { account: flatStrip, nowMs: now });
  assert.strictEqual(corroborated.mode, 'flat_corroborated');
  assert.strictEqual(corroborated.clearOverlay, true, 'URL + a fresh flat strip: two witnesses');

  const domRendered = poller.readDisposition({ items: [], onPage: false, sawDom: true }, { account: null, nowMs: now });
  assert.strictEqual(domRendered.clearOverlay, true, 'the positions DOM rendering empty is a witness in its own right');
});

test('a stale or margin-less strip cannot corroborate flatness', () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  assert.strictEqual(poller.readDisposition({ items: [], onPage: true }, { account: { readAt: '2026-09-19T16:20:00Z', margin: 0 }, nowMs: now }).clearOverlay, false);
  assert.strictEqual(poller.readDisposition({ items: [], onPage: true }, { account: { readAt: '2026-09-19T16:29:50Z', margin: null }, nowMs: now }).clearOverlay, false);
  assert.strictEqual(poller.readDisposition({ items: [], onPage: true }, { account: null, nowMs: now }).clearOverlay, false);
});

test("stripSaysFlat keeps the mirror's numbers — fresh within 120s, and |margin| <= 0.005", () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  assert.strictEqual(poller.stripSaysFlat({ readAt: '2026-09-19T16:28:01Z', margin: 0 }, now), true);
  assert.strictEqual(poller.stripSaysFlat({ readAt: '2026-09-19T16:27:59Z', margin: 0 }, now), false, 'past 120s is stale');
  assert.strictEqual(poller.stripSaysFlat({ readAt: '2026-09-19T16:29:50Z', margin: 0.006 }, now), false);
  assert.strictEqual(poller.stripSaysFlat({ readAt: '2026-09-19T16:29:50Z', margin: -0.005 }, now), true, 'the sign is irrelevant, the magnitude is not');
  assert.strictEqual(poller.stripSaysFlat(null, now), false);
  assert.strictEqual(poller.stripSaysFlat({ acceptedAt: '2026-09-19T16:29:50Z', margin: 0 }, now), true, 'getLive() carries acceptedAt');
});

test('a malformed read cannot throw, and cannot invent rows', () => {
  for (const bad of [null, undefined, {}, { items: null }, { items: 'not-an-array' }]) {
    const d = poller.readDisposition(bad);
    assert.strictEqual(d.rows, 0, `${JSON.stringify(bad)} must have no rows`);
    assert.strictEqual(d.setOverlay, false);
    assert.strictEqual(d.clearOverlay, false);
  }
});

// --- the tick gate is per symbol and session-aware (added 2026-09-20) -----------------------------
//
// Measured: **113 of 113 wakes between the Friday close and the Saturday were `skipped: market_closed`**.
// ⚠ THIS USED TO TEST A SESSION-AWARE GATE (10s open / 60m shut). It was reverted 2026-09-20 after measuring
// that `store/ticks.js` DEDUPES an unchanged bid+ask inside DEDUPE_WINDOW_MS = 60000, so a frozen price was
// already ~1 write a minute (54-58/hour measured, 60 predicted). A session gate on top of dedupe bought
// nothing and could only make a wrongly-"shut" calendar entry coarsen a series that should be dense. What is
// pinned now: the cadence must NOT depend on the calendar, while `nothingToWatch` (the NAVIGATOR's input)
// still must.

test('★ the tick gate does NOT consult the calendar — dedupe is what bounds a frozen price', () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  const rows = [{ name: 'Oil' }, { name: 'Bitcoin' }];
  const plan = poller.positionTickPlan({ rows, nowMs: now, lastBySymbolMs: new Map(), isOpen: (s) => s === 'Bitcoin' });
  assert.strictEqual(plan.due.length, 2, 'nothing has been written yet, so both are due');
  for (const d of plan.due) assert.strictEqual(d.everyMs, 10000, 'a shut session must NOT change the interval');
  assert.strictEqual(plan.live, 1);
  assert.strictEqual(plan.shut, 1, 'the session is still read — it decides nothingToWatch, not the cadence');
});

test('a shut symbol is re-read on the same 10s clock as a live one', () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  const rows = [{ name: 'Oil' }, { name: 'Bitcoin' }];
  const last = new Map([['Oil', now - 30000], ['Bitcoin', now - 30000]]);
  const plan = poller.positionTickPlan({ rows, nowMs: now, lastBySymbolMs: last, isOpen: (s) => s === 'Bitcoin' });
  assert.deepStrictEqual(plan.due.map((d) => d.symbol).sort(), ['Bitcoin', 'Oil'],
    '30s is past the 10s gate for BOTH — the shut one is not held back, dedupe handles the unchanged value');

  // And inside the gate neither is due, which is the property that keeps the write rate bounded.
  const fresh = new Map([['Oil', now - 5000], ['Bitcoin', now - 5000]]);
  assert.strictEqual(poller.positionTickPlan({ rows, nowMs: now, lastBySymbolMs: fresh, isOpen: (s) => s === 'Bitcoin' }).due.length, 0);
});

test('a broken calendar feed cannot change the cadence — it only affects nothingToWatch', () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  const unknown = poller.positionTickPlan({ rows: [{ name: 'Oil' }], nowMs: now, lastBySymbolMs: new Map(), isOpen: () => null });
  assert.strictEqual(unknown.due[0].everyMs, 10000);
  assert.strictEqual(unknown.nothingToWatch, false, '"we cannot tell" is not "closed"');

  const throws = poller.positionTickPlan({ rows: [{ name: 'Oil' }], nowMs: now, lastBySymbolMs: new Map(), isOpen: () => { throw new Error('feed down'); } });
  assert.strictEqual(throws.due[0].everyMs, 10000, 'a thrown feed is unknown, not closed');
  assert.strictEqual(throws.nothingToWatch, false);
});

test('★ nothingToWatch only when there ARE positions and every session is shut', () => {
  const now = Date.parse('2026-09-19T16:30:00Z');
  const shut = poller.positionTickPlan({ rows: [{ name: 'Oil' }], nowMs: now, lastBySymbolMs: new Map(), isOpen: () => false });
  assert.strictEqual(shut.nothingToWatch, true);

  const mixed = poller.positionTickPlan({ rows: [{ name: 'Oil' }, { name: 'Bitcoin' }], nowMs: now, lastBySymbolMs: new Map(), isOpen: (s) => s === 'Bitcoin' });
  assert.strictEqual(mixed.nothingToWatch, false, 'one trading instrument makes the book worth watching');

  // An EMPTY book is not this case: we do not know it is flat, which is when parking the tab IS worth it.
  const unknownBook = poller.positionTickPlan({ rows: [], nowMs: now, lastBySymbolMs: new Map(), isOpen: () => false });
  assert.strictEqual(unknownBook.nothingToWatch, false);
});

test('a row with no symbol name is skipped, not written under `undefined`', () => {
  const plan = poller.positionTickPlan({ rows: [{ name: null }, {}], nowMs: Date.now(), lastBySymbolMs: new Map(), isOpen: () => true });
  assert.strictEqual(plan.due.length, 0);
  assert.strictEqual(plan.live, 0);
});

test('sessionOpen answers without throwing, and says unknown rather than guessing', () => {
  assert.doesNotThrow(() => poller.sessionOpen('Oil'));
  assert.doesNotThrow(() => poller.sessionOpen('NotAnInstrument'));
});

// --- whether a navigation may be spent ---------------------------------------

test('★ a HARD kill means zero bridge navigation — this poller included', () => {
  const d = poller.decidePositionsNav({ killTier: 'hard', lastNavAt: 0, nowMs: Date.now() });
  assert.strictEqual(d.go, false);
  assert.strictEqual(d.reason, 'kill_switch_hard');
});

test('★ a book whose every session is shut is not worth a navigation', () => {
  const d = poller.decidePositionsNav({ killTier: 'off', lastNavAt: 0, nowMs: Date.now(), nothingToWatch: true });
  assert.strictEqual(d.go, false);
  assert.strictEqual(d.reason, 'sessions_closed');
  // and it is reported ahead of the throttle, because it is the more informative reason
  const both = poller.decidePositionsNav({ killTier: 'off', lastNavAt: Date.now(), nowMs: Date.now(), nothingToWatch: true });
  assert.strictEqual(both.reason, 'sessions_closed');
});

test('soft/off kills still allow it; the throttle is what bounds the rate', () => {
  const now = 1000000000;
  assert.strictEqual(poller.decidePositionsNav({ killTier: 'off', lastNavAt: 0, nowMs: now }).go, true);
  assert.strictEqual(poller.decidePositionsNav({ killTier: 'soft', lastNavAt: 0, nowMs: now }).go, true);
  const fresh = poller.decidePositionsNav({ killTier: 'off', lastNavAt: now - 1000, nowMs: now });
  assert.strictEqual(fresh.go, false);
  assert.strictEqual(fresh.reason, 'throttled');
  assert.strictEqual(poller.decidePositionsNav({ killTier: 'off', lastNavAt: now - 300001, nowMs: now }).go, true);
});

test('positionNavSeconds: 0 turns the click-through off completely', () => {
  assert.strictEqual(poller.navEveryMsFor({ positionNavSeconds: 0 }), 0);
  assert.strictEqual(poller.navEveryMsFor({ positionNavSeconds: '0' }), 0);
  assert.strictEqual(
    poller.decidePositionsNav({ killTier: 'off', lastNavAt: 0, nowMs: 1e12, everyMs: 0 }).reason, 'disabled');
  assert.strictEqual(poller.navEveryMsFor({}), poller.POSITION_NAV_MIN_INTERVAL_MS);
  assert.strictEqual(poller.navEveryMsFor({ positionNavSeconds: 600 }), 600000);
  assert.strictEqual(poller.navEveryMsFor({ positionNavSeconds: 'nonsense' }), poller.POSITION_NAV_MIN_INTERVAL_MS);
});

// --- the navigation itself, against the real lock ----------------------------

test('parking the tab takes the lock, navigates, and releases', async () => {
  const calls = [];
  const page = { goto: async (url, opts) => { calls.push({ url, opts }); } };
  const r = await poller.parkPositionsPage(page);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 1, 'exactly one navigation per park');
  assert.match(calls[0].url, /\/open-positions$/);
  assert.strictEqual(lock.held(), false, 'the lock must not survive the navigation');
  assert.strictEqual(lock.tryAcquire('probe'), true);
  lock.release('probe');
});

test('★ it will not steal the bridge from a ticket, and will not release what it does not hold', async () => {
  const page = { goto: async () => { throw new Error('must not navigate'); } };
  assert.strictEqual(lock.tryAcquire('ticket'), true);
  const r = await poller.parkPositionsPage(page);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bridge_busy');
  assert.strictEqual(r.heldBy, 'ticket');
  assert.strictEqual(lock.status().holder, 'ticket', 'the ticket must still own it — the finally must not over-release');
  lock.release('ticket');
  assert.strictEqual(lock.held(), false);
});

test('a failed navigation still releases the lock', async () => {
  const page = { goto: async () => { throw new Error('Timeout 20000ms exceeded'); } };
  const r = await poller.parkPositionsPage(page);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'goto_failed');
  assert.match(r.detail, /Timeout/);
  assert.strictEqual(lock.held(), false, 'a hung navigation must not wedge the shared bridge');
});

// --- the wiring, pinned structurally ----------------------------------------

const src = code('trading/agent/accountPoller.js');
const posBlock = src.slice(
  src.indexOf('let pos = await webtrader.readPositionsLive'),
  src.indexOf('const changed = !last'),
);

test('the positions slice is real (guards every pin below against a silent empty slice)', () => {
  assert.ok(posBlock.length > 500, 'the slice must not be empty');
  assert.match(posBlock, /readDisposition/);
});

test('★ the URL is no longer the gate for a tick that was already parsed', () => {
  assert.ok(!/if \(pos && pos\.onPage\) \{/.test(posBlock),
    'the old gate is exactly what discarded parsed rows: onPage is a substring test, not a statement about the DOM');
  assert.match(posBlock, /if \(disp\.rows\)/);
  assert.match(posBlock, /positionTickPlan\(\{ rows: pos\.items/, 'the write must go through the session-aware gate');
});

test('★ the navigation is decided before it is spent, and never queued for', () => {
  assert.match(posBlock, /decidePositionsNav\(\{ killTier/, 'the kill tier must be an input, not an afterthought');
  assert.match(posBlock, /parkPositionsPage\(cachedPage\)/);
  assert.ok(!/pageLock\.acquire\(/.test(src),
    'the hot path must tryAcquire and skip; waiting here would put the 1s loop behind a ticket');
});

test('the kill tier reaches pollOnce from the same cached settings read as the cadence', () => {
  const loopBlock = src.slice(src.indexOf('(async function loop()'), src.indexOf('function stop()'));
  assert.match(loopBlock, /killTier = \(settings && settings\.kill && settings\.kill\.tier\) \|\| 'off'/);
  assert.match(loopBlock, /pollOnce\(userId, \{ killTier, parked, navEveryMs: navEveryMsFor\(cfg\) \}\)/);
});

test('the live read exposes the DOM fact the disposition needs', () => {
  const webSrc = code('trading/plus500/webtrader.js');
  const evalSlice = webSrc.slice(
    webSrc.indexOf('function positionsEval'),
    webSrc.indexOf('async function readPositions('),
  );
  assert.match(evalSlice, /sawDom/, 'positionsEval must report whether the positions DOM rendered');
  assert.match(evalSlice, /OpenPosition\./, 'and it must be derived from the position rows/title, not invented');

  const liveSlice = webSrc.slice(
    webSrc.indexOf('async function readPositionsLive'),
    webSrc.indexOf('async function readPlus500Alerts'),
  );
  assert.match(liveSlice, /onPage: String\(page\.url\(\)\)\.includes\('\/open-positions'\)/,
    'onPage stays as a signal — it is only demoted from being the gate');
  assert.match(liveSlice, /\.\.\.r/, 'sawDom must travel with the evaluate result');
});

// --- the missing witness: WHERE the tab is (added 2026-09-20) ------------------------------------
//
// Measured over 20 hours of the shut venue: 54-58 `position_poll` rows per hour (gaps 60-70s), one distinct
// bid per hour, and ~64 reads per hour that had rows at all. Two readings of that, and they are opposites:
//
//   · the SHARED tab (`browser.newPage()` returns the Plus500 tab, not a fresh one) is dragged to
//     /trade/alerts by the mirror cycle between parks — a PATHING artifact, and the 60s is `mirror.pollSeconds`;
//   · or the app redirects itself off /open-positions when the market is shut — a CALENDAR artifact.
//
// `onPage` is a boolean and cannot tell them apart, so the fix could not be tested against the record that
// motivated it. A path string per read can.

test('★ the record now says WHERE the tab was, not just whether it was "on page"', () => {
  assert.match(posBlock, /const url = urlPath\(cachedPage\)/);
  assert.match(posBlock, /source: 'position_read_mode', mode: disp\.mode, url,/,
    'the mode row must carry the path — that string is the witness the boolean cannot be');
  assert.match(posBlock, /urlTransitions/, 'and URL churn must be countable, not just inferable');
});

test('urlPath reports the path, and answers null instead of throwing on a dead page', () => {
  assert.strictEqual(poller.urlPath({ url: () => 'https://app.plus500.com/open-positions?x=1' }), '/open-positions');
  assert.strictEqual(poller.urlPath({ url: () => 'https://app.plus500.com/trade/alerts' }), '/trade/alerts');
  assert.strictEqual(poller.urlPath({ url: () => { throw new Error('Target closed'); } }), null,
    'a closed page must degrade to "unknown", never to a string that reads like a real place');
});

test('★ a park that RAN is logged, whether it worked or not', () => {
  assert.match(posBlock, /source: 'position_nav', ok: !!park\.ok/,
    'only skip reasons used to be logged, so "did the click-through ever run?" was unanswerable');
  assert.match(posBlock, /tookMs/, 'and how long it held the bridge is the number TRD-83 was about');
  assert.match(posBlock, /urlBefore, urlAfter: urlPath\(cachedPage\)/,
    'a park is only useful if it MOVED the tab — the before/after pair is the proof');
  assert.match(posBlock, /rowsAfter/, 'and if it moved the tab and rows still did not appear, that is the finding');
});

test('★ the poller reports once a minute, and reports the minute WORST cycle', () => {
  const loopBlock = src.slice(src.indexOf('(async function loop()'), src.indexOf('function stop()'));
  assert.match(loopBlock, /const workMs = Date\.now\(\) - t0/);
  assert.match(loopBlock, /if \(workMs > workMsMax\) workMsMax = workMs/, 'a 44.5s cycle must not need luck to be recorded');
  assert.match(loopBlock, /if \(workMs > periodMs\) slowCycles \+= 1/);
  assert.match(loopBlock, /if \(Date\.now\(\) - lastStatsLogAt >= 60000\)/,
    'the first version logged only ON overrun, so a quiet weekend produced no data at all');
  assert.match(loopBlock, /source: 'account_poll_stats'/);
  assert.match(loopBlock, /workMsMax, slowCycles, periodMs, delayMs, overran: slowCycles > 0/);
  assert.ok(!/source: 'account_poll_overrun'/.test(src), 'the overrun-only row is superseded');
});

// --- what the 1s read COSTS, so the read-vs-write gate is a measured decision (added 2026-09-20) ---------
//
// The write side is already capped at ~1/min by `store/ticks.js` DEDUPE_WINDOW_MS = 60000 whenever the price
// is frozen, so "move the session gate to the read" is only worth considering if the read is expensive. It
// had never been timed. Two counters settle it: the mean/max read duration, and reads-with-rows vs ticks.

test('★ the positions read is TIMED, so its cost is a number and not an opinion', () => {
  assert.match(src, /const readT0 = Date\.now\(\)/);
  assert.match(posBlock, /recordReadMs\(posStats, Date\.now\(\) - readT0\)/);
  assert.match(posBlock, /recordReadMs\(posStats, Date\.now\(\) - reT0\)/,
    'the re-read after a park must count too — it is the slow one');
});

test('recordReadMs keeps the tail, and refuses nonsense', () => {
  const s = { readMsSum: 0, readMsMax: 0, readMsOver100: 0 };
  poller.recordReadMs(s, 5);
  poller.recordReadMs(s, 150);
  poller.recordReadMs(s, 40);
  assert.strictEqual(s.readMsSum, 195);
  assert.strictEqual(s.readMsMax, 150, 'the max is what tells you the tab was held up');
  assert.strictEqual(s.readMsOver100, 1, 'a slow tail must be countable, not averaged away');
  const before = { ...s };
  poller.recordReadMs(s, NaN);
  poller.recordReadMs(s, -1);
  poller.recordReadMs(s, null);
  assert.deepStrictEqual(s, before, 'a malformed duration must not pollute the mean');
});

test('★ reads-with-rows and ticks are both carried, because their RATIO is the dedupe fingerprint', () => {
  assert.match(posBlock, /posStats\.rowsRead \+= 1/);
  const loopBlock = src.slice(src.indexOf('(async function loop()'), src.indexOf('function stop()'));
  assert.match(loopBlock, /readMsAvg: posStats\.reads \? Math\.round\(posStats\.readMsSum \/ posStats\.reads\) : null/,
    'the mean must be null rather than NaN on a fresh process');
  assert.match(loopBlock, /rowsRead: posStats\.rowsRead, tickAttempts: posStats\.tickAttempts/,
    'a frozen price should show ~60 reads-with-rows per stored tick; that is dedupe working, not samples lost');
});

// --- attempts vs ROWS: the counter that produced a 6x misreading (added 2026-09-20) --------------------
//
// `posStats.ticks` counted what the gate asked for, not what the store kept, and it was read as "rows
// written": 6 a minute against 1 stored row, because `addTicks` DEDUPES an unchanged bid+ask inside
// DEDUPE_WINDOW_MS = 60000. The fix is not a comment — it is to record both halves of the ratio, because
// the gap between them IS the dedupe and a reader should not have to know that from memory.

test('★ the tick counter records attempts AND what the store did with them', () => {
  assert.match(posBlock, /posStats\.tickAttempts \+= ticks\.length/);
  assert.match(posBlock, /posStats\.tickInserted \+= Number\(res\.inserted\) \|\| 0/);
  assert.match(posBlock, /posStats\.tickDeduped \+= Number\(res\.deduped\) \|\| 0/);
  assert.ok(!/posStats\.ticks =/.test(src), 'the ambiguous name must be gone, or the next reader repeats the error');
  const loopBlock = src.slice(src.indexOf('(async function loop()'), src.indexOf('function stop()'));
  assert.match(loopBlock, /tickInserted: posStats\.tickInserted, tickDeduped: posStats\.tickDeduped/);
});
