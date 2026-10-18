// test/bundle-scope-filter.test.js — TRD-72 (2026-09-22): the deterministic scope filter.
//
// THE MEASUREMENT. 2026-09-21, through the real builder on the live watchlist: 15,874 chars / ~3,969
// tokens, of which 77% of MARKET SNAPSHOT and 55% of BIG PICTURE was about symbols NO strategy can
// trade — their snapshot, indicators, multi-timeframe rows and cost rows cannot change any decision,
// because nothing can propose them.
//
// The row asks for a deterministic filter "pinned by tests so a future refactor cannot quietly re-add
// the dead telemetry". That is what this file is. The load-bearing tests are the two SAFETY ones, since
// they are the cases where removing telemetry could cost more than tokens — and the TRD-78(a) pin, which
// protects the constant head the prefix cache depends on.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildBundle, buildBundleObj } = require('../trading/agent/promptBuilder');

// A symbol result as `quant.evaluateSymbol` produces it. `strategies === undefined` OMITS the field
// entirely, which is the "unknown provenance" case the filter must fail open on.
const sym = (symbol, strategies, extra = {}) => ({
  symbol, venue: 'plus500', status: 'ok', price: 100, atr14: 1, adx14: 20,
  donchian: null, signal: null, flat: 'no cross', tickCount: 100,
  indicators: { rsi: 50, bollinger: null, macd: null, stoch: null, sma50: 99, sma200: 98, bars: 100, venue: 'plus500' },
  bigPicture: [{ tf: '1h', venue: 'yahoo', bars: 120, last: 100, pos: 'inside' }],
  ...(strategies === undefined ? {} : { strategies }),
  ...extra,
});

const FACTS = (s) => ({ symbol: s, minimumUnits: 1, spreadValue: 0.5, fundingBuyPct: -0.01, fundingSellPct: -0.02 });

const build = ({ symbols, openTrades = [], venueCostFacts = {} }) => buildBundle({
  trigger: 'schedule', now: new Date('2026-09-22T00:00:00Z'),
  session: { state: 'open', detail: 'market open' },
  quantResult: { symbols },
  openTrades, closedTrades: [],
  venueCostFacts,
});

test('TRD-72: a symbol with an EMPTY scope is removed from every per-symbol section', () => {
  const text = build({
    symbols: [sym('Gold', ['survgold']), sym('Bitcoin', [])],
    venueCostFacts: { Gold: FACTS('Gold'), Bitcoin: FACTS('Bitcoin') },
  });
  const snapshot = text.split('--- INDICATORS')[0].split('--- MARKET SNAPSHOT')[1];
  const indicators = text.split('--- INDICATORS')[1].split('--- BIG PICTURE')[0];
  const bigPicture = text.split('--- BIG PICTURE')[1].split('--- ACTIVE POSITIONS')[0];
  const venueCost = text.split('--- VENUE COST')[1].split('--- MARKET PULSE')[0];

  assert.match(snapshot, /Gold \(plus500\)/, 'the SCOPED symbol keeps its snapshot');
  // ⚠ The SCOPE FILTER line ITSELF names the omitted symbols — that is the point of it — so this must
  // assert the absence of a snapshot ROW, not of the string. A bare /Bitcoin/ here fails on correct code.
  assert.doesNotMatch(snapshot, /Bitcoin \(plus500\)/, 'the UNscoped symbol has no snapshot ROW');
  assert.match(indicators, /Gold: RSI14/, 'and its indicators stay');
  assert.doesNotMatch(indicators, /Bitcoin/, 'the unscoped indicators are gone');
  assert.match(bigPicture, /Gold: 1h:/, 'and its multi-timeframe rows stay');
  assert.doesNotMatch(bigPicture, /Bitcoin/, 'the unscoped big-picture row is gone');
  assert.match(venueCost, /Gold:/, 'and its cost row stays');
  assert.doesNotMatch(venueCost, /Bitcoin/, 'the unscoped cost row is gone');
});

test('TRD-72: ★ the omission is STATED, never silent', () => {
  // A reader who sees one symbol where the watchlist holds three must be told the rest were removed and
  // why. A filter that quietly shrinks what the chairs believe the desk can trade is the defect class
  // this desk keeps finding.
  const text = build({ symbols: [sym('Gold', ['survgold']), sym('Bitcoin', []), sym('SGX', [])] });
  assert.match(text, /SCOPE FILTER: 2 of 3 watchlist symbols are omitted/);
  assert.match(text, /cannot be entered/);
  assert.match(text, /Bitcoin, SGX/, 'and it NAMES them, so the omission is auditable');
});

test('TRD-72: ★ a HELD symbol is kept even with an empty scope — the chair needs its price to EXIT', () => {
  // Scope can be cleared while a position is open (retire a strategy and the position remains). Removing
  // that symbol would delete the price for a LIVE exit decision — the one way this optimisation could
  // cost money rather than tokens.
  const text = build({
    symbols: [sym('Gold', ['survgold']), sym('Bitcoin', [])],
    openTrades: [{ symbol: 'Bitcoin', direction: 'sell', size: 1, openPrice: 100, openAt: '2026-09-21T00:00:00Z' }],
  });
  const snapshot = text.split('--- INDICATORS')[0].split('--- MARKET SNAPSHOT')[1];
  assert.match(snapshot, /Bitcoin \(plus500\)/, 'a held symbol keeps its snapshot whatever its scope');
  assert.doesNotMatch(text, /SCOPE FILTER: 2 of 2/, 'and it is NOT counted as omitted');
});

test('TRD-72: ★ an ABSENT strategies field is UNKNOWN, and unknown is INCLUDED (fail open)', () => {
  // `quant.evaluateSymbol` records the list on every result, but a fixture, a replay or a future caller
  // that omits it must degrade to the PREVIOUS behaviour — send everything — not to hidden telemetry.
  const text = build({ symbols: [sym('Gold', ['survgold']), sym('Mystery', undefined)] });
  const snapshot = text.split('--- INDICATORS')[0].split('--- MARKET SNAPSHOT')[1];
  assert.match(snapshot, /Mystery \(plus500\)/, 'a missing field is not evidence of an absent scope');
  assert.doesNotMatch(text, /SCOPE FILTER:/, 'and nothing is claimed to be omitted');
});

test('TRD-72: the unconditional sections are untouched by the filter', () => {
  const text = buildBundle({
    trigger: 'schedule', now: new Date('2026-09-22T00:00:00Z'),
    session: { state: 'open', detail: 'market open' },
    quantResult: { symbols: [sym('Bitcoin', [])] },
    openTrades: [{ symbol: 'Bitcoin', direction: 'sell', size: 2, openPrice: 101, openAt: '2026-09-21T00:00:00Z' }],
    closedTrades: [{ symbol: 'Oil', direction: 'buy', size: 1, openPrice: 90, closePrice: 91, grossPnl: 1, status: 'closed', closeAt: '2026-09-20T00:00:00Z' }],
  });
  assert.match(text, /HARD RULE: one position per symbol/, 'hard rules stay');
  assert.match(text, /Session state: open/, 'session state stays');
  assert.match(text, /--- ACTIVE POSITIONS/);
  assert.match(text, /Bitcoin sell size=2/, 'the position row stays');
  assert.match(text, /--- LAST 3 CLOSED TRADES/);
  assert.match(text, /Oil buy size=1/, 'the closed-trade row stays');
});

test('TRD-72: ★ the CONSTANT HEAD is byte-identical whatever the filter removes (TRD-78(a))', () => {
  // The filter must not touch the cacheable prefix. Its explanatory line lives INSIDE MARKET SNAPSHOT,
  // after the clock warning, precisely so the head cannot vary with the symbol set.
  const head = (symbols) => build({ symbols }).split('--- MARKET SNAPSHOT')[0];
  const few = head([sym('Gold', ['survgold'])]);
  const many = head([sym('Gold', ['survgold']), sym('Bitcoin', []), sym('SGX', []), sym('Silver', [])]);
  assert.strictEqual(few, many, 'a prefix cache must be able to match this head across wakes');
});

test('TRD-72: the stored object keeps the CENSUS and records the scope per row', () => {
  // ⚠ CORRECTED 2026-09-23. This test used to assert `obj.snapshot.map(s => s.symbol)` was `['Gold']` — the
  // stored object was filtered too. That bought ZERO prompt tokens (the chairs read the TEXT, which filters
  // independently; `context.centralContext` reads `quantResult.symbols` directly) and it trimmed the
  // dashboard's only data source (`public/js/app.js:370,566`), so the Decisions tab showed 2 of 12
  // watchlist symbols the moment this went live. The contract now: the object is the RECORD of what was
  // evaluated; only the chair's TEXT omits.
  const obj = buildBundleObj({
    userId: 1, trigger: 'schedule', now: new Date('2026-09-22T00:00:00Z'),
    session: { state: 'open', detail: 'market open' },
    quantResult: { symbols: [sym('Gold', ['survgold']), sym('Bitcoin', []), sym('SGX', [])] },
    openTrades: [], closedTrades: [],
    venueCostFacts: { Gold: FACTS('Gold'), Bitcoin: FACTS('Bitcoin') },
  });
  assert.deepEqual(obj.scopeFilter, { of: 3, scoped: 1, omitted: ['Bitcoin', 'SGX'] },
    'the record still says what the chair did NOT render');
  assert.deepEqual(obj.snapshot.map((s) => s.symbol), ['Gold', 'Bitcoin', 'SGX'],
    '★ the stored census keeps EVERY symbol evaluated — no silent gap in the record');
  assert.deepEqual(obj.snapshot.filter((s) => s.scoped).map((s) => s.symbol), ['Gold'],
    'and each row states whether the chair rendered it');
  assert.deepEqual(Object.keys(obj.venueCosts || {}), ['Gold'],
    'venueCosts stays scoped: it is the twin of the prompt SECTION, and nothing outside the prompt reads it');
});

test('TRD-72: the census and the chair\'s view cannot silently diverge', () => {
  // The failure this pins: a reader counts snapshot rows, compares them with `quant`'s own `evaluated`
  // count, and finds fewer — with nothing in the record explaining it. The invariants are that `of` IS the
  // census length, and that the rows marked `scoped` are exactly the rows the TEXT rendered.
  const symbols = [sym('Gold', ['survgold']), sym('Oil', ['survoil']), sym('Sugar', []), sym('Silver', [])];
  const args = {
    userId: 1, trigger: 'schedule', now: new Date('2026-09-22T00:00:00Z'),
    session: { state: 'open', detail: 'open' }, openTrades: [], closedTrades: [],
  };
  const obj = buildBundleObj({ ...args, quantResult: { symbols } });
  const text = buildBundle({ ...args, quantResult: { symbols } });
  assert.strictEqual(obj.snapshot.length, obj.scopeFilter.of, '`of` is the census, by definition');
  assert.strictEqual(obj.snapshot.filter((s) => s.scoped).length, obj.scopeFilter.scoped);
  const rendered = symbols.filter((s) => text.includes(`${s.symbol} (plus500)`)).map((s) => s.symbol);
  assert.deepEqual(rendered, obj.snapshot.filter((s) => s.scoped).map((s) => s.symbol),
    'the text rendered exactly the rows the object marked as scoped');
});
