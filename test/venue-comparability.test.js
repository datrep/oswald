'use strict';
// TRD-69 — is that venue pricing the SAME INSTRUMENT? Tests for the pure comparability module.
//
// The most important test here is the EMPTY one. The first run of this module against the live store
// aligned 0 pairs for every venue and reported it as a tidy result, because the store's column is
// `closePrice` and the code read `close`. An empty alignment is not "no difference" - it is no
// evidence, and it must never be reported as comparable. That is the same silence-reads-as-a-verdict
// failure this desk has hit twice already.
const test = require('node:test');
const assert = require('node:assert');
const vc = require('../trading/agent/venueComparability');

const HOUR = 3600000;
const t0 = Date.parse('2026-09-01T00:00:00Z');
const series = (n, fn, { offsetMin = 0, key = 'closePrice', start = t0 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ barStart: new Date(start + i * HOUR + offsetMin * 60000), [key]: fn(i) }));

const flat = (n, price) => series(n, () => price);
const n = 120; // > minPoints

// --- align -----------------------------------------------------------------

test('TRD-69: align reads closePrice, not close (the live silent-empty bug)', () => {
  const a = series(10, () => 100);
  const b = series(10, () => 100);
  assert.equal(vc.align(a, b).length, 10);
  // the trap: a series keyed `close` produces NO pairs, which must read as no evidence
  const wrongKey = series(10, () => 100, { key: 'close' });
  assert.equal(vc.align(a, wrongKey).length, 0);
  assert.equal(vc.assess(vc.align(a, wrongKey)).comparable, false);
  assert.equal(vc.assess(vc.align(a, wrongKey)).verdict, 'insufficient_data');
});

test('TRD-69: align buckets to the hour, so a :47 bar meets a :00 bar', () => {
  // measured: plus500_chart/binance/okx sit on :00 but yahoo lands anywhere in the hour (0..47)
  const ref = series(20, () => 100, { offsetMin: 0 });
  const yahooish = series(20, () => 100, { offsetMin: 47 });
  assert.equal(vc.align(ref, yahooish).length, 20, 'hour bucketing must pair these');
  assert.equal(vc.align(ref, yahooish, { bucketMs: 1 }).length, 0, 'exact-timestamp joining silently drops the whole venue');
});

test('TRD-69: align is an inner join on time and drops non-positive/non-finite closes', () => {
  const ref = series(5, () => 100);
  const sparse = [{ barStart: new Date(t0 + HOUR), closePrice: 101 }, { barStart: new Date(t0 + 99 * HOUR), closePrice: 999 }];
  assert.equal(vc.align(ref, sparse).length, 1);
  assert.equal(vc.align(ref, [{ barStart: new Date(t0), closePrice: 0 }]).length, 0, 'a zero close is not a price');
  assert.equal(vc.align(ref, [{ barStart: new Date(t0), closePrice: null }]).length, 0);
});

// --- assess: the four states -----------------------------------------------

test('TRD-69: identical series are comparable', () => {
  const r = vc.assess(vc.align(flat(n, 100), flat(n, 100)));
  assert.equal(r.comparable, true);
  assert.equal(r.verdict, 'comparable');
  assert.equal(r.medianBps, 0);
});

test('TRD-69: a small STABLE offset is a level gap - a different instrument/basis, not staleness', () => {
  // 100 -> 100.10 is +9.99 bps, held exactly
  const r = vc.assess(vc.align(flat(n, 100), flat(n, 100.1)));
  assert.equal(r.comparable, false);
  assert.equal(r.verdict, 'level_gap_stable');
  assert.equal(r.levelOk, false);
  assert.equal(r.stable, true);
  assert.match(r.reason, /will not converge/);
});

test('TRD-69: matching level with scatter is timing/staleness, NOT a different instrument', () => {
  const ref = series(n, (i) => 100 + (i % 2));
  const noisy = series(n, (i) => 100 + ((i + 1) % 2)); // same mean, no level gap
  const r = vc.assess(vc.align(ref, noisy));
  assert.equal(r.verdict, 'scatter_only');
  assert.equal(r.comparable, false);
  assert.match(r.reason, /timing\/staleness/);
});

test('TRD-69: a large offset WITH scatter says so, and names the level gap as dominant', () => {
  // This is Gold/yahoo as measured: median -116.84 bps, residual 108.43 bps. The first version of
  // this module called that "divergent ... timing/staleness", which was wrong and is why there are
  // four states.
  const ref = series(n, (i) => 4270 + (i % 3));
  const other = series(n, (i) => (4270 + (i % 3)) * 0.9883 * (1 + ((i % 5) - 2) / 1000));
  const r = vc.assess(vc.align(ref, other));
  assert.equal(r.verdict, 'level_gap_with_scatter');
  assert.equal(r.comparable, false);
  assert.match(r.reason, /level gap dominates/i);
});

test('TRD-69: too few points is insufficient_data, never comparable', () => {
  const r = vc.assess(vc.align(flat(10, 100), flat(10, 100)));
  assert.equal(r.verdict, 'insufficient_data');
  assert.equal(r.comparable, false);
  assert.equal(r.medianBps, 0, 'it may still show what little it saw');
  assert.match(r.reason, /not enough to say anything/);
});

test('TRD-69: NO DATA is never comparable - the silent-empty trap', () => {
  for (const input of [[], null, undefined]) {
    const r = vc.assess(input);
    assert.equal(r.comparable, false, 'an empty alignment must never read as a pass');
    assert.equal(r.verdict, 'insufficient_data');
    assert.equal(r.points, 0);
  }
});

test('TRD-69: thresholds are parameters, and moving them moves the verdict', () => {
  const pairs = vc.align(flat(n, 100), flat(n, 100.1)); // +9.99 bps
  assert.equal(vc.assess(pairs, { maxMedianBps: 5 }).comparable, false);
  assert.equal(vc.assess(pairs, { maxMedianBps: 15 }).comparable, true);
});

test('TRD-69: isSameInstrument refuses anything that is not comparable', () => {
  // RENAMED 2026-09-22 from `usableAsFallback`, which promised a money decision and computed a fact
  // about the pair. This is the DESCRIPTIVE test only; admission is `admit()` against the round trip.
  assert.equal(vc.isSameInstrument({ comparable: true }), true);
  assert.equal(vc.isSameInstrument({ comparable: false }), false);
  assert.equal(vc.isSameInstrument(null), false);
  assert.equal(vc.isSameInstrument(undefined), false);
  assert.equal(vc.usableAsFallback, undefined, 'the misleading name must not come back');
});

// --- small maths ------------------------------------------------------------

test('TRD-69: median and quantile behave, including the null cases', () => {
  assert.equal(vc.median([3, 1, 2]), 2);
  assert.equal(vc.median([4, 1, 3, 2]), 2.5);
  assert.equal(vc.median([]), null);
  assert.equal(vc.median([1, NaN, 3]), 2, 'non-finite values are ignored, not counted as zero');
  assert.equal(vc.quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(vc.quantile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(vc.quantile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(vc.quantile([], 0.9), null);
});

test('TRD-69: bps is relative to the reference and never divides by zero', () => {
  assert.equal(vc.bps(101, 100), 100);
  assert.equal(vc.bps(100, 100), 0);
  assert.equal(vc.bps(100, 0), null);
});

test('TRD-69: sensitivity never counts a pair it could not measure', () => {
  const rows = vc.sensitivity({ good: vc.align(flat(n, 100), flat(n, 100)), empty: [] }, [5, 50]);
  for (const band of rows) assert.ok(!band.venues.includes('empty'), 'an unmeasured venue must not appear as comparable at any tolerance');
  assert.ok(rows.find((b) => b.tolMedianBps === 5).venues.includes('good'));
});

// --- B4: admission. The threshold is DERIVED from the round-trip cost, never chosen -----------------
//
// The principle of record (2026-09-15 review, decision 3): "a substitutable venue must have residual
// bias below the round-trip cost, because otherwise the substitution costs more than it saves". So the
// budget below is the symbol's own cost, and the charge is the error the substitute imports.

const GOLD_RT = vc.roundTripBpsFromCfg({ cfdSpreadPct: 0.0097, cfdSlippagePct: 0.05 });   // 11.94 bps
const SGX_RT = vc.roundTripBpsFromCfg({ cfdSpreadPct: 0.2507, cfdSlippagePct: 0.05 });    // 60.14 bps

test('B4: roundTripBpsFromCfg derives the calibration of record, per side doubling included', () => {
  // spread and slip are PER SIDE and in PERCENT; a round trip is 2x, and percent -> bps is x100.
  assert.equal(vc.roundTripBpsFromCfg({ cfdSpreadPct: 0.0097, cfdSlippagePct: 0.05 }), 11.94); // Gold
  assert.equal(vc.roundTripBpsFromCfg({ cfdSpreadPct: 0.0364, cfdSlippagePct: 0.05 }), 17.28); // Oil
  assert.equal(vc.roundTripBpsFromCfg({ cfdSpreadPct: 0.0750, cfdSlippagePct: 0.05 }), 25);    // Bitcoin
  assert.equal(vc.roundTripBpsFromCfg({ cfdSpreadPct: 0.2507, cfdSlippagePct: 0.05 }), 60.14); // SGX
});

test('B4: an ABSENT cost is not a zero cost - the third appearance of Number(null) === 0', () => {
  // `Number(null) === 0` would make the missing dial the most permissive budget there is, admitting
  // everything. The absence has to be rejected before any coercion.
  for (const cfg of [{}, null, undefined, { cfdSpreadPct: 0.0097 }, { cfdSlippagePct: 0.05 }]) {
    assert.equal(vc.roundTripBpsFromCfg(cfg), null, `${JSON.stringify(cfg)} has no derivable round trip`);
  }
  const a = vc.assess(vc.align(flat(n, 100), flat(n, 100)));
  for (const roundTripBps of [null, undefined, '', 0, NaN, -5]) {
    const r = vc.admit(a, { roundTripBps });
    assert.equal(r.admitted, false, `no usable cost basis (${String(roundTripBps)}) must fail closed`);
    assert.equal(r.code, 'no_cost_basis');
  }
  // REPORTED distinctly though, because "we could not find a cost" and "the cost is zero" are two
  // different defects and a reader must be able to tell which one it is looking at.
  assert.equal(vc.admit(a, {}).budgetBps, null, 'absent -> unknown, not zero');
  assert.equal(vc.admit(a, { roundTripBps: null }).budgetBps, null);
  assert.equal(vc.admit(a, { roundTripBps: '' }).budgetBps, null);
  assert.equal(vc.admit(a, { roundTripBps: 0 }).budgetBps, 0, 'present-but-zero is reported AS zero');
  assert.equal(vc.admit(a, { roundTripBps: -5 }).budgetBps, -5, 'and a nonsense negative is not hidden');
});

test('B4: an unmeasured pair is not an admitted pair', () => {
  for (const pairs of [[], null, undefined]) {
    const r = vc.admit(vc.assess(pairs), { roundTripBps: GOLD_RT });
    assert.equal(r.admitted, false);
    assert.equal(r.code, 'insufficient_data');
  }
  assert.equal(vc.admit(null, { roundTripBps: GOLD_RT }).code, 'insufficient_data');
});

test('B4: every branch returns the same shape - no undefined keys for a reader to trip over', () => {
  const shapes = [
    vc.admit(vc.assess([]), { roundTripBps: GOLD_RT }),                       // insufficient_data
    vc.admit(vc.assess(vc.align(flat(n, 100), flat(n, 100))), {}),             // no_cost_basis
    vc.admit(vc.assess(vc.align(flat(n, 100), flat(n, 100))), { roundTripBps: GOLD_RT }), // admitted
    vc.admit(vc.assess(vc.align(flat(n, 100), flat(n, 100.2))), { roundTripBps: GOLD_RT }), // refused
  ];
  const keys = Object.keys(shapes[0]).sort();
  for (const s of shapes) {
    assert.deepEqual(Object.keys(s).sort(), keys, 'one shape for every branch');
    // STRICT: `assert.notEqual` is `!=`, for which `null != undefined` is FALSE - it would fail on the
    // deliberate nulls below rather than on an actual omission, which is the opposite of its purpose.
    for (const [k, v] of Object.entries(s)) assert.notStrictEqual(v, undefined, `${k} must be present, not undefined`);
  }
});

test('B4: a perfect pair is admitted, with the headroom stated', () => {
  const r = vc.admit(vc.assess(vc.align(flat(n, 100), flat(n, 100))), { roundTripBps: GOLD_RT });
  assert.equal(r.admitted, true);
  assert.equal(r.code, 'admitted');
  assert.equal(r.chargedBps, 0);
  assert.equal(r.headroomBps, 11.94);
  assert.equal(r.needsOffset, false);
  assert.match(r.reason, /11\.94 bps round trip/);
});

test('B4: an uncorrected level gap is charged IN FULL, not just its residual', () => {
  // +9.99 bps held exactly: the residual is ~0 but the price is still 9.99 bps wrong on every decision.
  // Charging only the residual would admit a different instrument whose offset happens to be stable.
  const pairs = vc.align(flat(n, 100), flat(n, 100.1));
  const a = vc.assess(pairs);
  assert.equal(a.levelOk, false, 'the 5 bps dial calls this a level gap');
  assert.ok(a.residualP90Bps <= 0.01, 'and the residual is essentially zero');

  const under = vc.admit(a, { roundTripBps: GOLD_RT });
  assert.equal(under.admitted, true, '9.99 bps of error IS below an 11.94 bps round trip');
  assert.equal(under.chargedBps, 9.99, 'charged in full, not as the residual');
  // SIGN: assess() measures REFERENCE relative to candidate (bps(ref, other)), so a candidate priced
  // ABOVE the reference reads as a NEGATIVE gap. The offset a corrector must apply keeps that sign.
  assert.equal(under.levelGapBps, -9.99);
  assert.equal(under.needsOffset, false, 'an admission is not a promise to apply an offset');
  assert.equal(under.dominant, 'level_gap');

  // Tighten the budget below the gap and it flips to the CONDITIONAL state, never a bare refusal:
  // the offset is a genuine constant, so a caller that applies it would be safe. pickTick does not.
  const over = vc.admit(a, { roundTripBps: 9 });
  assert.equal(over.admitted, false);
  assert.equal(over.code, 'admissible_with_offset');
  assert.equal(over.needsOffset, true);
  assert.equal(over.offsetBps, -9.99, 'the offset it must apply is returned, not left to memory');
  assert.equal(over.admissibleWithOffset, true);
  assert.match(over.reason, /pickTick does not/);
});

test('B4: with the offset corrected, only the irreducible residual is charged', () => {
  const a = vc.assess(vc.align(flat(n, 100), flat(n, 100.1)));
  const r = vc.admit(a, { roundTripBps: GOLD_RT, correctOffset: true });
  assert.equal(r.admitted, true);
  assert.ok(r.chargedBps <= 0.01, 'the level gap is gone once corrected');
  assert.equal(r.needsOffset, false, 'it has already been corrected');
});

test('B4: scatter alone can fail - and the SAME pair passes under a wider cost basis', () => {
  // +/-20 bps alternating around the same level: median 0, residual p90 ~20 - the figure the decision
  // note quotes. This is timing/staleness, not a different instrument, and the budget is what decides.
  const ref = flat(n, 100);
  const noisy = series(n, (i) => (i % 2 ? 100.2 : 99.8));
  const a = vc.assess(vc.align(ref, noisy));
  assert.equal(a.levelOk, true, 'the level matches');
  assert.ok(a.residualP90Bps >= 19 && a.residualP90Bps <= 21, `residual ~20 bps, got ${a.residualP90Bps}`);

  const gold = vc.admit(a, { roundTripBps: GOLD_RT });
  assert.equal(gold.admitted, false, '20 bps of scatter is not below a 11.94 bps round trip');
  assert.equal(gold.code, 'residual_exceeds_budget');
  assert.equal(gold.dominant, 'scatter');
  assert.equal(gold.needsOffset, false, 'there is nothing to correct - the offset is not the problem');

  const sgx = vc.admit(a, { roundTripBps: SGX_RT });
  assert.equal(sgx.admitted, true, 'the budget is PER SYMBOL: the same venue is admissible where a round trip is dear enough');
  assert.equal(sgx.chargedBps, a.p90AbsBps, 'uncorrected charges p90|diff| itself, not the residual');
});

test('B4: a level gap WITH scatter cannot be rescued by an offset', () => {
  // The measured yahoo-Gold shape: a large negative median plus large scatter. The offset is not a
  // constant, so there is nothing to subtract - naming it "admissible with offset" would be a lie.
  const ref = series(n, (i) => 4270 + (i % 3));
  const other = series(n, (i) => 4270 * 0.988 * (1 + ((i % 5) - 2) / 1000));
  const a = vc.assess(vc.align(ref, other));
  const r = vc.admit(a, { roundTripBps: vc.roundTripBpsFromCfg({ cfdSpreadPct: 0.0033, cfdSlippagePct: 0.05 }) });
  assert.equal(r.admitted, false);
  assert.equal(r.admissibleWithOffset, false, 'not fixable - the gap moves');
  assert.equal(r.code, 'level_gap_unstable');
  assert.match(r.reason, /different instrument/);
});

test('B4: admissionTable and admitLine name who survives, and "nobody" is a result', () => {
  const ref = flat(n, 100);
  const table = vc.admissionTable([
    { symbol: 'Gold', venue: 'plus500_chart', pairs: vc.align(ref, ref), roundTripBps: GOLD_RT },
    { symbol: 'Gold', venue: 'binance', pairs: vc.align(ref, series(n, (i) => (i % 2 ? 100.2 : 99.8))), roundTripBps: GOLD_RT },
  ]);
  assert.deepEqual(table.admitted, [{ symbol: 'Gold', venue: 'plus500_chart' }]);
  assert.deepEqual(table.withOffset, []);
  assert.match(vc.admitLine(table), /^admitted: Gold\/plus500_chart$/);

  const none = vc.admissionTable([
    { symbol: 'Gold', venue: 'binance', pairs: vc.align(ref, series(n, (i) => (i % 2 ? 100.2 : 99.8))), roundTripBps: GOLD_RT },
  ]);
  assert.match(vc.admitLine(none), /^admitted: NOBODY/, 'an empty admission set must be stated, not left blank');
});

test('B4: admissionTable assesses pairs itself, so a caller cannot forget to', () => {
  const ref = flat(n, 100);
  const table = vc.admissionTable([{ symbol: 'Gold', venue: 'okx', pairs: vc.align(ref, ref), roundTripBps: GOLD_RT }]);
  assert.equal(table.rows[0].assessment.verdict, 'comparable');
  assert.equal(table.rows[0].admitted, true);
});

