// Pins for the alternative-proxy agent's correlation core (2026-09-11).
// The agent must recognise same-direction proxies (~+1), inverse ones (~-1),
// and honestly refuse to score thin/absent overlap.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { alignedCorr } = require('../trading/agent/alternatives');

const series = (prices, start = Date.parse('2026-06-01T00:00:00Z'), step = 86400000) =>
  prices.map((c, i) => ({ t: start + i * step, c }));

const PRICES = [100, 101, 99, 102, 104, 103, 105, 107, 106, 108, 110, 109, 111, 112, 114, 113, 115, 117, 116, 118, 120, 119, 121, 123, 122];

test('identical series correlate at ~1', () => {
  const c = alignedCorr(series(PRICES), series(PRICES));
  assert.ok(c > 0.999, `expected ~1, got ${c}`);
});

test('inverse series (b = k/a) correlate at ~-1', () => {
  const b = PRICES.map((x) => 10000 / x);
  const c = alignedCorr(series(PRICES), series(b));
  assert.ok(c < -0.99, `expected ~-1, got ${c}`);
});

test('thin overlap returns null', () => {
  const a = series([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  assert.equal(alignedCorr(a, a), null);
});

test('disjoint timestamps return null', () => {
  const a = series(PRICES);
  const b = series(PRICES, Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(alignedCorr(a, b), null);
});

test('zero closes are skipped, not fatal', () => {
  const a = [
    100, 0, 101, 102, 103, 104, 105, 106, 107, 108, 109,
    110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
  ];
  const c = alignedCorr(series(a), series(a));
  assert.ok(Number.isFinite(c) && c > 0.9, `expected finite ~1, got ${c}`);
});
