// test/meter-page-walk.test.js — 2026-09-30: the meter must read the DAY, not its newest page.
//
// THE DEFECT THIS PINS. `budget.todayUsage()` summed ONE page of `llm_usage` rows and published the
// result as the day's total, so any day whose rows outnumbered `EVENT_QUERY_CAP` (500) produced a
// FLOOR reported as a total. Measured live before the fix:
//
//   2026-09-29   549 calls written, 500 read   -> 71,086 tokens (5.3%) invisible to the meter
//   2026-09-28   624 calls written, 500 read
//   2026-09-23   547 calls written, 500 read
//
// and because the caps are PER-CONSUMER the loss was not spread evenly: on 09-29 `shadow` stood at
// 270,022 (90.0% of its 300,000 cap) and the meter published 243,093 (81.0%), so `budget.allow()`
// saw nine points of headroom that did not exist. Three of the previous eight days were over the
// cap, so this was the meter's behaviour the moment the desk got busy — not an edge case.
//
// TWO THINGS MUST STAY TRUE, and the second is why the fix did NOT move the meter onto SQL:
//   1. the accumulator reads every row of the window (the tests below, by pages);
//   2. the independent detector (`meterIntegrity`) still compares two DIFFERENT code paths. If the
//      meter had been rewritten to use `store.llmUsageSince`, the detector would be comparing SQL
//      to SQL and would have silently retired the one control that caught this. So the meter keeps
//      its own `Number(...) || 0` arithmetic over its own field names; only the ROW SET changed.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const store = require('../trading/store');
const budget = require('../trading/agent/budget');
const { assess } = require('../trading/agent/meterIntegrity');

const nowIso = () => new Date().toISOString();
const row = (consumer, prompt, completion) => ({ createdAt: nowIso(), payload: { consumer, promptTokens: prompt, completionTokens: completion } });

test('todayUsage sums EVERY page the walk returns, not the newest one', async (t) => {
  const original = store.listEventsAll;
  t.after(() => { store.listEventsAll = original; });

  // Two pages: 500 rows of 1,000 tokens then 49 rows of 1,000 tokens — the 2026-09-29 shape.
  const rows = [];
  for (let i = 0; i < 549; i += 1) rows.push(row('shadow', 600, 400));
  store.listEventsAll = async () => ({ rows, pages: 2, truncated: false, pageSize: 500 });

  const usage = await budget.todayUsage(1);
  assert.equal(usage.calls, 549, 'a day of 549 calls must count 549, not the 500 that fit one page');
  assert.equal(usage.total, 549000, 'and the SUM must cover the same population the count does');
  assert.equal(usage.by.shadow, 549000);
  assert.equal(usage.fetched, 549);
  assert.equal(usage.pages, 2, 'the read reports how many pages it took');
  assert.equal(usage.truncated, false);
});

test('todayUsage asks the store for TODAY, at the page cap, and lets the store walk it', async (t) => {
  const original = store.listEventsAll;
  t.after(() => { store.listEventsAll = original; });

  let seen = null;
  store.listEventsAll = async (userId, opts) => { seen = { userId, opts }; return { rows: [], pages: 1, truncated: false }; };
  const usage = await budget.todayUsage(7);

  assert.equal(seen.userId, 7, 'the window belongs to the user being metered');
  assert.equal(seen.opts.kind, 'llm_usage', 'the accumulator reads the usage stream, not every event');
  assert.equal(seen.opts.pageSize, store.EVENT_QUERY_CAP, 'the page size is the store cap, not a request the store cannot honour');
  assert.ok(seen.opts.since instanceof Date, 'the window starts at the UTC day boundary');
  assert.equal(seen.opts.since.getTime(), budget.dayStartUtc().getTime(), 'and it is the SAME boundary the detector uses');
  assert.equal(usage.cap, store.EVENT_QUERY_CAP);
  assert.equal(usage.requestedLimit, store.EVENT_QUERY_CAP);
});

test('a walk that gave up is surfaced, never laundered into a total', async (t) => {
  const original = store.listEventsAll;
  t.after(() => { store.listEventsAll = original; });

  store.listEventsAll = async () => ({ rows: [row('chair', 10, 10)], pages: 40, truncated: true });
  const usage = await budget.todayUsage(1);
  assert.equal(usage.truncated, true, 'a bounded walk must say so — the caller cannot tell a total from a floor otherwise');
  assert.equal(usage.pages, 40);
});

test('the accumulator no longer takes a single page (falsifiable source pin)', () => {
  const src = code('trading/agent/budget.js');
  assert.match(src, /listEventsAll/, 'todayUsage must consume the paging helper');
  // The old form — a bounded single read published as a total — must not come back.
  assert.doesNotMatch(src, /const events = await store\.listEvents\(userId, \{ kind: 'llm_usage', limit: requestedLimit, since \}\)/,
    'the single-page accumulator is the defect, not an implementation detail');
});

test('the detector is NOT weakened: a short read still pages, and agreement is still ok', () => {
  const base = { dbEvents: 549, dbTokens: 549000, cap: 500, requestedLimit: 500, consumers: ['shadow'], seenConsumers: ['shadow'] };

  // FIXED: the walk read all 549 rows across 2 pages and the independent SQL count agrees.
  const walked = assess({ ...base, meteredTokens: 549000, meteredCalls: 549, fetched: 549, pages: 2, truncated: false });
  assert.equal(walked.status, 'ok', 'reading the whole day must clear the red honestly');
  assert.equal(walked.saturated, true, 'a 549-row read is still context: it reached the page cap');
  assert.match(walked.detail, /over 2 page\(s\)/, 'and the context names how many pages it took');
  assert.match(walked.detail, /nothing was dropped/);

  // UNFIXED (the historical shape): 500 of 549 read. This must STILL be bad — otherwise the fix
  // would have been a check that got quieter rather than a meter that got right.
  const short = assess({ ...base, meteredTokens: 500000, meteredCalls: 500, fetched: 500, pages: 1, truncated: false });
  assert.equal(short.status, 'bad');
  assert.ok(short.findings.some((f) => f.code === 'meter_dropped_rows'), 'row loss stays provable and stays bad');
});

test('a walk that stopped short is its own bad finding, distinct from a short sum', () => {
  const r = assess({
    dbEvents: 30000, dbTokens: 9000000, meteredTokens: 9000000, meteredCalls: 30000, fetched: 20000,
    pages: 40, truncated: true, cap: 500, requestedLimit: 500,
    consumers: ['chair'], seenConsumers: ['chair'],
  });
  assert.equal(r.status, 'bad');
  const f = r.findings.find((x) => x.code === 'meter_read_truncated');
  assert.ok(f, 'the meter admitting it stopped is a finding in its own right');
  assert.match(f.detail, /FLOOR being presented as a total/);

  // ...and the flag is only a defect when TRUE. `false`/absent must not fire: an absent input is not
  // evidence of damage (the same rule the missing-call-count guard above already follows).
  assert.equal(assess({ dbEvents: 10, dbTokens: 100, meteredTokens: 100, meteredCalls: 10, fetched: 10, pages: 1, truncated: false, cap: 500, requestedLimit: 500, consumers: ['chair'], seenConsumers: ['chair'] }).status, 'ok');
  assert.equal(assess({ dbEvents: 10, dbTokens: 100, meteredTokens: 100, meteredCalls: 10, fetched: 10, cap: 500, requestedLimit: 500, consumers: ['chair'], seenConsumers: ['chair'] }).status, 'ok');
});

test('the paging helper is a keyset walk that reports its own bound', async () => {
  const src = code('trading/store.js');
  assert.match(src, /async function listEventsAll/, 'the paging helper must exist');
  assert.match(src, /AND id < @beforeId/, 'the cursor must be keyset on the id the read already orders by');
  assert.match(src, /truncated/, 'a bounded walk must be able to say it stopped');
  // The single-page read stays single-page: `listEvents` is used for "the newest N" everywhere else.
  assert.match(src, /SELECT TOP \(@limit\) \* FROM TradingEvents/, 'listEvents keeps its existing contract');
});
