// EXE-14 S4 — the gate that decides whether an entry's levels may be moved to the FILL.
//
// WHY THIS FILE EXISTS. `openTrade` cannot be exercised without a bridge, a ledger and a filled order, so the
// decision that carries the risk is extracted as `fillAnchorPlan` and driven here. A gate proved only on its
// ALLOW path is not a gate: the entire risk of EXE-14 is the case where it acts when it must not, so every
// refusal below is asserted positively — the reason, and the ABSENCE of a target.
//
// The three refusals, in order, and why the order is the safety property:
//   1. the switch is not exactly `true`  — DEFAULT OFF; absent means off, never "unset means on"
//   2. the strategy is frozen            — moving a TRD-29 forward track's levels voids the track
//   3. the shift is a full stop or more  — `anchor_stale`: no longer the trade that was deliberated
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { fillAnchorPlan } = require('../trading/agent/executor');

const ON = { risk: { fillAnchoredStop: { enabled: true } } };
// A buy whose levels are 2.00 below/3.00 above the decision price: declared R:R 1.5, which is LEVEL_RR.
const LEVELS = { stop: 98, tp: 103 };
const DECISION = 100;
const NOT_FROZEN = { isFrozen: false, reason: null };

test('★ the switch is OFF unless it is exactly `true` — an absent block, false, and a string are all off', () => {
  for (const settings of [
    undefined,
    {},
    { risk: {} },
    { risk: { fillAnchoredStop: {} } },
    { risk: { fillAnchoredStop: { enabled: false } } },
    // ⚠ A STRING `'true'` IS NOT `true`. Reading it as enabled is how a settings typo silently arms the only
    // control on this desk that moves a stop on a live position.
    { risk: { fillAnchoredStop: { enabled: 'true' } } },
  ]) {
    const p = fillAnchorPlan({ settings, strategyId: 'survgold', levels: LEVELS, decisionPrice: DECISION, fillPrice: 100.24, frozen: NOT_FROZEN });
    assert.equal(p.act, false, `must not act for ${JSON.stringify(settings)}`);
    assert.equal(p.reason, 'disabled');
    assert.equal(p.target, undefined, 'and a disabled plan carries NO levels to write');
  }
});

test('★ a FROZEN strategy is held even with the switch ON — and the freeze is checked before the levels', () => {
  const p = fillAnchorPlan({
    settings: ON, strategyId: 'survgold', levels: LEVELS, decisionPrice: DECISION, fillPrice: 100.24,
    frozen: { isFrozen: true, reason: 'TRD-29' },
  });
  assert.equal(p.act, false, 'moving a frozen forward track level voids the track');
  assert.equal(p.reason, 'frozen_strategy');
  assert.equal(p.frozenReason, 'TRD-29', 'and the refusal names WHICH track it was protecting');
  assert.equal(p.target, undefined, 'nothing is written for a frozen strategy');
});

test('★ the freeze cannot be overridden by the switch, in either direction', () => {
  // The same frozen input, switch off then on: still held, and for the freeze reason only when it is on.
  const off = fillAnchorPlan({ settings: {}, strategyId: 'survgold', levels: LEVELS, decisionPrice: DECISION, fillPrice: 100.24, frozen: { isFrozen: true, reason: 'TRD-29' } });
  const on = fillAnchorPlan({ settings: ON, strategyId: 'survgold', levels: LEVELS, decisionPrice: DECISION, fillPrice: 100.24, frozen: { isFrozen: true, reason: 'TRD-29' } });
  assert.equal(off.act, false);
  assert.equal(on.act, false, 'enabling the feature must not un-freeze a track');
});

test('★ an `anchor_stale` shift is held, not clamped — a stop already at the money is not repaired', () => {
  // decision 100, stop 98 => stopDist 2. A fill at 102 has travelled a FULL stop distance.
  const p = fillAnchorPlan({ settings: ON, strategyId: 'survcsugar', levels: LEVELS, decisionPrice: DECISION, fillPrice: 102, frozen: NOT_FROZEN });
  assert.equal(p.act, false);
  assert.equal(p.reason, 'anchor_stale');
  assert.equal(p.stopDist, 2, 'and it reports the distance that made it stale');
  assert.equal(p.target, undefined);
});

test('missing levels are held rather than computed from null', () => {
  const p = fillAnchorPlan({ settings: ON, strategyId: 'survcsugar', levels: { stop: null, tp: 103 }, decisionPrice: DECISION, fillPrice: 100.24, frozen: NOT_FROZEN });
  assert.equal(p.act, false);
  assert.equal(p.reason, 'levels_missing');
});

// --- the allow path, and the property that justifies the whole step ---------

test('★ a healthy entry shifts BOTH levels to the fill and PRESERVES THE RISK DISTANCE EXACTLY', () => {
  const fill = 100.24;
  const p = fillAnchorPlan({ settings: ON, strategyId: 'survcsugar', levels: LEVELS, decisionPrice: DECISION, fillPrice: fill, frozen: NOT_FROZEN });
  assert.equal(p.act, true, `expected an act plan, got ${JSON.stringify(p)}`);
  assert.equal(p.reason, null);
  assert.ok(Math.abs(p.target.stopPrice - 98.24) < 1e-9, 'stop moves by fill - decision');
  assert.ok(Math.abs(p.target.takeProfitPrice - 103.24) < 1e-9, 'and the target moves by the SAME amount');

  // THE CLAIM EXE-14 RESTS ON: the distance the desk measured its risk from does not change.
  const before = Math.abs(DECISION - LEVELS.stop);
  const after = Math.abs(fill - p.target.stopPrice);
  assert.ok(Math.abs(after - before) < 1e-9, 'the risk distance is unchanged by construction');

  // ...and the realised R:R measured FROM THE FILL is now the declared one, which is the F20 fix itself.
  const realised = Math.abs(p.target.takeProfitPrice - fill) / Math.abs(fill - p.target.stopPrice);
  assert.ok(Math.abs(realised - 1.5) < 1e-9, `realised R:R must equal the declared 1.5, got ${realised}`);

  // The SAME numbers, unanchored, are what `field_levels` reports today: the fill lands BETWEEN the levels, so
  // the realised R:R is carried by the drift. Here 2.76/2.24 = 1.232 against a declared 1.5 — the same mechanism
  // that put #1151 and #1125 at 0.652.
  const unanchored = Math.abs(LEVELS.tp - fill) / Math.abs(fill - LEVELS.stop);
  assert.ok(unanchored < 1.5, `unanchored geometry must be worse than declared, got ${unanchored}`);
});

test('a SELL is shifted by the same symmetric rule — direction is deliberately not a parameter', () => {
  // sell: stop above, target below. The shift is `fill - decision` either way, so a sell that fills LOWER
  // gets both levels moved LOWER, and the span is preserved just the same.
  const levels = { stop: 102, tp: 97 };
  const p = fillAnchorPlan({ settings: ON, strategyId: 'survgold', levels, decisionPrice: 100, fillPrice: 99.7, frozen: NOT_FROZEN });
  assert.equal(p.act, true);
  assert.ok(Math.abs(p.target.stopPrice - 101.7) < 1e-9);
  assert.ok(Math.abs(p.target.takeProfitPrice - 96.7) < 1e-9);
  assert.ok(Math.abs(Math.abs(99.7 - p.target.stopPrice) - 2) < 1e-9, 'risk distance still 2');
});

// --- the two structural requirements the plan names, pinned ------------------

test('the SWITCH is read with `!== true`, so a truthy string cannot arm the only stop-moving control', () => {
  const ex = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'executor.js'), 'utf8');
  assert.match(ex, /if \(cfg\.enabled !== true\) return \{ act: false, reason: 'disabled' \};/,
    'absent / false / "true" must ALL mean off — and it is pinned against the exact line, because a later '
    + '`if (cfg.enabled)` rewrite reads as a tidy-up and silently changes the default to ON');
});

test('the connector method does NOT use withOrderReliability, and DOES hold the shared-tab lock', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'connector', 'browser.js'), 'utf8');
  const body = src.slice(src.indexOf('async function setPositionLevels'), src.indexOf('\nmodule.exports'));
  assert.ok(body.length > 200, 'the slice must find the function — an empty slice would pass every assertion below');
  assert.doesNotMatch(body, /withOrderReliability/,
    'a level edit is NOT an order: that wrapper journals every attempt as an order_attempt and feeds the '
    + 'unresolved-submit retry guard, so recording an edit there corrupts the journal TRD-42 cleaned');
  assert.match(body, /pageLock\.acquire\('ticket'/, 'it drives the SHARED tab, so the lock is taken in the connector');
  assert.match(body, /pageLock\.release\('ticket'\)/, 'and always released');
});
