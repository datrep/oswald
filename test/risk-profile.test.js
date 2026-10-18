// test/risk-profile.test.js — TRD-RSK-7 pins:
//   "each capability gets its own risk and position sizing, and the resolution REPORTS ITSELF."
//
// Owner's ask, verbatim: *"each with their own risk and position sizing"*. The measurement that made the flat
// object untenable: SGX's venue floor forces 0.1640% of equity against a 0.07% dial (2.34x) while every other
// symbol's floor sits at 0.11x-0.78x — and the only responses available were "accept it", "drop the symbol", or
// "raise a dial with no per-symbol form".
//
// The rule is a PURE function so it is testable without the live gate.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { resolveProfile, profileIdFor, PROFILE_KEYS } = require('../trading/riskProfile');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const BASE = { riskPerTradePct: 2.5, maxRiskPerTradePct: 0.07, maxAdversePct: 1.5, maxPositions: 10, initialEquity: 2685.76, dailyLossHaltPct: 3 };
// A helper rather than nested `Object.assign` literals. The nesting produced a brace-count error THREE times
// while writing this file — and a test is only worth what it is worth when it RUNS, so the shape that is hard
// to get right gets removed rather than carefully reproduced.
const withRisk = (profiles, extra) => ({ risk: Object.assign({}, BASE, extra || {}, { profiles }) });

// ---------------------------------------------------------------------------------------------
// ★ The property that makes this change safe
// ---------------------------------------------------------------------------------------------

test('★★ with NO profiles defined, the resolved risk is IDENTICAL to the input — inert until used', () => {
  // This is the safety of the whole change: an install that defines no profiles must behave EXACTLY as before,
  // which is what lets the owner add desks one at a time instead of migrating in one step.
  const settings = { risk: Object.assign({}, BASE) };
  const r = resolveProfile(settings, { strategy: 'survgold' });
  assert.equal(r.profileId, 'default');
  assert.equal(r.axis, 'default');
  assert.deepEqual(r.overrodeKeys, []);
  assert.deepEqual(r.ignoredKeys, []);
  assert.deepEqual(r.risk, BASE, 'the resolved object must equal the base exactly');
});

test('★ an EMPTY profiles object is the same as none — no accidental activation', () => {
  const settings = withRisk({});
  const r = resolveProfile(settings, { strategy: 'survgold', instrumentClass: 'spot' });
  assert.equal(r.profileId, 'default');
  assert.deepEqual(r.risk, Object.assign({}, BASE, { profiles: {} }));
});

test('the whole base is carried through, so no key the gate reads can be lost', () => {
  // Whitelisting the OUTPUT would risk dropping `exitTolerance`, `initialEquity` and friends, and a missing key
  // reads as undefined which several callers turn into a permissive default.
  const settings = { risk: Object.assign({}, BASE, { exitTolerance: { enabled: true, maxLossAtR: 0.5 }, profiles: { survgold: { maxAdversePct: 0.3 } } }) };
  const r = resolveProfile(settings, { strategy: 'survgold' });
  assert.deepEqual(r.risk.exitTolerance, { enabled: true, maxLossAtR: 0.5 }, 'a non-profile key must survive');
  assert.equal(r.risk.initialEquity, 2685.76, 'the account baseline must survive');
  assert.equal(r.risk.maxAdversePct, 0.3, 'and the override must apply');
});

// ---------------------------------------------------------------------------------------------
// Which profile applies — strategy innermost, then instrument class
// ---------------------------------------------------------------------------------------------

test('the strategy profile wins over the instrument-class profile', () => {
  const settings = withRisk({ survgold: { maxAdversePct: 0.3 }, option: { maxAdversePct: 0.9 } });
  const r = resolveProfile(settings, { strategy: 'survgold', instrumentClass: 'option' });
  assert.equal(r.profileId, 'survgold', 'strategy is INNERMOST and must win');
  assert.equal(r.axis, 'strategy');
  assert.equal(r.risk.maxAdversePct, 0.3);
});

test('the instrument-class profile applies when no strategy profile exists', () => {
  // The case this exists for: options have a different cost structure (spread + theta, not swap), a 100x
  // multiplier and a per-contract floor, so maxCostShareOfR and maxAdversePct mean something different there.
  const settings = withRisk({ option: { maxAdversePct: 0.9, maxCostShareOfR: 0.4 } });
  const r = resolveProfile(settings, { strategy: 'survgold', instrumentClass: 'option' });
  assert.equal(r.profileId, 'option');
  assert.equal(r.axis, 'instrumentClass');
  assert.equal(r.risk.maxCostShareOfR, 0.4);
});

test('a proposal naming neither axis falls back to default', () => {
  const settings = withRisk({ survgold: { maxAdversePct: 0.3 } });
  assert.equal(resolveProfile(settings, {}).profileId, 'default');
  assert.equal(resolveProfile(settings, { strategy: 'unknown', instrumentClass: 'unknown' }).profileId, 'default');
  assert.equal(resolveProfile(settings).profileId, 'default');
});

test('resolveProfile is defensive about missing settings', () => {
  assert.deepEqual(resolveProfile(null, { strategy: 'x' }).risk, {});
  assert.deepEqual(resolveProfile(undefined, {}).risk, {});
  assert.deepEqual(resolveProfile({}, {}).risk, {});
});

// ---------------------------------------------------------------------------------------------
// ★ Absence is hasOwnProperty, never falsiness
// ---------------------------------------------------------------------------------------------

test('★★ a profile whose whole point is turning something OFF must apply', () => {
  // `acceptVenueFloor: false` and `takeProfitOffsetPct: 0` are the shipped defaults, and `0` is a MEANING for
  // the stop cap (adverseStopCap returns "no cap" for <= 0). A `if (profiles[k])` test would skip a profile
  // that turns a feature off — the coercion bug class this desk keeps re-finding.
  const settings = withRisk({ survsgx: { acceptVenueFloor: false, takeProfitOffsetPct: 0 } });
  const r = resolveProfile(settings, { strategy: 'survsgx' });
  assert.equal(r.profileId, 'survsgx');
  assert.deepEqual(r.overrodeKeys.sort(), ['acceptVenueFloor', 'takeProfitOffsetPct']);
  assert.strictEqual(r.risk.acceptVenueFloor, false);
  assert.strictEqual(r.risk.takeProfitOffsetPct, 0);
});

// ---------------------------------------------------------------------------------------------
// ★ The whitelist, and the report
// ---------------------------------------------------------------------------------------------

test('★★ an unknown key in a profile is NOT applied, and is REPORTED', () => {
  // A silently ignored setting is the defect class this whole thread has been closing, so an unknown key must
  // be visible rather than dropped.
  const settings = withRisk({ survgold: { maxAdversePct: 0.3, initialEquity: 999, nonsense: 1 } });
  const r = resolveProfile(settings, { strategy: 'survgold' });
  assert.equal(r.risk.maxAdversePct, 0.3, 'a whitelisted key applies');
  assert.equal(r.risk.initialEquity, 2685.76, 'the risk BASELINE is account-level and must not be desk-scoped');
  assert.ok(!('nonsense' in r.risk), 'an unknown key must not reach the gate');
  assert.deepEqual(r.ignoredKeys.sort(), ['initialEquity', 'nonsense']);
  assert.deepEqual(r.overrodeKeys, ['maxAdversePct'], 'only applied keys are reported as overrides');
});

test('the account-level brakes are deliberately NOT profileable', () => {
  // `dailyLossHaltPct` is a PORTFOLIO brake: per-desk halts would let one desk keep trading through a loss that
  // stopped the others, which is the opposite of what a brake is for.
  assert.ok(!PROFILE_KEYS.includes('initialEquity'), 'the baseline is an account fact');
  assert.ok(!PROFILE_KEYS.includes('dailyLossHaltPct'), 'the daily halt is a portfolio brake');
  // L3 (rev 5): the margin ceiling is STRICTER than the daily halt, not merely parallel to it. The halt is a
  // portfolio brake; this is the venue's CAPACITY FOR ONE ACCOUNT, and the venue liquidates the account, not
  // the desk — so a per-desk override would let one desk commit margin another has already spent.
  assert.ok(!PROFILE_KEYS.includes('maxMarginUtilisationPct'), 'the venue margin ceiling is an account-level capacity fact');
  assert.ok(PROFILE_KEYS.includes('maxPositions'), 'but a desk DOES have its own slot economics');
  assert.ok(PROFILE_KEYS.includes('maxCostShareOfR'), 'and its own cost basis');
});

test('★ a profile that changes NOTHING is distinguishable from no profile at all', () => {
  // `overrodeKeys: []` on a named profile means the desk is configured but the profile is inert — which is a
  // finding, not a success, and it needs to be sayable.
  const settings = withRisk({ survgold: {} });
  const r = resolveProfile(settings, { strategy: 'survgold' });
  assert.equal(r.profileId, 'survgold', 'the profile IS matched and named');
  assert.deepEqual(r.overrodeKeys, [], 'but it overrode nothing — visible, not silent');
});

test('profileIdFor reports the AXIS, so a reader knows why that profile applied', () => {
  const settings = { risk: { profiles: { survgold: {}, option: {} } } };
  assert.equal(profileIdFor(settings, { strategy: 'survgold' }).axis, 'strategy');
  assert.equal(profileIdFor(settings, { instrumentClass: 'option' }).axis, 'instrumentClass');
  assert.equal(profileIdFor(settings, {}).axis, 'default');
});

// ---------------------------------------------------------------------------------------------
// The wiring — structural
// ---------------------------------------------------------------------------------------------

test('risk.evaluate resolves the profile ONCE, before anything reads risk.*', () => {
  const src = code('trading/agent/risk.js');
  const fn = src.indexOf('async function evaluate');
  const resolve = src.indexOf('const profile = resolveProfile(settings, {', fn);
  const riskObj = src.indexOf('const risk = profile.risk;', fn);
  assert.ok(fn > -1 && resolve > -1 && riskObj > -1, 'the profile must be resolved inside evaluate');
  assert.ok(resolve < riskObj, 'the resolution precedes the object it produces');
  // ⚠ ONE resolution, not one per rule: per-rule resolution is how the stop cap and the cost ceiling would come
  // to read different settings — the two-sources-of-truth shape this row exists to remove.
  const all = (src.match(/resolveProfile\(/g) || []).length;
  assert.equal(all, 1, `resolveProfile must be called exactly once in risk.js (found ${all})`);
  assert.doesNotMatch(src, /const risk = settings\.risk/, 'the old direct read must be gone');
});

test('the resolution is reported on the verdict AND on both decision payload shapes', () => {
  const risk = code('trading/agent/risk.js');
  assert.match(risk, /v\.riskProfile = \{ id: profile\.profileId, axis: profile\.axis, overrode: profile\.overrodeKeys \}/);
  const agg = code('trading/agent/aggregator.js');
  const n = (agg.match(/riskProfile: risk\.riskProfile \|\| null/g) || []).length;
  assert.equal(n, 2, `the profile must travel on BOTH decision shapes (found ${n} of 2)`);
});

test('the resolver is pure — no DB, no logger — which is why it is testable', () => {
  const d = code('trading/riskProfile.js');
  assert.doesNotMatch(d, /require\(/, 'the module must require nothing');
});
