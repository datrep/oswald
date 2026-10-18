// test/structure-bundle-purity.test.js — S1c: the gate that makes S1b safe.
//
// ★ WHY THIS IS A TEST AND NOT AN ASSERTION. The design doc (§12) says S1's gate is "the rendered bundle
// and `bundleObj` are byte-identical before and after — not merely 'no behaviour change'". The first
// version of that gate was the sentence "nothing enters the bundle", which is a claim about where a field
// was put; this file is a claim about what the RENDERERS DO. The difference matters because the sentence
// can be wrong without anything failing, and this cannot.
//
// ★ THE ACTUAL MECHANISM, and it is narrower than "the bundle ignores unknown fields":
//
//   1. `buildBundle` (the chair prompt text) and `buildBundleObj` (the stored record) both render
//      FIELD BY FIELD — every line pulls `s.price`, `s.atr14`, `s.donchian`, `s.signal`, `s.indicators`
//      BY NAME. A new TOP-LEVEL field on a symbol is therefore invisible to both.
//   2. `context.centralContext` (the paper desk's picture) is field-explicit in the same way.
//   3. BUT BOTH `buildBundleObj` AND `centralContext` pass `indicators` through **WHOLESALE**
//      (`indicators: s.indicators || null`). That is the ONE place a new field can leak into the stored
//      record and the paper context without a line of renderer code changing.
//
// So the rule S1b had to satisfy is not "do not change the bundle" — it is "do not change the bundle, and
// the only way you could have is by nesting inside `indicators`". S1b put `structure` top-level, and this
// file proves (a) that is sufficient and (b) that the failure mode it avoids is REAL, by producing it
// deliberately and asserting the difference. Without (b) the test could pass because the harness was
// broken, which is the failure mode of every differential test ever written.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isDeepStrictEqual } = require('node:util');

const { buildBundle, buildBundleObj } = require('../trading/agent/promptBuilder');
const { centralContext } = require('../trading/agent/context');

const NOW = new Date('2026-09-22T00:00:00Z');

// A structure result shaped exactly as `computeStructure` returns it — including the fields S1b added.
const STRUCTURE = {
  state: 'ok',
  basis: { venue: 'plus500', timeframe: '1h', sourceIntervalSec: 3600, asOf: 161, asOfBarStart: '2026-09-22T04:00:00.000Z' },
  params: { k: 2, d: 1.5, m: 3 },
  direction: 'bullish',
  protected: { side: 'low', price: 4340, index: 150, lagBars: 9 },
  swings: [{ kind: 'high', index: 158, price: 4376.44, status: 'confirmed', confirmedAtIndex: 160, lagBars: 1, label: 'HH' }],
  bos: { index: 161, close: 4375, level: 4376.44, direction: 'bullish', lagBars: 0 },
  mss: null, displacement: null, sweeps: [], fvg: [], orderBlock: null,
  dealingRange: { high: 4376.44, low: 4340 },
  position: { pct: 0.34, zone: 'equilibrium' },
  ote: null,
};

const BASE_INDICATORS = { rsi: 50, bollinger: null, macd: null, stoch: null, sma50: 99, sma200: 98, bars: 100, venue: 'plus500' };

// S2's payload, shaped exactly as `computeActivity` returns it. The median is deliberately written to four
// decimals so the byte-identical tests below can ALSO assert the prompt does not contain it — pinning on the
// WORD "activity" would be a pin on English rather than on the renderer.
const ACTIVITY = {
  state: 'ok',
  basis: { venue: 'plus500_chart', venueWhy: 'chart_series_faithful', timeframe: '1h', sourceIntervalSec: 3600, asOf: 161, asOfBarStart: '2026-09-22T04:00:00.000Z' },
  params: { days: 20, minSamples: 8 },
  hourUtc: 4,
  samples: 20,
  range: { nowBps: 41.7, medianBps: 19.3737, ratio: 2.152, percentile: 0.95 },
  body: { nowBps: 12.4, medianBps: 9.1, ratio: 1.363 },
};
const ACTIVITY_SENTINEL = '19.3737';

// `placement` is the whole point of this file: 'none' (as S1 found the field before), 'top' (as S1b puts
// it), or 'nested' (the placement that leaks — produced here deliberately so the guard can be shown to
// have teeth).
const sym = (placement) => ({
  symbol: 'Gold', venue: 'plus500', status: 'ok', price: 4370, atr14: 12, adx14: 24,
  donchian: { upper: 4400, lower: 4300 }, signal: null, flat: 'no cross', tickCount: 163,
  strategies: ['survgold'],
  indicators: placement === 'nested'
    ? { ...BASE_INDICATORS, structure: STRUCTURE, activity: ACTIVITY }
    : BASE_INDICATORS,
  bigPicture: [{ tf: '1h', venue: 'yahoo', bars: 120, last: 4370, pos: 'inside' }],
  ...(placement === 'top' ? { structure: STRUCTURE, activity: ACTIVITY } : {}),
});

const bundleCtx = (placement) => ({
  trigger: 'schedule', now: NOW,
  session: { state: 'open', detail: 'market open' },
  quantResult: { symbols: [sym(placement)] },
  openTrades: [], closedTrades: [], venueCostFacts: {},
});

const paperCtx = (placement) => ({
  now: NOW, session: { state: 'open' }, quantResult: { symbols: [sym(placement)] },
});

// ---------------------------------------------------------------------------
test('premise: the harness really renders, and it is deterministic across two calls', () => {
  // Without this the byte-identical tests below could pass over an empty string, which is the classic way
  // a differential test silently stops testing anything.
  const text = buildBundle(bundleCtx('none'));
  assert.ok(text.length > 500, `the rendered bundle must be substantial (got ${text.length} chars)`);
  assert.match(text, /MARKET SNAPSHOT/);
  assert.match(text, /Gold \(plus500\)/);
  assert.equal(text, buildBundle(bundleCtx('none')), 'two renders of one input must agree byte for byte');
  assert.ok(isDeepStrictEqual(buildBundleObj(bundleCtx('none')), buildBundleObj(bundleCtx('none'))));
});

test('★ the failure mode is REAL: nesting inside `indicators` DOES reach the stored bundle', () => {
  // This is the test that gives the rest of the file its teeth. If it ever stops failing, the two
  // byte-identical tests below have become vacuous and this file is decoration.
  const clean = buildBundleObj(bundleCtx('none'));
  const nested = buildBundleObj(bundleCtx('nested'));
  assert.ok(!isDeepStrictEqual(clean, nested),
    'a field nested in `indicators` MUST reach bundleObj — `indicators` is passed through wholesale, and '
    + 'if that ever stops being true this test file no longer proves anything and should be rewritten');
  // ...and the paper context has the SAME hole, from the same line of code.
  assert.ok(!isDeepStrictEqual(centralContext(paperCtx('none')), centralContext(paperCtx('nested'))),
    'centralContext also passes `indicators` through wholesale — the leak is in both bundles');
});

test('★ S1b: a TOP-LEVEL `structure` leaves the chair prompt byte-identical', () => {
  const before = buildBundle(bundleCtx('none'));
  const after = buildBundle(bundleCtx('top'));
  assert.equal(after, before,
    'the chair prompt must not change: it renders field by field, so a top-level field is invisible to it');
  // Not even the word appears — the chairs cannot be told about structure until S4 decides they should be.
  assert.doesNotMatch(after, /structure/i, 'the prompt must not mention structure at all in S1');
});

test('★ S1b: a TOP-LEVEL `structure` leaves the STORED bundle deep-equal', () => {
  const before = buildBundleObj(bundleCtx('none'));
  const after = buildBundleObj(bundleCtx('top'));
  assert.ok(isDeepStrictEqual(after, before),
    'the stored record must be unchanged — it is the only evidence of what the cache had to work with, and '
    + 'a new varying key in it is TRD-78 territory');
});

test('★ S1b: a TOP-LEVEL `structure` leaves the PAPER context deep-equal', () => {
  // The paper path is the one that is easy to forget, because it is a different file with its own
  // field-explicit map. It has the same wholesale `indicators` line as buildBundleObj — which is why the
  // safe placement is the same in both, and why the test has to cover both rather than infer one from
  // the other.
  const before = centralContext(paperCtx('none'));
  const after = centralContext(paperCtx('top'));
  assert.ok(isDeepStrictEqual(after, before),
    'centralContext must be unchanged: `s.structure` is top-level and it maps a named subset');
});

test('★ S2: the ACTIVITY measure rides the same gate — top-level, so both bundles stay untouched', () => {
  // S2's stated gate is "no reviewer change, therefore no shadow invalidation" (§12). That is a claim about
  // the RENDERERS, and this is where it is checked rather than believed. Both S2 fields are carried in the
  // fixtures above, so the byte-identical and deep-equal assertions cover them together — this test names
  // the S2 half explicitly so that deleting the field from the fixture cannot silently narrow the gate.
  const none = buildBundle(bundleCtx('none'));
  const top = buildBundle(bundleCtx('top'));
  assert.equal(top, none, 'the chair prompt must not change when a symbol carries an activity measure');
  assert.doesNotMatch(top, new RegExp(ACTIVITY_SENTINEL.replace('.', '\\.')),
    'the activity median must not appear in the prompt — the chairs cannot be told about it until S4');
  assert.ok(isDeepStrictEqual(buildBundleObj(bundleCtx('top')), buildBundleObj(bundleCtx('none'))),
    'the stored bundle must stay deep-equal');
  assert.ok(isDeepStrictEqual(centralContext(paperCtx('top')), centralContext(paperCtx('none'))),
    'and the paper context with it — the same wholesale-`indicators` hole is in both files');
});

test('★ and the two placements are genuinely different — the rule is "top-level", not luck', () => {
  // Stated as one assertion so the reason is legible: the same payload is invisible one way and visible
  // the other, and the ONLY thing that differs is where it sits.
  const topText = buildBundle(bundleCtx('top'));
  const noneText = buildBundle(bundleCtx('none'));
  assert.equal(topText, noneText, 'top-level: invisible to every renderer');
  // ★ THE MISSING ASSERTION. `nestedText` used to be assigned here and never used, so the file never
  // actually checked whether the `indicators` leak is visible in the RENDERED TEXT as well as in the stored
  // object. It is the load-bearing half of this test's claim, so it is now asserted rather than implied.
  assert.equal(buildBundle(bundleCtx('nested')), noneText,
    'the nested leak does NOT show up in the prompt — which is exactly why "the prompt looks the same" is '
    + 'not sufficient evidence of safety, and why the stored-object assertion below is the one that catches it');
  // The nested case leaks into the STORED object (proved above) even where it does not change the text,
  // which is exactly why "the prompt looks the same" is not sufficient evidence of safety.
  assert.ok(!isDeepStrictEqual(buildBundleObj(bundleCtx('nested')), buildBundleObj(bundleCtx('none'))),
    'nested: reaches the stored record — so the prompt agreeing is NOT enough to conclude safety');
});
