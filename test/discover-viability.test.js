// Pins for the AI-discoverer viability gate (2026-09-11): an aged AI symbol
// that cannot reach quant.MIN_BARS of 1h bars is unevaluable — the gate must
// evict it, while young symbols keep their grace period and viable symbols are
// always kept.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { partitionViable, VIABILITY_GRACE_HOURS } = require('../trading/agent/discoverer');
const { MIN_BARS } = require('../trading/agent/quant');

const H = 3600000;
const NOW = Date.parse('2026-09-11T04:00:00Z');
const aged = (h, symbol = 'Swire Pacific') => ({ symbol, addedAt: new Date(NOW - h * H).toISOString() });

test('young AI entries keep their grace period regardless of bar count', () => {
  const r = partitionViable([aged(VIABILITY_GRACE_HOURS - 1)], { 'swire pacific': 0 }, NOW);
  assert.equal(r.keep.length, 1);
  assert.equal(r.unviable.length, 0);
});

test('aged AI entries below the bar minimum are evicted', () => {
  const r = partitionViable([aged(48)], { 'swire pacific': MIN_BARS - 1 }, NOW);
  assert.equal(r.keep.length, 0);
  assert.equal(r.unviable.length, 1);
  assert.equal(r.unviable[0].symbol, 'Swire Pacific');
});

test('aged AI entries at or above the bar minimum are kept', () => {
  const r = partitionViable([aged(48), aged(48, 'SATS')], { 'swire pacific': MIN_BARS, sats: 500 }, NOW);
  assert.equal(r.keep.length, 2);
  assert.equal(r.unviable.length, 0);
});

test('the grace boundary is exclusive — exactly grace-hours old is judged', () => {
  const r = partitionViable([aged(VIABILITY_GRACE_HOURS)], { 'swire pacific': 5 }, NOW);
  assert.equal(r.unviable.length, 1);
});

test('missing bar count counts as unviable once aged; missing age is judged by bars', () => {
  const r = partitionViable([{ symbol: 'No Count' }, { symbol: 'No Age' }], {}, NOW);
  assert.equal(r.unviable.length, 2); // no addedAt -> aged 0 -> judged, 0 bars -> out
  const r2 = partitionViable([{ symbol: 'No Age' }], { 'no age': 999 }, NOW);
  assert.equal(r2.keep.length, 1); // plenty of bars -> kept
});
