// test/capture-market-state.test.js — the venue's banner must beat the desk's calendar.
//
// ★ THE DEFECT, FOUND LIVE 2026-09-14 on the first OPEN-market capture (TRD-50).
//
// captureFromObservation used to compute the market state as:
//     o.market || o.marketState || marketStateOf(o.contract) || fromItems
// and `o.market` is the probe's CALENDAR reading (instrumentProbe.run() puts
// sessions.calendarState(new Date()) there). So the calendar OUTRANKED the venue's own sidebar
// banner — despite marketStateOf's comment reading "the venue's market state, from the sidebar's
// own banner rather than from our session calendar", and despite usableQuote gating every cost
// constant on `marketState === 'open'`.
//
// Observed in the SGX capture:
//     SGX  cal=open  banner=CLOSED  -> stored quote `state=open`, spread 0.115
//
// A CLOSED-MARKET spread became a consumable cost constant. That is verbatim the hazard the
// registry exists to prevent ("a closed-market spread reads 2.89 for Gold spot and must never
// become a cost constant"). The gate had only ever been exercised on days when the two sources
// agreed, which is why it looked like it worked.
//
// The rule is deliberately ONE-DIRECTIONAL: the venue may only downgrade to closed. It can never
// upgrade a closed calendar to open, so nothing previously refused becomes admitted.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const spec = require('../trading/plus500/instrumentSpec');

test('★ a venue banner saying CLOSED beats a calendar saying open', () => {
  const r = spec.resolveCaptureMarketState({ calendar: 'open', venue: 'closed', fromItems: 'unknown' });
  assert.strictEqual(r.marketState, 'closed', 'the venue is the authority on its own session');
});

test('★ the disagreement is recorded, not resolved silently', () => {
  const r = spec.resolveCaptureMarketState({ calendar: 'open', venue: 'closed', fromItems: 'unknown' });
  assert.deepStrictEqual(r.conflict, { calendar: 'open', venue: 'closed', resolved: 'closed' });
  assert.strictEqual(r.calendarState, 'open', 'the calendar reading is kept as provenance');
  assert.strictEqual(r.venueState, 'closed');
});

test('★ the rule is ONE-DIRECTIONAL: the venue cannot upgrade closed to open', () => {
  // Nothing that was refused before this change may be admitted by it.
  const r = spec.resolveCaptureMarketState({ calendar: 'closed', venue: 'open', fromItems: 'unknown' });
  assert.strictEqual(r.marketState, 'closed', 'a closed calendar stays closed');
});

test('an open calendar with no banner is open (absence of evidence is not disagreement)', () => {
  const r = spec.resolveCaptureMarketState({ calendar: 'open', venue: 'unknown', fromItems: 'unknown' });
  assert.strictEqual(r.marketState, 'open');
  assert.strictEqual(r.conflict, null, 'a missing banner is NOT a conflict — else every capture conflicts');
});

test('no calendar falls back to the venue, then to the item scan', () => {
  assert.strictEqual(spec.resolveCaptureMarketState({ venue: 'closed' }).marketState, 'closed');
  assert.strictEqual(spec.resolveCaptureMarketState({ fromItems: 'closed' }).marketState, 'closed');
  assert.strictEqual(spec.resolveCaptureMarketState({ fromItems: 'open' }).marketState, 'open');
  assert.strictEqual(spec.resolveCaptureMarketState({}).marketState, 'unknown', 'never assume open');
});

test('the recorded state is what usableQuote gates on', () => {
  // The end-to-end consequence: a closed capture must be refused by the cost model.
  const closed = spec.resolveCaptureMarketState({ calendar: 'open', venue: 'closed' });
  const verdict = spec.usableQuote({ buy: 4.0, sell: 3.9, spread: 0.1, marketState: closed.marketState });
  assert.strictEqual(verdict.usable, false, 'a closed-market spread must never be consumable');
  assert.match(verdict.reason, /market_closed/);

  const open = spec.resolveCaptureMarketState({ calendar: 'open', venue: 'unknown' });
  const ok = spec.usableQuote({ buy: 4.0, sell: 3.9, spread: 0.1, marketState: open.marketState });
  assert.strictEqual(ok.usable, true, 'an open, self-consistent quote is still usable');
});

test('★ a NON-selected row is unknown, never the calendar', () => {
  // The calendar is an opinion about the MARKET, not evidence about a particular instrument's
  // session. Measured consequence of getting this wrong, at 22:52 SGT with Hong Kong shut:
  // Geely Automobile state=open spread 0.120 and China Shenhua state=open spread 0.230, both
  // consumed by venueCostFacts as `spreadBasis: open_market_capture` — a closed-market spread
  // becoming a cost constant.
  const r = spec.quoteStateFor({ sidebarSymbol: 'Gold', symbol: 'Geely Automobile', marketState: 'open' });
  assert.strictEqual(r, 'unknown', 'no per-instrument evidence means NO assertion, whatever the calendar says');
});

test('★ the selected instrument keeps the resolved state', () => {
  assert.strictEqual(spec.quoteStateFor({ sidebarSymbol: 'Gold', symbol: 'Gold', marketState: 'open' }), 'open');
  assert.strictEqual(spec.quoteStateFor({ sidebarSymbol: 'SGX', symbol: 'SGX', marketState: 'closed' }), 'closed');
});

test('an unknown sidebar symbol cannot vouch for anything', () => {
  // A collapsed sidebar (contract null) describes nothing, so no row may be called open.
  const r = spec.quoteStateFor({ sidebarSymbol: null, symbol: 'Gold', marketState: 'open' });
  assert.strictEqual(r, 'unknown');
});

test('★ and the consequence: venueCostFacts can no longer consume such a quote', () => {
  // The single consumer of the column filters on `marketState === 'open'`.
  const state = spec.quoteStateFor({ sidebarSymbol: 'Gold', symbol: 'China Shenhua', marketState: 'open' });
  const v = spec.usableQuote({ buy: 45.53, sell: 45.30, spread: 0.23, marketState: state });
  assert.strictEqual(v.usable, false, 'this spread must not reach the cost model');
  assert.match(v.reason, /market_unknown/);
});

test('the capture path uses the helper rather than an inline ternary', () => {
  const { code } = require('./_source');
  const src = code('trading/agent/instruments.js');
  assert.match(src, /quoteStateFor\(/, 'the quote state must route through the tested helper');
});

test('marketStateOf only reports closed on positive evidence', () => {
  assert.strictEqual(spec.marketStateOf({ closedBanner: true }), 'closed');
  assert.strictEqual(spec.marketStateOf({ closedTitle: 'Market is closed' }), 'closed');
  assert.strictEqual(spec.marketStateOf({}), 'unknown', 'a missing banner is unknown, never open');
  assert.strictEqual(spec.marketStateOf(null), 'unknown');
});

test('the capture path uses the helper rather than an inline precedence chain', () => {
  const { code } = require('./_source');
  const src = code('trading/agent/instruments.js');
  assert.match(src, /resolveCaptureMarketState\(/, 'the capture must route through the tested helper');
  // The defect was this specific ASSIGNMENT: the calendar (o.market) deciding marketState before
  // the venue's banner was ever consulted. Passing the calendar INTO the helper is fine; letting
  // it pick the state on its own is the bug.
  assert.ok(!/const marketState\s*=\s*o\.market/.test(src),
    'the old `const marketState = o.market || ...` assignment must be gone — it is the bug');
});
