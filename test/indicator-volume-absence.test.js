// test/indicator-volume-absence.test.js — obv must not publish a CONSTANT as an indicator (2026-09-23).
//
// THE DEFECT: the presence guard was `volumes.some((v) => v != null && Number.isFinite(Number(v)))`, and
// `Number(0)` is finite — so an all-zero volume series PASSED it and obv returned `{ obv: 0 }`. A constant
// in an indicator field is worse than a null: a null reads as "missing", a 0 reads as "the volume balance
// is neutral", and it is rendered into the chair prompt as a real reading.
//
// WHY IT IS NOT A THEORETICAL BRANCH (measured 2026-09-23, `plus500_chart`): the venue's chart feed carries
// NO volume for whole instrument classes — Gold 0 of 1,142 bars, Silver 0 of 1,134, Bitcoin 0 of 1,207,
// BNB 0 of 504. And `capture.bankChartBars` writes `0` whether the feed OMITTED volume or the instrument
// had none, so zero and absent share one value in this data and a finiteness test cannot separate them.
// ("Present" therefore has to mean "varies".)
//
// The one case that must KEEP working is a series that mixes real volume with genuine quiet bars — zeros
// there are measurements, not a sentinel.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { obv } = require('../trading/agent/indicators');
const { bucketChartBars } = require('../trading/plus500/capture');

const CLOSES = [100, 101, 100, 102, 101];

test('an all-zero volume series is ABSENT, not a neutral balance', () => {
  assert.strictEqual(obv(CLOSES, CLOSES.map(() => 0)), null,
    '0 is finite, so the old guard accepted this and published a constant 0');
});

test('an all-null volume series is absent', () => {
  assert.strictEqual(obv(CLOSES, CLOSES.map(() => null)), null);
});

test('★ a CONSTANT volume series is degenerate — with no volume variation OBV is a direction tally', () => {
  // With constant volume the cumulative is (# up bars − # down bars) × that constant, i.e. a price-direction
  // count wearing a volume label. That is not On-Balance Volume.
  assert.strictEqual(obv(CLOSES, CLOSES.map(() => 7)), null);
});

test('★ zeros mixed with real volume stay USABLE — those zeros are real quiet bars', () => {
  const r = obv([100, 101, 100, 102], [0, 0, 0, 5]);
  assert.ok(r, 'one non-zero bar is enough to make the series informative');
  assert.strictEqual(r.obv, 5, 'only the final up-bar contributes');
});

test('real volume still produces a signed balance', () => {
  const up = obv([100, 101, 102], [10, 20, 30]);
  assert.ok(up && up.obv === 50, 'two up bars accumulate +20 and +30');
  const down = obv([102, 101, 100], [10, 20, 30]);
  assert.ok(down && down.obv === -50, 'and two down bars accumulate the negative');
});

test('a length mismatch is refused rather than silently truncated', () => {
  assert.strictEqual(obv([1, 2, 3], [1, 2]), null);
});

// ── the WRITER side (4.6/4.7-A, 2026-10-03): absence must reach the column as NULL, not 0 ───────────────
test('bucketChartBars seeds NULL — an omitted volume is never written as 0', () => {
  const bars = [
    { DT: 0, Open: 1, High: 2, Low: 0.5, Close: 1.5 },
    { DT: 60000, Open: 1.5, High: 2.5, Low: 1, Close: 2 },
  ];
  const r = bucketChartBars(bars, 3600);
  assert.strictEqual(r.rows[0].volume, null, 'no volume in the feed -> NULL in the row');
});

test('present volumes still sum; a mixed window sums exactly what was read', () => {
  const bars = [
    { DT: 0, Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 10 },
    { DT: 60000, Open: 1.5, High: 2.5, Low: 1, Close: 2, Volume: 5 },
    { DT: 61000, Open: 2, High: 2.2, Low: 1.9, Close: 2.1 },
  ];
  const r = bucketChartBars(bars, 3600);
  assert.strictEqual(r.rows[0].volume, 15);
});
