// test/capture-chart-bars.test.js — TRD-68, the SILENCE half (fixed 2026-09-22).
//
// ★ THE DEFECT IT PINS, and it is a defect about a DISCARDED DIAGNOSTIC rather than a missing one.
//
// `bankChartBars` has always returned `chartErr` on failure. The caller did this:
//     const cb = await bankChartBars(userId, sym.symbol, page);
//     chartBars += cb.chartBars || 0;      // cb.chartErr DISCARDED
// and `captureBySearch` returned `missing` for TICKS only. So a symbol whose SIGNAL SERIES had stopped being
// written was reported as FULLY CAPTURED.
//
// What that cost, measured before the fix: China Shenhua's 1h `plus500_chart` series sat 456 minutes stale
// while the same sweep reported `captured:36, missing:[]` — an EMPTY missing list — and the symbol appeared in
// it with 3 perfectly captured ticks. The only visible artefact anywhere was a bare `stale` on a dashboard
// panel with no explanation, while the owner (correctly) read it as flat data. A symbol whose series is stale
// is silently excluded from evaluation forever: quant returns no signal, no price is rendered, nothing pages,
// and it still costs a scout slot and rides in every chair bundle.
//
// The two miss kinds answer different questions and are now separate fields:
//   `missing`      — the TICK lookup found nothing (the ticket/search question)
//   `chartMissing` — the ticket worked, the CHART BARS did not (with the reason)
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'capture.js'), 'utf8');
// Strip comments before asserting: the comment that explains why not to discard `chartErr` CONTAINS the
// discarding line, and a pin that matches prose instead of code fails on correct code. (This has cost three
// separate false failures across the TRD-UI work alone.)
const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
const code = codeOnly(src);

function fnBody(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) return null;
  const rest = src.slice(start + 1);
  const cut = rest.indexOf('\nasync function ');
  return cut === -1 ? rest : rest.slice(0, cut);
}
const body = (name) => codeOnly(fnBody(name) || '');

test('the premise: bankChartBars still returns chartErr, and the caller still has a chartBars line to read', () => {
  // Without this the pin below could pass over a function that no longer reports failures at all.
  const bank = body('bankChartBars');
  assert.ok(bank, 'bankChartBars is gone — delete this file with it');
  assert.match(bank, /chartErr/, 'bankChartBars must still report WHY the chart bars failed');
  assert.ok((bank.match(/chartErr/g) || []).length >= 2,
    'bankChartBars must report chartErr on BOTH failure paths (too few bars AND a thrown read)');
  assert.match(code, /chartBars \+= cb\.chartBars \|\| 0;/, 'the caller no longer reads chartBars — re-read this file');
});

test('★ chartErr is no longer discarded: it is collected per symbol with its reason', () => {
  const search = body('captureBySearch');
  assert.match(search, /const chartMissing = \[\];/, 'captureBySearch must collect chart-bar failures');
  assert.match(search, /if \(cb\.chartErr\) chartMissing\.push\(\{ symbol: sym\.symbol, error: cb\.chartErr \}\)/,
    'the error must be KEPT WITH ITS REASON — the symbol alone does not say why');
  // The exact shape of the original defect: incrementing the count and ignoring the error beside it.
  assert.doesNotMatch(search, /chartBars \+= cb\.chartBars \|\| 0;\s*\n\s*\}/,
    'the chartBars increment must not be the last thing done with the result — that is the discarded chartErr');
});

test('★ the capture result distinguishes a TICK miss from a CHART-BAR miss', () => {
  // The two are different facts and only the first was ever visible. Asserting the RETURN of each function
  // rather than the file as a whole, because a field added to one path and forgotten in the other is exactly
  // the half-applied edit this work nearly shipped.
  assert.match(body('captureBySearch'),
    /return \{ ticks, missing, chartBars, chartMissing, chartIdentity, chartMerge, chartInterval \};/,
    'captureBySearch must return BOTH new fields — chartMissing (TRD-68), chartIdentity (TRD-GRD-3) — and chartMerge, '
    + 'which is TRD-GRD-5\'s recorded merge arithmetic, and chartInterval, which is the measured-vs-claimed verdict');
  for (const fn of ['captureDynamic', 'captureFixed']) {
    const b = body(fn);
    assert.ok(b, `${fn} is gone`);
    assert.match(b, /chartMissing/, `${fn} must not drop the chart-bar failures`);
    // EVERY scope that mentions chartMissing must also BIND it. A return that references an
    // undeclared identifier is a ReferenceError at CAPTURE time — on the desk, mid-wake — and a partial edit
    // produces exactly that. This assertion caught it once: the destructure and the return lived in different
    // edit hunks, and the first attempt applied one without the other.
    // 2026-10-18: the binding may be EITHER the destructure from captureBySearch (captureFixed's shape) or a
    // local accumulator the function declares itself (captureDynamic's shape since the watchlist restructure).
    // The invariant is "mentioned implies bound"; the pin asserts that, not one literal line.
    const bound = /(?:const|let)\s*\{[^}]*chartMissing[^}]*\}\s*=\s*await\s+captureBySearch/.test(b)
      || /(?:const|let)\s+chartMissing\s*=/.test(b);
    assert.ok(bound,
      `${fn} mentions chartMissing without binding it — that is a ReferenceError at capture time`);
  }
});

test('★ a chart-bar failure is logged as telemetry, so it survives the request', () => {
  const search = body('captureBySearch');
  assert.match(search, /source: 'capture_chart_bars'/, 'the failure must be logged with a stable source tag');
  assert.match(search, /if \(chartMissing\.length\)/, 'telemetry only on FAILURE — otherwise the event is a stream, not a signal');
  assert.match(search, /symbols: chartMissing\.slice\(0, 8\)/, 'the event must name the symbols, capped so it cannot grow without bound');
});

test('★ the outer catch records the tick-path failure too, keeping it out of the chart-bar question', () => {
  // The search throwing is a TICK-path failure and stays in `missing`; it is ALSO recorded in chartMissing with
  // a distinguishing prefix so that "why is this symbol not in the book" has exactly one place to look. Mixing
  // the two into one list would re-create the original confusion in the opposite direction.
  const search = body('captureBySearch');
  assert.match(search, /missing\.push\(sym\.symbol\)/, 'a thrown search still belongs in `missing`');
  assert.match(search, /error: `tick_path: /, 'and must be tagged so it cannot be mistaken for a chart-bar failure');
});

// ── TRD-GRD-3 (2026-09-24): WHOSE BARS WERE THOSE? ────────────────────────────────────────────────────
//
// The defect: `bankChartBars` banks a chart's series under its `symbol` ARGUMENT while the data comes from
// whatever the PAGE is displaying, and it never compared the two. 151 rows of the wrong instrument reached
// quant across seven watchlist symbols before it was found (trading/docs/instrument-swap-2026-09-24.md).
//
// These pins cover OBSERVE MODE only. Nothing here asserts that a mismatch is refused, because it is not:
// the venue's name for an instrument need not equal the desk's, so enforcement must wait for the naming
// agreement to be measured on this desk's own watchlist.

test('the premise: readChartBars still reports the instrument the chart is DISPLAYING', () => {
  // The whole check rests on this field existing. If ChartIQ stops exposing `chart.symbol`, the verdict is
  // `unrecorded` forever and a guard built on it would be inert — so assert the PRODUCER's side of the
  // contract, not ours. (This repo has shipped a guard that could never fire: activity's `days`.)
  const wt = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'webtrader.js'), 'utf8');
  assert.match(wt, /symbol: engine\.chart\.symbol/, 'readChartBars must keep returning the displayed instrument');
});

test('★ bankChartBars no longer discards the displayed instrument', () => {
  const bank = body('bankChartBars');
  assert.match(bank, /const chartSymbol = c\.symbol/, 'the chart symbol must be READ, not dropped');
  assert.match(bank, /chartIdentity: chartIdentityVerdict\(chartSymbol, symbol, registrySymbol\)/, 'and adjudicated against the REGISTRY symbol, not the desk name');
  assert.match(bank, /instruments\.getInstrumentById\(userId, \{ venue: 'plus500', venueInstrumentId: chartId \}\)/, 'the lookup must be the exact-id one');
  // The risky line stays, and that is the point: rows are still built from the ARGUMENT. It is safe only
  // BECAUSE the comparison above exists — if that comparison is ever removed, this pin is what says so.
  // 2026-09-25 (TRD-GRD-5): the row fields now come from `bucketChartBars` (which returns `timeframe` with the
  // bars it bucketed), so the pin narrows to the part that carries the risk — that `symbol` is the ARGUMENT and
  // not the chart's instrument. `bucketed.rows` never contains a symbol, which is why the spread cannot
  // override it; that is asserted rather than assumed.
  assert.match(code, /venue: 'plus500_chart', symbol, \.\.\.r,/, 'rows built from the argument — the identity comparison is what makes that safe');
  const { bucketChartBars: bcb } = require('../trading/plus500/capture');
  const built = bcb([{ DT: 0, Open: 1, High: 2, Low: 0, Close: 1, Volume: null }], 3600).rows;
  assert.equal('symbol' in built[0], false,
    'bucketed rows must NOT carry a symbol — if they ever do, the spread above would override the desk symbol with the chart\'s instrument and this whole defect comes back');
});

test('★ chartInstrumentId parses the venue instrument id, and null when there is nothing to parse', () => {
  const { chartInstrumentId: id } = require('../trading/plus500/capture');
  assert.strictEqual(id('11_Sell'), '11');
  assert.strictEqual(id('3406_Sell'), '3406');
  assert.strictEqual(id('11'), '11');
  assert.strictEqual(id(' 115_Buy'), '115');
  for (const nothing of [null, undefined, '', '   ', 'Gold', '_Sell']) {
    assert.strictEqual(id(nothing), null, `${JSON.stringify(nothing)} must parse to null, not to a guess`);
  }
});

test('★ chartIdentityVerdict: the REGISTRY decides, and absence is never `match`', () => {
  const { chartIdentityVerdict: v } = require('../trading/plus500/capture');
  // The real pairs, measured live 2026-09-24.
  assert.strictEqual(v('11_Sell', 'Gold', 'Gold'), 'match');
  assert.strictEqual(v('10_Sell', 'Oil', 'Oil'), 'match');
  assert.strictEqual(v('115_Sell', 'Arabica Coffee', 'Arabica Coffee'), 'match');
  // A stale read: the chart is still on Gold while Oil is being banked. This is the defect itself.
  assert.strictEqual(v('11_Sell', 'Oil', 'Gold'), 'mismatch');
  // ★ THE CASE THAT COVERED A REAL SYMBOL ON THE FIRST LIVE OBSERVATION. The venue gives an id, so the check
  // RUNS, but there is no registry row — 3989/Sands China today. It must be its OWN verdict: `match` would
  // pass a symbol the check never examined, and `mismatch` would refuse a legitimate capture.
  assert.strictEqual(v('3989_Sell', 'Sands China', null), 'unregistered');
  assert.strictEqual(v('3989_Sell', 'Sands China', undefined), 'unregistered');
  assert.strictEqual(v('3989_Sell', 'Sands China', ''), 'unregistered');
  // Nothing to parse at all.
  for (const nothing of [null, undefined, '', 'Gold']) {
    assert.strictEqual(v(nothing, 'Gold', 'Gold'), 'unrecorded');
  }
  // ★ `undefined === undefined` is `true`, so a naive equality check would call a silent pair an agreement.
  assert.notStrictEqual(v(undefined, undefined, undefined), 'match');
});

test('★ both names are OUR names, so a real difference is NOT normalised away', () => {
  const { chartIdentityVerdict: v } = require('../trading/plus500/capture');
  // Registry and watchlist are both desk-side, so case and spacing between them are not identity...
  assert.strictEqual(v('11_Sell', 'SandsChina', 'Sands China'), 'match');
  // ...but a genuine spelling difference is a finding, not noise. This is the pair that made the ORIGINAL
  // name-based check unenforceable, so it stays pinned.
  assert.strictEqual(v('11_Sell', 'Bank of East Asia', 'Bank of E.Asia'), 'mismatch');
  // Oil and Brent Oil are genuinely different instruments here — ids 10 and 431 — so an alias pair would
  // not have silently disabled the check. Asserted because the alternative design assumed it.
  assert.strictEqual(v('431_Sell', 'Oil', 'Brent Oil'), 'mismatch');
});

test('★ the caller CONSUMES the verdict, and the event fires on SILENCE too', () => {
  const search = body('captureBySearch');
  // A returned field nobody reads is not telemetry — that is TRD-68, one screen up, verbatim.
  assert.match(search, /chartIdentity\[cb\.chartIdentity\]/, 'the caller must tally the verdict, not just receive it');
  assert.match(search, /source: 'capture_chart_identity'/, 'the result must be logged with a stable source tag');
  assert.match(search, /chartIdentity\.mismatch \|\| chartIdentity\.unrecorded \|\| chartIdentity\.unregistered/,
    '`unregistered` must fire too: a guard that is ABSENT for one symbol looks exactly like a guard that PASSED for it');
  assert.match(search, /unregistered: chartIdentity\.unregistered/, 'the event must carry the coverage count, not only the anomaly count');
  assert.match(search, /samples: chartIdentity\.samples/, 'the event must name the disagreements, capped');
  assert.match(search, /chartIdentity\.samples\.length < 8/, 'capped so the event cannot grow without bound');
});

test('★ REACHABILITY: the registry lookup resolves — and a TEXT pin cannot see this', () => {
  // ⚠ THIS IS THE SECTION-8 NEAR-MISS AGAIN, AND THIS TIME IT WAS PRE-EMPTED RATHER THAN HIT. `trading/store.js`
  // does NOT re-export `getInstrumentById` — it is `undefined` there — so `store.getInstrumentById(...)` inside
  // bankChartBars would have thrown a TypeError on EVERY capture while the text assertions above passed
  // untouched, because the call site would still LOOK correct. Assert that the module the code actually
  // requires exports it, and record WHY the direct require exists.
  const instruments = require('../trading/store/instruments');
  assert.strictEqual(typeof instruments.getInstrumentById, 'function',
    'capture.js requires this directly; if it disappears, every capture throws');
  assert.strictEqual(typeof require('../trading/store').getInstrumentById, 'undefined',
    'if the store index ever exports getInstrumentById, capture.js may use it — until then the direct require is deliberate');
});

test('★ chartIdentity is deliberately LOCAL to captureBySearch — and that is asserted, not assumed', () => {
  // It is logged at the point of measurement, so propagating it upward buys nothing and costs a destructure
  // in two more scopes. Setting that down here means a later half-edit — adding it to a return without
  // adding the destructure — fails HERE rather than as a ReferenceError on the desk, mid-wake.
  for (const fn of ['captureDynamic', 'captureFixed', 'captureOnce']) {
    const b = body(fn);
    if (!b) continue;
    // ⚠ `fnBody` slices to the NEXT `async function`, so for the LAST function the "body" runs to END OF
    // FILE and swallows the `module.exports` line — where `chartIdentityVerdict` legitimately appears. Strip
    // the export statement first, or this pin fails on correct code. The first version of it did exactly
    // that, which is the same failure this file's own header warns about (a pin that matches something other
    // than the code it names) in a new costume: here it matched the EXPORT LIST instead of the scope.
    const scope = b.replace(/module\.exports[\s\S]*$/, '');
    assert.doesNotMatch(scope, /chartIdentity/,
      `${fn} mentions chartIdentity without destructuring it — either propagate it properly or leave it local`);
  }
});
