// test/pricebars-provenance.test.js — 043: the interval a bar was built FROM is recorded, not assumed.
//
// ★ THE DEFECT THIS PINS (design doc §4.1). `capture.bankChartBars` maps
//   {900:'15m', 1800:'1h', 3600:'1h', 14400:'4h', 86400:'1d'} and FALLS THROUGH to '1h' for anything else.
//   So a 30-MINUTE chart is stored with `timeframe = '1h'`, two 30m bars merged into each bucket — and
//   `tfMap` sends BOTH 1800 and 3600 to '1h', which means the stored `timeframe` ALONE cannot distinguish
//   the two provenances. Nothing on the row said which one it was, so no consumer could ever tell.
//
// ★ WHY IT MATTERS RATHER THAN BEING PEDANTRY. The capture's interval is whatever the last flow to navigate
//   the tab left the chart on, and the chart profile is PER SYMBOL — a single sweep can therefore write rows
//   of different provenance under one label. Every statistic this desk derives from bars is a RANGE
//   statistic (protected swings, BOS levels, the dealing range, ATR multiples of swing distance), and a
//   range statistic computed across a sampling-interval change is not comparable bar to bar. The engine
//   cannot check a basis it was never given.
//
// ★ THE FIX, IN TWO PARTS, and the second is the one that keeps it fixed:
//   1. `PriceBars.sourceIntervalSec` — the sampling interval, in seconds, of the series the row was built
//      from. `native` is then DERIVED (`sourceIntervalSec === seconds(timeframe)`), not asserted.
//   2. A writer that does not declare it now THROWS. That is the part with teeth: the original bug was a
//      silent substitution (`|| '1h'`), and the only reliable defence against a silent substitution is to
//      make the absent value an error rather than a default. An explicit `null` is still allowed and means
//      "unknown" — a RECORDED unknown, which is different from a forgotten one (TRD-111: `undefined` is not
//      `null` when the consequence is a substitution downstream).
//
// ★ A NOTE ON THE SOURCE PINS BELOW. They are regexes over comment-stripped code, because a pin that also
//   matches the PROSE describing the change passes on a file where the change was reverted (the TRD-68
//   lesson). They are deliberately narrow: they assert that the declaration comes from the CHART READING
//   and not from the bucket the mapping chose, which is the entire content of the defect.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  TIMEFRAME_SECONDS, BAR_TIMEFRAMES, barIntervalProvenance, sourceIntervalOf, upsertProviderBars,
} = require('../trading/store/bars');

// Comments stripped: each pin must match CODE, not the comment that explains the code.
// ★ `split(/\r?\n/)`, NOT `split('\n')`. Splitting on `\n` alone leaves the `\r` on the end of every line,
// and `/\/\/.*$/` then cannot match — `.` will not cross `\r` and `$` is end-of-STRING here — so the
// comments were never stripped at all and every pin in this file was matching prose. It passed anyway,
// which is the point: a POSITIVE `assert.match` cannot detect a broken stripper, only a NEGATIVE pin can.
function codeOnly(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

// ── 1. The premise. If this stops being true the column is unnecessary, and that should be a decision. ──
test('PREMISE: the map sends 1800 and 3600 to the SAME label, which is why timeframe cannot carry provenance', () => {
  const capture = codeOnly('trading/plus500/capture.js');
  // ★ MATCH THE COLLISION, NOT THE IDENTIFIER (2026-09-25). This pin used to name the literal `tfMap`, so
  // extracting the bucketing into `bucketChartBars`/`TF_MAP` (TRD-GRD-5) broke a test that was still checking
  // the right premise. A rename failing a premise check is noise, and noise trains a reader to update the pin
  // without reading it — which is how a premise check quietly stops checking its premise. What matters is that
  // BOTH 1800 and 3600 resolve to '1h'; the parse below asserts exactly that and survives any rename.
  const m = capture.match(/TF_MAP = Object\.freeze\(\{([^}]*)\}\)/);
  assert.ok(m, 'the chart-timeframe map must still exist in capture.js as a frozen literal');
  const byLabel = new Map();
  for (const x of m[1].matchAll(/(\d+):\s*'([^']+)'/g)) {
    const label = x[2];
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(Number(x[1]));
  }
  const on1h = byLabel.get('1h') || [];
  assert.ok(on1h.includes(1800) && on1h.includes(3600),
    `1800 and 3600 must still collide on the '1h' label — a '1h' row's timeframe cannot then say which chart built it. Found on 1h: ${JSON.stringify(on1h)}`);
});

// ── 1b. The volume rollup publishes a sum only when every component was known (4.6/4.7-A, 2026-10-03) ──
test('the interval rollup never passes off a PARTIAL sum as the window s volume', () => {
  const bars = codeOnly('trading/store/bars.js');
  assert.match(bars, /volume = CASE WHEN COUNT\(volume\) = COUNT\(\*\) THEN SUM\(volume\) END/,
    'SUM() skips NULLs — the rollup must return NULL unless EVERY hourly component carried volume');
});

// ── 2. Declare-or-throw. The silent `|| '1h'` made loud. ───────────────────────────────────────────────
test('a row that OMITS sourceIntervalSec is rejected instead of being assumed to be 1h', () => {
  assert.throws(
    () => sourceIntervalOf({ symbol: 'Gold', timeframe: '1h' }),
    (e) => e instanceof RangeError && /Gold/.test(e.message) && /sourceIntervalSec/.test(e.message),
    'an absent declaration must throw — assuming 1h is exactly the defect',
  );
});

test('an explicit NULL is accepted and means unknown — undefined is not null', () => {
  assert.strictEqual(sourceIntervalOf({ symbol: 'Gold', sourceIntervalSec: null }), null);
});

test('zero, negative and non-numeric intervals are rejected rather than coerced', () => {
  for (const bad of [0, -1800, 'abc', NaN, Infinity]) {
    assert.throws(
      () => sourceIntervalOf({ symbol: 'Gold', sourceIntervalSec: bad }),
      RangeError,
      `sourceIntervalSec ${JSON.stringify(bad)} must not reach the store`,
    );
  }
});

// The check runs BEFORE the pool is opened, so an undeclared batch fails without a database at all — which
// is also what makes this testable in the unit suite.
test('upsertProviderBars rejects an undeclared row before it reaches the database', async () => {
  await assert.rejects(
    () => upsertProviderBars(1, [{
      venue: 'plus500_chart', symbol: 'Gold', timeframe: '1h', barStart: new Date('2026-09-22T00:00:00Z'),
      openPrice: 4349, high: 4376, low: 4340, closePrice: 4370, volume: 0,
    }]),
    RangeError,
  );
});

test('an empty batch is still a no-op', async () => {
  assert.deepStrictEqual(await upsertProviderBars(1, []), { upserted: 0, flagged: 0 });
});

// ── 3. Derived, not asserted. ─────────────────────────────────────────────────────────────────────────
test('THE DEFECT ITSELF: a 30-minute chart stored as "1h" is NOT native', () => {
  const p = barIntervalProvenance({ timeframe: '1h', sourceIntervalSec: 1800 });
  assert.strictEqual(p.expectedIntervalSec, 3600);
  assert.strictEqual(p.native, false);
  assert.strictEqual(p.aggregated, true);
});

test('a genuine 1h row is native', () => {
  const p = barIntervalProvenance({ timeframe: '1h', sourceIntervalSec: 3600 });
  assert.strictEqual(p.native, true);
  assert.strictEqual(p.aggregated, false);
});

test('a daily bar built from hourly rows is not native to 1d', () => {
  // upsertDailyBars aggregates 1h rows, so its source interval is 3600 — the column says so rather than
  // letting a reader assume the bucket size is the sampling interval.
  assert.strictEqual(barIntervalProvenance({ timeframe: '1d', sourceIntervalSec: 3600 }).native, false);
});

test('an UNRECORDED row reports unknown, which is neither native nor aggregated', () => {
  const p = barIntervalProvenance({ timeframe: '1h', sourceIntervalSec: null });
  assert.strictEqual(p.native, null, 'an unrecorded provenance must not read as a pass');
  assert.strictEqual(p.aggregated, null);
});

test('TIMEFRAME_SECONDS covers every timeframe the store accepts', () => {
  // 2026-10-21: `1m` joins the ladder. The pin is deliberately exact, so extending the store REQUIRES this
  // line to change — which is the point: a timeframe that exists in BAR_TIMEFRAMES but not here would make
  // `barIntervalProvenance` unable to judge a row it accepted.
  assert.deepStrictEqual(
    TIMEFRAME_SECONDS,
    { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 },
  );
  assert.deepStrictEqual(
    BAR_TIMEFRAMES,
    Object.keys(TIMEFRAME_SECONDS),
    'the accepted list and the seconds ladder must stay the same set, in the same order',
  );
});

// ── 4. Source pins on the writers — the declaration is the CHART'S interval, not the bucket's. ────────
test('the chart capture declares the interval it READ, not the target it bucketed into', () => {
  const capture = codeOnly('trading/plus500/capture.js');
  assert.match(
    capture,
    /sourceIntervalSec:\s*c\.intervalSec/,
    'the row must carry readChartBars\' own intervalSec — `target` is a bucketing decision, not the fact',
  );
});

test('the tick-built hour path records 3600 by construction', () => {
  const bars = codeOnly('trading/store/bars.js');
  assert.match(bars, /sourceIntervalSec = 3600/);
  assert.match(bars, /'1h', s\.bar, s\.openPrice, s\.high, s\.low, s\.closePrice, s\.ticks, 3600\);/);
});

test('upsertProviderBars checks EVERY row up front, including rows barViolation will discard', () => {
  const bars = codeOnly('trading/store/bars.js');
  assert.match(
    bars,
    /for \(const b of rows\) sourceIntervalOf\(b\);/,
    'a validity-conditional check would let provenance be omitted on exactly the rows most likely to be re-examined',
  );
  assert.match(bars, /table\.columns\.add\('sourceIntervalSec', sql\.Int/);
});
