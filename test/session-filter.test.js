// test/session-filter.test.js — TRD-18 entry gate checks.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const session = require('../trading/agent/lab/session');
const regturtle = require('../trading/agent/strategies/regimeTurtle');
const lab = require('../trading/agent/lab');

const hourMs = (h) => Date.UTC(2026, 0, 5, h, 0, 0);

test('entryAllowed: the frozen filter is NOT usable -> everything allowed', () => {
  assert.strictEqual(session.SESSION_FILTER.usable, false);
  for (let h = 0; h < 24; h++) assert.strictEqual(session.entryAllowed(hourMs(h)), true);
});

test('entryAllowed: a usable filter blocks only its skip hours', () => {
  const f = { usable: true, skipHoursUtc: [17, 18, 19] };
  assert.strictEqual(session.entryAllowed(hourMs(17), f), false);
  assert.strictEqual(session.entryAllowed(hourMs(19), f), false);
  assert.strictEqual(session.entryAllowed(hourMs(20), f), true);
  assert.strictEqual(session.entryAllowed(hourMs(3), f), true);
});

test('candidate backtest honours cfg.sessionFilter at ENTRY time (re-train semantics)', () => {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push({ time: Date.UTC(2026, 0, 5, 0, 0, 0) + i * 3600000, open: 100, high: 100.5, low: 99.5, close: 100 });
  for (let i = 30; i < 90; i++) {
    const c = 100 + (i - 29);
    bars.push({ time: Date.UTC(2026, 0, 5, 0, 0, 0) + i * 3600000, open: c - 1, high: c + 0.5, low: c - 0.5, close: c });
  }
  const ctx = lab.labContext(bars, { k: 4 });
  const un = regturtle.backtest(bars, { capital: 10000 }, ctx);
  assert.ok(un.trades.length >= 1, 'without a filter the trend series trades');
  const blocked = regturtle.backtest(bars, { capital: 10000, sessionFilter: { usable: true, skipHoursUtc: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] } }, ctx);
  assert.strictEqual(blocked.trades.length, 0, 'a full-day filter blocks every entry');
});
