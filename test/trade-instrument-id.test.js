'use strict';
// test/trade-instrument-id.test.js — 2026-10-27. Which instrument is a trade judged against?
//
// ⚠ THE DEFECT THIS PINS. `constraintAudit.runOnce` resolved a trade's instrument ONLY from a symbol→id map built
// from `Instruments` AT AUDIT TIME. The fact was reconstructed later rather than recorded at entry, so:
//   · a symbol renamed in the registry between entry and audit made the trade unjoinable;
//   · an OPTION contract could never join — `Instruments.symbol` holds the underlying ("Gold") while `Trades.symbol`
//     holds the venue's composite name ("Oil | Call 94 | Sep W2"). Measured: 4 such trades, `instrument_unknown`.
// Migration 055 records the id on the row; the map remains the fallback for the 316 rows that predate it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tradeInstrumentId } = require('../trading/agent/constraintAudit');

const map = (pairs) => new Map(pairs);

test('★ the RECORDED id wins — the map is not consulted when the row carries one', () => {
  // The conflicting map entry is the whole point: a registry that has since re-pointed the symbol must not be able to
  // override what was true when the trade was opened.
  assert.equal(tradeInstrumentId({ symbol: 'Gold', venueInstrumentId: '11' }, map([['Gold', '999']])), '11');
});

test('★ an option trade joins on its recorded id even though its symbol matches nothing', () => {
  const id = tradeInstrumentId({ symbol: 'Oil | Call 94 | Sep W2', venueInstrumentId: '1888' }, map([['Oil', '14']]));
  assert.equal(id, '1888');
});

test('a row that predates the column falls back to the symbol map', () => {
  assert.equal(tradeInstrumentId({ symbol: 'Gold', venueInstrumentId: null }, map([['Gold', '11']])), '11');
  assert.equal(tradeInstrumentId({ symbol: 'Gold' }, map([['Gold', '11']])), '11');
});

test('★ an EMPTY STRING is absent, not present — the comparison this repo has already paid for once', () => {
  // `'' != null` is TRUE. Treating a blank id as recorded would produce an id nothing can match, and the trade would
  // silently become `instrument_unknown` again with a value sitting in the column.
  assert.equal(tradeInstrumentId({ symbol: 'Gold', venueInstrumentId: '' }, map([['Gold', '11']])), '11');
  assert.equal(tradeInstrumentId({ symbol: 'Gold', venueInstrumentId: '' }, map([['Gold', '']])), null);
});

test('nothing recorded and no match is NULL — never a guess', () => {
  assert.equal(tradeInstrumentId({ symbol: 'Unknown Thing' }, map([['Gold', '11']])), null);
  assert.equal(tradeInstrumentId({}, map([])), null);
  assert.equal(tradeInstrumentId(null, map([])), null);
  assert.equal(tradeInstrumentId({ symbol: 'Gold' }, null), null);
});

test('ids are compared as STRINGS, because a venue id may be numeric in one place and text in another', () => {
  assert.strictEqual(tradeInstrumentId({ symbol: 'Gold', venueInstrumentId: 11 }, map([])), '11');
  assert.strictEqual(tradeInstrumentId({ symbol: 'Gold' }, map([['Gold', 11]])), '11');
});

// --- structural: the write path must actually carry it -------------------------------------------
test('★ the trades writer still has the column — a refactor must not silently drop it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'store.js'), 'utf8');
  assert.match(src, /INSERT INTO Trades \([^)]*venueInstrumentId\)/,
    'store.createTrade no longer writes venueInstrumentId — migration 055 would be dead and the audit would fall back '
    + 'to the symbol map for every new trade');
});

test('★ and the entry path passes it through from the risk resolution', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'wakePipeline.js'), 'utf8');
  assert.match(src, /venueInstrumentId: \(d\.sizeCalc && d\.sizeCalc\.venueFloor/,
    'wakePipeline no longer passes venueInstrumentId to openTrade — new trades would record NULL and the column would '
    + 'fill with nothing');
});

test('★ the venue\'s own id is read AT SUBMIT and the executor PREFERS it over the risk resolution', () => {
  // The risk resolution cannot name an option (its composite contract name has no registry row), so the chart read is
  // the only source that works for the case this column exists to fix. Two halves, both pinned.
  const wt = fs.readFileSync(path.join(__dirname, '..', 'trading', 'plus500', 'webtrader.js'), 'utf8');
  assert.match(wt, /const chartSymbol = await readChartSymbol\(page\);/, 'placeOrder must read the chart symbol');
  assert.match(wt, /return \{\s*positionId: posId,\s*chartSymbol,/, 'and return it with the fill');
  const ex = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'executor.js'), 'utf8');
  assert.match(ex, /chartInstrumentId\(fill && fill\.chartSymbol\)/,
    'executor must parse the fill\'s chartSymbol rather than relying on the risk resolution alone');
});
