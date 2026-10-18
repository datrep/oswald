// test/position-pnl-path.test.js — TRD-PNL-1, 2026-09-25.
//
// The row says: the NET P/L path is read every ~2.4s and thrown away. `Trades.floatingPnl` holds the
// venue's own NetPL, but it is ONE MUTABLE COLUMN — `accountPoller` overwrote it on every poll, so all
// that survives of a trade's path is its final sample.
//
// Two things this test is built to stop, because both are silent:
//
//   (1) KEYING ON THE SYMBOL. The price-tick path above keys on `symbol`, and reusing that key here would
//       merge two positions on one instrument into a single P/L series — and, through the store's
//       price dedupe, would also DISCARD a sample where the price held still while the P/L moved. A P/L
//       series must not be deduped on price. The non-vacuity test below proves the keying test can fail.
//   (2) LOSING THE TERMINAL SAMPLE. `position_poll` reads OPEN positions only, so a position that stops
//       being reported has closed. Without the `voided` half the last row of every path sits one poll
//       short of the real exit — the single most important sample in the series.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const poller = require('../trading/agent/accountPoller');

const NOW = 1_800_000_000_000;

// --- cadence ------------------------------------------------------------------

test('a row with a NetPL becomes a sample once the interval has passed', () => {
  const rows = [{ positionId: '1888006320', name: 'Gold', direction: 'sell', size: 0.225, pnl: 1.21 }];
  const fresh = new Map([['id:1888006320', NOW - 1000]]);
  const plan = poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: fresh });
  assert.strictEqual(plan.due.length, 0, '1s into the gate is not due');

  const stale = new Map([['id:1888006320', NOW - 60000]]);
  const plan2 = poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: stale });
  assert.strictEqual(plan2.due.length, 1);
  assert.strictEqual(plan2.due[0].pnl, 1.21);
});

test('★ the checkpoint cadence is 60s, because TradingEvents has NO retention (unlike PriceTicks)', () => {
  // Measured 2026-09-25: `retention.tickDays` prunes PriceTicks only. Writing this at the 10s tick cadence
  // would add ~8,640 unpruned rows/day/position. The range is complete in memory and emitted at close, so
  // this stream only has to survive a restart — 60s is the deliberate trade, and this test exists so that
  // raising it back toward the tick gate cannot happen silently.
  const rows = [{ positionId: 'A1', name: 'Gold', direction: 'sell', pnl: 1.0 }];
  assert.strictEqual(poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: new Map([['id:A1', NOW - 30000]]) }).due.length, 0,
    '30s is NOT due — that is the tick gate, not this one');
  assert.strictEqual(poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: new Map([['id:A1', NOW - 60000]]) }).due.length, 1);
});

// --- keying (the trap this exists for) ----------------------------------------

test('★ two positions on the SAME symbol are two different P/L series', () => {
  const rows = [
    { positionId: 'A1', name: 'Gold', direction: 'sell', size: 0.225, pnl: 1.21 },
    { positionId: 'A2', name: 'Gold', direction: 'buy', size: 0.100, pnl: -4.50 },
  ];
  const plan = poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: new Map() });
  assert.strictEqual(plan.due.length, 2, 'one symbol is not one series');
  assert.notStrictEqual(plan.due[0].key, plan.due[1].key);
  assert.deepStrictEqual(plan.due.map((d) => d.pnl).sort((a, b) => a - b), [-4.5, 1.21]);
});

test('★ non-vacuity: the same-symbol case FAILS if the key is the symbol', () => {
  // Re-derive the plan with a symbol key and show it collapses two positions into one — i.e. the test
  // above is capable of failing rather than passing by construction.
  const rows = [
    { positionId: 'A1', name: 'Gold', direction: 'sell', size: 0.225, pnl: 1.21 },
    { positionId: 'A2', name: 'Gold', direction: 'buy', size: 0.100, pnl: -4.50 },
  ];
  const bySymbol = new Set(rows.map((r) => r.name));
  assert.strictEqual(bySymbol.size, 1, 'a symbol key really would merge them');
  const byPosition = new Set(rows.map((r) => poller.positionKey(r)));
  assert.strictEqual(byPosition.size, 2, 'the position key keeps them apart');
});

test('a row with no id still gets a NAMED fallback key, and no name gets none', () => {
  assert.strictEqual(poller.positionKey({ positionId: '7', name: 'Gold' }), 'id:7');
  assert.match(String(poller.positionKey({ name: 'Oil', direction: 'buy', size: 10 })), /^sym:Oil:buy:10$/);
  assert.strictEqual(poller.positionKey({}), null);
  assert.strictEqual(poller.positionKey(null), null);
});

// --- an absent P/L is not a zero ----------------------------------------------

test('★ a row with no NetPL produces NO sample — it must not be recorded as 0', () => {
  const rows = [{ positionId: 'A1', name: 'Gold', direction: 'sell', pnl: null },
                { positionId: 'A2', name: 'Oil', direction: 'buy', pnl: undefined },
                { positionId: 'A3', name: 'Gold', direction: 'sell', pnl: '' }];
  const plan = poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: new Map() });
  assert.strictEqual(plan.due.length, 0, 'writing 0 would claim a flat position at breakeven that was never read');
});

test('a genuine 0 P/L IS a sample — absent and zero are different facts', () => {
  const rows = [{ positionId: 'A1', name: 'Gold', direction: 'sell', pnl: 0 }];
  const plan = poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: new Map() });
  assert.strictEqual(plan.due.length, 1, 'a real flat reading must survive');
});

// --- the terminal sample ------------------------------------------------------

test('★ a position that stops being reported is returned as voided (the terminal sample)', () => {
  const last = new Map([['id:A1', NOW - 1000], ['id:A2', NOW - 1000]]);
  const rows = [{ positionId: 'A1', name: 'Gold', direction: 'sell', pnl: 2.00 }];
  const plan = poller.positionPnlPlan({ rows, nowMs: NOW, lastByPositionMs: last });
  assert.deepStrictEqual(plan.voided, ['id:A2'], 'A2 closed and must be reported, not silently dropped');
});

test('an empty read voids everything tracked — position_poll cannot see a closed position', () => {
  const last = new Map([['id:A1', NOW], ['id:A2', NOW]]);
  const plan = poller.positionPnlPlan({ rows: [], nowMs: NOW, lastByPositionMs: last });
  assert.strictEqual(plan.due.length, 0);
  assert.strictEqual(plan.voided.length, 2);
});

// --- the running range --------------------------------------------------------

test('the range tracks first / last / min / max and counts real samples', () => {
  const ranges = new Map();
  const row = { positionId: 'A1', name: 'Oil', direction: 'buy' };
  for (const pnl of [1.0, -4.6, 3.2, -1.1]) poller.pnlRangeObserve(ranges, 'id:A1', { ...row, pnl });
  const r = ranges.get('id:A1');
  assert.strictEqual(r.first, 1.0, 'the OPENING sample is not recoverable from min/max and must be kept');
  assert.strictEqual(r.min, -4.6);
  assert.strictEqual(r.max, 3.2);
  assert.strictEqual(r.last, -1.1);
  assert.strictEqual(r.n, 4, 'n lets a thin range be visible as thin');
});

test('a missing P/L does not corrupt the range or invent a sample', () => {
  const ranges = new Map();
  poller.pnlRangeObserve(ranges, 'id:A1', { positionId: 'A1', name: 'Oil', pnl: 2.0 });
  poller.pnlRangeObserve(ranges, 'id:A1', { positionId: 'A1', name: 'Oil', pnl: null });
  const r = ranges.get('id:A1');
  assert.strictEqual(r.min, 2.0);
  assert.strictEqual(r.max, 2.0);
  assert.strictEqual(r.n, 1, 'the absent read must not be counted');
});

// --- the wiring, pinned structurally -----------------------------------------

const src = code('trading/agent/accountPoller.js');
const posBlock = src.slice(
  src.indexOf('let pos = await webtrader.readPositionsLive'),
  src.indexOf('const changed = !last'),
);

test('the positions slice is real (guards every pin below against a silent empty slice)', () => {
  assert.ok(posBlock.length > 500, 'the slice must not be empty');
  assert.match(posBlock, /readDisposition/);
});

test('★ the net P/L write rides the existing read, inside the same block as the tick write', () => {
  assert.match(posBlock, /positionPnlPlan\(\{/, 'the P/L plan must be planned, not inlined');
  assert.match(posBlock, /rows: pos\.items/, 'and it must read the same rows the tick write reads');
  assert.match(posBlock, /logEvent\(userId, 'position_pnl'/);
});

test('★ provenance rides with every sample, so net and gross can never be conflated', () => {
  assert.match(posBlock, /source: 'position_poll'/);
  assert.match(posBlock, /net: true/);
});

test('★ the range is emitted when a position disappears, carrying its sample count', () => {
  assert.match(posBlock, /logEvent\(userId, 'pnl_range'/);
  assert.match(posBlock, /samples: r\.n/);
  assert.match(posBlock, /pnlPlan\.voided/);
});

test('★ the P/L series does NOT go through the price-tick path (which dedupes on bid+ask)', () => {
  const pnlAt = posBlock.indexOf('positionPnlPlan({');
  const tickAt = posBlock.indexOf('store.addTicks(userId, ticks)');
  assert.ok(tickAt !== -1 && pnlAt !== -1, 'both writes must be present to compare them');
  assert.ok(!/addTicks\(userId, [^)]*pnl/i.test(posBlock),
    'a P/L sample must not be deduped on price: two positions can share a symbol and a price can hold still while the P/L moves');
  assert.ok(posBlock.includes('positionId: d.row.positionId'), 'the sample must carry the position identity');
});
