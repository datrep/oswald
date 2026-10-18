// test/chair-persona-source.test.js — TRD-DEL-1: the seat persona is resolved in ONE place, and the place the
// PANEL reads must be the same place the VOTE reads.
//
// The defect this guards: a chair saved with `persona: null` still votes through the persona its seat POSITION
// implies (trend -> risk -> macro), while the settings UI rendered that seat as a bare "seat default". The
// operator was therefore tuning three chairs' weights and reading three chairs' reasons with no way to see which
// lens produced which sentence.
//
// Two separate claims are pinned here, and the second is the one that can rot silently:
//   1. the fallback is by seat ORDER, and it reports which source supplied it; and
//   2. `chairRoster(settings)` — what the settings route publishes — equals `resolveChairs(deliberators(settings).chairs)`
//      — what the vote loop applies. Two copies of this rule is exactly how a DISPLAYED persona drifts from a
//      VOTING one, and the panel would then be confidently wrong rather than merely uninformative.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const agg = require('../trading/agent/aggregator');

test('resolveChairs falls back by seat order and says where the persona came from', () => {
  const r = agg.resolveChairs([
    { id: 'chair-1', weight: 1, persona: null },
    { id: 'chair-2', weight: 1 },
    { id: 'chair-3', weight: 1, persona: 'macro' },
  ]);
  assert.deepStrictEqual(r.map((c) => c.persona), ['trend', 'risk', 'macro']);
  assert.deepStrictEqual(r.map((c) => c.personaSource), ['seat-default', 'seat-default', 'configured']);
});

test('an explicit persona always wins, and is reported as configured', () => {
  const r = agg.resolveChairs([{ id: 'a', weight: 2, persona: 'risk' }]);
  assert.strictEqual(r[0].persona, 'risk');
  assert.strictEqual(r[0].personaSource, 'configured');
});

test('a seat past the persona list gets NONE, not a wrong one, and still reports honestly', () => {
  const r = agg.resolveChairs([
    { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' },
  ]);
  assert.deepStrictEqual(r.map((c) => c.personaSource), ['seat-default', 'seat-default', 'seat-default', 'none', 'none']);
  assert.strictEqual(r[3].persona, null);
  assert.strictEqual(r[4].persona, null);
});

test('the resolver preserves the fields it does not own — model, temperature, extra keys', () => {
  const r = agg.resolveChairs([{ id: 'chair-1', model: 'deepseek-reasoner', temperature: 0.8, weight: 1.5, persona: null, note: 'keep me' }]);
  assert.strictEqual(r[0].model, 'deepseek-reasoner');
  assert.strictEqual(r[0].temperature, 0.8);
  assert.strictEqual(r[0].weight, 1.5);
  assert.strictEqual(r[0].note, 'keep me');
  assert.strictEqual(r[0].persona, 'trend', 'seat index 0 resolves to trend');
});

// ★ A TRAP FOUND WHILE WRITING THIS TEST, and it is worth pinning because the first version of the assertion
// above got it WRONG: the fallback is by ARRAY POSITION, not by the chair's `id`. A chair literally named
// `chair-2` sitting at index 0 votes as `trend`. So the id is a LABEL and the position is the LENS — which
// means reordering or deleting a seat silently re-assigns every later seat's persona, and nothing warns.
// An operator who "removes chair-1 because it is not adding anything" moves chair-2 to index 0 and chair-3 to
// index 1, and the surviving seats quietly swap from risk/macro to trend/risk.
test('the LENS comes from the array position, not from the chair id — reordering re-assigns personas', () => {
  const byId = agg.resolveChairs([{ id: 'chair-2', weight: 1, persona: null }]);
  assert.strictEqual(byId[0].persona, 'trend', 'chair-2 at index 0 is trend — the id is a label, not the lens');

  const full = [
    { id: 'trend-seat', weight: 1, persona: null },
    { id: 'risk-seat', weight: 1, persona: null },
    { id: 'macro-seat', weight: 1, persona: null },
  ];
  assert.deepStrictEqual(agg.resolveChairs(full).map((c) => c.persona), ['trend', 'risk', 'macro']);
  // Drop the FIRST seat: the survivors shift up one lens.
  const dropped = agg.resolveChairs(full.slice(1));
  assert.deepStrictEqual(dropped.map((c) => c.persona), ['trend', 'risk'],
    'deleting a seat re-lenses the ones after it — the reason `personaSource` is recorded with every vote');
  assert.deepStrictEqual(dropped.map((c) => c.id), ['risk-seat', 'macro-seat'],
    'the ids did NOT change, so the panel would have shown risk-seat/ macro-seat while they voted trend/ risk');
});

test('empty and malformed rosters resolve to an empty list rather than throwing', () => {
  for (const v of [[], null, undefined, 'nonsense', 7]) {
    assert.deepStrictEqual(agg.resolveChairs(v), [], `resolveChairs(${JSON.stringify(v)}) must be []`);
  }
  // A hole in the array must not become an undefined seat that later reads as a persona-less chair object.
  const holey = agg.resolveChairs([null, { id: 'b', weight: 1 }]);
  assert.strictEqual(holey.length, 2);
  assert.strictEqual(holey[0].id, 'chair');
  assert.strictEqual(holey[0].personaSource, 'seat-default');
});

// ★ THE CLAIM THAT CAN ROT SILENTLY: what the panel publishes is what the vote applies.
test('chairRoster (what the settings route publishes) EQUALS what the vote loop resolves', () => {
  const shapes = [
    {},                                                                  // no deliberation block at all
    { deliberation: {} },                                                // block present, no chairs key
    { deliberation: { chairs: [] } },                                    // empty array -> defaults
    { deliberation: { chairs: [{ id: 'chair-1', weight: 1, persona: null }, { id: 'chair-2', weight: 1 }] } }, // THE LIVE SHAPE
    { deliberation: { chairs: [{ id: 'chair-1', weight: 1, persona: 'trend' }] } },
  ];
  for (const settings of shapes) {
    const published = agg.chairRoster(settings);
    const applied = agg.resolveChairs(agg.deliberators(settings).chairs);
    assert.deepStrictEqual(published, applied,
      `the panel and the vote disagree for ${JSON.stringify(settings)} — a displayed persona that is not the`
      + ' voting one is worse than no display at all');
    // Non-vacuity: every seat must carry a source, or the panel has nothing to show.
    for (const c of published) {
      assert.ok(['configured', 'seat-default', 'none'].includes(c.personaSource), `bad source ${c.personaSource}`);
    }
  }
});

// The live configuration is the case that produced the defect: personas present in the DEFAULT chairs, absent
// in saved ones. Both must be representable, and the difference must be visible.
test('the default roster is CONFIGURED and a persona-less saved roster is SEAT DEFAULT', () => {
  const fromDefaults = agg.chairRoster({});
  assert.deepStrictEqual(fromDefaults.map((c) => c.persona), ['trend', 'risk', 'macro']);
  assert.deepStrictEqual(fromDefaults.map((c) => c.personaSource), ['configured', 'configured', 'configured']);

  const savedNull = agg.chairRoster({ deliberation: { chairs: [{ id: 'chair-1', weight: 1 }, { id: 'chair-2', weight: 1 }, { id: 'chair-3', weight: 1 }] } });
  assert.deepStrictEqual(savedNull.map((c) => c.persona), ['trend', 'risk', 'macro']);
  assert.deepStrictEqual(savedNull.map((c) => c.personaSource), ['seat-default', 'seat-default', 'seat-default'],
    'the live shape must be reported as INHERITED, which is the whole point of the row');
  assert.ok(savedNull.some((c) => c.personaSource === 'seat-default'),
    'at least one shape must exercise the fallback, or these assertions prove nothing');
});
