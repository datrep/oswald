'use strict';
// TRD-GRD-5 (2026-09-25) — the chart bucketing, pinned.
//
// WHAT THE ROW ASKED FOR AND COULD NOT GET. Its gate has two halves. Bucket alignment passed (measured: 0 rows
// off the hour in 22,739). The RANGE-FIDELITY half could not be discharged, and the row says why: the chart's
// own 5m and 30m bars are never stored, so an aggregated hour cannot be recomputed; the only independent 1h
// series is the tick-built one, and that is disqualified because the tick feed's density varies ~40x across the
// period being compared. Its stated next action was therefore to RECORD HOW MANY SOURCE BARS BUILT EACH ROW.
//
// So this file pins two things:
//   1. the merge arithmetic is REPORTED at write time (`merge.histogram`), which is what the row asked for; and
//   2. ★ AN AGGREGATED HOUR AND A NATIVE HOUR CARRY THE SAME OHLC — which is the proof that the merge count is
//      the ONLY fact that distinguishes them, and therefore that volume (0 on every chart row) could never
//      have carried it. That is the non-vacuity test for the whole task.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { bucketChartBars } = require('../trading/plus500/capture');

const HOUR = 3600000;
// A fixed, aligned hour so nothing depends on the clock.
const H0 = Date.UTC(2026, 8, 24, 10, 0, 0);

// One NATIVE hourly bar with a known shape.
const NATIVE = [{ DT: H0, Open: 100, High: 110, Low: 90, Close: 105, Volume: null }];

// TWELVE 5-minute bars whose union has the SAME open / high / low / close as the native hour above.
function twelve5m() {
  const bars = [];
  for (let i = 0; i < 12; i++) {
    const o = 100 + i * 0.5;
    bars.push({ DT: H0 + i * 300000, Open: o, High: o + 0.25, Low: o - 0.25, Close: o + 0.25, Volume: null });
  }
  // force the union's extremes and the final close to match the native bar exactly
  bars[0].Open = 100;
  bars[3].High = 110;
  bars[7].Low = 90;
  bars[11].Close = 105;
  return bars;
}

// TWO 30-minute bars whose union has the SAME open / high / low / close as the native hour above. 1800 is the
// interval that still merges INTO a 1h bucket, now that 5m and 1m have timeframes of their own.
function two30m() {
  return [
    { DT: H0, Open: 100, High: 110, Low: 95, Close: 99, Volume: null },
    { DT: H0 + 1800000, Open: 99, High: 103, Low: 90, Close: 105, Volume: null },
  ];
}

test('a native 1h chart writes one source bar per bucket', () => {
  const b = bucketChartBars(NATIVE, 3600);
  assert.equal(b.target, '1h');
  assert.equal(b.bucketMs, HOUR);
  assert.equal(b.fallThrough, false);
  assert.equal(b.nativePerBucket, 1);
  assert.deepEqual(b.merge.histogram, { 1: 1 });
  assert.equal(b.merge.merged, false, 'nothing was merged, so nothing needs a caveat');
});

test('a 30m chart is MAPPED to 1h, not a fall-through — and merges exactly two bars', () => {
  // ⚠ `1800` IS IN THE MAP (`{1800: '1h'}`), so it must NOT report fallThrough: the substitution it performs
  // is declared. Conflating the mapped case with the unmapped one would make the fall-through flag useless.
  const bars = [];
  for (let i = 0; i < 4; i++) bars.push({ DT: H0 + i * 1800000, Open: 100 + i, High: 101 + i, Low: 99 + i, Close: 100.5 + i, Volume: null });
  const b = bucketChartBars(bars, 1800);
  assert.equal(b.target, '1h');
  assert.equal(b.fallThrough, false);
  assert.equal(b.nativePerBucket, 2);
  assert.deepEqual(b.merge.histogram, { 2: 2 }, 'two hours, two source bars each');
  assert.equal(b.merge.merged, true);
});

test('a 5m chart has its OWN timeframe now — and a genuinely unmapped interval still reports fall-through', () => {
  // 2026-10-21: `300` joined the map. Until then it fell through to 1h and twelve 5m bars became one row,
  // which is why the finer structure could never be measured. It is now a first-class series.
  const b = bucketChartBars(twelve5m(), 300);
  assert.equal(b.target, '5m', '300 maps to its own timeframe');
  assert.equal(b.bucketMs, 300000);
  assert.equal(b.fallThrough, false, '300 IS in the map');
  assert.equal(b.nativePerBucket, 1);
  assert.equal(b.merge.buckets, 12, 'twelve 5m bars are twelve buckets, not one merged hour');
  assert.equal(b.merge.merged, false);

  // ⚠ AND THE FALL-THROUGH FLAG MUST STILL MEAN SOMETHING. 20 minutes is not on the ladder, so the substitution
  // to 1h must still be NAMED rather than left inferable — the case the original test existed to protect.
  const twenty = bucketChartBars(twelve5m(), 1200);
  assert.equal(twenty.target, '1h', 'an unmapped interval is still substituted');
  assert.equal(twenty.fallThrough, true, 'and the flag says so');
  assert.equal(twenty.nativePerBucket, 3, 'three 20m bars per hour');
});

test('mapped intervals produce their own timeframe', () => {
  const fifteen = [];
  for (let i = 0; i < 8; i++) fifteen.push({ DT: H0 + i * 900000, Open: 1, High: 2, Low: 0, Close: 1, Volume: null });
  const b = bucketChartBars(fifteen, 900);
  assert.equal(b.target, '15m');
  assert.equal(b.bucketMs, 900000);
  assert.equal(b.fallThrough, false, '900 IS mapped');
  assert.equal(b.nativePerBucket, 1);
  assert.equal(b.merge.buckets, 8);

  const four = bucketChartBars([{ DT: H0, Open: 1, High: 2, Low: 0, Close: 1, Volume: null }], 14400);
  assert.equal(four.target, '4h');
  assert.equal(four.bucketMs, 14400000);

  const day = bucketChartBars([{ DT: H0, Open: 1, High: 2, Low: 0, Close: 1, Volume: null }], 86400);
  assert.equal(day.target, '1d');
});

test('an UNKNOWN interval is a fall-through, and an ABSENT one is not', () => {
  // 7200s (2h) is unmapped -> substituted, and the flag says so.
  const unknown = bucketChartBars([{ DT: H0, Open: 1, High: 2, Low: 0, Close: 1, Volume: null }], 7200);
  assert.equal(unknown.target, '1h');
  assert.equal(unknown.fallThrough, true);
  assert.equal(unknown.nativePerBucket, 0.5, 'a 2h chart into 1h buckets is a SUBDIVISION, not a merge');

  // ★ AN ABSENT INTERVAL IS NOT A SUBSTITUTION. Nothing was declared, so nothing was overridden — the caller
  // records `sourceIntervalSec = null`, which means "unknown", and calling that a fall-through would blame the
  // mapping for the chart's silence. Absence is never a pass, and it is not a failure of this function either.
  for (const absent of [null, undefined]) {
    const b = bucketChartBars([{ DT: H0, Open: 1, High: 2, Low: 0, Close: 1, Volume: null }], absent);
    assert.equal(b.fallThrough, false, `absence (${absent}) must not be reported as a mapped substitution`);
    assert.equal(b.nativePerBucket, null, 'an unknown interval has no expected merge factor');
    assert.equal(b.target, '1h');
  }
});

test('★ an aggregated hour and a native hour are INDISTINGUISHABLE by OHLC — so the merge count is the only proof', () => {
  // This is the non-vacuity test for TRD-GRD-5. If the two rows differed, the range-fidelity question could
  // have been answered from the stored data and the row would not have needed a new recorded field at all.
  //
  // ⚠ THE MERGE NOW COMES FROM 30m. Since 5m and 1m gained their own timeframes, 1800 -> '1h' is the remaining
  // interval that still merges INTO an hour, so it is the case that keeps this test meaningful.
  const native = bucketChartBars(NATIVE, 3600).rows;
  const aggregated = bucketChartBars(two30m(), 1800).rows;

  assert.equal(native.length, 1);
  assert.equal(aggregated.length, 1);
  assert.deepEqual(aggregated[0], native[0],
    'same open/high/low/close AND same barStart — the ONLY difference is how many source bars went in');

  // ...and the difference that remains is exactly the field the row asked to be recorded.
  assert.deepEqual(bucketChartBars(NATIVE, 3600).merge.histogram, { 1: 1 });
  assert.deepEqual(bucketChartBars(two30m(), 1800).merge.histogram, { 2: 1 });

  // And volume cannot carry it: the chart's volume is 0 and 0 == 0 on both sides.
  assert.equal(Number(aggregated[0].volume), 0);
  assert.equal(Number(native[0].volume), 0);
});

test('every bucket starts exactly on its boundary, and a partial hour is its own bucket', () => {
  // Alignment is the half of the row's gate that PASSED (measured: 0 of 22,739 rows off the hour). Pinned here
  // so the floor cannot regress into a rounding. 25 half-hours is 12 full buckets plus one partial.
  const bars = [];
  for (let i = 0; i < 25; i++) bars.push({ DT: H0 + i * 1800000, Open: 1, High: 2, Low: 0, Close: 1, Volume: null });
  const b = bucketChartBars(bars, 1800);
  assert.equal(b.merge.buckets, 13, '25 half-hour bars span twelve full hour buckets and one partial');
  for (const r of b.rows) {
    assert.equal(r.barStart.getUTCMinutes(), 0, `bucket start must be on the hour, got ${r.barStart.toISOString()}`);
    assert.equal(r.barStart.getUTCSeconds(), 0);
    assert.equal(r.barStart.getTime() % HOUR, 0);
  }
  // 12 full buckets of two, then the partial one
  assert.deepEqual(b.merge.histogram, { 2: 12, 1: 1 });
  assert.equal(b.merge.min, 1);
  assert.equal(b.merge.max, 2);
});

test('an empty series reports nothing rather than a merge of zero', () => {
  const b = bucketChartBars([], 300);
  assert.equal(b.merge.buckets, 0);
  assert.equal(b.merge.min, null);
  assert.equal(b.merge.max, null);
  assert.equal(b.merge.merged, false);
  assert.deepEqual(b.merge.histogram, {});
  assert.deepEqual(b.rows, []);
});

test('the mapping decision was NOT taken silently, and the bucketing is not restated', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'capture.js'), 'utf8');
  // ★ The map is a DECLARED DECISION, and on 2026-10-21 it was declared differently: 60 -> '1m' and 300 -> '5m'
  // join it, because storing only 1h meant 59 of every 60 one-minute bars were destroyed at write time. The pin
  // is exact so any further change to the mapping has to be visible in this line.
  assert.match(src, /TF_MAP = Object\.freeze\(\{ 60: '1m', 300: '5m', 900: '15m', 1800: '1h', 3600: '1h', 14400: '4h', 86400: '1d' \}\)/,
    'the mapping is frozen so a silent edit is a visible one');
  assert.match(src, /const bucketed = bucketChartBars\(c\.bars, c\.intervalSec\)/,
    'bankChartBars must DELEGATE the bucketing');
  // ★ COUNTED, not merely present-or-absent. The first version of this assertion demanded ZERO occurrences and
  // failed — because the loop legitimately lives once, inside the extracted function. "Gone" was the wrong
  // claim; "exists in exactly one place" is the one that means what it is supposed to mean.
  const loops = (src.match(/const agg = buckets\.get\(start\)/g) || []).length;
  assert.equal(loops, 1,
    `the bucket loop must exist in EXACTLY one place — the extracted function (found ${loops})`);
  assert.equal((src.match(/buckets\.set\(start, agg\)/g) || []).length, 1, 'and its accumulator with it');
  assert.match(src, /chartMerge: bucketed\.merge/, 'the merge arithmetic must be reported in the capture result');
  // The 5m bucket must exist now that the function can target a declared timeframe it previously could not
  // reach: BUCKET_MS used to omit '5m' because nothing mapped to it.
  assert.match(src, /BUCKET_MS = Object\.freeze\(\{ '1m': 60000, '5m': 300000/);
});

test('★ the clean case is RECORDED, not merely absent — the GRD-4 heartbeat', () => {
  // The enforcement question is "does `mismatch` EVER fire on a healthy capture", and a record that only ever
  // holds anomalies can answer it only in the affirmative: health left no trace. So the clean branch writes a
  // low-cadence event instead of nothing.
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'capture.js'), 'utf8');
  assert.match(src, /const IDENTITY_HEARTBEAT_MS = 6 \* 3600 \* 1000;/);
  assert.match(src, /else if \(Date\.now\(\) - lastIdentityHeartbeat >= IDENTITY_HEARTBEAT_MS\)/,
    'the heartbeat must be the ELSE of the anomaly branch, so a clean sweep and an anomalous one cannot both fire');
  assert.match(src, /heartbeat: true/, 'and it must be LABELLED, so a reader can tell it from an anomaly');
  // ★ The heartbeat must not be quotable as authorisation — and the pin must not go stale in the OTHER
  // direction either. It asserts the INTENT (refusal stays an owner decision) and that a CLEARED blocker is no
  // longer claimed. The previous version pinned one literal sentence, and it went red the moment the coverage
  // gap that sentence described was closed on 2026-09-25: a pin on prose ages with the prose.
  assert.match(src, /refusal is an owner decision/, 'the heartbeat must say who owns the refusal decision');
  assert.match(src, /COVERAGE gap was closed 2026-09-25/, 'and must record the gate that WAS closed, with its date');
  assert.doesNotMatch(src, /Enforcement remains unauthorised while any symbol is unregistered/,
    'the cleared blocker must not still be claimed — a stale recorded claim is what these rows exist to stop');
  // The anomaly branch still wins, and its condition is unchanged.
  assert.match(src, /if \(chartIdentity\.mismatch \|\| chartIdentity\.unrecorded \|\| chartIdentity\.unregistered\)/);
  // And TRD-GRD-5's merge arithmetic rides the heartbeat, because the capture result is written down nowhere
  // else and the fidelity question needs a durable record of how many source bars built each stored row.
  assert.match(src, /merge: chartMerge,/);
});

