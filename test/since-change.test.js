// test/since-change.test.js — the post-change measurement tool refuses to pool, and refuses to speak.
//
// THE DEFECT THIS TOOL EXISTS FOR. Every statistic the desk publishes is a ROLLING window —
// `parityCheck` hardcodes `days: 90`, `netEdge` defaults to `days: 90`, `strategyStats` to 30. A
// rolling window averages trades from before a code change together with trades from after it and
// reports the mixture as though it described one regime. When the change is the thing under
// evaluation, the pre-change trades are not noise to be tolerated, they ARE the measurement.
//
// Measured on 2026-09-24, that is not theoretical. Against a 2026-09-23T00:00Z boundary the two
// enabled strategies flip sign:
//
//     survgold   pre-change n=18  mean R -0.1196   ->  post-change n=6  mean R +0.2439
//     survoil    pre-change n=14  mean R -0.5321   ->  post-change n=4  mean R +0.4121
//
// The pooled 90-day read says both are negative. The change-scoped read says both are positive.
//
// SO THE LOAD-BEARING TEST IS NOT "does partition split on a timestamp" — that is arithmetic. It is
// that a pre-change trade CANNOT REACH a post-change statistic. A partition that split correctly
// and then let the pre-change rows contribute to a mean would pass the obvious test and produce the
// exact defect the tool was written to remove.
//
// AND THE SECOND DECISION IS THE REFUSAL. n=6 and n=4 produce no verdict, and the tool says so
// rather than reporting a state it cannot support. `expectancyVerdict` is called with the gate's own
// `minTrades`, so the tool cannot drift into a floor the live harness would not apply.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { partition, measure, excursions, verdictFor, NO_VERDICT } = require('../trading/scripts/since-change');
const { code } = require('./_source');

const SINCE = '2026-09-23T00:00:00Z';

// open 4000 / stop 4012 / size 1 => risk 12, so grossPnl -12 is exactly R = -1.
const tr = (over = {}) => ({
  id: 1, strategyId: 'survgold', symbol: 'Gold', direction: 'sell',
  openPrice: 4000, stopPrice: 4012, size: 1, grossPnl: -12,
  closeAt: new Date('2026-09-24T00:00:00Z'),
  mfePct: 0.5, maePct: -0.5,
  ...over,
});

// ── the split ─────────────────────────────────────────────────────────────────────────────────

test('partition: a close exactly at the boundary counts as post-change', () => {
  const { post, pre } = partition([tr({ id: 1, closeAt: new Date(SINCE) })], SINCE);
  assert.equal(post.length, 1, 'a trade closing at the declared instant is part of the new regime');
  assert.equal(pre.length, 0);
});

test('partition: a trade with no readable closeAt belongs to neither population', () => {
  // Dropped, not guessed. Defaulting an unreadable row into `post` would inflate the sample under
  // test — the failure mode where the tool silently grades itself.
  //
  // The `null` case is the sharp one: `new Date(null)` is the epoch, which is FINITE, so a naive
  // `Number.isFinite` guard files it as a pre-change trade from 1970 rather than rejecting it.
  const { post, pre } = partition([tr({ closeAt: null }), tr({ closeAt: '' }), tr({ closeAt: 'not a date' })], SINCE);
  assert.equal(post.length, 0);
  assert.equal(pre.length, 0, 'null must not be filed as an epoch-dated pre-change trade');
});

test('★ a pre-change outlier cannot reach a post-change statistic', () => {
  // The pre-change trade is a +120,000 winner: R = +10000 against this risk. If the split leaked,
  // it would move the mean R by orders of magnitude, so this fails loudly rather than subtly.
  const postTrades = [tr({ id: 1 }), tr({ id: 2 }), tr({ id: 3 })];
  const base = measure(partition(postTrades, SINCE).post);

  const split = partition([...postTrades, tr({ id: 99, grossPnl: 120000, closeAt: new Date('2026-09-01T00:00:00Z') })], SINCE);
  const after = measure(split.post);

  assert.equal(split.pre.length, 1, 'the outlier must have been recognised as pre-change');
  assert.equal(after.rTrades, base.rTrades);
  assert.equal(after.trades, base.trades);
  assert.equal(after.meanR, base.meanR);
  assert.equal(after.sdR, base.sdR);
  assert.equal(after.meanR, -1, 'all three post-change trades are R = -1');
});

// ── the refusal ───────────────────────────────────────────────────────────────────────────────

test('verdictFor: below the floor it returns NO VERDICT and no state', () => {
  const v = verdictFor(measure([tr({ id: 1 })]), { alpha: 0.05, looks: 1, minTrades: 10 });
  assert.equal(v.state, NO_VERDICT);
  assert.equal(v.refused, true);
  assert.match(v.reason, /below minTrades=10/);
  // The distinction that matters: NO_VERDICT is not a synonym for 'undecided'. `undecided` is a
  // finding about the data; NO_VERDICT is a statement that there is not enough data to find
  // anything, and conflating them would let a 4-trade sample be reported as a neutral result.
  assert.notEqual(v.state, 'undecided');
});

test('verdictFor: it refuses rather than inventing dispersion', () => {
  // n clears the floor but every trade has the SAME outcome, so sd is 0 and no interval exists.
  const identical = Array.from({ length: 10 }, (_, i) => tr({ id: i + 1, grossPnl: 12 }));
  const v = verdictFor(measure(identical), { alpha: 0.05, looks: 1, minTrades: 10 });
  assert.equal(v.state, NO_VERDICT);
  assert.equal(v.refused, true);
});

test('verdictFor: at or above the floor it produces a real verdict', () => {
  const many = Array.from({ length: 10 }, (_, i) => tr({ id: i + 1, grossPnl: i % 2 ? 24 : -12 }));
  const v = verdictFor(measure(many), { alpha: 0.05, looks: 1, minTrades: 10 });
  assert.equal(v.refused, false);
  assert.ok(['accept', 'retire', 'undecided'].includes(v.state), `unexpected state ${v.state}`);
  assert.ok(Number.isFinite(v.lower) && Number.isFinite(v.upper));
});

test('verdictFor: it uses the gate floor it was given, not one of its own', () => {
  // Varied outcomes so the sample has dispersion — with identical trades the refusal would come from
  // sd = 0 and the test would pass for the wrong reason.
  const three = [tr({ id: 1, grossPnl: -12 }), tr({ id: 2, grossPnl: 24 }), tr({ id: 3, grossPnl: -6 })];
  assert.equal(verdictFor(measure(three), { minTrades: 10 }).refused, true);
  assert.equal(verdictFor(measure(three), { minTrades: 3 }).refused, false);
});

// ── the descriptive layer ─────────────────────────────────────────────────────────────────────

test('measure: a trade with no usable stop is EXCLUDED and COUNTED, never scored as 0 R', () => {
  const m = measure([tr({ id: 1 }), tr({ id: 2, stopPrice: null })]);
  assert.equal(m.trades, 2);
  assert.equal(m.rTrades, 1);
  assert.equal(m.rExcluded, 1, 'an unmeasurable trade is reported, not absorbed');
});

test('excursions: null and empty-string excursions are MISSING, not zero', () => {
  // `Number(null)` and `Number('')` are both 0, so the naive read would score two unmeasured rows as
  // a perfectly flat trade and drag both means toward zero.
  const e = excursions([tr({ id: 1, mfePct: null, maePct: '' }), tr({ id: 2, mfePct: 1, maePct: -0.25 })]);
  assert.equal(e.mfeN, 1);
  assert.equal(e.maeN, 1);
  assert.equal(e.mfe, 1);
  assert.equal(e.mae, -0.25);
  assert.equal(e.grossEdge, 0.75, 'gross edge is MFE% - |MAE%|, before costs');
});

// ── structure: the invariants a behavioural test cannot reach ────────────────────────────────

const SRC = code('trading/scripts/since-change.js');

test('structural: the statistic is IMPORTED from the gate, not reimplemented here', () => {
  // A tool with its own arithmetic measures a different quantity from the rule it is previewing, and
  // the two drift apart with neither being obviously wrong.
  assert.match(SRC, /require\('\.\.\/agent\/expectancy'\)/);
  assert.match(SRC, /rStats/);
  assert.match(SRC, /expectancyVerdict/);
});

test('structural: it does NOT touch analytics, whose statistics are rolling-window only', () => {
  // `netEdge` takes `days` and nothing else, so it cannot express a change boundary at all;
  // `parityCheck` both pools and WRITES. Importing either would reintroduce the defect. That
  // `netEdge` has no `since` parameter is itself part of the registered defect, not a fix.
  assert.doesNotMatch(SRC, /require\('\.\.\/agent\/analytics'\)/);
  assert.doesNotMatch(SRC, /parityCheck\(/);
  assert.doesNotMatch(SRC, /netEdge\(/);
});

test('structural: the window is an absolute instant, and the boundary is never guessed', () => {
  assert.match(SRC, /--since <ISO instant> is REQUIRED/);
  assert.match(SRC, /process\.exit\(2\)/, 'bad usage exits 2 rather than measuring something else');
  // One wide read, then split in memory — so the population under test is defined by `cut`, not by a
  // day count that would silently round or drift.
  assert.match(SRC, /listClosedTradesForStats\(userId, \{ days: 3650, limit: LIMIT \}\)/);
  assert.match(SRC, /partition\(rows, cut\)/);
});

test('structural: it is read-only and spends no look', () => {
  assert.doesNotMatch(SRC, /\b(INSERT|UPDATE|DELETE)\b/);
  assert.doesNotMatch(SRC, /saveSettings|retireStrategy|logEvent|setState/);
  // Saturation is reported because a silently truncated read would make every number wrong in the
  // same direction and look entirely plausible.
  assert.match(SRC, /saturated/);
});

test('structural: the pure core is exported behind a main guard', () => {
  assert.match(SRC, /require\.main === module/);
  assert.match(SRC, /module\.exports = \{ partition, measure, excursions, verdictFor, NO_VERDICT \}/);
});
