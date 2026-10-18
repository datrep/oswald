// test/instrument-spec.test.js — TRD-45 Phase 1: the instrument-spec contract.
//
// Every fixture below is REAL data from the Phase 0 capture (2026-09-13, Gold weekly chain, 21
// instruments, market CLOSED), so the tests pin the venue's own numbers rather than my idea of
// them. The three that matter most:
//
//   1. `a closed-market spread is NEVER usable` — Phase 0 measured Gold spot's spread as 2.89 while
//      the venue was rendering "Market is closed". That number must never reach a cost model, and
//      the only thing standing between it and one is `usableQuote`.
//   2. `a missing unit amount is NEVER a zero` — `Number(null) === 0` has now bitten this codebase
//      four times; here a zero floor is a sizing floor the venue never agreed to.
//   3. `untestable pairing is NOT a pass` — Phase 0's sidebar guard reported contractSpec=YES while
//      describing the wrong instrument, because "is any instrument showing" was asked instead of
//      "is the target showing". The three-valued answer is the fix, so it is pinned.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const spec = require('../trading/plus500/instrumentSpec');
const { CODES } = spec;

// The richest instrument in the Phase 1 inventory: `Gold | Put 4225 | Sep W3` (venue id 1116957),
// whose unit kind differs from its own underlying's spot CFD (Options vs Troy Ounces).
const RICH = {
  name: 'Gold | Put 4225 | Sep W3',
  unitAmount: '15',
  unitKind: 'Options',
  leverage: '1:5',
  dynamicSpread: '0.81',
  pointValue: '1 USD',
  initialMargin: '20.00%',
  maintenanceMargin: '10.00%',
  strikePrice: '4225',
  optionType: 'Put',
  expiryDate: '1:00 AM 9/19/2026',
  nextSession: 'Mon 6:00 AM - Tue 5:00 AM',
  fundingBuy: '0.0000%',
  fundingSell: '0.0000%',
  fundingTime: '--',
  closedBanner: true,
  closedTitle: 'Market is closed',
};
// Gold spot (venue id 11) — same underlying, a TENTH of the minimum size, a different unit.
const SPOT = {
  name: 'Gold', unitAmount: '0.025', unitKind: 'Troy Ounces', leverage: '1:5',
  dynamicSpread: '2.89', pointValue: '1 USD', initialMargin: '20.00%',
  buy: '4350.52', sell: '4347.63', closedBanner: true, closedTitle: 'Market is closed',
};

// --- the absent-value trap ------------------------------------------------------
test('a missing unit amount is NEVER a zero', () => {
  // `Number(null) === 0` and `Number('') === 0`, so a bare Number.isFinite guard ACCEPTS absence and
  // yields a finite 0 — a sizing floor of zero presented as a measurement of the venue's minimum.
  for (const absent of [null, undefined, '']) assert.equal(spec.isNum(absent), false, `${absent} must be absent`);
  // `isNum` answers "is this a number", NOT "is this usable" — 0 IS a number, and conflating the two
  // here is what would let a zero through as a valid floor. The positivity check is checkSpec's job,
  // asserted separately below.
  for (const bad of ['abc', true, {}, [], NaN]) assert.equal(spec.isNum(bad), false, `${JSON.stringify(bad)} is not a number`);
  assert.equal(spec.isNum(0), true, 'zero is a number — rejecting it is a DIFFERENT rule');
  assert.equal(spec.isNum(0.025), true);
  assert.equal(spec.isNum('15'), true);

  const v = spec.checkSpec({ unitAmount: null, unitKind: 'Options', instrumentClass: 'spot' });
  assert.ok(v.includes(CODES.UNIT_MISSING));
  assert.ok(spec.violationsAreFatal(v), 'a missing unit amount must be FATAL — it is the registry\'s whole point');
  const zero = spec.checkSpec({ unitAmount: 0, unitKind: 'Options', instrumentClass: 'spot' });
  assert.ok(zero.includes(CODES.UNIT_NOT_POSITIVE));
});

// --- parsing the venue's own formats ---------------------------------------------
test('parseLeverage reads the venue ratio and refuses everything else', () => {
  assert.equal(spec.parseLeverage('1:5'), 5);
  assert.equal(spec.parseLeverage(' 1:5 '), 5);
  assert.equal(spec.parseLeverage('1:2.5'), 2.5);
  // A bare number is NOT a ratio — accepting '5' would silently treat a leverage multiplier as a
  // ratio and (via the invariant) as a 20% margin that the venue never stated.
  assert.equal(spec.parseLeverage('5'), null);
  assert.equal(spec.parseLeverage('0:5'), null);
  assert.equal(spec.parseLeverage('1:0'), null);
  assert.equal(spec.parseLeverage(null), null);
});

test('parsePercent keeps presentation out and absence null', () => {
  assert.equal(spec.parsePercent('20.00%'), 20);
  assert.equal(spec.parsePercent('0.0000%'), 0);
  assert.equal(spec.parsePercent('-0.0319%'), -0.0319);
  assert.equal(spec.parsePercent('10.00 %'), 10);
  assert.equal(spec.parsePercent('--'), null, 'an em-dash placeholder is absence, not zero');
  assert.equal(spec.parsePercent(null), null);
});

test('classifyName separates the underlying from the option, order-independently', () => {
  assert.deepEqual(spec.classifyName('Gold | Put 4225 | Sep W3'), {
    instrumentClass: 'option', underlying: 'Gold', optionType: 'Put', strikePrice: 4225, expiryLabel: 'Sep W3',
  });
  assert.deepEqual(spec.classifyName('Gold'), {
    instrumentClass: 'spot', underlying: 'Gold', optionType: null, strikePrice: null, expiryLabel: null,
  });
  // Same segments, different order — the CLASS must survive, which is what stops a venue reshuffle
  // from turning an option into a spot and hiding its expiry.
  assert.equal(spec.classifyName('Gold | Sep W3 | Call 4450').instrumentClass, 'option');
  assert.equal(spec.classifyName('Gold | Sep W3 | Call 4450').strikePrice, 4450);
  assert.equal(spec.classifyName('Oil | Call 101 | Sep W2').optionType, 'Call');
  // A bare number with no Call/Put is still a strike; it must not become the expiry label.
  assert.equal(spec.classifyName('Gold | 4225 | Sep W3').strikePrice, 4225);
  assert.equal(spec.classifyName('Gold | 4225 | Sep W3').instrumentClass, 'spot', 'no Call/Put means no option');
});

test('parseExpiry builds a real instant from components, and rejects stale ones', () => {
  const d = spec.parseExpiry('1:00 AM 9/19/2026');
  assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8, 'September');
  assert.equal(d.getDate(), 19);
  assert.equal(d.getHours(), 1);
  assert.equal(d.getMinutes(), 0);
  // 12 AM is midnight, not noon — the `% 12` case that gets this wrong by 12 hours.
  assert.equal(spec.parseExpiry('12:00 AM 9/19/2026').getHours(), 0);
  assert.equal(spec.parseExpiry('12:30 PM 9/19/2026').getHours(), 12);
  assert.equal(spec.parseExpiry('--'), null);
  assert.equal(spec.parseExpiry(''), null);
  // An expiry already in the past is a rolled contract, not a fact to store.
  assert.equal(spec.parseExpiry('1:00 AM 9/19/2026', { now: '2026-10-01T00:00:00Z' }), null);
});

// --- the venue's own arithmetic ---------------------------------------------------
test('spread is buy minus sell, and absence is null rather than zero', () => {
  assert.equal(spec.spreadOf({ buy: '4350.52', sell: '4347.63' }), 2.89);
  assert.equal(spec.spreadOf({ buy: '14.05', sell: '13.24' }), 0.81);
  // Either side missing -> null. Returning 0 here would be a ZERO COST, which is the most
  // expensive possible misreading of "we did not get the number".
  assert.equal(spec.spreadOf({ buy: null, sell: '13.24' }), null);
  assert.equal(spec.spreadOf({ buy: '14.05' }), null);
  assert.equal(spec.spreadOf({}), null);
});

test('initialMargin == 100/leverage is asserted, not derived', () => {
  const good = spec.checkSpec({ unitAmount: 15, unitKind: 'Options', instrumentClass: 'option', expiryAt: new Date(), strikePrice: 4225, leverageRaw: '1:5', initialMarginPct: 20 });
  assert.equal(good.includes(CODES.MARGIN_LEVERAGE_MISMATCH), false);
  // 1:5 implies a 20% initial margin. A 25% reading means a misparse somewhere, and the check must
  // be able to FAIL — deriving margin from leverage would make it tautological.
  const bad = spec.checkSpec({ unitAmount: 15, unitKind: 'Options', instrumentClass: 'option', expiryAt: new Date(), strikePrice: 4225, leverageRaw: '1:5', initialMarginPct: 25 });
  assert.ok(bad.includes(CODES.MARGIN_LEVERAGE_MISMATCH));
});

test('★ the margin tolerance is DERIVED from the venue\'s display precision, not chosen', () => {
  // ★ 2026-09-29 — THE LIVE COUNTER-EXAMPLE. This check used a flat 0.01 with the comment "enough to
  // absorb the display rounding to 2dp". Bitcoin disagrees: the venue states '1:1.67' and 60.00%, so a
  // flat test computed 100/1.67 = 59.8802 and reported a mismatch on a row the venue considers
  // consistent. The error in the MARGIN scales as 100/L^2 x dL, so a 2dp ratio permits 0.18 points at
  // L = 1.67 and 0.005 at L = 10 — no flat constant can be right at both ends of a 6x spread.
  const btc = { unitAmount: 1, unitKind: 'Bitcoin', instrumentClass: 'spot', leverageRaw: '1:1.67', initialMarginPct: 60 };
  assert.equal(spec.checkSpec(btc).includes(CODES.MARGIN_LEVERAGE_MISMATCH), false, 'the real Bitcoin row must not be flagged');
  // The window is the venue's OWN precision, so it is narrow: 1:1.67 can only imply 59.70-60.06%.
  assert.ok(spec.checkSpec({ ...btc, initialMarginPct: 61 }).includes(CODES.MARGIN_LEVERAGE_MISMATCH), 'and a one-point error still fails');
  assert.ok(spec.checkSpec({ ...btc, initialMarginPct: 55 }).includes(CODES.MARGIN_LEVERAGE_MISMATCH));
  // The tight-ratio end of the spread is unaffected: a 1:10 row has almost no rounding slack, which is
  // why the old constant looked fine for two weeks — six of the seven live rows have err = 0.0000.
  assert.equal(spec.checkSpec({ unitAmount: 10, unitKind: 'Shares', instrumentClass: 'spot', leverageRaw: '1:10', initialMarginPct: 10 }).includes(CODES.MARGIN_LEVERAGE_MISMATCH), false);
  assert.ok(spec.checkSpec({ unitAmount: 10, unitKind: 'Shares', instrumentClass: 'spot', leverageRaw: '1:10', initialMarginPct: 9 }).includes(CODES.MARGIN_LEVERAGE_MISMATCH), '1:10 permits 9.995-10.005%, not 9%');
});

test('a spread that disagrees with buy minus sell is a violation', () => {
  const ok = spec.checkSpec({ unitAmount: 15, unitKind: 'Options', instrumentClass: 'option', expiryAt: new Date(), strikePrice: 4225, spread: 0.81, buy: 14.05, sell: 13.24 });
  assert.equal(ok.includes(CODES.SPREAD_MISMATCH), false);
  const bad = spec.checkSpec({ unitAmount: 15, unitKind: 'Options', instrumentClass: 'option', expiryAt: new Date(), strikePrice: 4225, spread: 1.23, buy: 14.05, sell: 13.24 });
  assert.ok(bad.includes(CODES.SPREAD_MISMATCH));
});

test('an option without an expiry or a strike is not storable as one', () => {
  const v = spec.checkSpec({ unitAmount: 1.5, unitKind: 'Options', instrumentClass: 'option', leverageRaw: '1:5', initialMarginPct: 20 });
  assert.ok(v.includes(CODES.OPTION_NO_EXPIRY));
  assert.ok(v.includes(CODES.OPTION_NO_STRIKE));
  // And a SPOT carrying option fields is the mirror-image error: the class was misread.
  const sp = spec.checkSpec({ unitAmount: 0.025, unitKind: 'Troy Ounces', instrumentClass: 'spot', strikePrice: 4225 });
  assert.ok(sp.includes(CODES.SPOT_WITH_OPTION_FIELDS));
});

// --- the three-valued pairing check ------------------------------------------------
test('untestable pairing is NOT a pass', () => {
  assert.equal(spec.pairsWithRow('Gold | Put 4225 | Sep W3', 'Gold | Put 4225 | Sep W3'), true);
  assert.equal(spec.pairsWithRow('Gold | Put 4225 | Sep W3', 'Gold | Call 4225 | Sep W3'), false);
  // null = we could not tell (sidebar collapsed, or the page rotated away). The bug Phase 0 caught
  // was this collapsing into "true" and reporting a confident YES for the wrong instrument.
  assert.equal(spec.pairsWithRow('Gold', null), null);
  assert.equal(spec.pairsWithRow(null, 'Gold'), null);
  assert.deepEqual(
    spec.checkSpec({ venueName: 'Gold', unitAmount: 1, unitKind: 'x', instrumentClass: 'spot' }, { rowName: null }),
    [CODES.PAIRING_UNTESTABLE],
    'an unverifiable pairing is reported, not silently accepted',
  );
  // A CONFIRMED mismatch is fatal: the spec describes a different instrument than the row.
  const mism = spec.checkSpec({ venueName: 'A', unitAmount: 1, unitKind: 'x', instrumentClass: 'spot' }, { rowName: 'B' });
  assert.ok(mism.includes(CODES.SIDEBAR_MISMATCH));
  assert.ok(spec.violationsAreFatal(mism));
});

// --- THE PHASE 0 REGRESSION: closed-market quotes ---------------------------------
test('a closed-market spread is NEVER usable', () => {
  // Gold spot, 2026-09-13: buy 4350.52 / sell 4347.63 -> 2.89, captured while the venue rendered
  // "Market is closed". It is a placeholder rate, not a cost.
  const closed = spec.usableQuote({ buy: '4350.52', sell: '4347.63', marketState: 'closed' });
  assert.equal(closed.usable, false);
  assert.match(closed.reason, /market_closed_at_capture/);

  // The SAME numbers are usable once the market is open — the gate is about when, not what.
  const open = spec.usableQuote({ buy: '4350.52', sell: '4347.63', marketState: 'open' });
  assert.equal(open.usable, true);
  assert.equal(open.spread, 2.89);

  // 'unknown' is a real answer and must not be treated as open (a missing banner is not evidence
  // that trading is live).
  assert.equal(spec.usableQuote({ buy: 1, sell: 0.9, marketState: 'unknown' }).usable, false);
  assert.equal(spec.usableQuote({ buy: 1, sell: 0.9 }).usable, false, 'an absent state is not open');
  // Degenerate numbers are refused for their own reasons.
  assert.equal(spec.usableQuote({ buy: 1, sell: 1, marketState: 'open' }).reason, 'non_positive_spread');
  assert.equal(spec.usableQuote({ buy: 1, marketState: 'open' }).reason, 'quote_incomplete');
  assert.equal(spec.usableQuote(null).reason, 'no_quote');
});

test('marketStateOf reads the venue banner and stays unknown without one', () => {
  assert.equal(spec.marketStateOf({ closedBanner: true }), 'closed');
  assert.equal(spec.marketStateOf({ closedTitle: 'Market is closed' }), 'closed');
  assert.equal(spec.marketStateOf({ closedTitle: 'Opens on Mon 6:00 AM' }), 'unknown');
  assert.equal(spec.marketStateOf({}), 'unknown');
  assert.equal(spec.marketStateOf(), 'unknown');
});

// --- the real read, end to end ------------------------------------------------------
test('the richest Phase 0 instrument converts cleanly', () => {
  const { spec: row, marketState, violations } = spec.toRow(RICH, { rowName: RICH.name, tzOffsetMinutes: 0 });
  assert.equal(marketState, 'closed');
  assert.equal(row.venueName, 'Gold | Put 4225 | Sep W3');
  assert.equal(row.symbol, 'Gold');
  assert.equal(row.instrumentClass, 'option');
  assert.equal(row.optionType, 'Put');
  assert.equal(row.strikePrice, 4225);
  assert.equal(row.unitAmount, 15);
  assert.equal(row.unitKind, 'Options');
  assert.equal(row.leverageRaw, '1:5', 'the ratio is stored RAW, never as a bare multiplier');
  assert.equal(row.initialMarginPct, 20);
  assert.equal(row.maintenanceMarginPct, 10);
  assert.equal(row.pointValue, 1);
  assert.equal(row.pointValueUnit, 'USD');
  assert.equal(row.spread, 0.81);
  assert.ok(row.expiryAt instanceof Date);
  // The ONLY violations on a real capture are provenance ones. Nothing here is fatal, so the row is
  // storable — the closed-market note records WHY the spread is not a cost.
  assert.deepEqual(violations, [CODES.CLOSED_CAPTURE]);
  assert.equal(spec.violationsAreFatal(violations), false, 'a closed capture is provenance, not a defect');
});

test('the spot CFD on the SAME underlying is a different instrument', () => {
  // This is the finding that motivated the whole phase: one underlying, two classes, and minimums
  // that differ by 600x (0.025 Troy Ounces vs 15 Options).
  const { spec: row, violations } = spec.toRow(SPOT, { rowName: SPOT.name });
  assert.equal(row.instrumentClass, 'spot');
  assert.equal(row.unitAmount, 0.025);
  assert.equal(row.unitKind, 'Troy Ounces');
  assert.equal(row.optionType, null);
  assert.equal(row.expiryAt, null);
  assert.deepEqual(violations, [CODES.CLOSED_CAPTURE]);
});

test('toRow on junk produces violations instead of a confident row', () => {
  const { spec: row, violations } = spec.toRow({}, { rowName: null });
  assert.equal(row.instrumentClass, 'spot', 'the safe default: an unknown class is not option');
  assert.equal(row.unitAmount, null);
  assert.equal(row.spread, null);
  assert.ok(violations.includes(CODES.UNIT_MISSING));
  assert.ok(spec.violationsAreFatal(violations), 'and it must not be usable');
  assert.equal(spec.toRow(null).spec.unitAmount, null);
});

// --- migration 045: the venue's OWN label for the field the minimum is read from --------------------
//
// `unitAmount` is read BY COLUMN POSITION (`sidebar.rates-and-values.column-0.value`; column-1 is leverage,
// column-2 the dynamic spread), and the comment above that line ASSERTS its meaning. So the one field the
// desk enforces as a hard sizing veto is the one field identified by where it sits rather than by its own
// name. Migration 045 records the venue's own word for it when the probe can match it against the venue's
// LABELLED definition/value list.
test('the venue\u2019s label for the stat box is carried, and its absence stays NULL', () => {
  const labelled = spec.toRow({ ...SPOT, unitAmountLabel: 'Minimum trade size' }, { rowName: 'Gold' });
  assert.equal(labelled.spec.unitAmountLabel, 'Minimum trade size');
  assert.equal(labelled.spec.unitAmount, 0.025, 'the label must not disturb the value beside it');
  assert.equal(labelled.spec.unitKind, 'Troy Ounces', 'nor the unit');

  // NULL MEANS "THE VENUE DOES NOT LABEL THIS FIELD", never "no minimum" — so an unlabelled read must
  // produce null rather than an empty string that reads like a label someone forgot to fill in.
  for (const absent of [undefined, null, '']) {
    const r = spec.toRow({ ...SPOT, unitAmountLabel: absent }, { rowName: 'Gold' });
    assert.equal(r.spec.unitAmountLabel, null, `${JSON.stringify(absent)} must resolve to null, not ${JSON.stringify(r.spec.unitAmountLabel)}`);
  }
  assert.equal(spec.toRow(SPOT, { rowName: 'Gold' }).spec.unitAmountLabel, null,
    'a probe that never sent a label must not have one invented for it');
});

test('the label is ADDITIVE: it changes no violation and no other field', () => {
  // The registry's COALESCE ("a null means this read did not include it, never the venue says there is
  // none") lives in store/instruments.js. The spec half has to hold too: a new field must not perturb what
  // checkSpec says about an otherwise-good row, or every capture's violation list would move at once.
  const withLabel = spec.toRow({ ...RICH, unitAmountLabel: 'Amount' }, { rowName: RICH.name, tzOffsetMinutes: 0 });
  const without = spec.toRow(RICH, { rowName: RICH.name, tzOffsetMinutes: 0 });
  assert.deepEqual(withLabel.violations, without.violations, 'the label must not add or remove a violation');
  assert.equal(withLabel.spec.unitAmount, 15);
  assert.equal(withLabel.spec.unitKind, 'Options');
  assert.equal(withLabel.marketState, without.marketState, 'nor move the market state');
});

// --- quoteForInstrument: the option-chain confusion that cost the desk its cost model ----------------
//
// MEASURED 2026-09-14 (the live registry): `symbol='Gold'` carried 97 open-market quotes from the
// OPTION chain and 17 from the spot row. The cost facts took the newest quote per SYMBOL, which was an
// option's - buy 67.18 / sell 65.62, i.e. a premium, on a day Gold spot traded ~4300 - and charged its
// premium-relative half-spread as the spot CFD's cost. Real numbers below.

const OPT_QUOTE = { venue: 'plus500', venueInstrumentId: '1115812', symbol: 'Gold', buy: 67.18, sell: 65.62, marketState: 'open', capturedAt: '2026-09-14T14:53:51.806Z' };
const SPOT_QUOTE = { venue: 'plus500', venueInstrumentId: '1110000', symbol: 'Gold', buy: 4312.90, sell: 4312.62, marketState: 'open', capturedAt: '2026-09-14T14:53:51.790Z' };
// Exactly the expression `venueCostFacts` uses to turn a quote into a cost.
const halfPct = (q) => ((q.buy - q.sell) / 2) / ((q.buy + q.sell) / 2) * 100;

test('the same symbol in two classes: the quote must match the INSTRUMENT, not the name', () => {
  const quotes = [OPT_QUOTE, SPOT_QUOTE];
  // The option quote is NEWER, so a symbol-keyed "newest wins" picks it. That was the defect.
  assert.ok(new Date(OPT_QUOTE.capturedAt) > new Date(SPOT_QUOTE.capturedAt));
  const got = spec.quoteForInstrument(quotes, { venue: 'plus500', venueInstrumentId: '1110000' });
  assert.equal(got, SPOT_QUOTE, 'the spot row gets the spot quote, never the newer option one');
  const half = halfPct(got);
  assert.ok(half > 0.0032 && half < 0.0034, `the spot half-spread is ~0.0033% of price, got ${half}`);
});

test('the option-only failure is quantified: same expression, 350x the number', () => {
  // This is what a symbol-keyed pick actually charged: a half-spread RELATIVE TO A PREMIUM.
  const wrong = halfPct(OPT_QUOTE);
  assert.equal(Math.round(wrong * 1e4) / 1e4, 1.1747, 'the fabricated half-spread, in percent');
  const right = halfPct(SPOT_QUOTE);
  assert.ok(wrong / right > 300, 'and it was more than two orders of magnitude from the truth');
  // Which makes the round trip the cost model charges (2 x (half + 0.05 slip) x 100 bps) absurd:
  const rt = (h) => Math.round(2 * (h + 0.05) * 100 * 100) / 100;
  assert.equal(rt(wrong), 244.94, 'Gold was charged a 244.94 bps round trip');
  assert.ok(rt(right) < 12, `instead of ~${rt(right)} bps`);
});

test('NO symbol-level fallback: another instrument quote is not this one\u2019s quote', () => {
  // The whole point. Absence is the honest answer and it lets the cost model keep the calibrated basis.
  const onlyOption = [OPT_QUOTE];
  assert.equal(spec.quoteForInstrument(onlyOption, { venue: 'plus500', venueInstrumentId: '1110000' }), null);
  // ...even when the symbol matches and the quote is fresh and open.
  assert.equal(spec.quoteForInstrument(onlyOption, { venue: 'plus500', venueInstrumentId: null }), null,
    'an instrument with no venue id can never be matched to a quote');
});

test('a closed-market quote can never win, however new it is', () => {
  const closedNewer = { ...SPOT_QUOTE, marketState: 'closed', capturedAt: '2026-09-14T23:00:00.000Z' };
  assert.equal(spec.quoteForInstrument([closedNewer, SPOT_QUOTE], { venue: 'plus500', venueInstrumentId: '1110000' }), SPOT_QUOTE);
  assert.equal(spec.quoteForInstrument([closedNewer], { venue: 'plus500', venueInstrumentId: '1110000' }), null,
    'Phase 0 measured 2.89 for Gold spot while the venue said closed - it must never become a cost');
});

test('the venue must match too, and the newest of the SAME instrument wins', () => {
  const otherVenue = { ...SPOT_QUOTE, venue: 'yahoo' };
  assert.equal(spec.quoteForInstrument([otherVenue], { venue: 'plus500', venueInstrumentId: '1110000' }), null);
  const older = { ...SPOT_QUOTE, capturedAt: '2026-09-13T00:00:00.000Z' };
  assert.equal(spec.quoteForInstrument([older, SPOT_QUOTE], { venue: 'plus500', venueInstrumentId: '1110000' }), SPOT_QUOTE);
  // ids are compared as strings: the driver returns NVARCHAR as a string, the spec row may carry a number
  assert.equal(spec.quoteForInstrument([SPOT_QUOTE], { venue: 'plus500', venueInstrumentId: 1110000 }), SPOT_QUOTE);
});
