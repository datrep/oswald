// test/expectancy.test.js — the retirement decision must not be a coin flip.
//
// The rule this replaces retired a strategy when `expectancy <= 0`, which for a zero-edge
// strategy is true about HALF THE TIME AT EVERY n (EVIDENCE_THRESHOLDS.md rev 2.2, §4.2). The
// headline test below is therefore "a zero-edge strategy is never retired, at any n" — the fix
// stated as an assertion.
//
// The boundary tests reproduce the published table in EVIDENCE_THRESHOLDS.md §5.1 exactly
// (-0.526R at n=10, -0.351R at 20, -0.281R at 30, -0.215R at 50, at sd 0.907R). If someone
// changes the quantile convention (t -> z, or drops the spending ratio), these fail.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { normInv, tOneSided95, sampleSd, rMultiple, rStats, expectancyVerdict, driftFlag } = require('../trading/agent/expectancy');

const close = (a, b, tol = 5e-4) => assert.ok(Math.abs(a - b) < tol, `expected ${a} ~= ${b}`);

// --- quantiles ------------------------------------------------------------------
test('normInv matches published normal quantiles', () => {
  close(normInv(0.95), 1.6448536);
  close(normInv(0.975), 1.9599640);
  close(normInv(0.995), 2.5758293);
  close(normInv(0.5), 0, 1e-9);
  assert.ok(Number.isNaN(normInv(0)), 'p=0 is outside the domain');
  assert.ok(Number.isNaN(normInv(1)), 'p=1 is outside the domain');
});

test('tOneSided95 returns the tabulated values, not the normal limit', () => {
  close(tOneSided95(9), 1.833, 1e-3);
  close(tOneSided95(19), 1.729, 1e-3);
  close(tOneSided95(29), 1.699, 1e-3);
  close(tOneSided95(49), 1.677, 1e-3);   // NOT 1.645 — the t/z distinction matters
  assert.ok(tOneSided95(9) > normInv(0.95), 't must be stricter than z at n=10');
});

test('sampleSd is undefined (not zero) below two samples', () => {
  assert.ok(Number.isNaN(sampleSd([1])));
  assert.ok(Number.isNaN(sampleSd([])));
  close(sampleSd([1, 2, 3]), 1);
});

// --- R-multiples ----------------------------------------------------------------
test('the R-multiple divides by the risk the trade ACTUALLY took', () => {
  // fill 100, stop 98, size 3 → risk 6; pnl 3 → 0.5R
  close(rMultiple({ grossPnl: 3, size: 3, openPrice: 100, stopPrice: 98 }), 0.5);
  // a wider stop is more risk per unit, so the same pnl is a smaller R
  close(rMultiple({ grossPnl: 3, size: 3, openPrice: 100, stopPrice: 96 }), 0.25);
});

test('a trade with no usable stop yields no R rather than a wrong one', () => {
  assert.equal(rMultiple({ grossPnl: 3, size: 3, openPrice: 100, stopPrice: null }), null);
  assert.equal(rMultiple({ grossPnl: 3, size: null, openPrice: 100, stopPrice: 98 }), null);
  assert.equal(rMultiple({ grossPnl: 3, size: 3, openPrice: 100, stopPrice: 100 }), null, 'zero risk cannot normalise');
});

test('rStats excludes and COUNTS the trades it cannot use', () => {
  const s = rStats([
    { grossPnl: 6, size: 3, openPrice: 100, stopPrice: 98 },   // +1R
    { grossPnl: -6, size: 3, openPrice: 100, stopPrice: 98 },  // -1R
    { grossPnl: 5, size: 3, openPrice: 100, stopPrice: null }, // unusable
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.excluded, 1);
  close(s.meanR, 0);
  close(s.sdR, Math.SQRT2, 1e-6);
});

// --- the headline: a zero-edge strategy is never retired ------------------------
test('a zero-edge strategy is NOT retired, at any n — the coin flip is gone', () => {
  // This is the defect the rewrite exists to fix: the old `expectancy <= 0` branch retired a
  // strategy with exactly zero edge about half the time, at every sample size.
  for (const n of [10, 20, 30, 50, 100, 200]) {
    const v = expectancyVerdict({ n, meanR: 0, sdR: 0.907 }, { looks: 1 });
    assert.equal(v.state, 'undecided', `n=${n} should be undecided, got ${v.state}`);
    assert.ok(v.upper > 0 && v.lower < 0, 'both bounds must straddle zero');
  }
});

test('a genuinely losing strategy IS retired, and a genuinely winning one accepted', () => {
  const bad = expectancyVerdict({ n: 50, meanR: -0.5, sdR: 0.907 }, { looks: 1 });
  assert.equal(bad.state, 'retire');
  assert.ok(bad.upper < 0);
  const good = expectancyVerdict({ n: 50, meanR: 0.5, sdR: 0.907 }, { looks: 1 });
  assert.equal(good.state, 'accept');
  assert.ok(good.lower > 0);
});

test('below minTrades the verdict is insufficient, never a decision', () => {
  const v = expectancyVerdict({ n: 4, meanR: -5, sdR: 0.9 }, { minTrades: 10 });
  assert.equal(v.state, 'insufficient');
  assert.ok(/minTrades/.test(v.reason));
});

test('a degenerate sample (sd 0) is insufficient, not a zero-width certainty', () => {
  const v = expectancyVerdict({ n: 20, meanR: 0.1, sdR: 0 }, { minTrades: 10 });
  assert.equal(v.state, 'insufficient');
  assert.ok(/dispersion/.test(v.reason));
});

// --- reproduces the published boundary table ------------------------------------
test('boundaries reproduce EVIDENCE_THRESHOLDS.md §5.1 exactly (sd 0.907R, one look)', () => {
  const cases = [[10, -0.526], [20, -0.351], [30, -0.281], [50, -0.215]];
  for (const [n, want] of cases) {
    const v = expectancyVerdict({ n, meanR: 0, sdR: 0.907 }, { looks: 1, minTrades: 1 });
    close(v.boundary, want, 2e-3);
  }
});

test('more looks means a stricter boundary (alpha is spent, not reused)', () => {
  const one = expectancyVerdict({ n: 20, meanR: 0, sdR: 0.907 }, { looks: 1, minTrades: 1 });
  const many = expectancyVerdict({ n: 20, meanR: 0, sdR: 0.907 }, { looks: 12, minTrades: 1 });
  assert.ok(many.boundary < one.boundary, '12 looks must demand stronger evidence than 1');
  assert.ok(many.z > one.z);
});

test('looks defaults sanely and never divides by zero', () => {
  const v = expectancyVerdict({ n: 20, meanR: 0, sdR: 0.907 }, { looks: 0, minTrades: 1 });
  assert.equal(v.looks, 1);
  assert.ok(Number.isFinite(v.z));
});

// --- drift is a flag, not a trigger ---------------------------------------------
test('driftFlag refuses a reference it cannot trust', () => {
  assert.equal(driftFlag(30, null).comparable, false);
  // A 1-trade backtest recording 100% must not become a retirement gun.
  const thin = driftFlag(70, { winRate: 100, trades: 1 });
  assert.equal(thin.comparable, false);
  assert.ok(/cannot support a comparison/.test(thin.reason));
});

test('driftFlag reports a real lag without retiring anything', () => {
  const f = driftFlag(41, { winRate: 42, trades: 259 });
  assert.equal(f.comparable, true);
  assert.equal(f.lagging, false, 'a 1pp gap is not a 20pp lag');
  const lag = driftFlag(15, { winRate: 42, trades: 259 });
  assert.equal(lag.lagging, true);
  assert.equal(lag.gapPp, -27);
});
