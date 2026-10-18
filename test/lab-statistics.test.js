// test/lab-statistics.test.js — offline unit checks for the Strategy Lab
// statistics engine (TRD-14): block bootstrap, BCa p, BH, PRDS check.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const stats = require('../trading/agent/lab/statistics');

const WIN = 100;
const LOSS = -100;

function shuffle(nets, seed) {
  const rng = stats.mulberry32(seed);
  for (let i = nets.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [nets[i], nets[j]] = [nets[j], nets[i]];
  }
  return nets;
}

function edgeNets(n, winPct, { shuffleSeed = 7 } = {}) {
  const wins = Math.round((n * winPct) / 100);
  const nets = [];
  for (let i = 0; i < n; i++) nets.push(i < wins ? WIN : LOSS);
  return shuffle(nets, shuffleSeed); // realistic unclustered trade order
}

test('profitFactor: zero losses -> Infinity, no trades -> null, mixed -> ratio', () => {
  assert.strictEqual(stats.profitFactor([100, 50]).pf, Infinity);
  assert.strictEqual(stats.profitFactor([]).pf, null);
  assert.strictEqual(stats.profitFactor([100, -50, 50, -50]).pf, 1.5);
});

test('mulberry32: deterministic stream', () => {
  const a = stats.mulberry32(42);
  const b = stats.mulberry32(42);
  for (let i = 0; i < 5; i++) assert.strictEqual(a(), b());
});

test('bootstrapPF: seeded resamples are reproducible and block-length correct', () => {
  const nets = edgeNets(60, 50);
  const r1 = stats.bootstrapPF(nets, { block: 5, resamples: 500, seed: 0xABCD + 353 });
  const r2 = stats.bootstrapPF(nets, { block: 5, resamples: 500, seed: 0xABCD + 353 });
  assert.strictEqual(r1.pfs.length, 500);
  assert.deepStrictEqual(r1.pfs, r2.pfs);
  assert.strictEqual(r1.countLe, r2.countLe);
});

test('bcaPvalue: seeded determinism + edge beats no-edge (synthetic pair)', () => {
  const seed = 0xABCD + 400;
  const edge = edgeNets(80, 65);   // PF ~1.86 — strong synthetic edge
  const flat = edgeNets(80, 50);   // PF 1.0 — no edge
  const e1 = stats.bcaPvalue(edge, { seed });
  const e2 = stats.bcaPvalue(edge, { seed });
  const f1 = stats.bcaPvalue(flat, { seed });
  assert.strictEqual(e1.p, e2.p);
  assert.ok(e1.pfObs > 1);
  assert.ok(e1.p < 0.05, `edge p ${e1.p} should clear 0.05`);
  assert.ok(f1.p > 0.2, `flat p ${f1.p} should be large`);
  assert.ok(e1.p < f1.p);
});

test('bcaPvalue: all-wins series carries a tiny p and an Infinity PF', () => {
  const allWins = Array(30).fill(WIN);
  const r = stats.bcaPvalue(allWins, { seed: 0xABCD + 401 });
  assert.strictEqual(r.pfObs, Infinity);
  assert.ok(r.p < 0.01);
});

test('bcaPvalue: small-sample flag at the 20..29 boundary', () => {
  const r25 = stats.bcaPvalue(edgeNets(25, 55), { seed: 0xABCD + 402 });
  const r30 = stats.bcaPvalue(edgeNets(30, 55), { seed: 0xABCD + 402 });
  const r10 = stats.bcaPvalue(edgeNets(10, 55), { seed: 0xABCD + 402 });
  assert.strictEqual(r25.smallSample, true);
  assert.strictEqual(r30.smallSample, false);
  assert.strictEqual(r10.smallSample, false);
});

test('bh: rank rungs and the worked m = 17 rank-1 threshold', () => {
  const r = stats.bh([0.001, 0.01, 0.4], 0.1);
  assert.deepStrictEqual(r.significant.sort(), [0, 1]);
  assert.strictEqual(r.ranks[0].threshold, (1 / 3) * 0.1);
  // m = 17: only a p below (1/17)*0.10 = 0.00588 clears rank 1.
  const m17 = stats.bh([0.01, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], 0.1);
  assert.deepStrictEqual(m17.significant, []);
  const m17b = stats.bh([0.005, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9], 0.1);
  assert.deepStrictEqual(m17b.significant, [0]);
});

test('normCdf/normInv round-trip (within approximation accuracy)', () => {
  for (const p of [0.01, 0.05, 0.1, 0.5, 0.9, 0.95, 0.99]) {
    assert.ok(Math.abs(stats.normCdf(stats.normInv(p)) - p) < 1e-6);
  }
});

test('prdsCheck: positive cross-correlation passes, negative flags owner review', () => {
  const pos = stats.prdsCheck([{ a: 10, b: 12 }, { a: 20, b: 22 }, { a: -5, b: -4 }, { a: 5, b: 4 }]);
  assert.strictEqual(pos.flagged, false);
  assert.ok(pos.r > 0.9);
  const neg = stats.prdsCheck([{ a: 10, b: -10 }, { a: 20, b: -20 }, { a: -5, b: 5 }]);
  assert.strictEqual(neg.flagged, true);
  assert.ok(neg.r < 0);
  const none = stats.prdsCheck([{ a: 10, b: 20 }]);
  assert.strictEqual(none.r, null);
});
