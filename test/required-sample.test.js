// test/required-sample.test.js — TRD-41: what would it take for the evidence to reach a verdict?
//
// The parity harness reports `insufficient` for every strategy, which says nothing about whether the
// evidence EVER arrives. This pins the scan that answers it: hold the observed mean/sd fixed and find
// the n at which the REAL verdict flips.
//
// The numbers below are the desk's actual observations on 2026-09-14 (survoil n=4, mean R +0.3634,
// sd 0.8815; survgold n=3, mean R +0.5365, sd 1.5584). They are pinned so that a change to the
// critical value — a different quantile convention, or dropping the alpha-spending ratio — is visible
// as a moved target rather than as a quietly different requirement.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { requiredSample, expectancyVerdict } = require('../trading/agent/expectancy');

const CFG = { alpha: 0.05, looks: 2, minTrades: 10 };

test('the desk\'s two live strategies would be ACCEPTED, at n=25 and n=34', () => {
  // The answer to TRD-41's question, on the real numbers: acceptance is reachable, not hypothetical.
  assert.equal(requiredSample({ meanR: 0.3634, sdR: 0.8815 }, CFG).acceptAt, 25, 'survoil');
  assert.equal(requiredSample({ meanR: 0.5365, sdR: 1.5584 }, CFG).acceptAt, 34, 'survgold');
  // And the scan agrees with the verdict it claims to be predicting: one n below the target is not
  // accepting, and the target itself is.
  const at = requiredSample({ meanR: 0.3634, sdR: 0.8815 }, CFG).acceptAt;
  assert.notEqual(expectancyVerdict({ n: at - 1, meanR: 0.3634, sdR: 0.8815 }, CFG).state, 'accept');
  assert.equal(expectancyVerdict({ n: at, meanR: 0.3634, sdR: 0.8815 }, CFG).state, 'accept');
});

test('a non-positive mean can NEVER be accepted, at any n', () => {
  // Not "far away" — unreachable. The lower bound is mean minus a positive quantity, so it cannot
  // cross zero from below. Reporting a large n here would invite waiting for something impossible.
  const r = requiredSample({ meanR: -0.0181, sdR: 0.2477 }, CFG);
  assert.equal(r.acceptAt, null);
  assert.equal(r.unreachable, true);
  assert.equal(r.verdictKind, 'retire', 'it approaches RETIREMENT instead');
  assert.ok(Number.isFinite(r.retireAt));
  // A zero mean is the boundary case and is unreachable too.
  assert.equal(requiredSample({ meanR: 0, sdR: 0.5 }, CFG).unreachable, true);
});

test('EVERY EXTRA LOOK MOVES THE TARGET AWAY', () => {
  // The finding that matters operationally: each logged parity check spends alpha, which tightens the
  // critical value, which needs MORE trades to clear the same edge. So running the harness to "just
  // look" permanently inflates its own requirement, and the schedule is not neutral.
  const at = (looks) => requiredSample({ meanR: 0.3634, sdR: 0.8815 }, { ...CFG, looks }).acceptAt;
  const series = [1, 2, 5, 10, 20, 53].map(at);
  assert.deepEqual(series, [18, 25, 34, 40, 47, 57], 'survoil: the real schedule');
  for (let i = 1; i < series.length; i += 1) {
    assert.ok(series[i] > series[i - 1], `look ${i} must need more data, got ${series}`);
  }
  // Roughly +0.5 to +1 trade per look at this edge, against an arrival rate of ~2/day — so a weekly
  // check on a desk still accruing data raises the bar far slower than the data arrives. That is what
  // makes the gate REACHABLE, and the reason the number is worth reporting rather than assuming.
  const perLook = (series[series.length - 1] - series[0]) / 52;
  assert.ok(perLook > 0.5 && perLook < 1.0, `per-look cost was ${perLook}`);
});

test('it refuses to guess when mean/sd are not usable', () => {
  assert.match(requiredSample({ meanR: NaN, sdR: 1 }, CFG).reason, /mean R and a positive sd/);
  assert.equal(requiredSample({ meanR: 0.3, sdR: 0 }, CFG).acceptAt, null);
  assert.equal(requiredSample({ meanR: 0.3, sdR: NaN }, CFG).acceptAt, null);
  // A single trade has no sd at all, which is `macd` today — `>5000` must not be reported as a target.
  assert.match(requiredSample({ meanR: -0.0764, sdR: NaN }, CFG).reason, /positive sd/);
});

test('the scan is bounded and reports the floor honestly', () => {
  // The loop starts at minTrades because expectancyVerdict returns `insufficient` below it, so an
  // acceptance target can never be reported BELOW the floor the desk configured.
  const r = requiredSample({ meanR: 5, sdR: 0.1 }, { ...CFG, minTrades: 30 });
  assert.ok(r.acceptAt >= 30);
  // An enormous edge with trivial variance accepts at the floor, not at 1.
  assert.equal(requiredSample({ meanR: 100, sdR: 1 }, { ...CFG, minTrades: 10 }).acceptAt, 10);
  // Nothing is found within the cap -> null rather than a fabricated number.
  const capped = requiredSample({ meanR: 1e-6, sdR: 50 }, { ...CFG, cap: 200 });
  assert.equal(capped.acceptAt, null);
  assert.equal(capped.unreachable, false, 'a tiny positive edge is far away, not unreachable');
});
