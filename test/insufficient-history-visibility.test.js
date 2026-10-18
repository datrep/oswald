// test/insufficient-history-visibility.test.js — TRD-UI-8.
//
// THE COMPLAINT. Two symbols showed up as `flat insufficient data · insufficient_data` and nothing else. A reader
// could not tell which of these they were looking at:
//   * a symbol ONE bar short, where waiting a wake fixes it, or
//   * a symbol TWENTY-NINE short, where the symbol is simply not usable yet,
// so the honest action could not be chosen. The threshold existed (MIN_BARS = 30) and the count existed
// (`tickCount`) but neither was ever put next to the other.
//
// WHAT IS PINNED HERE, AND WHY IN TWO STYLES. The scan is tested BEHAVIOURALLY, because it is importable and the
// number it chooses is the whole point. The render is pinned against the SOURCE, because `trading/public/**` is a
// browser ESM bundle with no exports — the same boundary `trailing-stop-dom.test.js` documents for the same reason.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../trading/store');
const quant = require('../trading/agent/quant');
const { code } = require('./_source');

const APP = code('trading/public/js/app.js');
const ROUTES = code('trading/routes.js');
const QUANT = code('trading/agent/quant.js');

const idx = (hay, needle) => {
  const i = hay.indexOf(needle);
  assert.notStrictEqual(i, -1, `expected the source to contain: ${needle}`);
  return i;
};

// Real rows only in the sense that matters here: `barStart` + OHLC, which is what listBars returns.
const series = (n, startHour = 0) => Array.from({ length: n }, (_, i) => ({
  barStart: new Date(Date.UTC(2026, 8, 30, startHour + i)).toISOString(),
  openPrice: 10, high: 11, low: 9, closePrice: 10, volume: 1, venue: 'stub',
}));

function withBars(byKey, fn) {
  const real = store.listBars;
  store.listBars = async (userId, { symbol, venue } = {}) => byKey[`${symbol}|${venue}`] || [];
  return Promise.resolve()
    .then(fn)
    .finally(() => { store.listBars = real; });
}

test('a symbol under the threshold reports the threshold AND the best series it has, not the watchlist row\'s own', async () => {
  // ⚠ THE MEASURED SHAPE (2026-09-30): Natural Gas has 18 hourly bars on plus500_chart and 6 on plus500. The old
  // search only recorded a series on SUCCESS, so a below-threshold symbol fell through to the row's own venue and
  // reported "6 of 30" — a shortfall THREE TIMES the real one. Below the threshold that number is the only thing
  // the desk can offer, so it has to be the best one it has.
  await withBars({
    'Natural Gas|plus500': series(6),
    'Natural Gas|plus500_chart': series(18, 5),
    'Natural Gas|yahoo': series(2, 10),
  }, async () => {
    const r = await quant.evaluateSymbol(1, { symbol: 'Natural Gas', venue: 'plus500' }, [], [], {});
    assert.strictEqual(r.status, 'insufficient_data');
    // the threshold travels WITH the count, so a renderer never has to know 30
    assert.strictEqual(r.minBars, quant.MIN_BARS);
    assert.strictEqual(r.barCount, 18, 'the BEST series, not the 6 on the watchlist row\'s own venue');
    // the count that was ALREADY being sent, under a name that does not call bars "ticks"
    assert.strictEqual(r.tickCount, r.barCount, 'both names still carry the same number');
    // and when a different venue supplied the better series, provenance says so rather than crediting the row
    assert.strictEqual(r.tickVenue, 'plus500_chart');
  });
});

test('when the symbol\'s own venue IS the best series, provenance is unchanged and the count is still right', async () => {
  await withBars({
    'Soybeans|plus500': series(6),
    'Soybeans|yahoo': series(2, 10),
  }, async () => {
    const r = await quant.evaluateSymbol(1, { symbol: 'Soybeans', venue: 'plus500' }, [], [], {});
    assert.strictEqual(r.status, 'insufficient_data');
    assert.strictEqual(r.barCount, 6);
    assert.strictEqual(r.minBars, quant.MIN_BARS);
    assert.strictEqual(r.tickVenue, 'plus500');
  });
});

test('the search still PREFERS a venue that clears the threshold, and a sufficient symbol is unaffected', async () => {
  // the fallback must not have quietly become the primary path: with enough history the first venue in
  // IND_VENUE_PREF that clears MIN_BARS still wins, exactly as before.
  await withBars({
    'Oil|yahoo': series(40, 0),
    'Oil|plus500': series(30, 0),
  }, async () => {
    const r = await quant.evaluateSymbol(1, { symbol: 'Oil', venue: 'plus500' }, [], [], {});
    assert.strictEqual(r.tickVenue, 'yahoo');
    assert.ok(r.barCount >= quant.MIN_BARS);
    assert.notStrictEqual(r.status, 'insufficient_data');
  });
});

test('the scan emits the threshold, and it is the SAME constant the gate uses', () => {
  // one home for 30: the emitter reads MIN_BARS rather than restating it
  idx(QUANT, 'minBars: MIN_BARS,');
  idx(QUANT, 'barCount: bars.length');
  assert.ok(!/minBars:\s*\d/.test(QUANT), 'the threshold must be the constant, never a literal');
});

test('the route annotates the threshold, so a wake persisted BEFORE the field existed still shows it', () => {
  // ⚠ a snapshot is read long after it was written, and the rows the user was looking at had already been
  // persisted - so writing the field only at scan time would have left the very rows that prompted this blank.
  idx(ROUTES, 's.minBars = quant.MIN_BARS');
  assert.ok(!/minBars\s*=\s*30/.test(ROUTES), 'the annotated value must be the constant');
});

test('the render names the threshold and what is LEFT, and keeps no copy of the threshold itself', () => {
  idx(APP, 'const insufficientBars = (s) => {');
  idx(APP, 'const insufficientCount = (s) => {');
  idx(APP, 'const insufficientText = (s) => {');
  // it reads the emitted numbers, tolerating the old field name for rows written before `barCount` existed
  idx(APP, 'Number(s.minBars)');
  idx(APP, 's.barCount != null ? s.barCount : s.tickCount');
  // and the three surfaces that used to hide it: the wake row, the status cell, the bars column
  idx(APP, "s.status === 'insufficient_data' ? insufficientText(s)");
  idx(APP, 'insufficientCount(s)');
  idx(APP, 'ins.have} / ${ins.need');
  // ⚠ THE CELL THE COMPLAINT ACTUALLY CAME FROM: the wake row's OWN status cell, which printed the bare machine
  // code `insufficient_data` and stopped there. It keeps the code - it matches the event names, so it stays
  // greppable - and gains the count beside it, with the full sentence on hover.
  idx(APP, "ins ? ` · ${esc(insufficientCount(s))}` : ''");
  idx(APP, '${ins ? ` title="${esc(insufficientText(s))}"` : \'\'}');
  // ⚠ THE POINT OF THE WHOLE CHANGE: the threshold is NEVER written down in the client. A second copy of 30 is a
  // worse answer than the bug, because it can disagree with the scan and nobody would know which one was right.
  const helpers = APP.slice(idx(APP, 'const insufficientBars = (s) => {'), idx(APP, 'const undeliberatedWhy ='));
  assert.ok(!/\b30\b/.test(helpers), 'the client must not carry its own threshold');
  assert.ok(!/MIN_BARS\s*=/.test(APP), 'and must not define one either');
});

test('the LONG explanation carries the numbers too, because the banner is what a reader actually sees', () => {
  // the banner says why nothing is entering; it must not require opening the scouts table to learn how far off
  idx(APP, "if (cause === 'scout_no_history') {");
  idx(APP, 'CAUSE_TEXT.scout_no_history.long');
  idx(APP, 'hourly bars');
  // and it degrades to the old wording rather than inventing a threshold when the row has none
  idx(APP, "if (!b) return 'insufficient data';");
});
