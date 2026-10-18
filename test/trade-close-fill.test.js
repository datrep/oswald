// test/trade-close-fill.test.js — TRD-108: a venue close's RATE is not the trade's FILL (2026-09-21).
//
// ★★★ SUPERSEDED IN PART 2026-09-30 (TRD-PNL-5 / #1496). The TRD-108 premise — "the money says the fill went
// past the level, by 22-38% of the stop in R" — WAS THE CURRENCY, NOT SLIPPAGE. `impliedFillPrice` divided a
// P&L denominated in the ACCOUNT's currency (SGD) by a size quoted in the INSTRUMENT's (USD), so the derived
// exit sat ~1.28x further from the entry than the trade really went — 1.28 being USD/SGD, measured the hard way
// in TRD-RSK-14. Across all 60 venue closes: Gold 1.2965, Oil 1.2978, Arabica 1.3262, Silver 1.2804, against
// **SGX 1.0482** — the one SGD-quoted instrument, whose P&L currency already matches the account's.
//
// SO THE PINS BELOW WERE UPGRADED RATHER THAN RESTORED. The derivation is still correct arithmetic and still
// pinned — but it now REFUSES unless both currencies are stated and equal, and the write path is pinned to
// refuse, because a fill that cannot be derived is a gap while an invented one is a wrong measurement.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code, read } = require('./_source');
const { impliedFillPrice, sameCurrency, CLOSE_PRICE_SOURCE } = require('../trading/agent/closeFill');

const VENUE_CLOSE = 'trading/agent/venueClose.js';
const EXECUTOR = 'trading/agent/executor.js';
const AUTOPSY = 'trading/agent/autopsy.js';
const STORE = 'trading/store.js';
const MIGRATION = 'sql/migrations/041_trade_close_fill.sql';

// --- the derivation ------------------------------------------------------------

test('★ the fill falls out of the money — the row own worked case, within ONE currency', () => {
  // #1047, Oil sell: open 97.08, size 12.22, venue NetPL +28.86. The row records the result as 94.7183
  // against a take-profit of 94.7162 — a LIMIT order fills AT its level, so the money reconciles to 0.002.
  const fill = impliedFillPrice({
    openPrice: 97.08, direction: 'sell', grossPnl: 28.86, size: 12.22,
    pnlCurrency: 'USD', quoteCurrency: 'USD',
  });
  assert.strictEqual(fill, 94.718298, 'the derivation, at the 6dp the column stores');
  assert.ok(Math.abs(fill - 94.7183) < 0.0001, "and it reproduces the row's recorded 4dp figure exactly");
  assert.ok(Math.abs(fill - 94.7162) < 0.01, 'it lands on the declared take-profit, which is the point');
});

test('★★ a P&L and a price in DIFFERENT currencies derive NOTHING WITHOUT A RATE — and that is the fix', () => {
  // ⚠ THE EXACT SHAPE OF THE DEFECT, on the trade the owner pasted: #1148, Silver sell 22.5 oz, 60.826 ->
  // 61.205, S$-10.97. Spending the SGD figure as though it were USD yields 61.321556 — a fill 0.12 PAST the
  // stop, where the venue's own arithmetic puts it 0.004 past. The venue's rates and its P&L are mutually
  // consistent ONLY at fx 1.2865, so the number was never a price — and a rate-less call must NOT invent one.
  const wrong = impliedFillPrice({
    openPrice: 60.834, direction: 'sell', grossPnl: -10.97, size: 22.5,
    pnlCurrency: 'SGD', quoteCurrency: 'USD',
  });
  assert.strictEqual(wrong, null, 'an SGD P&L against a USD price, with no rate, must derive NOTHING');
  // and what it WOULD have said, kept as the evidence rather than as a value: this is the number 60 rows hold
  const asIfSame = impliedFillPrice({
    openPrice: 60.834, direction: 'sell', grossPnl: -10.97, size: 22.5,
    pnlCurrency: 'SGD', quoteCurrency: 'SGD',
  });
  assert.strictEqual(asIfSame, 61.321556, 'and this is exactly the inflation — the SGD figure spent as USD');
  assert.ok(asIfSame > 61.2011, 'i.e. past the stop the venue actually closed at');
  assert.ok(Math.abs(asIfSame - 61.321556) < 1e-6);
});

test('the currency contract: stated and EQUAL, or nothing', () => {
  const base = { openPrice: 100, direction: 'sell', grossPnl: 10, size: 2 };
  assert.strictEqual(impliedFillPrice(base), null, 'silence is not a currency');
  assert.strictEqual(impliedFillPrice({ ...base, pnlCurrency: 'SGD' }), null, 'half a contract is no contract');
  assert.strictEqual(impliedFillPrice({ ...base, pnlCurrency: 'SGD', quoteCurrency: null }), null,
    'an unknown instrument currency cannot be assumed to match the account one');
  assert.strictEqual(impliedFillPrice({ ...base, pnlCurrency: 'SGD', quoteCurrency: 'USD' }), null, 'mismatch');
  // ⚠ case and padding are not a currency difference - refusing here would hide real derivations behind a typo
  assert.strictEqual(impliedFillPrice({ ...base, pnlCurrency: 'sgd', quoteCurrency: ' SGD ' }), 95,
    'casing and whitespace are normalised, not treated as a mismatch');
  assert.strictEqual(impliedFillPrice({ ...base, pnlCurrency: 'SGD', quoteCurrency: 'SGD' }), 95);
  assert.strictEqual(sameCurrency('USD', 'usd'), true);
  assert.strictEqual(sameCurrency('', ''), false, 'two blanks are not a match');
  assert.strictEqual(sameCurrency(null, null), false);
});

test('direction flips the sign of the derivation — a buy and a sell are not the same arithmetic', () => {
  const same = { pnlCurrency: 'SGD', quoteCurrency: 'SGD' };
  const sell = impliedFillPrice({ openPrice: 100, direction: 'sell', grossPnl: 10, size: 2, ...same });
  const buy = impliedFillPrice({ openPrice: 100, direction: 'buy', grossPnl: 10, size: 2, ...same });
  assert.strictEqual(sell, 95, 'a winning SELL filled BELOW its open');
  assert.strictEqual(buy, 105, 'a winning BUY filled ABOVE its open');
});

test('an underivable fill is NULL — never 0, and never the level', () => {
  const same = { pnlCurrency: 'SGD', quoteCurrency: 'SGD' };
  assert.strictEqual(impliedFillPrice({ openPrice: 100, direction: 'sell', grossPnl: 5, size: 0, ...same }), null, 'no size');
  assert.strictEqual(impliedFillPrice({ openPrice: 100, direction: 'sell', grossPnl: 5, size: -2, ...same }), null, 'negative size');
  assert.strictEqual(impliedFillPrice({ openPrice: 100, direction: 'sideways', grossPnl: 5, size: 2, ...same }), null, 'unknown direction');
  assert.strictEqual(impliedFillPrice({ openPrice: 100, direction: 'sell', grossPnl: null, size: 2, ...same }), null, 'no P&L');
  assert.strictEqual(impliedFillPrice({ openPrice: null, direction: 'sell', grossPnl: 5, size: 2, ...same }), null, 'no open price');
  assert.strictEqual(impliedFillPrice(), null, 'nothing at all');
  assert.strictEqual(impliedFillPrice({ openPrice: 100, direction: 'sell', grossPnl: 0, size: 2, ...same }), 100,
    'a zero P&L is a REAL result (the fill equals the open), so it must not be confused with absent');
});

// --- the write paths -----------------------------------------------------------

test('★ a venue close writes BOTH facts, and says which one closePrice is', () => {
  const src = code(VENUE_CLOSE);
  assert.match(src, /closePrice: row\.closeRate \?\? null,/, 'the venue rate still lands on closePrice');
  assert.match(src, /closeFillPrice,/, 'and the derived fill lands beside it');
  assert.match(src, /closePriceSource: CLOSE_PRICE_SOURCE\.venueRate/,
    'closePriceSource must be written whenever closePrice is — provenance is not optional');
  assert.match(src, /impliedFillPrice\(\{\s*openPrice: trade\.openPrice, direction: trade\.direction, grossPnl: row\.netPnl, size: trade\.size,/,
    'derived from the VENUE P&L, which is the authoritative number');
});

test('★ a desk close writes the fill under BOTH names, so closeFillPrice has no conditional meaning', () => {
  const src = code(EXECUTOR);
  const at = src.indexOf('closePrice: fill.price ?? null,');
  assert.ok(at > -1, 'the executor still writes its own fill price');
  const block = src.slice(at, at + 400);
  assert.match(block, /closeFillPrice: fill\.price \?\? null,/, 'the same value under the fill column');
  assert.match(block, /closePriceSource: CLOSE_PRICE_SOURCE\.fill/, 'and says that closePrice IS the fill');
  // The autopsy is handed the same fact, or its slippage would fall back to a level on this path too.
  assert.match(src, /closeFillPrice: fill\.price/, 'the autopsy call carries it as well');
});

test('★★ the venue-close path takes BOTH currencies from the settings that declare them', () => {
  const src = code(VENUE_CLOSE);
  // ⚠ UPGRADED 2026-09-30 (TRD-PNL-4 / #1484). This pinned `pnlCurrency: ACCOUNT_CURRENCY` plus a hard
  // `quoteCurrency: null` - the stopgap that removed a WRONG derivation while the fact it needed was still
  // recorded nowhere. The row landed, so the stopgap is gone: both values are read from settings, and the
  // refusal now survives per INSTRUMENT (an unrecorded one resolves to null) rather than for every row.
  assert.match(src, /pnlCurrency: currencyOf\(settings\),/,
    'the P&L currency is read from the declaration, not restated');
  assert.match(src, /quoteCurrency: instrumentCurrencyOf\(settings, trade\.symbol\),/,
    'and the instrument one is looked up per symbol');
  assert.ok(!/ACCOUNT_CURRENCY/.test(src), 'the stopgap literal must be GONE, not shadowed');
  assert.ok(!/'SGD'/.test(src), 'and no currency may be written down in this module at all');
  // the venue rate is still written, WITH its provenance - the pair that makes the refusal harmless
  assert.match(src, /closePrice: row\.closeRate \?\? null,/);
  assert.match(src, /closePriceSource: CLOSE_PRICE_SOURCE\.venueRate/);
  // and with NOTHING recorded, the derivation is still refused - the safe state, not an accident
  assert.strictEqual(impliedFillPrice({
    openPrice: 60.834, direction: 'sell', grossPnl: -10.97, size: 22.5,
    pnlCurrency: null, quoteCurrency: null,
  }), null, 'nothing declared must derive nothing');
  assert.strictEqual(impliedFillPrice({
    openPrice: 60.834, direction: 'sell', grossPnl: -10.97, size: 22.5,
    pnlCurrency: 'SGD', quoteCurrency: 'USD',
  }), null, 'a recorded mismatch with NO supplied rate still refuses — the derivation may not assume one');
});

// --- #1499 residual: the conversion, with the rate the desk now stores -----------------

test('★★ WITH a stamped rate, a cross-currency P&L DOES derive — and reconciles to the venue (#1148)', () => {
  // The venue statement's own numbers, now fed the rate the P&L reconciles at: Silver sell 22.5 oz,
  // open 60.826, close rate 61.205, S$-10.97, fx 1.2865.
  const fill = impliedFillPrice({
    openPrice: 60.826, direction: 'sell', grossPnl: -10.97, size: 22.5,
    pnlCurrency: 'SGD', quoteCurrency: 'USD', fx: 1.2865,
  });
  assert.strictEqual(fill, 61.204978, 'the derivation, at the 6dp the column stores');
  assert.ok(Math.abs(fill - 61.205) < 0.001, "within a hundredth of a percent of the venue's own close rate — the rate WAS the fill");
});

test('the rate is used ONLY for a stated mismatch — never applied when the currencies already match', () => {
  assert.strictEqual(impliedFillPrice({
    openPrice: 100, direction: 'sell', grossPnl: 10, size: 2,
    pnlCurrency: 'SGD', quoteCurrency: 'SGD', fx: 2,
  }), 95, 'a same-currency derivation must IGNORE fx entirely — a rate multiplied in twice is worse than none');
});

test('a mismatch needs a USABLE rate — absent, zero, negative, non-numeric all refuse as before', () => {
  const base = { openPrice: 100, direction: 'sell', grossPnl: 10, size: 2, pnlCurrency: 'SGD', quoteCurrency: 'USD' };
  for (const fx of [null, undefined, 0, -1.2, 'x', NaN]) {
    assert.strictEqual(impliedFillPrice({ ...base, fx }), null, `fx ${String(fx)} must refuse`);
  }
  // and an UNDECLARED currency is still not "defaults to 1", rate or no rate
  assert.strictEqual(impliedFillPrice({ ...base, quoteCurrency: null, fx: 1.28 }), null);
  assert.strictEqual(impliedFillPrice({ ...base, pnlCurrency: null, fx: 1.28 }), null);
});

test('★ the write path LOOKS UP the stamped rate, and the stale premise is gone from the source', () => {
  const src = code(VENUE_CLOSE);
  assert.match(src, /fxAtClose\(userId, closedAt\)/, 'the close-time rate comes from the lookup');
  assert.match(src, /fx: fx \? fx\.fx : null,/, 'and is passed into the derivation');
  // ⚠ comments are stripped from `code()` — a claim that lives in a COMMENT must be pinned against `read()`,
  // or the pin passes vacuously (measured: the first version of this test asserted fxSgd against code()).
  assert.ok(!/does not store/.test(read(VENUE_CLOSE)), 'the premise that closed this refusal is gone from the FILE, comments included');
  assert.match(code('trading/agent/closeFill.js'), /fx = null/, 'the derivation takes the rate');
  assert.match(read('trading/agent/closeFill.js'), /fxSgd/, 'and documents where the rate comes from');
});

test('the store accepts both columns, and the schema has them', () => {
  const src = code(STORE);
  assert.match(src, /'closeFillPrice', 'closePriceSource'/, 'updateTrade allow-lists them');
  const sql = read(MIGRATION);
  assert.match(sql, /ALTER TABLE dbo\.Trades ADD closeFillPrice DECIMAL\(18,6\) NULL/);
  assert.match(sql, /ALTER TABLE dbo\.Trades ADD closePriceSource NVARCHAR\(24\) NULL/);
  assert.match(sql, /IF COL_LENGTH\('dbo\.Trades', 'closeFillPrice'\) IS NULL/, 're-runnable, like its neighbours');
});

// --- the metric that was measuring the wrong thing ------------------------------

test('★ the autopsy slippage prefers the FILL, and records which price it used', () => {
  const src = code(AUTOPSY);
  assert.match(src, /const closeFillPrice = Number\(trade\.closeFillPrice\);/, 'the column is read');
  assert.match(src, /const exitPx = Number\.isFinite\(closeFillPrice\) && closeFillPrice > 0 \? closeFillPrice : closePrice;/,
    'the fill is preferred, with closePrice as the documented fallback');
  assert.match(src, /diagnosis\.exitPriceSource = exitPx === closeFillPrice \? 'closeFillPrice' : 'closePrice';/,
    'and the record says WHICH price the number came from — old and new rows must stay distinguishable');
  // The metric itself must be computed from the chosen price, not from closePrice by accident.
  assert.match(src, /metrics\.slippagePct = \+\(\(\(\(exitPx - lastMid\) \* dir\) \/ lastMid\) \* 100\)\.toFixed\(4\);/);
  assert.ok(!/metrics\.slippagePct = \+\(\(\(\(closePrice - lastMid\)/.test(src),
    'the old closePrice-only computation must be gone, not merely shadowed');
});

test('the source constants are the only spelling of the two provenances', () => {
  assert.strictEqual(CLOSE_PRICE_SOURCE.venueRate, 'venue_rate');
  assert.strictEqual(CLOSE_PRICE_SOURCE.fill, 'fill');
  assert.ok(!/'venue_rate'/.test(code(VENUE_CLOSE)), 'the literal is not re-typed at the call site');
});
