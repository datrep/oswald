// test/spread-derivation.test.js — TRD-79: the DERIVED spread basis and the three guards it must carry.
//
// WHAT THIS PINS. TRD-79's original fix direction ("compute the per-symbol half-spread as the p75 of
// stored tick history") was measured before it was implemented, and the measurement REFUTED parts of
// the row and turned up three ways the naive version would have been a silent defect. Each has a test
// here, because each is a mistake that has ALREADY been made once in this repo:
//
//   1. A SINGLE-SIDED FEED DERIVES A ZERO SPREAD. yahoo is structurally a mid feed (4,431/4,431 ticks
//      with ask == bid), so a p75 over it is 0.00000% -> a 0.00 bps round trip -> THE MOST PERMISSIVE
//      BUDGET POSSIBLE, and every yahoo venue would be admitted on a cost of zero. That is the
//      `Number(null) === 0` coercion this codebase has now fixed five times, arriving through a new
//      door. A derivation must REFUSE a feed it cannot measure, and the refusal must be ABSENCE from
//      the basis map rather than a 0 in it.
//
//   2. THE HALF-DIVISOR. `cfdSpreadPct` is a HALF-spread (% of price per side): `(ask - bid)/2/mid*100`.
//      A full spread is 2x that and the two are indistinguishable in a column of small numbers. The
//      first measurement of this row used the full spread and reported "the curated table is twice the
//      derived value" — the mistake was mine and `reproductionVerdict` is the check that caught it, so
//      that check is pinned here rather than left inside a temp script.
//
//   3. VENUE. Provider venues are a DIFFERENT MARKET, not a cheaper one (measured 2.77x to 11,475x
//      apart against the desk's reference), so rows from another venue are excluded and counted, never
//      averaged in.
//
// AND THE COMPOSITION, which is what makes this change safe: a spread is NOT a round trip. The budget
// stays `2 x (spread + slip) x 100`. A derived spread substituted for it would move venue admission,
// the net-edge screen and the TRD-114 cost ceiling at once (Gold 11.94 -> 3.08 bps).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const sd = require('../trading/agent/spreadDerivation');
const bt = require('../trading/agent/backtest');
const vc = require('../trading/agent/venueComparability');

// Module-level state, so every test starts from a known state.
function reset() { bt.setSpreadDerivation({}); }
const row = (bid, ask, extra = {}) => ({ venue: 'plus500', symbol: 'Test', source: 'plus500_frontend', bid, ask, ...extra });

// --- guard 1: a single-sided feed is REFUSED, never priced at zero --------------------------------
test('GUARD 1: a mid-only feed (ask == bid) is refused, and the refusal is ABSENCE not zero', () => {
  // yahoo's shape exactly: every row two-sided in appearance, none of them actually two-sided.
  const yahoo = Array.from({ length: 200 }, () => row(77.36, 77.36, { venue: 'yahoo', source: 'yahoo_rest' }));
  const r = sd.deriveHalfSpread(yahoo, { venue: 'yahoo', sources: ['yahoo_rest'] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'single_sided_feed');
  assert.equal(r.halfPct, null, 'a mid feed did NOT derive a spread');
  assert.equal(r.twoSided, 0);
  assert.equal(r.flat, 200, 'the flat count is what proves the refusal was about the feed');
  // And the map the cost model consumes holds NO entry for it — an entry of 0 would be a free trade.
  const basis = sd.deriveSpreadBasis(yahoo, { venue: 'yahoo', sources: ['yahoo_rest'] });
  assert.deepEqual(basis.basis, {});
  assert.deepEqual(basis.refused.single_sided_feed, ['Test']);
});

test('GUARD 1: flat rows do not drag a real p75 down — they are excluded, not treated as zero', () => {
  // plus500's real shape: 1,020 two-sided Gold ticks against 3,257 flat `position_poll` reads.
  const twoSided = Array.from({ length: 40 }, () => row(100, 100.02));
  const flat = Array.from({ length: 200 }, () => row(95.52, 95.52, { source: 'position_poll' }));
  const withFlat = sd.deriveHalfSpread([...twoSided, ...flat]);
  const withoutFlat = sd.deriveHalfSpread(twoSided);
  assert.equal(withFlat.ok, true);
  assert.equal(withFlat.twoSided, 40);
  // The position reads are excluded ONE STEP EARLIER, as non-quotes: `position_poll` reports the
  // position's current rate, which is a price and not a quote, so it never even reaches the flat
  // counter. The filter order is venue -> source -> shape, and it is pinned here because "which bucket
  // did this row land in" is what a refusal's diagnosis is built from.
  assert.equal(withFlat.flat, 0);
  assert.equal(withFlat.excludedBySource.position_poll, 200, 'the position reads are excluded BY SOURCE');
  assert.equal(sd.classifyRow(flat[0]).kind, 'not_a_quote_source');
  assert.equal(withFlat.halfPct, withoutFlat.halfPct, 'the flat rows contributed nothing to the value');
  // The value is the half-spread of 0.02 on a 100.01 mid, i.e. 0.009999%, NOT 0.019998%.
  assert.ok(Math.abs(withFlat.halfPct - 0.009999) < 1e-6, `derived ${withFlat.halfPct}`);
});

test('GUARD 1: a sample below the floor is REFUSED with the count, not priced', () => {
  const r = sd.deriveHalfSpread([row(100, 100.02)]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'below_min_sample');
  assert.equal(r.twoSided, 1);
  assert.equal(r.minTwoSided, sd.MIN_TWO_SIDED);
  assert.equal(sd.deriveSpreadBasis([row(100, 100.02)]).results[0].halfPct, null);
});

test('GUARD 1: an unreadable row is not a zero spread either', () => {
  assert.equal(sd.halfSpreadPct(null, null), null);
  assert.equal(sd.halfSpreadPct(100, null), null);
  assert.equal(sd.halfSpreadPct(0, 0.02), null);
  assert.equal(sd.halfSpreadPct(100, 99.98), null, 'an inverted quote is not a two-sided quote');
  const r = sd.deriveSpreadBasis([row(null, 100), row(100, 99.98)], {});
  assert.deepEqual(r.basis, {});
  assert.deepEqual(r.refused.single_sided_feed, ['Test']);
  assert.equal(sd.classifyRow(row(100, 99.98)).why, 'ask < bid', 'an inverted quote is refused AS inverted');
});

// --- guard 2: the half-divisor, and the check that caught the 2x error -----------------------------
test('GUARD 2: the quantity is a HALF-spread — (ask - bid)/2/mid — and fullPct is exactly 2x', () => {
  // 100.00 / 100.02 -> full 0.02 on a 100.01 mid = 0.019998%, halved = 0.009999%.
  const full = ((100.02 - 100) / 100.01) * 100;
  const half = sd.halfSpreadPct(100, 100.02);
  assert.ok(Math.abs(half - full / 2) < 1e-12, `half ${half} vs full/2 ${full / 2}`);
  assert.ok(Math.abs(half - 0.009999) < 1e-6);
  const r = sd.deriveHalfSpread(Array.from({ length: 40 }, () => row(100, 100.02)));
  assert.ok(Math.abs(r.fullPct - 2 * r.halfPct) < 1e-9);
  assert.equal(r.unit, sd.UNIT);
});

test('GUARD 2: reproductionVerdict names a 2x mismatch instead of calling it a difference', () => {
  // The exact shape of my own error: a FULL spread compared against a HALF one reads as "2x", and a
  // verdict of "differs" would have been a shrug rather than a diagnosis.
  assert.equal(sd.reproductionVerdict(0.01, 0.02).verdict, 'unit_mismatch_2x');
  assert.equal(sd.reproductionVerdict(0.02, 0.01).verdict, 'unit_mismatch_half');
  assert.equal(sd.reproductionVerdict(0.00982, 0.0097).verdict, 'reproduces');
  assert.equal(sd.reproductionVerdict(null, 0.0097).verdict, 'not_comparable');
  assert.equal(sd.reproductionVerdict(0, 0.0097).verdict, 'not_comparable', 'zero is not a comparable basis');
});

test('GUARD 2: the curated table reproduces from tick history 7/7 (measured 2026-09-21)', () => {
  // The measured derived values and the table entries, as data. If a future change makes the
  // derivation a full spread, 7 of these 7 flip to `unit_mismatch_2x` and this test says so in words.
  const measured = [
    ['Bitcoin', 0.07500, 0.0750], ['Gold', 0.00982, 0.0097], ['Arabica Coffee', 0.03793, 0.0378],
    ['SGX', 0.25084, 0.2507], ['Sugar', 0.08203, 0.0817], ['Silver', 0.04525, 0.0468], ['Oil', 0.03714, 0.0364],
  ];
  for (const [symbol, derived, curated] of measured) {
    const v = sd.reproductionVerdict(derived, curated);
    assert.equal(v.verdict, 'reproduces', `${symbol}: ratio ${v.ratio}`);
    assert.ok(v.ratio > 0.98 && v.ratio < 1.04, `${symbol}: ratio ${v.ratio}`);
    assert.equal(bt.CALIBRATED_SPREAD_HALF_PCT[symbol], curated, `${symbol} table value moved`);
  }
});

// --- guard 3: venue scoping ------------------------------------------------------------------------
test('GUARD 3: another venue is a different market — excluded AND counted, never averaged in', () => {
  const rows = [
    ...Array.from({ length: 40 }, () => row(100, 100.02)),
    // okx quotes Gold tighter; the desk does not trade there, and blending would price a market the
    // desk cannot reach (measured 2.77x apart on Gold, 11,475x on Bitcoin).
    ...Array.from({ length: 40 }, () => row(100, 100.005, { venue: 'okx', source: 'okx_rest' })),
  ];
  const r = sd.deriveHalfSpread(rows);
  assert.equal(r.ok, true);
  assert.equal(r.twoSided, 40, 'only the desk venue priced the symbol');
  assert.equal(r.excludedByVenue.okx, 40);
  assert.ok(Math.abs(r.halfPct - 0.009999) < 1e-6, 'the okx rows did not tighten the value');
});

test('GUARD 3: a feed from another venue alone is refused, not silently priced', () => {
  const okx = Array.from({ length: 100 }, () => row(100, 100.005, { venue: 'okx', source: 'okx_rest' }));
  const r = sd.deriveHalfSpread(okx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_rows_at_desk_venue');
  assert.equal(sd.deriveHalfSpread(okx, { venue: 'okx', sources: ['okx_rest'] }).ok, true, 'and it is the VENUE that refused it');
});

test('GUARD 3: a feed whose only rows are position reads is refused, and says so', () => {
  const reads = Array.from({ length: 100 }, () => row(95.5, 95.5, { source: 'position_poll' }));
  const r = sd.deriveHalfSpread(reads);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_quote_source_rows');
  assert.equal(r.excludedBySource.position_poll, 100);
});

// --- the composition, which is what keeps the three gates from moving all at once ------------------
test('A SPREAD IS NOT A ROUND TRIP: nothing here is ever returned in bps', () => {
  const r = sd.deriveHalfSpread(Array.from({ length: 40 }, () => row(100, 100.02)));
  assert.equal(r.covers, sd.COVERS);
  assert.equal(r.covers, 'spread_only');
  assert.equal(r.unit, 'half_spread_pct_per_side');
  assert.ok(!('roundTripBps' in r) && !('bps' in r), 'no result carries a budget');
  assert.ok(!('roundTripBps' in sd.deriveSpreadBasis([])), 'not even the whole-basis result');
});

test('the budget stays 2 x (spread + slip) x 100 — the derivation feeds ONE term of it', () => {
  reset();
  bt.setSpreadDerivation({ derived: { 'Wilmar International': { halfPct: 0.382, n: 63 } }, provenance: { days: 14 } });
  const cfg = bt.costCfgFor('Wilmar International');
  assert.equal(cfg.cfdSpreadPct, 0.382);
  assert.equal(cfg.cfdSlippagePct, 0.05, 'the CALIBRATED slippage term is composed in, not replaced');
  assert.equal(vc.roundTripBpsFromCfg(cfg), 86.4, '2 x (0.382 + 0.05) x 100');
  assert.notEqual(vc.roundTripBpsFromCfg(cfg), 76.4, 'a spread-only budget would have been 2 x 0.382 x 100');
  reset();
});

// --- the lane's precedence and provenance -----------------------------------------------------------
test('the CURATED entry wins over a derived one, and keeps its own label', () => {
  reset();
  bt.setSpreadDerivation({ derived: { Gold: { halfPct: 0.00982, n: 1020 } }, provenance: { days: 14 } });
  const cfg = bt.costCfgFor('Gold');
  assert.equal(cfg.cfdSpreadPct, 0.0097, 'the calibration of record, not the window-dependent p75');
  assert.equal(cfg.costModelBasis.spread, 'tick_history_p75');
  assert.equal(cfg.costModelVersion, 'v2');
  assert.equal(cfg.costModelBasis.spreadSample, undefined, 'a curated value has no sample size to report');
  assert.equal(vc.roundTripBpsFromCfg(cfg), 11.94, 'three live gates read this number — it did not move');
  reset();
});

test('the derived lane prices a symbol that has no curated entry, and SAYS how thin it is', () => {
  reset();
  assert.equal(bt.costCfgFor('Wilmar International').costModelVersion, 'v1-flat', 'the gap being filled');
  assert.equal(vc.roundTripBpsFromCfg(bt.costCfgFor('Wilmar International')), null, 'null, not zero');
  bt.setSpreadDerivation({
    derived: { 'Wilmar International': { halfPct: 0.382, n: 63 } },
    provenance: { venue: 'plus500', days: 14, rows: 12345 },
  });
  const cfg = bt.costCfgFor('Wilmar International');
  assert.equal(cfg.costModelVersion, 'v2-derived', 'a computed basis is not labelled v2 (a curated one)');
  assert.equal(cfg.costModelBasis.spread, 'tick_history_p75_derived');
  assert.equal(cfg.costModelBasis.spreadSample, 63);
  assert.equal(bt.getSpreadDerivation().provenance.rows, 12345, 'the provenance says what the audit read');
  reset();
});

test('the audit relabels a curated entry it could NOT verify, and only when audited', () => {
  reset();
  // Ethereum/Solana/BNB/SHEIN/PAX Gold have NO stored ticks at all: the number is a decision, not a
  // measurement, and until the audit runs the label says tick_history_p75 (the historical label — this
  // change must not silently relabel stored provenance).
  assert.equal(bt.costCfgFor('Ethereum').costModelBasis.spread, 'tick_history_p75');
  bt.setSpreadDerivation({ derived: {}, unverifiable: ['Ethereum'], provenance: { venue: 'plus500', days: 14 } });
  assert.equal(bt.costCfgFor('Ethereum').costModelBasis.spread, 'calibrated_table');
  assert.equal(bt.costCfgFor('Ethereum').cfdSpreadPct, 0.1251, 'the curated number is kept — relabelled, not deleted');
  assert.equal(bt.costCfgFor('Gold').costModelBasis.spread, 'tick_history_p75', 'a verified entry is untouched');
  reset();
});

test('a derived entry of zero (or an unusable one) is DROPPED, not stored', () => {
  reset();
  bt.setSpreadDerivation({
    derived: { Zero: 0, Null: null, NaNd: 'abc', Neg: -1, Obj: { halfPct: null, n: 90 }, Good: { halfPct: 0.02, n: 40 } },
    provenance: { days: 14 },
  });
  const d = bt.getSpreadDerivation();
  assert.deepEqual(Object.keys(d.derived), ['Good']);
  assert.equal(d.derived.Good.halfPct, 0.02);
  assert.equal(d.derived.Good.n, 40);
  assert.equal(bt.costCfgFor('Zero').costModelVersion, 'v1-flat');
  reset();
});

test('UNSEEDED IS UNCHANGED: the fallbacks behave exactly as before this lane existed', () => {
  reset();
  assert.deepEqual(bt.costCfgFor('Gold'), {
    cfdSpreadPct: 0.0097, cfdSlippagePct: 0.05, cfdSwapClockMinuteUtc: null,
    costModelVersion: 'v2',
    // TRD-114 added `slippage` to the basis label. Unseeded means the flat placeholder prices the symbol, and the
    // label says so — the point of the field is that a measured basis and a placeholder can never look alike.
    costModelBasis: {
      spread: 'tick_history_p75', funding: 'flat_placeholder',
      slippage: 'calibrated_placeholder', swapClock: 'utc_midnight',
    },
  });
  assert.deepEqual(bt.costCfgFor('ZZZ-NOT-AN-INSTRUMENT'), { costModelVersion: 'v1-flat' });
  assert.equal(bt.getSpreadDerivation().audited, false);
  // An unseeded slippage lane is ALSO unchanged: no residual, placeholder price.
  assert.deepEqual(bt.getSlipDerivation().derived, {});
});

test('a provenance-less seed cannot relabel anything (an audit that did not happen is not an audit)', () => {
  reset();
  bt.setSpreadDerivation({ derived: { Gold: 0.0098 }, unverifiable: ['Ethereum'] });
  assert.equal(bt.getSpreadDerivation().audited, false);
  assert.equal(bt.costCfgFor('Ethereum').costModelBasis.spread, 'tick_history_p75');
  reset();
});
