'use strict';
// instrumentRefresh.test.js — the daily contract-spec refresh cadence.
//
// `Instruments` was fed only by a manual UI probe and its newest row was 26 days old, while `carryPctFor` prices
// overnight carry on held positions from it. The refresh clicks rows on the ONE shared tab and holds the `ticket`
// page lock that orders wait up to 240s on, so the cadence is the safety mechanism, not a detail.
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../trading/plus500/instrumentRefresh');

const at = (iso) => new Date(iso);

test('shouldRun: disabled is disabled', () => {
  assert.deepStrictEqual(r.shouldRun({ now: at('2026-10-27T03:00:00Z'), cfg: { ...r.DEFAULTS, enabled: false } }),
    { run: false, reason: 'disabled' });
});

test('shouldRun: refuses OUTSIDE the quiet window — the tab is shared with live trading', () => {
  // 09:00Z is inside the HK/SG session and inside the desk's active hours.
  const v = r.shouldRun({ now: at('2026-10-27T09:00:00Z'), lastAt: null });
  assert.equal(v.run, false);
  assert.match(v.reason, /outside_quiet_hours \(9Z\)/);
});

test('shouldRun: runs inside the quiet window when nothing has run', () => {
  assert.deepStrictEqual(r.shouldRun({ now: at('2026-10-27T03:00:00Z'), lastAt: null }), { run: true, reason: 'due' });
});

test('shouldRun: a recent run blocks a second one, so an hourly timer is not an hourly sweep', () => {
  const v = r.shouldRun({ now: at('2026-10-27T03:30:00Z'), lastAt: at('2026-10-27T02:10:00Z') });
  assert.equal(v.run, false);
  assert.match(v.reason, /recent \(1\.3h ago\)/);
});

test('shouldRun: an hourly timer yields about one run per day, not one per tick', () => {
  // ⚠ THE FIRST VERSION OF THIS TEST SEEDED `last` AT 02:05 ON THE SAME DAY IT ITERATED, so every tick was "too
  // recent" and it measured 0 runs — the rule was right and the fixture was wrong. The last run must be a day
  // earlier for a day of ticks to contain a refresh at all.
  let ran = 0;
  let last = at('2026-10-25T02:05:00Z');
  const start = at('2026-10-25T00:00:00Z').getTime();
  for (let h = 1; h <= 72; h++) {
    const now = at(new Date(start + h * 3600000).toISOString());
    if (r.shouldRun({ now, lastAt: last }).run) { ran += 1; last = now; }
  }
  // Three days of hourly ticks, a three-hour window and a 23-hour floor: one refresh per day, never 72.
  assert.ok(ran >= 2 && ran <= 4, `expected 2-4 runs across 72 hourly ticks, got ${ran}`);
});

test('shouldRun: an unreadable last-run time does not block forever', () => {
  // `lastRunAt` returns null on a failed read. Ignorance is not evidence of a recent run.
  assert.equal(r.shouldRun({ now: at('2026-10-27T03:00:00Z'), lastAt: null }).run, true);
  assert.equal(r.shouldRun({ now: at('2026-10-27T03:00:00Z'), lastAt: 'not-a-date' }).run, true);
});

// ============================================================================================
// WHICH SYMBOLS, AND WHETHER A RUN COUNTS AT ALL
//
// ⚠ The only refresh this module has ever performed reported `ok: true, rowsOnPage: 0, scanned: 0`. It refreshed
// nothing, and because `lastRunAt` filters on `ok='true'` it also reset the 23h throttle — a probe that read nothing
// suppressing its own retry. Both halves are pinned below.
// ============================================================================================

const book = (open) => ({ getOpenTrades: async () => open });
const watch = (...syms) => ({ watchlist: { symbols: syms.map((s) => ({ symbol: s, source: 'manual' })) } });

test('★ the refresh set is the BOOK: open positions first, then the watchlist', async () => {
  // A symbol the desk HOLDS carries funding cost tonight; a symbol it merely watches is interest, not need.
  const plan = await r.symbolsToRefresh(1, watch('Gold', 'Oil'), { symbols: 6 }, book([{ symbol: 'Bitcoin' }]));
  assert.deepStrictEqual(plan.take, ['Bitcoin', 'Gold', 'Oil']);
  assert.equal(plan.total, 3);
  assert.equal(plan.cappedOut, 0);
});

test('a symbol in both the book and the watchlist is refreshed ONCE', async () => {
  const plan = await r.symbolsToRefresh(1, watch('Gold', 'Oil'), { symbols: 6 }, book([{ symbol: 'Gold' }]));
  assert.deepStrictEqual(plan.take, ['Gold', 'Oil']);
  assert.equal(plan.total, 2);
});

test('the cap bounds the walk but counts what it left out rather than dropping it', async () => {
  const plan = await r.symbolsToRefresh(1, watch('Gold', 'Oil', 'Silver'), { symbols: 2 }, book([{ symbol: 'Bitcoin' }]));
  assert.deepStrictEqual(plan.take, ['Bitcoin', 'Gold']);
  assert.equal(plan.total, 4);
  assert.equal(plan.cappedOut, 2);
});

test('an unreadable book still lets the watchlist refresh — but is not silently an empty book', async () => {
  const broke = { getOpenTrades: async () => { throw new Error('db down'); } };
  const plan = await r.symbolsToRefresh(1, watch('Gold'), { symbols: 6 }, broke);
  assert.deepStrictEqual(plan.take, ['Gold']);
  assert.match(plan.openError, /db down/);
});

test('★ nothing_refreshed is a REASON, not a success — the exact defect this replaced', () => {
  const plan = { take: ['Gold'], total: 1, cappedOut: 0, openError: null };
  assert.match(r.refreshReason({ plan, refreshed: [], failed: [{ symbol: 'Gold', reason: 'no_rows' }] }),
    /^nothing_refreshed \(no_rows\)$/);
  // The old code returned `refreshed` for this case, which is what reset the throttle.
  assert.notEqual(r.refreshReason({ plan, refreshed: [], failed: [] }), 'refreshed');
});

test('refreshReason names every other outcome', () => {
  const plan = { take: ['Gold'], total: 1, cappedOut: 0, openError: null };
  assert.equal(r.refreshReason({ plan, refreshed: [{ symbol: 'Gold', instruments: 1 }], failed: [] }), 'refreshed');
  assert.equal(r.refreshReason({ plan, refreshed: [{ symbol: 'Gold' }], failed: [{ symbol: 'Oil', reason: 'x' }] }), 'partial');
  assert.equal(r.refreshReason({ plan: { take: [], openError: null } }), 'no_symbols');
  // An unreadable book and an empty one are different answers.
  assert.equal(r.refreshReason({ plan: { take: [], openError: 'db down' } }), 'no_symbols_book_unreadable');
});

test('the cap is a real number even when the config omits it', async () => {
  const plan = await r.symbolsToRefresh(1, watch('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'), {}, book([]));
  assert.equal(plan.take.length, 6);
  assert.equal(plan.cappedOut, 2);
});
