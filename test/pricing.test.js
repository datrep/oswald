'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { windowAt, nextChangeAt, effectiveRates } = require('../services/pricing');

test('windowAt returns peak inside a window and off-peak outside', () => {
  const windows = [{ start: '01:00', end: '04:00' }];
  assert.equal(windowAt(new Date('2026-08-18T02:00:00Z'), windows), 'peak');
  assert.equal(windowAt(new Date('2026-08-18T05:00:00Z'), windows), 'off-peak');
});

test('windowAt handles overnight (wrap-around) windows', () => {
  const windows = [{ start: '22:00', end: '02:00' }];
  assert.equal(windowAt(new Date('2026-08-18T23:00:00Z'), windows), 'peak');
  assert.equal(windowAt(new Date('2026-08-18T12:00:00Z'), windows), 'off-peak');
});

test('nextChangeAt returns a future timestamp', () => {
  const windows = [{ start: '01:00', end: '04:00' }];
  const now = new Date('2026-08-18T00:00:00Z');
  assert.ok(new Date(nextChangeAt(now, windows)).getTime() > now.getTime());
});

test('effectiveRates picks the right model/window rates', () => {
  const cfg = {
    model: 'deepseek-v4-pro',
    peakWindows: [{ start: '01:00', end: '04:00' }],
    models: {
      'deepseek-v4-pro': {
        peak: { cacheHit: 1, cacheMiss: 2, output: 3 },
        offPeak: { cacheHit: 4, cacheMiss: 5, output: 6 },
      },
    },
  };
  const peak = effectiveRates(new Date('2026-08-18T02:00:00Z'), cfg);
  assert.equal(peak.window, 'peak');
  assert.equal(peak.inputCacheHitPer1M, 1);
  const off = effectiveRates(new Date('2026-08-18T05:00:00Z'), cfg);
  assert.equal(off.window, 'off-peak');
  assert.equal(off.outputPer1M, 6);
});
