// test/live-backtest-parity.test.js — 2026-09-12: the reconciliation test that
// would have caught the trailing-anchor divergence (S3), and the one before it.
//
// WHY THIS EXISTS. Two live-vs-backtest divergences have been found on this desk
// by manual inspection, both silent, both invalidating prior evidence:
//   1. the CFD worksheet double-counted costs (TRD-25), and
//   2. the trailing-stop anchor was seeded from pre-entry bars in live
//      (quant.js) while the backtest seeds it from the entry price
//      (turtleUltimate.backtest) — see test/trailing-anchor.test.js.
// No test caught either, because each side was only ever tested in isolation. A
// unit test on quant.js proves quant.js is self-consistent; it cannot prove the
// desk and the backtest agree. This test drives BOTH REAL ENTRY POINTS on the
// same input and asserts they produce the same exit.
//
// WHAT IT ASSERTS. Given the same bar rows (the shape stored in PriceBars) and
// the same open-position record, the live path (quant.openPositionContext +
// turtleUltimate.liveSignal) and the backtester (turtleUltimate.backtest) must
//   - exit on the SAME bar, and
//   - exit at the SAME trail price.
// It is exact rather than approximate because the backtester records the stop
// itself as the trade's exitPrice (closePos(stop, i, 'trailing_stop')).
//
// WHAT IT DOES NOT COVER (stated so nobody over-reads a green run): the live desk
// has exit authorities the backtest does not model at all — the venue-native
// take-profit, and the LLM position-review loop. Parity here is parity of the
// TRAILING RULE only.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { atr, adx } = require('../trading/agent/indicators');
const turtle = require('../trading/agent/strategies/turtleUltimate');
const { openPositionContext } = require('../trading/agent/quant');

const CFG = {
  donchianPeriod: 20, adxPeriod: 14, adxGate: 20, atrPeriod: 14,
  atrStopMultiple: 2, riskPerTradePct: 1, capital: 10000,
};

// Bar ROWS in the stored shape (PriceBars): {barStart, openPrice, high, low, closePrice}.
// Built so the backtest enters once and is later stopped out by the trail.
//
// The pre-entry section deliberately contains a high (118) that is ABOVE anything
// the position will reach (the run tops out at 113.8). That is the day-one shape —
// Oil's pre-entry high ~104.3 against an entry at 99.9 — and it is the only way
// this test can detect a pre-entry fallback at all: if the pre-entry range sat
// below the post-entry peak, including it would not move the trail.
function barRows() {
  const rows = [];
  let t = Date.UTC(2026, 0, 1, 0);
  const push = (o, h, l, c) => {
    rows.push({ barStart: new Date(t).toISOString(), openPrice: o, high: h, low: l, closePrice: c });
    t += 3600000;
  };
  // 20 bars declining from a prior high of ~118 -> ~101 (pre-entry history).
  for (let i = 0; i < 20; i++) { const c = 118 - i * 0.9; push(c + 0.9, c + 1.0, c - 0.4, c); }
  // 25 bars of tight oscillation: narrow Donchian range, ADX builds.
  for (let i = 0; i < 25; i++) { const c = 100 + (i % 2 === 0 ? 0.3 : -0.3); push(100, c + 0.5, 100 - 1.0, c); }
  // Steady rise -> breakout above the range.
  for (let i = 0; i < 12; i++) { const c = 100.6 + i * 1.2; push(c - 1.2, c + 0.4, c - 1.4, c); }
  // Sharp pullback -> the trail is the first exit to trigger.
  for (let i = 0; i < 8; i++) { const c = 113.4 - i * 1.6; push(c + 1.6, c + 1.8, c - 0.2, c); }
  return rows;
}

// Exactly the mapping backtest.js:208 applies to the same rows.
const toSeries = (rows) => rows.map((b) => ({ open: b.openPrice, high: b.high, low: b.low, close: b.closePrice, time: b.barStart }));

// Mirror around 100 to turn the uptrend into a downtrend (highs/lows swap).
const mirror = (rows) => rows.map((r) => ({
  barStart: r.barStart, openPrice: 200 - r.openPrice, high: 200 - r.low, low: 200 - r.high, closePrice: 200 - r.closePrice,
}));

// Walk the LIVE path bar by bar over the same rows and return the first exit.
function liveExit(rows, trade, cfg) {
  const series = toSeries(rows);
  const highs = series.map((b) => b.high), lows = series.map((b) => b.low), closes = series.map((b) => b.close);
  const entryIdx = series.findIndex((b) => b.time === trade.entryTime);
  const open = { symbol: 'Test', venue: 'plus500', direction: trade.direction, openPrice: trade.entryPrice, openAt: rows[entryIdx].barStart };
  for (let k = entryIdx; k < rows.length; k++) {
    const a = atr(highs.slice(0, k + 1), lows.slice(0, k + 1), closes.slice(0, k + 1), cfg.atrPeriod);
    const d = adx(highs.slice(0, k + 1), lows.slice(0, k + 1), closes.slice(0, k + 1), cfg.adxPeriod);
    const openTrade = openPositionContext(rows.slice(0, k + 1), open); // the LIVE anchor
    const r = turtle.liveSignal({
      highs: highs.slice(0, k + 1), lows: lows.slice(0, k + 1), closes: closes.slice(0, k + 1),
      atr14: a, adx14: d, price: closes[k], prevPrice: k > 0 ? closes[k - 1] : null,
      params: { ...CFG }, openTrade,
    });
    if (r && r.type === 'exit') return { idx: k, basis: r.basis, direction: r.direction };
  }
  return null;
}

const stopFrom = (basis) => Number(String(basis).match(/trailing stop ([\d.]+) hit/)[1]);

for (const [label, rows] of [['long (breakout up)', barRows()], ['short (mirrored breakdown)', mirror(barRows())]]) {
  test(`live and backtest exit the same ${label} at the same trail price`, () => {
    const series = toSeries(rows);
    const res = turtle.backtest(series, CFG);
    const trade = res.trades[0];
    assert.ok(trade, 'scenario must produce a trade — fix the fixture, not the assertion');
    assert.strictEqual(trade.reason, 'trailing_stop', 'this scenario is about the trailing exit');

    const btIdx = series.findIndex((b) => b.time === trade.exitTime);
    const live = liveExit(rows, trade, CFG);
    assert.ok(live, 'the live path must also exit — a null here IS the S3 divergence');

    assert.strictEqual(live.idx, btIdx, `exit bar: live ${live.idx} vs backtest ${btIdx}`);
    assert.strictEqual(live.direction, trade.direction);
    assert.strictEqual(stopFrom(live.basis), +Number(trade.exitPrice).toFixed(4), 'same trail price');
  });
}

test('parity holds across an independent entry (no shared state between runs)', () => {
  // Guards against the test passing for an incidental reason: re-running the
  // backtest must give the same trade, and the live walk must land on the same
  // bar both times.
  const rows = barRows();
  const a = turtle.backtest(toSeries(rows), CFG).trades[0];
  const b = turtle.backtest(toSeries(rows), CFG).trades[0];
  assert.deepStrictEqual({ e: a.entryTime, x: a.exitTime, p: a.exitPrice }, { e: b.entryTime, x: b.exitTime, p: b.exitPrice });
  assert.deepStrictEqual(liveExit(rows, b, CFG), liveExit(rows, a, CFG));
});
