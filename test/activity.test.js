// test/activity.test.js — the volume-free activity measure (design doc §6, P2 item 1).
//
// ★ WHAT THIS FILE HAS TO PROVE, and two of these are the kind of thing that is invisible when wrong:
//
//   1. NOTHING LOOKS FORWARD. The measure is computed over bars[0..asOf] and the baseline must not improve
//      when the future is appended. Tested by literally appending future bars and asserting the result is
//      unchanged — a property, not an inspection.
//   2. THE BAR IS NOT IN ITS OWN BASELINE. An off-by-one here (`i <= asOf`) drags the median toward the
//      value being measured, which shrinks the ratio that the measure exists to report. It would still
//      produce a plausible number, which is exactly why it needs a test rather than a reading.
//   3. THE BASELINE IS THE SAME HOUR ONLY. Intraday range has a strong shape (Bitcoin 251 at 20:00Z vs 557
//      at 14:00Z, §4.2), so a baseline that pooled hours would report the CLOCK as activity.
//   4. IT NEVER READS VOLUME. That is the entire reason this measure exists — `plus500.volume` is a capture
//      count and `plus500_chart.volume` is absent for Gold/Silver/Bitcoin/BNB (0 of 1,135 / 1,127 / 1,200 /
//      497 bars, measured 2026-09-22). A pin on the SOURCE, not on a result, because a volume read would
//      silently reintroduce the dependency this module was written to remove.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { computeActivity, DEFAULTS } = require('../trading/agent/activity');

const CLOSE = 100;
// Range and body are BASIS POINTS of the close, and `(high-low)/close*10000` is not exact in binary floating
// point (30 bps round-trips as 30.000000000001), so quantity assertions are tolerance comparisons. An
// exact-equality assertion on a derived float fails for reasons unrelated to the behaviour it pins.
const near = (actual, expected, what, tol = 1e-6) => {
  assert.ok(
    Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tol,
    `${what}: expected ~${expected}, got ${actual}`,
  );
};

// A bar whose range and body are EXACTLY the requested basis points of the close, so the fixture's expected
// values are arithmetic rather than "whatever the generator happened to produce".
function mkBar({ day, hour, rangeBps, bodyBps = 0, close = CLOSE }) {
  const rp = (rangeBps / 10000) * close;
  const bp = (bodyBps / 10000) * close;
  return {
    barStart: new Date(Date.UTC(2026, 8, day, hour, 0, 0)), // 2026-09-<day>T<hour>:00Z
    openPrice: close - bp,
    high: close + rp / 2,
    low: close - rp / 2,
    closePrice: close,
  };
}

// `days` full days of 24 hourly bars. `hourRange(hour)` decides the range of every bar at that hour, so a
// fixture can make one hour-of-day behave differently from the rest on purpose.
function series({ days, hourRange = () => 10, bodyRange = () => 0, startDay = 1 }) {
  const out = [];
  for (let d = 0; d < days; d++) {
    for (let h = 0; h < 24; h++) out.push(mkBar({ day: startDay + d, hour: h, rangeBps: hourRange(h), bodyBps: bodyRange(h) }));
  }
  return out;
}

const HOUR = 10;             // the hour-of-day under measurement
const NOW = { day: 21, hour: HOUR };

test('asOf is required, and it is required because a default would be the lookahead path', () => {
  const bars = series({ days: 25 });
  assert.throws(() => computeActivity({ bars }), /asOf is required/);
  assert.throws(() => computeActivity({ bars, asOf: 'nope' }), /asOf is required/);
  assert.throws(() => computeActivity({ bars, asOf: 10 ** 6 }), /outside/);
});

test('the range ratio is the measured bar against the MEDIAN of the same hour', () => {
  // Every 10:00Z bar has a 30 bps range; the measured bar has 60.
  const bars = [...series({ days: 20, hourRange: (h) => (h === HOUR ? 30 : 10) }), mkBar({ ...NOW, rangeBps: 60 })];
  const r = computeActivity({ bars, asOf: bars.length - 1 });
  assert.equal(r.state, 'ok');
  assert.equal(r.hourUtc, HOUR);
  assert.equal(r.samples, 20);
  near(r.range.nowBps, 60, 'now');
  near(r.range.medianBps, 30, 'median');
  near(r.range.ratio, 2, 'ratio');
  assert.equal(r.range.percentile, 1, 'nothing in the baseline was as wide, so the percentile is 1');
});

// ★ THE OFF-BY-ONE. With 20 baseline bars at 30 bps plus the measured bar at 60, an `i <= asOf` loop would
// use 21 samples with a median of 30 — the same median, so this fixture would NOT catch it. The fixture is
// built so that including the bar MOVES the median: an even count takes the mean of the two middle values.
test('★ the bar being measured is NOT in its own baseline', () => {
  // Baseline at this hour: 9 bars at 10 bps and 1 bar at 40 bps -> sorted [10 x9, 40], 10 samples, median = 10.
  const bars = series({ days: 10, hourRange: (h) => (h === HOUR ? 10 : 99) });
  // Make the newest same-hour baseline bar (day 10) unusually wide, so a stray inclusion would move things.
  const idx = bars.findIndex((b) => b.barStart.getUTCDate() === 10 && b.barStart.getUTCHours() === HOUR);
  assert.ok(idx > 0, 'fixture: day 10 at the measured hour must exist');
  bars[idx] = mkBar({ day: 10, hour: HOUR, rangeBps: 40 });
  bars.push(mkBar({ ...NOW, rangeBps: 100 }));

  const r = computeActivity({ bars, asOf: bars.length - 1 });
  assert.equal(r.samples, 10, 'ten same-hour baseline bars — eleven would mean the measured bar was counted');
  near(r.range.medianBps, 10, 'median of [10 x9, 40]');
  // An EVEN count takes the mean of the two middle values, which is why the fixture uses one outlier:
  // folding the measured 100 bps bar in would move the median to 25, not leave it at 10.
  assert.notEqual(Math.round(r.range.medianBps), 25, 'a median of 25 is the signature of self-inclusion');
});

test('★ only the same hour-of-day forms the baseline — the clock must not read as activity', () => {
  // Every other hour is WILD (500 bps); this hour is calm (10 bps). A pooled baseline would report the
  // measured bar as extremely quiet when it is exactly typical for its hour.
  const bars = [...series({ days: 20, hourRange: (h) => (h === HOUR ? 10 : 500) }), mkBar({ ...NOW, rangeBps: 10 })];
  const r = computeActivity({ bars, asOf: bars.length - 1 });
  assert.equal(r.samples, 20, 'only the 20 bars at 10:00Z');
  near(r.range.medianBps, 10, 'median');
  near(r.range.ratio, 1, 'typical for its own hour, despite being the quietest bar in the day');
});

test('★ nothing looks forward — appending future bars cannot change a past measurement', () => {
  const bars = [...series({ days: 20, hourRange: () => 20 }), mkBar({ ...NOW, rangeBps: 50 })];
  const asOf = bars.length - 1;
  const before = computeActivity({ bars, asOf });
  // Now append a year of extreme future bars at the same hour. A lookahead would fold them in.
  const future = [...bars, ...series({ days: 30, hourRange: () => 9000, startDay: 22 })];
  const after = computeActivity({ bars: future, asOf });
  assert.deepEqual(after, before, 'the measurement at asOf must be a function of bars[0..asOf] and nothing else');
});

test('the trailing window is bounded in DAYS, not in bar count', () => {
  // A huge bar at this hour sits 21 days back: outside the 20-day default, inside a 60-day one. The fixture
  // is CHRONOLOGICAL — `startDay` advances so that barStart order IS array order, because a fixture whose
  // order disagrees with its timestamps silently tests something other than the window logic.
  const old = mkBar({ day: 1, hour: HOUR, rangeBps: 5000 });
  const baseline = series({ days: 20, hourRange: () => 30, startDay: 2 });   // days 2..21
  const bars = [old, ...baseline, mkBar({ day: 22, hour: HOUR, rangeBps: 60 })];

  const wide = computeActivity({ bars, asOf: bars.length - 1 });
  assert.equal(wide.samples, 20, 'the 21-day-old bar is outside the default window');
  near(wide.range.medianBps, 30, 'and therefore cannot influence the median');

  const wider = computeActivity({ bars, asOf: bars.length - 1, params: { days: 60 } });
  assert.equal(wider.samples, 21, 'widening the window is what brings it in');
  assert.ok(wider.range.medianBps > 30, 'and then it does move the median — the window is doing real work');
});

test('insufficient_history is its OWN state, never a ratio computed from three samples', () => {
  const bars = [...series({ days: 3, hourRange: () => 30 }), mkBar({ ...NOW, rangeBps: 60 })];
  const r = computeActivity({ bars, asOf: bars.length - 1 });
  assert.equal(r.state, 'insufficient_history');
  assert.equal(r.range, null, 'no ratio at all, rather than a confident-looking one');
  assert.match(r.reason, /minSamples/);
  assert.equal(r.samples, 3, 'the count is still reported — the insufficiency is a fact about the data');
});

test('a zero baseline yields NO ratio rather than Infinity', () => {
  // Perfectly flat bars at this hour: median range 0. `x / 0` would report an infinitely active bar.
  const bars = [...series({ days: 20, hourRange: (h) => (h === HOUR ? 0 : 10) }), mkBar({ ...NOW, rangeBps: 60 })];
  const r = computeActivity({ bars, asOf: bars.length - 1 });
  assert.equal(r.state, 'ok');
  near(r.range.medianBps, 0, 'median');
  assert.strictEqual(r.range.ratio, null, 'undefined is not "very large"');
});

test('body is measured independently of range, and a wide bar need not have a wide body', () => {
  const bars = [...series({ days: 20, hourRange: () => 20, bodyRange: () => 5 }), mkBar({ ...NOW, rangeBps: 20, bodyBps: 20 })];
  const r = computeActivity({ bars, asOf: bars.length - 1 });
  near(r.body.medianBps, 5, 'body median');
  near(r.body.ratio, 4, 'body ratio');
  near(r.range.ratio, 1, 'the same bar is entirely typical BY RANGE — a range-only measure would call it unremarkable, ' +
    'which is why both are reported');
});

test('params are validated, and the resolved params are echoed with the result', () => {
  const bars = [...series({ days: 20, hourRange: () => 20 }), mkBar({ ...NOW, rangeBps: 40 })];
  const r = computeActivity({ bars, asOf: bars.length - 1, params: { days: 10, minSamples: 4 } });
  assert.deepEqual(r.params, { days: 10, minSamples: 4 }, 'every result states the N it used');
  assert.throws(() => computeActivity({ bars, asOf: bars.length - 1, params: { days: 0 } }), RangeError);
  assert.throws(() => computeActivity({ bars, asOf: bars.length - 1, params: { minSamples: 0 } }), RangeError);
  assert.throws(() => computeActivity({ bars, asOf: bars.length - 1, params: { days: 'twenty' } }), RangeError);
  assert.equal(DEFAULTS.days, 20);
});

test('the basis travels with the measurement, so a ratio can be traced to the series it came from', () => {
  const bars = [...series({ days: 20, hourRange: () => 20 }), mkBar({ ...NOW, rangeBps: 40 })];
  const r = computeActivity({ bars, asOf: bars.length - 1, basis: { venue: 'plus500_chart', venueWhy: 'chart_series_faithful', timeframe: '1h', sourceIntervalSec: 3600 } });
  assert.equal(r.basis.venue, 'plus500_chart');
  assert.equal(r.basis.venueWhy, 'chart_series_faithful');
  assert.equal(r.basis.sourceIntervalSec, 3600);
  assert.equal(r.basis.asOf, bars.length - 1);
});

// ★ SOURCE PIN. The measure is volume-free by construction; a future edit that reached for `volume` would
// reintroduce the exact dependency (Gold/Silver/Bitcoin have none) that this module exists to avoid — and
// it would do so silently, because the number would still look fine on Oil.
test('★ the module never reads volume, and never reads a clock or a random source', () => {
  // ★ `split(/\r?\n/)`, NOT `split('\n')`. On a CRLF file, splitting on `\n` leaves `\r` on every line and
  // `/\/\/.*$/` then never matches — so the comments stay in and a NEGATIVE pin passes on prose. That bug was
  // found HERE: it had silently disabled the same protection in two other test files.
  const src = fs.readFileSync(path.join(__dirname, '../trading/agent/activity.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(src, /volume/i, 'volume-free is the whole point — `plus500_chart` volume is 0 for the ' +
    'instrument survgold trades, so a volume read makes this module useless exactly where it is needed');
  assert.doesNotMatch(src, /Date\.now|Math\.random/);
  assert.doesNotMatch(src, /getPool|require\((['"])[^'"]*store|require\((['"])[^'"]*db\2/, 'no I/O — the caller supplies the bars');
  // PREMISE for the three pins above: the stripper must actually strip, or a negative pin passes on prose too.
  assert.doesNotMatch(src, /WHY THIS RATHER THAN RVOL/, 'comment stripping is broken, so the pins above prove nothing');
});
