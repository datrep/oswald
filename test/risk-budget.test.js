// Pins for the exposure-budget composition (2026-09-11 incident: per-position
// cap 80% + portfolio budget 50% made every clamped entry veto forever — both
// turtle survivors were vetoed while the book was flat). The budget now BINDS
// by resizing (caps compose into one size); the hard veto remains only when
// the book has no room left.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fitExposureBudget } = require('../trading/agent/risk');

test('fits within the remaining budget -> untouched', () => {
  const r = fitExposureBudget({ size: 4, price: 100, exposurePct: 0, exposureCapPct: 50, equity: 1000 });
  assert.equal(r.fitted, false);
  assert.equal(r.full, false);
  assert.equal(r.size, 4);
});

test('over budget -> resized to the remaining room (same stop, lower risk)', () => {
  const r = fitExposureBudget({ size: 10, price: 100, exposurePct: 10, exposureCapPct: 50, equity: 1000 });
  assert.equal(r.fitted, true);
  assert.equal(r.full, false);
  assert.equal(r.size, 4); // remaining 40% of 1000 = 400 / 100
});

test('book at the cap -> full (caller vetoes)', () => {
  const r = fitExposureBudget({ size: 10, price: 100, exposurePct: 55, exposureCapPct: 50, equity: 1000 });
  assert.equal(r.full, true);
  assert.equal(r.size, 0);
});

test('budget disabled (NaN) -> untouched', () => {
  const r = fitExposureBudget({ size: 10, price: 100, exposurePct: 0, exposureCapPct: NaN, equity: 1000 });
  assert.equal(r.fitted, false);
  assert.equal(r.size, 10);
});

test('incident replay: Oil post-cap size fits to the 50% budget instead of vetoing', () => {
  const r = fitExposureBudget({ size: 31.8103, price: 101.22, exposurePct: 0, exposureCapPct: 50, equity: 4023.41 });
  assert.equal(r.fitted, true);
  assert.equal(r.full, false);
  assert.ok(Math.abs(r.size - 19.8746) < 0.01, `fitted size ${r.size}`);
  assert.ok(Math.abs(r.wantedPct - 80.0) < 0.1, `wantedPct ${r.wantedPct}`);
});
