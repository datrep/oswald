// Pins for the account-strip FIFO flicker guard (2026-09-11). The venue
// occasionally renders a transitional frame: pnl 0 while equity/available
// still carry the PRE-pnl value (observed +2.5% one-sample spikes). The guard
// must reject those and keep everything else.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isPlausibleSample } = require('../trading/agent/accountPoller');

const settled = { available: 2834.12, equity: 4009.37, margin: 587.62, pnl: -110.46 };

test('pnl-zero flicker with a big jump after a real-pnl sample is rejected', () => {
  const flicker = { available: 2944.58, equity: 4119.83, margin: 587.62, pnl: 0 };
  assert.equal(isPlausibleSample(flicker, settled), false);
});

test('SMALL-scale flicker is rejected by the exact no-P&L identity (2026-09-11)', () => {
  // observed live: eq 4028.46 / pnl 0 between 4025.92/-2.54 pairs — the old
  // 0.25% threshold (~10) missed the 2.54-dollar version of the same frame.
  const prev = { equity: 4025.92, pnl: -2.54 };
  const flicker = { equity: 4028.46, pnl: 0 };
  assert.equal(isPlausibleSample(flicker, prev), false);
});

test('a legitimate close-to-flat (equity holds, pnl flips to 0) is accepted', () => {
  // position closed: balance absorbs the P&L, equity stays ~unchanged.
  const prev = { equity: 4025.92, pnl: -2.54 };
  const closed = { equity: 4025.92, pnl: 0 };
  assert.equal(isPlausibleSample(closed, prev), true);
});

test('pnl-zero sample without a jump is accepted (flat book)', () => {
  const flat = { available: 2834.12, equity: 4009.37, margin: 587.62, pnl: 0 };
  assert.equal(isPlausibleSample(flat, settled), true);
});

test('normal settled samples always pass', () => {
  const next = { available: 2838.73, equity: 4013.97, margin: 587.62, pnl: -105.85 };
  assert.equal(isPlausibleSample(next, settled), true);
});

test('the first sample ever is accepted', () => {
  assert.equal(isPlausibleSample(settled, null), true);
});

test('a sub-threshold jump with a pnl flip to zero is still accepted', () => {
  const small = { available: 2840, equity: 4015, margin: 587.62, pnl: 0 }; // +5.6 = 0.14%
  assert.equal(isPlausibleSample(small, settled), true);
});

test('null/equity-less samples are never plausible', () => {
  assert.equal(isPlausibleSample(null, settled), false);
  assert.equal(isPlausibleSample({ pnl: 1 }, settled), false);
});
