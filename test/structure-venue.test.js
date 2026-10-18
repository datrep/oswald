// test/structure-venue.test.js — which OHLC series owns structure, and why the answer is not assumed.
//
// ★ THE DEFECT THIS PINS (§10 residual Q1, the last item before S2). `VENUE_OF_RECORD` is the venue the
//   desk trades at, and that ONE venue is stored from TWO different paths:
//     `plus500`        — `upsertHourlyBars` builds each hour from MAX(mid)/MIN(mid) over the ~3-6 ticks the
//                        wake happened to capture, i.e. a SAMPLE of the hour;
//     `plus500_chart`  — the venue's OWN chart series (ChartIQ masterData), i.e. the venue's aggregation
//                        of its own feed.
//   A sample of an hour cannot contain that hour's extremes, so the sampled series understates RANGE — and
//   protected swings, BOS levels and the dealing range ARE those extremes. A protected low built on an
//   understated low is swept in reality while looking unbroken here, which is the one failure mode that
//   makes a level engine worse than no level engine.
//
// ★ MEASURED, NOT PREFERRED (`trading/scripts/repro/venue-fidelity-audit.js`, 2026-09-22):
//     Gold    tick 17.3 bps  chart 40.1 bps  yahoo ~41 bps
//     Oil     tick 27.0      chart 82.4      yahoo ~79
//     Sugar   tick 15.2      chart 82.4      yahoo ~52
//   The tick series is the outlier by 2-15x on every symbol measured; the tick high is BELOW the chart high
//   in 86% of Gold's overlapping hours and the tick low ABOVE the chart low in 99% (one-sided = sampling,
//   not a different instrument); and same-hour closes agree to |mean|/sd <= 0.24 (Gold -1.30 bps, Oil
//   +1.17), so switching the series moves the EXTREMES without moving the PRICE.
//
// ★ WHO THIS FILE IS FOR. The resolver is pure and lives outside the DB-bound block on purpose: the same
//   shape of decision went unnoticed for 2.4 hours in this file's history because it was inline (TRD-PRC-1).
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { resolveStructureVenue, STRUCTURE_CHART_VENUE } = require('../trading/agent/quant');
const { DEFAULTS } = require('../trading/agent/structure');

// Comments stripped: a pin must match CODE, not the comment that explains the code (the TRD-68 lesson).
// ★ `split(/\r?\n/)`, NOT `split('\n')`: splitting on `\n` alone leaves `\r` on every line and `/\/\/.*$/`
// then never matches, so the comments stay in and the pins match PROSE. A positive `assert.match` cannot
// detect that; the `doesNotMatch` pin at the bottom of this file is what does.
function codeOnly(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const ARGS = { configured: 'plus500', chartVenue: 'plus500_chart', minBars: 60 };

// ── 1. The decision itself ────────────────────────────────────────────────────────────────────────────
test('the venue\'s OWN chart series wins when it has enough history', () => {
  const r = resolveStructureVenue({ ...ARGS, chartBars: 300 });
  assert.strictEqual(r.venue, 'plus500_chart');
  assert.strictEqual(r.why, 'chart_series_faithful');
  assert.strictEqual(r.bars, 300);
});

test('exactly minBars is enough — the boundary is inclusive', () => {
  assert.strictEqual(resolveStructureVenue({ ...ARGS, chartBars: 60 }).venue, 'plus500_chart');
  assert.strictEqual(resolveStructureVenue({ ...ARGS, chartBars: 59 }).venue, 'plus500');
});

test('a thin chart series falls back to the configured venue, and says which kind of thin it was', () => {
  const below = resolveStructureVenue({ ...ARGS, chartBars: 12 });
  assert.strictEqual(below.venue, 'plus500');
  assert.strictEqual(below.why, 'chart_series_below_min_bars');
  assert.strictEqual(below.bars, null, 'the fallback series length was not read, so it must not be claimed');

  const absent = resolveStructureVenue({ ...ARGS, chartBars: 0 });
  assert.strictEqual(absent.why, 'chart_series_absent', 'absent and thin are different facts about the data');
});

test('a non-numeric chart count is treated as absent rather than as a large number', () => {
  for (const bad of [null, undefined, NaN, 'many']) {
    assert.strictEqual(resolveStructureVenue({ ...ARGS, chartBars: bad }).venue, 'plus500');
  }
});

// ── 2. The silent-substitution guard ─────────────────────────────────────────────────────────────────
test('an omitted minBars THROWS instead of silently choosing the fallback', () => {
  // `chartBars >= undefined` is FALSE, so an omitted minBars would have selected the fallback on every
  // symbol with no record of why. That is the substitution class this desk keeps paying for, so the
  // resolver refuses the input rather than absorbing it.
  for (const bad of [undefined, null, NaN, 0, -1, 'sixty']) {
    assert.throws(
      () => resolveStructureVenue({ ...ARGS, chartBars: 300, minBars: bad }),
      RangeError,
      `minBars ${JSON.stringify(bad)} must not be absorbed`,
    );
  }
});

test('the structure engine\'s own minBars is the threshold, not a second number to keep in sync', () => {
  assert.strictEqual(DEFAULTS.minBars, 60);
  const quant = codeOnly('trading/agent/quant.js');
  assert.match(
    quant,
    /minBars: STRUCTURE_DEFAULTS\.minBars/,
    'the resolver must be given the engine\'s minBars, or the two warm-up rules can drift apart',
  );
});

// ── 3. Source pins — the resolution is actually reached, and its reason survives ──────────────────────
test('evaluateSymbol resolves the venue instead of reading VENUE_OF_RECORD directly into the basis', () => {
  const quant = codeOnly('trading/agent/quant.js');
  assert.match(quant, /resolveStructureVenue\(\{/);
  assert.match(quant, /configured: VENUE_OF_RECORD/, 'the configured venue is the FALLBACK, never the primary');
  assert.match(quant, /chartVenue: STRUCTURE_CHART_VENUE/);
  assert.doesNotMatch(
    quant,
    /const structVenue = VENUE_OF_RECORD;/,
    'this line is the defect: it made the sampled series the level source unconditionally',
  );
});

test('the basis carries WHY the series was chosen, so a level is traceable to its highs and lows', () => {
  const structure = codeOnly('trading/agent/structure.js');
  // `outBasis` is built field-by-field, so a reason thread through `basis` is DROPPED unless it is named
  // there. Without these two lines `venueWhy` would be computed, passed, and thrown away.
  assert.match(structure, /venueWhy: \(basis && basis\.venueWhy\)/);
  assert.match(structure, /venueBars: \(basis && basis\.venueBars\)/);
});

test('the chart venue is named once as the STRUCTURE choice, and the choice goes through the constant', () => {
  assert.strictEqual(STRUCTURE_CHART_VENUE, 'plus500_chart');
  const quant = codeOnly('trading/agent/quant.js');
  assert.match(quant, /const STRUCTURE_CHART_VENUE = 'plus500_chart';/);
  assert.match(quant, /chartVenue: STRUCTURE_CHART_VENUE/);
  // The venue literal DOES appear elsewhere — `IND_VENUE_PREF` and `BIG_VENUES` — but those answer a
  // different question (which venue supplies INDICATORS) and are deliberately not authority on this one.
  // What must never happen is the structure choice reaching for a literal of its own.
  assert.doesNotMatch(
    quant,
    /chartVenue:\s*'/,
    'the structure venue must go through the constant, or a deliberate change becomes a hunt',
  );
});
