'use strict';
// test/assessability.test.js — ★★ WHEN COULD THE DESK OBSERVE A CONSTRAINT AT ALL?
//
// The subject is a SECOND date that is not `effectiveFrom`: not when the venue changed its terms, but when this
// desk became able to honour or check them. Before `size-contract-scale` (2026-10-02) it could not — its size
// derivation omitted the contract scale, so the venue minimum refused every entry and the desk recorded its own
// arithmetic error as a venue fact.
//
// ⚠ MOST OF THESE TESTS ARE ABOUT WHAT MUST *NOT* HAPPEN, because the dangerous direction is silent: a floor that
// resolves to nothing reads as "always assessable", and nothing looks wrong.
const { test } = require('node:test');
const assert = require('node:assert');
const a = require('../trading/agent/assessability');
const c = require('../trading/agent/constraints');
const epoch = require('../trading/agent/epoch');

const EPOCHS = [
  { id: 'size-contract-scale', landedAt: '2026-10-02' },
  { id: 'pointvalue-notional', landedAt: '2026-10-01' },
];

test('★ the floor is DERIVED from the registry, and the module holds no date of its own', () => {
  const { floors, missing } = a.resolveFloors({ epochs: EPOCHS });
  assert.deepStrictEqual(missing, []);
  assert.strictEqual(floors.minimum_trade_size, '2026-10-02');
  // ⚠ The map must cite an ID. A literal date here would be a second producer of a fact epoch.js owns, and the
  // two would drift the first time an entry was corrected.
  for (const v of Object.values(a.FLOOR_EPOCHS)) {
    assert.ok(!/^\d{4}-\d{2}-\d{2}/.test(v), `FLOOR_EPOCHS must cite an id, not a date — got ${v}`);
  }
});

test('★ a floor whose epoch is GONE is reported, not silently dropped', () => {
  // A renamed epoch must not turn "we cannot judge this" into "always judgeable". That is the permissive
  // direction and it leaves no trace.
  const { floors, missing } = a.resolveFloors({ epochs: [{ id: 'something-else', landedAt: '2026-10-02' }] });
  assert.deepStrictEqual(floors, {});
  assert.deepStrictEqual(missing, [{ field: 'minimum_trade_size', epochId: 'size-contract-scale' }]);
  const r = a.assessableFrom('plus500.11.minimum_trade_size', { epochs: [{ id: 'x', landedAt: '2026-10-02' }] });
  assert.strictEqual(r.why, 'epoch_not_in_registry');
  assert.strictEqual(r.epochId, 'size-contract-scale');
});

test('★ EVERY id cited is a real epoch in the registry — the guard that keeps this file honest', () => {
  // This is the whole reason the map cites ids. If an entry is renamed or removed, this fails HERE rather than the
  // floor quietly evaporating in production.
  const { missing } = a.resolveFloors({ epochs: epoch.FEATURES });
  assert.deepStrictEqual(missing, [],
    'FLOOR_EPOCHS cites an epoch that does not exist: ' + JSON.stringify(missing));
});

test('fieldOf agrees with the key parser — a wrong field would apply the WRONG floor', () => {
  assert.strictEqual(a.fieldOf('plus500.11.minimum_trade_size'), 'minimum_trade_size');
  assert.strictEqual(a.fieldOf('plus500.single_tab'), 'single_tab');
  assert.strictEqual(a.fieldOf('garbage'), null, 'an unparsable key must yield NO floor, never a guess');
});

test('★ half-open: AT the floor is assessable, one millisecond before it is not', () => {
  assert.strictEqual(a.beforeFloor('2026-10-02T00:00:00Z', '2026-10-02'), false);
  assert.strictEqual(a.beforeFloor('2026-10-01T23:59:59.999Z', '2026-10-02'), true);
  // An unreadable date must not invent a block — the caller sees nothing rather than a false refusal.
  assert.strictEqual(a.beforeFloor('nonsense', '2026-10-02'), false);
  assert.strictEqual(a.beforeFloor('2026-10-01T00:00:00Z', null), false);
});

test('every field WITHOUT a floor has a stated reason — an unstated omission reads as "always assessable"', () => {
  const fields = ['minimum_trade_size', 'initial_margin_pct', 'funding_buy_pct', 'funding_sell_pct', 'funding_time'];
  for (const f of fields) {
    const hasFloor = Object.prototype.hasOwnProperty.call(a.FLOOR_EPOCHS, f);
    const hasReason = Object.prototype.hasOwnProperty.call(a.NO_FLOOR, f);
    assert.ok(hasFloor !== hasReason, `${f} must be EITHER floored OR have a named absence, not both and not neither`);
  }
  // The one that matters: margin has no epoch to cite, and that is a registry gap worth naming rather than hiding.
  assert.match(a.NO_FLOOR.initial_margin_pct, /NO registered epoch/);
});

// ── THE RESOLVER HONOURS IT ──────────────────────────────────────────────────────────────────────────────────
const row = (o = {}) => ({
  constraintVersionId: 1,
  constraintKey: 'plus500.11.minimum_trade_size',
  constraintType: 'numeric_limit',
  valueNumeric: 0.025,
  valueUnit: 'Troy Ounces',
  effectiveFrom: '2026-01-01T00:00:00Z',
  effectiveTo: null,
  recordedAt: '2026-01-01T00:00:00Z',
  verificationState: 'observed',
  venue: 'plus500',
  venueInstrumentId: '11',
  ...o,
});
const K = 'plus500.11.minimum_trade_size';
const FLOORS = { [K]: '2026-10-02' };

test('★ BEFORE the floor: unassessable with its OWN reason — not a breach, not a pass', () => {
  const subject = c.resolveSubject([row()], { venue: 'plus500', venueInstrumentId: '11', at: '2026-09-01T00:00:00Z' });
  const r = c.assessSubject({ subject, observations: { [K]: 0.001 }, directions: { [K]: 'min' }, checks: [K], at: '2026-09-01T00:00:00Z', floors: FLOORS });
  assert.strictEqual(r.verdict, c.UNASSESSABLE, 'a size far BELOW the minimum still must not be judged here');
  assert.deepStrictEqual(r.beforeFloor, [K], 'and the reason is listed by key, not buried in a count');
  assert.strictEqual(r.results[0].reason, 'before_assessability_floor');
  assert.strictEqual(r.results[0].floor, '2026-10-02');
});

test('★ the comparison is never even run before the floor — a breach cannot leak out', () => {
  // ⚠ Ordering matters. Computing the verdict and discarding it would still leave a BREACHED in `results` that a
  // careless caller could surface, and the point is that no statement about the venue is available at all.
  const subject = c.resolveSubject([row()], { venue: 'plus500', venueInstrumentId: '11', at: '2026-09-01T00:00:00Z' });
  const r = c.assessSubject({ subject, observations: { [K]: 0.001 }, directions: { [K]: 'min' }, checks: [K], at: '2026-09-01T00:00:00Z', floors: FLOORS });
  assert.ok(!r.results.some((x) => x.verdict === c.BREACHED));
});

test('AT or after the floor the assessment resolves normally', () => {
  const subject = c.resolveSubject([row()], { venue: 'plus500', venueInstrumentId: '11', at: '2026-10-03T00:00:00Z' });
  const r = c.assessSubject({ subject, observations: { [K]: 0.5 }, directions: { [K]: 'min' }, checks: [K], at: '2026-10-03T00:00:00Z', floors: FLOORS });
  assert.strictEqual(r.verdict, c.SATISFIED);
  assert.deepStrictEqual(r.beforeFloor, []);
});

test('a floor for a key that is not in force changes nothing', () => {
  const subject = c.resolveSubject([row()], { venue: 'plus500', venueInstrumentId: '11', at: '2026-09-01T00:00:00Z' });
  const r = c.assessSubject({ subject, observations: {}, directions: {}, checks: [], at: '2026-09-01T00:00:00Z', floors: { OTHER: '2026-10-02' } });
  assert.deepStrictEqual(r.beforeFloor, []);
});

test('NO floors supplied behaves exactly as before — the caller that predates this cannot be broken by it', () => {
  const subject = c.resolveSubject([row()], { venue: 'plus500', venueInstrumentId: '11', at: '2026-09-01T00:00:00Z' });
  const r = c.assessSubject({ subject, observations: { [K]: 0.5 }, directions: { [K]: 'min' }, checks: [K], at: '2026-09-01T00:00:00Z' });
  assert.strictEqual(r.verdict, c.SATISFIED);
  // ⚠ `[]`, NOT `undefined`: the field is additive but ALWAYS present, so a reader never has to branch on whether
  // this call predated floors. An absent key would be indistinguishable from "no key was floored".
  assert.deepStrictEqual(r.beforeFloor, []);
});
