// test/geometry-replay.test.js — the ordering rules of the path replay, pinned rather than inferred.
//
// The module exists because the desk's payoff ratio is an OUTPUT (TRD-TP-1 #1412), so the only way to rank a
// geometry is to walk a real path and ask which level was touched FIRST. Every rule that decides that is a
// rule that could be got wrong in the permissive direction, so each one is pinned here.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const g = require('../trading/agent/geometryReplay');

const T0 = '2026-09-28T00:00:00Z';
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();
const path = (mids) => mids.map((m, i) => ({ at: at(i), mid: m }));

// --- the levels -----------------------------------------------------------------------------------
test('a long puts its stop BELOW and its target ABOVE; a short mirrors it', () => {
  const long = g.levels({ direction: 'buy', entryPx: 100, riskPct: 1, targetMultiple: 2 });
  assert.equal(long.ok, true);
  assert.equal(long.stopPx, 99);
  assert.equal(long.targetPx, 102);
  assert.equal(long.payoffRatio, 2);

  const short = g.levels({ direction: 'sell', entryPx: 100, riskPct: 1, targetMultiple: 2 });
  assert.equal(short.stopPx, 101, 'a short is stopped ABOVE');
  assert.equal(short.targetPx, 98, 'and targets BELOW');
  assert.equal(short.payoffRatio, 2, 'the ratio is direction-free — that is what makes it comparable');
});

test('the direction sign is applied in ONE place, so a replay cannot silently become long-only', () => {
  // Identical paths, opposite directions: the outcomes must be mirror images, not the same outcome twice.
  const up = path([100, 101, 102, 103]);
  const long = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: up, riskPct: 1, targetMultiple: 2 });
  const short = g.replayPath({ direction: 'sell', entryPx: 100, entryAt: T0, path: up, riskPct: 1, targetMultiple: 2 });
  assert.equal(long.outcome, 'target');
  assert.equal(short.outcome, 'stop');
  assert.equal(long.grossR, 2);
  assert.equal(short.grossR, -1);
});

test('absent or unusable inputs are refused rather than defaulted', () => {
  assert.equal(g.levels({ direction: 'hold', entryPx: 100, riskPct: 1, targetMultiple: 2 }).ok, false);
  assert.equal(g.levels({ direction: 'buy', entryPx: null, riskPct: 1, targetMultiple: 2 }).ok, false);
  assert.equal(g.levels({ direction: 'buy', entryPx: 100, riskPct: 0, targetMultiple: 2 }).ok, false);
  assert.equal(g.levels({ direction: 'buy', entryPx: 100, riskPct: 1, targetMultiple: 0 }).ok, false);
  assert.equal(g.replayPath({ direction: 'buy', entryPx: 100, path: null, riskPct: 1, targetMultiple: 2 }).ok, false);
  // targetOn='declared' with no declared distance is an unanswerable question, not a zero.
  assert.equal(g.levels({ direction: 'buy', entryPx: 100, riskPct: 1, targetMultiple: 2, targetOn: 'declared' }).ok, false);
  assert.equal(g.levels({ direction: 'buy', entryPx: 100, riskPct: 1, targetMultiple: 2, targetOn: 'nonsense' }).ok, false);
});

// --- which level came first -----------------------------------------------------------------------
test('the FIRST level touched decides, not the more favourable one', () => {
  const stopFirst = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 99, 103]), riskPct: 1, targetMultiple: 2 });
  assert.equal(stopFirst.outcome, 'stop', 'it dipped to the stop before it reached the target');

  const targetFirst = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 102, 98]), riskPct: 1, targetMultiple: 2 });
  assert.equal(targetFirst.outcome, 'target', 'the stop was touched LATER and must not win');
  assert.equal(targetFirst.exitPx, 102);
});

test('a level executes AT ITS LEVEL, not at the mid that reported the breach', () => {
  // A 10s sample can sit well past the level. Booking the sample's mid turns a stop into a smaller loss purely
  // from sampling luck, and a target into a bigger win.
  const stopped = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 95]), riskPct: 1, targetMultiple: 2 });
  assert.equal(stopped.outcome, 'stop');
  assert.equal(stopped.exitPx, 99, 'the stop is 99, not the 95 the sample happened to print');
  assert.equal(stopped.grossR, -1, 'and the loss is exactly one unit of risk');

  const targeted = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 102, 102.5]), riskPct: 1, targetMultiple: 2 });
  assert.equal(targeted.exitPx, 102);
  assert.equal(targeted.grossR, 2, 'a win is exactly the payoff ratio, before cost');
});

test('a step wide enough to have crossed BOTH levels is FLAGGED, and both policies are available', () => {
  // 100 -> 103 in one sample, with a 1% stop and a 2% target: the gap is 3% and the step is 3%, so the path
  // MAY have dipped to 99 before reaching 103 and the sample cannot say.
  const observed = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 103]), riskPct: 1, targetMultiple: 2 });
  assert.equal(observed.coarse, true, 'the step is flagged whatever the policy');
  assert.equal(observed.ambiguous, 1);
  assert.equal(observed.outcome, 'target', 'by default the observed sequence decides — it is the only evidence of order');

  const strict = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 103]), riskPct: 1, targetMultiple: 2, coarsePolicy: 'stop' });
  assert.equal(strict.outcome, 'stop', 'under the strict policy an unreadable step is charged as a loss');
  assert.equal(strict.coarse, true);

  // The same destination reached in two calm steps is decidable and is never flagged.
  const calm = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 101, 103]), riskPct: 1, targetMultiple: 2 });
  assert.equal(calm.outcome, 'target');
  assert.equal(calm.coarse, false);
  assert.equal(calm.ambiguous, 0);
});

// --- the window -----------------------------------------------------------------------------------
test('ticks at or before the entry are ignored', () => {
  const pre = [{ at: at(-5), mid: 90 }, { at: at(-1), mid: 120 }, { at: at(1), mid: 100.5 }];
  const v = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: pre, riskPct: 1, targetMultiple: 2 });
  assert.equal(v.outcome, 'timeout', 'the 90 and the 120 happened before the position existed');
  assert.equal(v.ticks, 1);
});

test('the horizon is the same for every geometry, and a timeout exits at the last price', () => {
  const far = path([100, 100.4, 100.6, 105]);
  const capped = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: far, riskPct: 1, targetMultiple: 2, maxHoldMin: 2 });
  assert.equal(capped.outcome, 'timeout', 'the target is only reached on minute 3');
  assert.equal(capped.exitPx, 100.6, 'so it exits at the last price INSIDE the horizon');
  assert.equal(capped.holdMin, 2);
});

test('an empty window is no_data, not a zero return', () => {
  const v = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: [], riskPct: 1, targetMultiple: 2 });
  assert.equal(v.outcome, 'no_data');
  assert.equal(v.grossR, null, 'a missing measurement is a state, not a 0.00R trade');
  assert.equal(v.netR, null);
});

// --- cost -----------------------------------------------------------------------------------------
test('cost is charged on EVERY trade, in units of the risk, win or lose', () => {
  // The round trip is a fixed % of PRICE, so a tighter stop makes it a bigger share of R.
  const win = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 102]), riskPct: 1, targetMultiple: 2, costPct: 0.2 });
  const loss = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 99]), riskPct: 1, targetMultiple: 2, costPct: 0.2 });
  assert.equal(win.grossR, 2);
  assert.equal(win.costR, 0.2, '0.2% of price against a 1% risk is 0.2R');
  assert.equal(win.netR, 1.8);
  assert.equal(loss.netR, -1.2, 'a loser pays the round trip too — this is why break-even is not 1/(1+R)');
});

test('an ABSENT cost basis is null, never a free trade', () => {
  const v = g.replayPath({ direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 99]), riskPct: 1, targetMultiple: 2 });
  assert.equal(v.costR, null);
  assert.equal(v.netR, v.grossR, 'with no basis the gross stands, and costR says WHY');
});

test('break-even includes cost: p = (1 + c/r) / (1 + k)', () => {
  assert.equal(g.breakevenWinRate({ targetMultiple: 1, costShareOfR: 0 }), 0.5, 'a 1R target with free trading is a coin flip');
  const p143 = g.breakevenWinRate({ targetMultiple: 1.425, costShareOfR: 0.215 });
  assert.ok(Math.abs(p143 - (1.215 / 2.425)) < 1e-12);
  assert.ok(p143 > 0.5, 'at 1.425R with Gold\'s cost share the desk needs better than a coin flip');
  assert.equal(g.breakevenWinRate({ targetMultiple: 1.425 }), null, 'no cost basis -> no number, not a smaller one');
  assert.equal(g.breakevenWinRate({ targetMultiple: 0, costShareOfR: 0.1 }), null);
});

// --- the mechanism under test: (a) versus (b) -----------------------------------------------------
test('targeting the DECLARED distance is what makes capping the stop raise the payoff ratio', () => {
  // This is the whole defect in one assertion. Same stop, same target rule, two reward bases:
  //   (a) target = k x DECLARED   -> capping the stop shrinks the denominator only
  //   (b) target = k x RISK       -> the payoff ratio IS k, whatever the cap does
  const a = g.levels({ direction: 'buy', entryPx: 100, riskPct: 0.5, targetMultiple: 1.425, declaredRiskPct: 2, targetOn: 'declared' });
  const b = g.levels({ direction: 'buy', entryPx: 100, riskPct: 0.5, targetMultiple: 1.425, declaredRiskPct: 2, targetOn: 'risk' });
  assert.equal(a.payoffRatio, 5.7, '2% declared / 0.5% capped x 1.425 — the cap inflated it 4x');
  assert.equal(b.payoffRatio, 1.425, 'the named parameter holds regardless of the cap');
  assert.ok(a.targetPx > b.targetPx, 'and (a) is reaching for a much further price');
});

test('the grid applies the cap by SHORTENING the risk, never the reward, and only when it binds', () => {
  const rows = g.grid({
    direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 100.6, 100.9]),
    declaredRiskPct: 1, stopScales: [1], targetMultiples: [1], targetOn: 'risk', capPct: 0.3,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].riskPct, 0.3, 'a 1% declared stop is capped to 0.3%');
  assert.equal(rows[0].cappedBy, 'cap');

  // A declared stop NARROWER than the cap is untouched — a cap must never widen a stop.
  const wide = g.grid({
    direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 100.6]),
    declaredRiskPct: 0.2, stopScales: [1], targetMultiples: [1], targetOn: 'risk', capPct: 0.3,
  });
  assert.equal(wide[0].riskPct, 0.2);
  assert.equal(wide[0].cappedBy, null, 'the cap did not bind and must not be credited');
});

test('under (b) the payoff ratio is constant across stop widths, which is the point of (b)', () => {
  const rows = g.grid({
    direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 100.2, 100.4]),
    declaredRiskPct: 1, stopScales: [0.25, 1, 2], targetMultiples: [2], targetOn: 'risk',
  });
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.levels.payoffRatio, 2, `stopScale ${r.stopScale} changed the payoff ratio under (b)`);
  // Under (a) the same sweep is NOT constant: the reward base moves with the declared distance while the stop
  // does not, so the ratio is 2 x declared/risk.
  const a = g.grid({
    direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 100.2, 100.4]),
    declaredRiskPct: 1, stopScales: [0.25, 1, 2], targetMultiples: [2], targetOn: 'declared',
  });
  assert.deepEqual(a.map((r) => r.levels.payoffRatio), [8, 2, 1], 'under (a) it swings 8x with the stop width');
});

test('the grid refuses a stop scale it cannot build rather than guessing a width', () => {
  const rows = g.grid({
    direction: 'buy', entryPx: 100, entryAt: T0, path: path([100, 100.5]),
    declaredRiskPct: null, stopScales: [1, 2], targetMultiples: [1], targetOn: 'risk',
  });
  assert.equal(rows.length, 0, 'no declared distance means no risk unit, so no grid');
});

// --- the statistics that decide how much of a ranking survives the sample ---------------------------
test('mean and percentile are honest about an empty sample', () => {
  assert.equal(g.mean([]), null, 'a mean over nothing is not 0 — it is absent');
  assert.equal(g.mean([1, NaN, 3]), 2, 'a non-finite value is dropped rather than poisoning the mean');
  assert.equal(g.percentile([], 0.5), null);
  const s = [1, 2, 3, 4];
  assert.equal(g.percentile(s, 0), 1);
  assert.equal(g.percentile(s, 1), 4);
  assert.equal(g.percentile(s, 0.5), 2.5, 'interpolated, not snapped to a member');
});

test('the bootstrap is SEEDED, so a re-run is not a re-roll', () => {
  const vals = [1, -1, 2, -2, 0.5, 3, -0.5, 1.5];
  const a = g.bootstrapMeanCI(vals, { trials: 200, seed: 7 });
  const b = g.bootstrapMeanCI(vals, { trials: 200, seed: 7 });
  assert.deepEqual(a, b, 'same seed must give the same interval');
  const c = g.bootstrapMeanCI(vals, { trials: 200, seed: 8 });
  assert.notDeepEqual(a, c, 'a different seed should give a different draw');
  assert.equal(a.mean, g.mean(vals), 'the point estimate is the observed mean, not the interval');
  assert.ok(a.lo <= a.mean && a.mean <= a.hi, 'the observed mean lies inside its own interval');
});

test('a one-trade sample has no interval, and says so', () => {
  const one = g.bootstrapMeanCI([1.5], { trials: 100, seed: 1 });
  assert.equal(one.n, 1);
  assert.equal(one.lo, null, 'resampling a single observation has exactly one outcome — there is no spread to report');
  assert.equal(one.trials, 0);
});

test('a fragile winner loses the bootstrap, and a robust one keeps it', () => {
  // ROBUST: cell A beats cell B on every trade.  WINNER: A, every time.
  const a = { key: 'A', values: [1, 2, 1, 2, 1, 2, 1, 2] };
  const b = { key: 'B', values: [0, 1, 0, 1, 0, 1, 0, 1] };
  const robust = g.bootstrapWinner([a, b], { trials: 500, seed: 3 });
  assert.equal(robust[0].key, 'A');
  assert.equal(robust[0].share, 1, 'a uniformly better cell must win every resample');

  // FRAGILE: B wins by one huge observation that most resamples omit.
  const fragileA = { key: 'A', values: [0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10, 0.10] };
  const fragileB = { key: 'B', values: [-0.20, -0.20, -0.20, -0.20, -0.20, -0.20, -0.20, 5.00] };
  const fragile = g.bootstrapWinner([fragileA, fragileB], { trials: 2000, seed: 4 });
  const shareB = fragile.find((x) => x.key === 'B').share;
  assert.ok(shareB < 0.75, `one observation should not carry it: B won only ${(shareB * 100).toFixed(0)}% of resamples`);
  assert.ok(fragile.find((x) => x.key === 'A').share > 0.2, 'the steady cell must win a real share');
});

test('the winner bootstrap is PAIRED, so a shared trade index moves every cell at once', () => {
  // Two cells that are the SAME numbers under different labels must tie exactly, whatever the seed.
  const p = { key: 'p', values: [1, -1, 2, -2, 3] };
  const q = { key: 'q', values: [1, -1, 2, -2, 3] };
  const out = g.bootstrapWinner([p, q], { trials: 500, seed: 11 });
  assert.equal(out.length, 2);
  assert.equal(out[0].mean, out[1].mean);
  assert.ok(Math.abs(out[0].share + out[1].share - 1) < 1e-9, 'the shares are a distribution over the cells');
});

test('the winner bootstrap refuses a set it cannot resample', () => {
  assert.deepEqual(g.bootstrapWinner([], { trials: 10 }), []);
  assert.deepEqual(g.bootstrapWinner([{ key: 'only', values: [1] }], { trials: 10 }), [], 'one observation cannot be resampled into a distribution');
  // Cells of UNEQUAL length are truncated to the shortest, so the pairing stays valid.
  const out = g.bootstrapWinner([{ key: 'long', values: [1, 1, 1, 1] }, { key: 'short', values: [2, 2] }], { trials: 200, seed: 5 });
  assert.equal(out[0].key, 'short');
  assert.equal(out[0].mean, 2);
});
