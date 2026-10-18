// test/pairs.test.js — TRD-24 pair lifecycle state machine checks.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const pairs = require('../trading/agent/pairs');

const quietLog = { write: async () => {} };

function leg(over = {}) {
  return { id: 0, symbol: 'Gold', direction: 'buy', size: 10, status: 'open', openAt: new Date(), pairId: 'P', ...over };
}

// --- pure classifier ----------------------------------------------------------

test('pairState: open / half_closed / unhedged / failed / closed / pending', () => {
  assert.deepStrictEqual(pairs.pairState([]), { state: 'pending', openLegs: 0, rejectedLegs: 0 });

  const both = pairs.pairState([leg({ id: 1 }), leg({ id: 2, symbol: 'Silver', direction: 'sell' })]);
  assert.strictEqual(both.state, 'open');
  assert.strictEqual(both.divergencePct, 0);

  const diverged = pairs.pairState([leg({ id: 1, size: 10 }), leg({ id: 2, symbol: 'Silver', size: 7 })]);
  assert.strictEqual(diverged.state, 'half_closed');
  assert.strictEqual(diverged.divergencePct, 30);

  const one = pairs.pairState([leg({ id: 1 })]);
  assert.strictEqual(one.state, 'unhedged');
  assert.strictEqual(one.survivor.id, 1);

  const failed = pairs.pairState([leg({ id: 1, status: 'rejected' })]);
  assert.strictEqual(failed.state, 'failed');

  const closed = pairs.pairState([leg({ id: 1, status: 'closed' }), leg({ id: 2 })]);
  assert.strictEqual(closed.state, 'unhedged'); // one still open
  assert.strictEqual(pairs.pairState([leg({ id: 1, status: 'closed' })]).state, 'closed');
});

// --- openPair policies ---------------------------------------------------------

function fakeExecutor({ aPlaced = true, bFailures = 0 } = {}) {
  const calls = { open: [], close: [] };
  let bAttempts = 0;
  return {
    calls,
    bAttempts: () => bAttempts,
    async openTrade(_u, _s, fields) {
      calls.open.push(fields);
      if (String(fields.note).includes('leg A')) {
        return aPlaced ? { placed: true, tradeId: 101 } : { placed: false, reason: 'rej_A' };
      }
      bAttempts += 1;
      return bAttempts > bFailures ? { placed: true, tradeId: 102 } : { placed: false, reason: 'rej_B' };
    },
    async closeTrade(_u, _s, tradeId) { calls.close.push(tradeId); return { closed: true }; },
  };
}

test('openPair: both legs fill and share one pairId', async () => {
  const ex = fakeExecutor();
  const r = await pairs.openPair(1, {}, { pairId: 'pair-open-1', legA: { symbol: 'Gold', direction: 'buy', size: 1 }, legB: { symbol: 'Silver', direction: 'sell', size: 1 } }, { executor: ex, log: quietLog, alert: async () => {} });
  assert.strictEqual(r.opened, true);
  assert.strictEqual(ex.calls.open.length, 2);
  assert.ok(ex.calls.open.every((f) => f.pairId === 'pair-open-1'));
  assert.strictEqual(ex.calls.close.length, 0);
});

test('openPair: leg B fails once, the single re-attempt succeeds', async () => {
  const ex = fakeExecutor({ bFailures: 1 });
  const r = await pairs.openPair(1, {}, { pairId: 'pair-retry-1', legA: { symbol: 'Gold', direction: 'buy', size: 1 }, legB: { symbol: 'Silver', direction: 'sell', size: 1 } }, { executor: ex, log: quietLog, alert: async () => {} });
  assert.strictEqual(r.opened, true);
  assert.strictEqual(ex.bAttempts(), 2);
  assert.strictEqual(ex.calls.close.length, 0);
});

test('openPair: leg B fails twice -> leg A is UNWOUND and an alert is sent', async () => {
  const ex = fakeExecutor({ bFailures: 2 });
  const sent = [];
  const r = await pairs.openPair(1, {}, { pairId: 'pair-fail-1', legA: { symbol: 'Gold', direction: 'buy', size: 1 }, legB: { symbol: 'Silver', direction: 'sell', size: 1 } }, { executor: ex, log: quietLog, alert: async (t) => sent.push(t) });
  assert.strictEqual(r.opened, false);
  assert.strictEqual(r.state, 'failed');
  assert.strictEqual(ex.bAttempts(), 2);
  assert.deepStrictEqual(ex.calls.close, [101]); // leg A unwound
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].includes('pair trade failed'));
});

test('openPair: leg A rejected -> no leg B attempt at all', async () => {
  const ex = fakeExecutor({ aPlaced: false });
  const r = await pairs.openPair(1, {}, { pairId: 'pair-failA-1', legA: { symbol: 'Gold', direction: 'buy', size: 1 }, legB: { symbol: 'Silver', direction: 'sell', size: 1 } }, { executor: ex, log: quietLog, alert: async () => {} });
  assert.strictEqual(r.opened, false);
  assert.strictEqual(ex.bAttempts(), 0);
});

// --- sweep policies ------------------------------------------------------------

function fakeStore(openTrades) {
  return { getOpenTrades: async () => openTrades };
}

test('sweep: unhedged survivor past the grace window is auto-unwound + alarm', async () => {
  const survivor = leg({ id: 7, pairId: 'pair-unh-1', openAt: new Date(Date.now() - 30 * 60000) });
  const ex = fakeExecutor();
  const sent = [];
  const r = await pairs.sweep(1, {}, { store: fakeStore([survivor]), executor: ex, alert: async (t) => sent.push(t), log: quietLog });
  assert.strictEqual(ex.calls.close.length, 1);
  assert.strictEqual(ex.calls.close[0], 7);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(r.items[0].state, 'unhedged_unwound');
});

test('sweep: young unhedged survivor only logs (no close, no alarm yet)', async () => {
  const survivor = leg({ id: 8, pairId: 'pair-unh-2', openAt: new Date(Date.now() - 60 * 1000) });
  const ex = fakeExecutor();
  const sent = [];
  const r = await pairs.sweep(1, {}, { store: fakeStore([survivor]), executor: ex, alert: async (t) => sent.push(t), log: quietLog });
  assert.strictEqual(ex.calls.close.length, 0);
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(r.items[0].state, 'unhedged');
});

test('sweep: half-close alarms once per transition', async () => {
  const legA = leg({ id: 9, pairId: 'pair-half-1', size: 10 });
  const legB = leg({ id: 10, pairId: 'pair-half-1', symbol: 'Silver', direction: 'sell', size: 4 });
  const ex = fakeExecutor();
  const sent = [];
  const deps = { store: fakeStore([legA, legB]), executor: ex, alert: async (t) => sent.push(t), log: quietLog };
  const r1 = await pairs.sweep(1, {}, deps);
  const r2 = await pairs.sweep(1, {}, deps);
  assert.strictEqual(r1.items[0].state, 'half_closed');
  assert.strictEqual(r2.items[0].state, 'half_closed');
  assert.strictEqual(sent.length, 1); // deduped across sweeps
});

test('sweep: healthy open pair -> state open, no actions', async () => {
  const legA = leg({ id: 11, pairId: 'pair-ok-1', size: 10 });
  const legB = leg({ id: 12, pairId: 'pair-ok-1', symbol: 'Silver', direction: 'sell', size: 10 });
  const ex = fakeExecutor();
  const sent = [];
  const r = await pairs.sweep(1, {}, { store: fakeStore([legA, legB]), executor: ex, alert: async (t) => sent.push(t), log: quietLog });
  assert.strictEqual(r.items[0].state, 'open');
  assert.strictEqual(ex.calls.close.length, 0);
  assert.strictEqual(sent.length, 0);
});
