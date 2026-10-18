// 2026-09-11 (owner patch): stale-anchor RE-ANCHOR pins — the quarantine
// deadlock that starved Silver (~24h at ~64 vs anchor 67.3) and Sany Heavy
// Equipment (~9.45 vs anchor 10.0 since its Sep-8 sweep rows). The mid context
// only refreshes from ACCEPTED ticks, so once the market trends past the
// 12xMAD / flat-window guard, every next tick is rejected forever and the
// anchor can never move. Re-anchor when the anchor is STALE and the move is a
// plausible regime shift; keep poison protection for fresh anchors and
// huge-scale misreads.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyTick } = require('../trading/store/ticks');

const NOW = Date.parse('2026-09-11T12:00:00Z');
const H = 3600 * 1000;

const tick = (mid, over = {}) => ({ venue: 'plus500', symbol: 'Silver', bid: mid - 0.01, ask: mid + 0.01, source: 'plus500_frontend', ...over });
const ctx = (mids, latestAgoMs) => ({
  mids,
  latest: { bid: mids[mids.length - 1] - 0.01, ask: mids[mids.length - 1] + 0.01, capturedAt: new Date(NOW - latestAgoMs).toISOString() },
});

// med 67.125, mad 0.075 -> limit 0.9; |64 - 67.125| = 3.125 violates it.
const SILVER_MIDS = [67.0, 67.1, 67.2, 67.05, 67.15, 67.25];

test('Silver live case: FRESH anchor rejects the move (mad_magnitude)', () => {
  const d = classifyTick(tick(64.0), ctx(SILVER_MIDS, 5 * 60 * 1000), NOW);
  assert.equal(d.kind, 'quarantine');
  assert.equal(d.reason, 'mad_magnitude');
});

test('Silver live case: STALE anchor re-anchors instead of starving', () => {
  const d = classifyTick(tick(64.0), ctx(SILVER_MIDS, 24 * H), NOW);
  assert.equal(d.kind, 'accept');
  assert.equal(d.reanchor.oldMid, 67.125);
  assert.equal(d.reanchor.newMid, 64);
  assert.equal(d.reanchor.ageMin, 1440);
});

test('Sany live case: flat window (mad=0) + stale anchor re-anchors at ~9.455 vs 10.0', () => {
  const mids = [10.0, 10.0, 10.0, 10.0];
  const d = classifyTick(tick(9.455, { symbol: 'Sany Heavy Equipment' }), ctx(mids, 48 * H), NOW);
  assert.equal(d.kind, 'accept');
  assert.equal(d.reanchor.newMid, 9.455);
});

test('flat window + FRESH anchor still quarantines (flat_window_deviation)', () => {
  const mids = [10.0, 10.0, 10.0, 10.0];
  const c = { mids, latest: { bid: 9.99, ask: 10.01, capturedAt: new Date(NOW - 5 * 60 * 1000).toISOString() } };
  const d = classifyTick(tick(9.455, { symbol: 'Sany Heavy Equipment' }), c, NOW);
  assert.equal(d.kind, 'quarantine');
  assert.equal(d.reason, 'flat_window_deviation');
});

test('window catch-up: after a re-anchor, reads at the NEW level pass while the old median lingers', () => {
  const mids = [10.0, 10.0, 10.0, 10.0, 10.0, 9.455]; // real life: 47 old rows; median still 10.0
  const c = { mids, latest: { bid: 9.445, ask: 9.465, capturedAt: new Date(NOW - 5 * 60 * 1000).toISOString() } };
  const d = classifyTick(tick(9.455, { symbol: 'Sany Heavy Equipment' }), c, NOW);
  assert.equal(d.kind, 'accept');
  assert.ok(d.catchup);
  assert.equal(d.reanchor, undefined);
});

test('SGX live case: a read FAR from the newest accepted tick stays quarantined (fresh anchor)', () => {
  const mids = [24.2, 24.25, 24.2, 24.3, 24.25, 24.22];
  const c = { mids, latest: { bid: 24.19, ask: 24.21, capturedAt: new Date(NOW - 7 * 60 * 1000).toISOString() } };
  const d = classifyTick(tick(18.195, { symbol: 'SGX' }), c, NOW);
  assert.equal(d.kind, 'quarantine');
  assert.equal(d.reason, 'mad_magnitude');
});

test('poison-scale misread stays quarantined even against a stale anchor', () => {
  const d = classifyTick(tick(1000), ctx(SILVER_MIDS, 48 * H), NOW);
  assert.equal(d.kind, 'quarantine');
  assert.equal(d.reason, 'mad_magnitude');
});

test('within-limit move against a fresh anchor accepts without re-anchor', () => {
  const d = classifyTick(tick(67.2), ctx(SILVER_MIDS, 5 * 60 * 1000), NOW);
  assert.equal(d.kind, 'accept');
  assert.equal(d.reanchor, undefined);
});

test('identical tick within the dedupe window is deduped', () => {
  const c = { mids: [64, 64, 64, 64], latest: { bid: 63.99, ask: 64.01, capturedAt: new Date(NOW - 30 * 1000).toISOString() } };
  const d = classifyTick(tick(64.0), c, NOW);
  assert.equal(d.kind, 'dedupe');
});

test('no context: first-ever tick accepts', () => {
  const d = classifyTick(tick(64.0), undefined, NOW);
  assert.equal(d.kind, 'accept');
});
