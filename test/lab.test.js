// test/lab.test.js — offline unit checks for the Strategy Lab harness (TRD-13).
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lab = require('../trading/agent/lab');
const ind = require('../trading/agent/indicators');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthBars(n, fn) {
  return Array.from({ length: n }, (_, i) => {
    const { open, high, low, close } = fn(i);
    return { time: i, open, high, low, close };
  });
}

test('toKBar: OHLC aggregation, partial trailing block excluded', () => {
  // 10 bars -> two completed 4-bar blocks; bars 8-9 form a partial block.
  const bars = synthBars(10, (i) => ({ open: i, high: i + 1, low: i, close: i + 0.5 }));
  const blocks = lab.toKBar(bars, 4);
  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(
    { time: blocks[0].time, open: blocks[0].open, high: blocks[0].high, low: blocks[0].low, close: blocks[0].close },
    { time: 0, open: 0, high: 4, low: 0, close: 3.5 }
  );
  assert.deepStrictEqual(
    { time: blocks[1].time, open: blocks[1].open, high: blocks[1].high, low: blocks[1].low, close: blocks[1].close },
    { time: 4, open: 4, high: 8, low: 4, close: 7.5 }
  );
});

test('labContext: bar-causal visibility (no block or ratio leaks from the future)', () => {
  const bars = synthBars(9, () => ({ open: 100, high: 101, low: 99, close: 100 }))
    .map((b, i) => ({ ...b, time: i + 1 })); // realistic positive timestamps
  const ctx = lab.labContext(bars, { ratioBars: bars.map((b) => ({ ...b, close: 50 })) });
  // Completed 4h blocks: [0..3], [4..7]; bar 8 is a forming block.
  assert.strictEqual(ctx.blocks.length, 2);
  assert.strictEqual(ctx.counts[3], 1);
  assert.strictEqual(ctx.counts[7], 2);
  assert.strictEqual(ctx.counts[8], 2);
  assert.strictEqual(ctx.ctxAt(5).barsK.length, 1);
  assert.strictEqual(ctx.ctxAt(8).barsK.length, 2);
  // Ratio: all 9 bars have a matching time; at index 4 only times 1..5 visible.
  assert.strictEqual(ctx.ratio.length, 9);
  assert.strictEqual(ctx.ctxAt(4).ratio.length, 5);
  assert.strictEqual(ctx.ctxAt(4).ratio[4].ratio, 2);
});

test('regimeSeries: final ADX is float-identical to indicators.adx()', () => {
  const rng = mulberry32(0xC0FFEE);
  const bars = synthBars(300, () => {
    const drift = (rng() - 0.5) * 4;
    const base = 100 + drift;
    return { open: base, high: base + rng() * 2, low: base - rng() * 2, close: base + (rng() - 0.5) * 2 };
  });
  const flags = lab.regimeSeries(bars);
  const expected = ind.adx(bars.map((b) => b.high), bars.map((b) => b.low), bars.map((b) => b.close), 14);
  assert.ok(expected != null);
  assert.ok(Math.abs(flags[flags.length - 1].adx - expected) < 1e-9);
});

test('regimeSeries: causal — flag at i equals a recomputation on bars[0..i] only', () => {
  const rng = mulberry32(0xBEEF);
  const bars = synthBars(150, (i) => {
    const w = Math.sin(i / 5) * 3 + (rng() - 0.5) * 1.5;
    return { open: 50 + w, high: 50 + w + 1, low: 50 + w - 1, close: 50 + w };
  });
  const flags = lab.regimeSeries(bars);
  for (const i of [30, 60, 90, 120, 149]) {
    const prefix = lab.regimeSeries(bars.slice(0, i + 1));
    assert.deepStrictEqual(flags[i], prefix[i]);
  }
});

test('regimeSeries: trend and range regimes read correctly', () => {
  const up = synthBars(120, (i) => ({ open: 100 + i, high: 100 + i + 1, low: 100 + i - 0.5, close: 100 + i + 0.5 }));
  const upFlag = lab.regimeSeries(up)[119];
  assert.strictEqual(upFlag.regime, 'trend');
  assert.strictEqual(upFlag.dir, 'up');
  assert.ok(upFlag.adx > 25);

  const chop = synthBars(120, (i) => {
    const c = 100 + (i % 2 === 0 ? 2 : 0);
    return { open: c, high: c + 0.5, low: c - 0.5, close: c };
  });
  const chopFlag = lab.regimeSeries(chop)[119];
  assert.strictEqual(chopFlag.regime, 'range');
});

test('buildRatio: bar-start alignment drops mismatched timestamps', () => {
  const primary = [
    { time: 1, open: 10, high: 10, low: 10, close: 10 },
    { time: 2, open: 20, high: 20, low: 20, close: 20 },
    { time: 3, open: 30, high: 30, low: 30, close: 30 },
  ];
  const other = [
    { time: 2, open: 5, high: 5, low: 5, close: 5 },
    { time: 3, open: 6, high: 6, low: 6, close: 6 },
    { time: 4, open: 7, high: 7, low: 7, close: 7 }, // no primary bar -> dropped
  ];
  const ratio = lab.buildRatio(primary, other);
  assert.strictEqual(ratio.length, 2);
  assert.strictEqual(ratio[0].time, 2);
  assert.strictEqual(ratio[0].ratio, 4);
  assert.strictEqual(ratio[1].time, 3);
  assert.strictEqual(ratio[1].ratio, 5);
});

test('visibleUpTo: counts series elements with time <= t', () => {
  const s = [{ time: 1 }, { time: 3 }, { time: 5 }];
  assert.strictEqual(lab.visibleUpTo(s, 0), 0);
  assert.strictEqual(lab.visibleUpTo(s, 2), 1);
  assert.strictEqual(lab.visibleUpTo(s, 4), 2);
  assert.strictEqual(lab.visibleUpTo(s, 5), 3);
});

test('normalize: store rows map to the shared trade shape', () => {
  const rows = [{ barStart: '2026-09-10T00:00:00Z', openPrice: 1, high: 2, low: 0.5, closePrice: 1.5 }];
  const b = lab.normalize(rows)[0];
  assert.strictEqual(b.time, new Date('2026-09-10T00:00:00Z').getTime());
  assert.strictEqual(b.open, 1);
  assert.strictEqual(b.high, 2);
  assert.strictEqual(b.low, 0.5);
  assert.strictEqual(b.close, 1.5);
});
