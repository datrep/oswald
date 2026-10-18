// test/chart-interval-verification.test.js — 2026-09-25.
//
// ★ WHY THIS IS NOT CALLED "THE PIN". The row was "nothing pins the chart interval", and the obvious fix —
// drive `stx.setPeriodicity` and assert 1h — WAS TRIED AND MEASURED, AND IT IS NOT AVAILABLE ON THIS VENUE.
// `setPeriodicity` EXISTS and returns without throwing, but its own minified source records the new layout
// UNCONDITIONALLY and only then tries to reload:
//
//     ke.periodicity=me, ke.interval=be, ke.timeUnit=Ce;              // the CLAIM, made first
//     ... if (needDifferentData) { if (quoteDriver) {...} else dataCallback ? dataCallback()
//           : console.log("cannot change periodicity because neither dataCallback or quoteDriver are set")
//
// and on the live engine `dataCallback === null` and `quoteDriver === false`, so the reload branch cannot run.
// MEASURED: `layout` read 3600s while the series measured 900000 ms of bar spacing, for 45 seconds across
// five navigations. It is a LABEL-CHANGER. Driving it would write rows labelled 1h, built from 15m bars,
// carrying `sourceIntervalSec = 3600` — design-doc §4.1 with a FALSIFIED provenance, strictly worse than the
// mixed label it replaced. So `setPeriodicity` is deliberately NOT called, and the test that says so is the
// first structural pin below.
//
// WHAT REPLACES IT, IN TWO PARTS:
//   1. THE INTERVAL IS VERIFIED, NOT TRUSTED. The series' own bar spacing is measured beside the layout's
//      claim, and a row is written only when the two AGREE. That makes a falsified provenance impossible
//      instead of merely unlikely.
//   2. THE 15-MINUTE HOLE IS CLOSED. `TF_MAP[900]` is `'15m'` — the ONLY entry below 1h — so every other
//      interval refreshes the 1h series, and a tab left on 15m (measured: it was) refreshed it NOT AT ALL.
//      Structure reads exactly one series, `quant.STRUCTURE_CHART_VENUE` at `timeframe: '1h'`, the primary
//      AND ONLY venue since TRD-STR-1, and nothing consumes `plus500_chart` at `'15m'` (`BIG_TFS` has no 15m
//      entry). A 15m read is therefore ROLLED UP to 1h via `store.upsertAggBars`, which declares
//      `sourceIntervalSec = 900` — so those rows are recorded as AGGREGATED, not native, which is exactly
//      what `barIntervalProvenance` exists to tell apart.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const webtrader = require('../trading/plus500/webtrader');
const { bucketChartBars } = require('../trading/plus500/capture');
const { barIntervalProvenance } = require('../trading/store/bars');

const captureSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'capture.js'), 'utf8');
const wtSrc = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'webtrader.js'), 'utf8');
// A pin that matches PROSE passes on the comment explaining the defect, so comments are stripped before every
// structural assertion. (This has cost three separate false failures in this repo.)
const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
const captureCode = codeOnly(captureSrc);
const wtCode = codeOnly(wtSrc);

function fnBody(srcText, name) {
  const start = srcText.indexOf(`async function ${name}(`);
  if (start === -1) return null;
  const rest = srcText.slice(start + 1);
  const cut = rest.indexOf('\nasync function ');
  return cut === -1 ? rest : rest.slice(0, cut);
}

const MIN = 60000;
const HOUR_MS = 3600000;
const H0 = Date.UTC(2026, 8, 24, 10, 0, 0);
// ⚠ THE BARS CARRY OHLC DELIBERATELY. `readChartBars` measures the spacing of the series it is about to
// STORE, i.e. AFTER its own `Close != null` filter — so a fixture of bare `{ DT }` objects is filtered away
// entirely and measures `null`. The first version of this file did exactly that and it is why the rule is
// asserted here on the same shape the capture actually returns.
const bar = (dt) => ({ DT: dt, Open: 100, High: 101, Low: 99, Close: 100.5, Volume: null });
function gapped(step, count) {
  return Array.from({ length: count }, (_, i) => bar(H0 + i * step));
}
// ★ THE LIVE SERIES, to scale: 988 deltas of 15m, 9 session breaks, 2 weekend gaps of 49.25h.
function live15m() {
  const bars = [];
  let t = H0;
  for (let i = 0; i < 12; i++) { bars.push(bar(t)); t += 15 * MIN; }
  t += 75 * MIN;                      // session break: the next delta is 15 + 75 = 90 minutes
  for (let i = 0; i < 12; i++) { bars.push(bar(t)); t += 15 * MIN; }
  t += 177300000;                     // weekend
  for (let i = 0; i < 6; i++) { bars.push(bar(t)); t += 15 * MIN; }
  return bars;
}

// ── 1. the measurement rule ─────────────────────────────────────────────────────────────────────────────

test('barSpacingSec reads a uniform series', () => {
  assert.equal(webtrader.barSpacingSec(gapped(15 * MIN, 10)), 900);
  assert.equal(webtrader.barSpacingSec(gapped(HOUR_MS, 10)), 3600);
});

test('★ GAPS only ever INFLATE a delta — so the MINIMUM positive spacing is the interval', () => {
  // The live shape: 15m bars with session breaks and weekends in them. This is the whole reason the rule is
  // min and not `deltas[0]` and not the mean.
  const series = live15m();
  assert.equal(webtrader.barSpacingSec(series), 900, 'a gapped 15m series must still measure 900s');
  // ★ NON-VACUITY: the alternatives are WRONG on this same series, so the rule is doing work.
  const deltas = series.slice(1).map((b, i) => (b.DT - series[i].DT) / 1000);
  // Every gap delta is the gap PLUS one bar length (the missing bars are what was skipped), so these are
  // asserted as "at least a break" rather than as an arithmetic result — the live histogram's own values are
  // 4500000 ms and 177300000 ms.
  assert.ok(deltas.includes(5400), 'the fixture must actually contain a session break');
  assert.ok(deltas.some((d) => d >= 177300), 'and a weekend-sized gap');
  assert.equal(deltas[0], 900, 'the series starts inside a session, so a FIRST-delta reader looks right here');
  const meanSec = Math.round((series[series.length - 1].DT - series[0].DT) / 1000 / (series.length - 1));
  assert.notEqual(meanSec, 900, '...while the MEAN is neither of the two real spacings — which is why it is not the mean');
  assert.equal(Math.min(...deltas.filter((d) => d > 0)), 900, 'only the minimum recovers the true interval');
});

test('barSpacingSec refuses to invent a measurement', () => {
  assert.equal(webtrader.barSpacingSec([]), null, 'an empty series has no spacing — null, not 0');
  assert.equal(webtrader.barSpacingSec([{ DT: H0 }]), null, 'one bar has no delta');
  assert.equal(webtrader.barSpacingSec(null), null);
  assert.equal(webtrader.barSpacingSec('nope'), null);
  // Duplicate and backwards timestamps are not deltas.
  assert.equal(webtrader.barSpacingSec([{ DT: H0 }, { DT: H0 }, { DT: H0 - MIN }]), null);
});

// ── 2. the verdict ─────────────────────────────────────────────────────────────────────────────────────

test('chartIntervalVerdict: agreement is required, and SILENCE IS NOT AGREEMENT', () => {
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: 900, measuredSec: 900 }), 'agree');
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: 3600, measuredSec: 900 }), 'disagree');
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: 900, measuredSec: 3600 }), 'disagree');
  // Unmeasurable is its own verdict. Treating it as agreement is how a guard goes inert.
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: 900, measuredSec: null }), 'unmeasured');
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: null, measuredSec: 900 }), 'unmeasured');
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: null, measuredSec: null }), 'unmeasured');
});

test('★★ THE LIVE CASE, and the non-vacuity of the verdict itself', () => {
  // Measured on the desk's shared chart after `setPeriodicity({period:1, interval:1, timeUnit:'hour'})`:
  // the layout claimed one hour and the series measured fifteen minutes, and it stayed that way for 45s.
  const live = { layoutSec: 3600, measuredSec: 900 };
  assert.equal(webtrader.chartIntervalVerdict(live), 'disagree');
  // The check that would have shipped the falsified provenance.
  const trustTheLayout = () => 'agree';
  assert.equal(trustTheLayout(live), 'agree', 'trusting the layout reads the broken chart as fine');
  assert.notEqual(webtrader.chartIntervalVerdict(live), trustTheLayout(live),
    'the verdict must differ from "trust the layout" on the exact state that was measured');
});

// ── 3. readChartBars end-to-end against a stubbed engine ────────────────────────────────────────────────

function withFakeEngine(engine, fn) {
  const prior = global.CIQ;
  global.CIQ = { ChartEngine: { registeredContainers: { 0: { stx: engine } } } };
  try {
    // `readChartBars` only needs an object with `evaluate`; running the page callback in-process against a
    // stubbed `CIQ` exercises the REAL conversion and the REAL measurement, not a copy of them.
    return fn({ evaluate: async (cb) => cb() });
  } finally {
    if (prior === undefined) delete global.CIQ; else global.CIQ = prior;
  }
}

test('★ readChartBars measures the series beside the layout\'s claim', async () => {
  const honest = withFakeEngine(
    { chart: { symbol: '11_Sell', masterData: gapped(15 * MIN, 40) }, layout: { interval: 15, timeUnit: 'minute' } },
    (page) => webtrader.readChartBars(page),
  );
  const r = await honest;
  assert.equal(r.intervalSec, 900, 'the layout claim converts through CHART_UNIT_SEC');
  assert.equal(r.measuredIntervalSec, 900, 'and the series agrees with it');
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: r.intervalSec, measuredSec: r.measuredIntervalSec }), 'agree');
  assert.equal(r.symbol, '11_Sell');
});

test('★★ readChartBars EXPOSES the falsified case rather than papering over it', async () => {
  // The engine claiming one hour over fifteen-minute bars — the state `setPeriodicity` actually produces.
  const falsified = await withFakeEngine(
    { chart: { symbol: '11_Sell', masterData: gapped(15 * MIN, 40) }, layout: { interval: 60, timeUnit: 'minute' } },
    (page) => webtrader.readChartBars(page),
  );
  assert.equal(falsified.intervalSec, 3600);
  assert.equal(falsified.measuredIntervalSec, 900);
  assert.equal(webtrader.chartIntervalVerdict({ layoutSec: falsified.intervalSec, measuredSec: falsified.measuredIntervalSec }),
    'disagree', 'this is the state that must never be written');
});

test('readChartBars passes an engine failure through untouched', async () => {
  const prior = global.CIQ;
  delete global.CIQ;
  try {
    const r = await webtrader.readChartBars({ evaluate: async (cb) => cb() });
    assert.equal(r.error, 'no_chart_engine', 'no engine is a failure, not an empty success');
    assert.equal(r.measuredIntervalSec, undefined, 'and there is no measurement to report');
  } finally {
    if (prior !== undefined) global.CIQ = prior;
  }
});

test('★★ NOTHING NODE-SIDE MAY BE NAMED INSIDE page.evaluate — and a stub CANNOT catch this', () => {
  // `page.evaluate` serialises the callback's SOURCE and runs it in the browser, so any Node binding it names
  // is a ReferenceError on EVERY read. The stubbed tests above cannot see this: an in-process stub runs the
  // callback where the module closure IS in scope. That is exactly how `CHART_UNIT_SEC` reached a live run on
  // 2026-09-25 with every unit test passing, so this guard is deliberately structural rather than behavioural.
  const fn = wtSrc.slice(wtSrc.indexOf('async function readChartBars('), wtSrc.indexOf('async function readTicket('));
  const cbStart = fn.indexOf('page.evaluate(');
  const cbEnd = fn.indexOf('\n  });', cbStart);
  assert.ok(cbStart !== -1 && cbEnd !== -1, 'could not locate the page callback — re-read readChartBars');
  // ⚠ COMMENTS ARE STRIPPED FIRST, and this guard tripped on its own prose the first time it was run: the
  // comment inside the callback NAMES `CHART_UNIT_SEC` to explain why naming it there is fatal. Matching prose
  // instead of code is the same false failure this repo has now hit four times.
  const callback = codeOnly(fn.slice(cbStart, cbEnd));
  for (const nodeBinding of ['CHART_UNIT_SEC', 'barSpacingSec', 'chartIntervalVerdict']) {
    assert.doesNotMatch(callback, new RegExp(nodeBinding),
      `${nodeBinding} is a NODE binding and does not exist inside page.evaluate`);
  }
  // And the conversion really does happen on this side of the bridge, through the one unit table.
  assert.match(wtCode, /CHART_UNIT_SEC\[read\.layoutTimeUnit\]/, 'the layout pair must be converted on the Node side');
});

// ── 4. the call site ────────────────────────────────────────────────────────────────────────────────────

test('★★ setPeriodicity is NOT called — it is a label-changer on this venue, and that is a measurement', () => {
  // If someone "fixes" the interval by driving the engine API, every other assertion in this file becomes
  // decorative while the desk writes 1h-labelled rows built from 15m bars.
  assert.doesNotMatch(wtCode, /setPeriodicity\s*\(/, 'the engine API must not be driven: it records the claim before it can fail');
  assert.doesNotMatch(captureCode, /setPeriodicity\s*\(/);
  // And the reason must stay written down where the next reader meets the code, not only in a task row.
  assert.match(wtSrc, /cannot change periodicity because neither dataCallback or quoteDriver are set/,
    'the header must keep the engine\'s own failure string — that is the evidence for not calling it');
});

test('★ bankChartBars VERIFIES before it writes, and refuses on anything but agreement', () => {
  const bank = codeOnly(fnBody(captureSrc, 'bankChartBars') || '');
  assert.ok(bank, 'bankChartBars is gone — delete this file with it');
  const verdictAt = bank.indexOf('chartIntervalVerdict');
  const writeAt = bank.indexOf('upsertProviderBars');
  assert.ok(verdictAt !== -1, 'bankChartBars must verify the interval');
  assert.ok(writeAt !== -1, 'bankChartBars must still write the rows');
  assert.ok(verdictAt < writeAt, 'the verdict must be taken BEFORE the write — verifying afterwards checks nothing');
  assert.match(bank, /if \(iv !== 'agree'\)/, "the refusal must trigger on anything that is not 'agree' — including 'unmeasured'");
  assert.match(bank, /chartBars: 0/, 'a refused row set must bank nothing');
  assert.match(bank, /chartErr: `interval_\$\{iv\}: /, 'the refusal must NAME the verdict, so "unmeasured" and "disagree" are distinguishable from outside');
  assert.match(bank, /layout \$\{describe\(c\.intervalSec\)\} vs series \$\{describe\(c\.measuredIntervalSec\)\}/,
    'both numbers must be in the refusal — the claim and the measurement');
  // The refusal rides the EXISTING chartErr path, which TRD-68 wired to chartMissing and telemetry.
  assert.match(bank, /chartInterval: ivReport/, 'and the verdict travels with the refusal');
});

test('★ the 15m hole is closed by ROLLING UP, guarded on the bucket and not on the literal', () => {
  const bank = codeOnly(fnBody(captureSrc, 'bankChartBars') || '');
  assert.match(bank, /if \(bucketed\.bucketMs < 3600000\) \{/,
    'the rollup must trigger on the BUCKET so the rule survives a change to TF_MAP (a literal "15m" check would not)');
  assert.match(bank, /store\.upsertAggBars\(userId, \{ venue: 'plus500_chart', symbol, fromTf: target, toTf: '1h' \}\)/,
    'the rollup must use the store\'s aggregation, which declares the SOURCE interval');
  assert.match(bank, /chartRollup = await store\.upsertAggBars/, 'the rollup must be counted, not discarded');
});

test('★ the rolled-up rows are recorded as AGGREGATED, not native — the column exists for exactly this', () => {
  // Cross-module, against the real provenance function: `upsertAggBars` writes `sourceIntervalSec = 900` for a
  // 15m -> 1h rollup, so the structure series can tell a native hour from a stitched one.
  const rolled = barIntervalProvenance({ timeframe: '1h', sourceIntervalSec: 900 });
  assert.equal(rolled.native, false);
  assert.equal(rolled.aggregated, true, 'a rolled-up hour must not claim to be a native hour');
  const native = barIntervalProvenance({ timeframe: '1h', sourceIntervalSec: 3600 });
  assert.equal(native.native, true);
  // And the rollup's target is a real timeframe the aggregation accepts.
  assert.equal(bucketChartBars([], 900).target, '15m', 'the rollup source is the 15m bucket');
});

test('★ the pin target is still a TF_MAP HIT — the mapping GRD-5 ruled on is untouched', () => {
  const b = bucketChartBars([], 3600);
  assert.equal(b.target, '1h');
  assert.equal(b.fallThrough, false);
  assert.equal(b.nativePerBucket, 1);
});

test('★ the sweep CONSUMES the verdict, logs failures, and records a clean one', () => {
  const search = codeOnly(fnBody(captureSrc, 'captureBySearch') || '');
  assert.match(search, /const chartInterval = \{ agree: 0, disagree: 0, unmeasured: 0, rollups: 0, firstError: null \};/,
    'the sweep must tally the verdict — the three outcomes must stay distinguishable');
  assert.match(search, /if \(cb\.chartInterval\) \{/, 'the per-symbol verdict must actually be read');
  assert.match(search, /if \(cb\.chartRollup\) chartInterval\.rollups \+= cb\.chartRollup;/,
    'the rollup count must be consumed at the sweep level — a field nobody reads is not telemetry');
  // ★ THE GRD-4 LESSON APPLIED TO THE VERDICT: a capture whose interval always agreed leaves NO trace, so a
  // signal-only record could never distinguish "every sweep verified its interval" from "the verification
  // stopped being called" — and the second looks exactly like the first.
  assert.match(search, /interval: chartInterval,/,
    'the match-case heartbeat must carry the interval verdict, or a healthy verification is invisible');
  assert.match(search, /source: 'capture_chart_interval'/, 'a failure must be logged with a stable source tag');
  assert.match(search, /note: 'the engine\\'s declared interval and the series\\' own bar spacing did not agree/,
    'the event must say WHY, because the failure mode ("layout claims, series disagrees") is not guessable');
  assert.match(search, /return \{ ticks, missing, chartBars, chartMissing, chartIdentity, chartMerge, chartInterval \};/,
    'captureBySearch must return the verdict');
  for (const fn of ['captureDynamic', 'captureFixed']) {
    const b = codeOnly(fnBody(captureSrc, fn) || '');
    // 2026-10-18: same generalisation as the chartMissing pin — captureDynamic accumulates its own verdict
    // (const chartInterval = ...) instead of destructuring captureBySearch's return. The invariant is
    // "mentioned implies bound": an undeclared identifier here is a ReferenceError at capture time.
    const bound = /(?:const|let)\s*\{[^}]*chartInterval[^}]*\}\s*=\s*await\s+captureBySearch/.test(b)
      || /(?:const|let)\s+chartInterval\s*=/.test(b);
    assert.ok(bound,
      `${fn} must bind chartInterval — referencing an undeclared identifier is a ReferenceError at capture time`);
    assert.match(b, /chartInterval,/, `${fn} must pass the verdict through rather than dropping it`);
  }
});
