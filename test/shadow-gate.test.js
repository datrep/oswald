// test/shadow-gate.test.js — TRD-SHW-3 (2026-09-14). The pre-registered gate.
//
// The pins that matter most are the two null-value traps:
//   * a NULL p-value must never be significant — in JS `null <= 0.05` is TRUE,
//     so a forgotten guard declares an unrun test a discovery;
//   * the gate must not compute a test it has not unlocked, which is asserted
//     behaviourally (no p, no family, verdict not_ready) rather than by reading
//     the source.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const g = require('../trading/agent/shadowGate');
const shadow = require('../trading/agent/shadow');
const score = require('../trading/agent/shadowScore');
const { code } = require('./_source');

const T0 = '2026-09-14T00:00:00.000Z';
const at = (h) => new Date(new Date(T0).getTime() + h * 3600 * 1000).toISOString();
// ★ `openPrice` — the column `PriceBars` actually has (see test/shadow-score.test.js).
// This fixture said `open`, which the implementation also read, so baseline C's draws
// were all fabricated zeros that nobody noticed (TRD-SHW-4, 2026-09-23).
const bar = (i) => {
  const o = 100 + i * 0.1;
  return { barStart: at(i), openPrice: o, high: o + 0.05, low: o - 0.05, closePrice: o };
};
// 60 hourly bars, gently rising, enough for a random entry to have somewhere to go.
const bars = Array.from({ length: 60 }, (_, i) => bar(i));

const row = (over = {}) => ({
  id: 1, createdAt: T0, symbol: 'Gold', venue: 'plus500', direction: 'buy',
  priceAtCall: 100, atr14: 1, confidence: 0.7,
  realisedR: 0.6, benchmarkLongR: 0.1, ...over,
});

// --- the RNG --------------------------------------------------------------

test('the bootstrap RNG is deterministic, so two runs on one dataset cannot disagree', () => {
  const a = g.mulberry32(20260914);
  const b = g.mulberry32(20260914);
  const seq = [a(), a(), a()];
  assert.deepStrictEqual(seq, [b(), b(), b()]);
  assert.ok(seq.every((x) => x >= 0 && x < 1));
  // A different seed must actually diverge, or the pin above proves nothing.
  const c1 = g.mulberry32(1);
  const c2 = g.mulberry32(2);
  assert.notStrictEqual(c1(), c2());
});

// --- the bootstrap --------------------------------------------------------

test('a strictly positive sample clears its lower bound and reports a small p', () => {
  const xs = [0.5, 0.6, 0.55, 0.7, 0.45, 0.8, 0.6, 0.5, 0.65, 0.55];
  const b = g.bootstrapMean(xs, { trials: 2000, seed: 7 });
  assert.ok(b.lower > 0, `lower=${b.lower}`);
  assert.ok(b.mean > 0.5 && b.mean < 0.7);
  assert.ok(b.p < 0.05, `p=${b.p}`);
});

test('a sample that straddles zero does not clear the lower bound', () => {
  const xs = [1, -1, 0.5, -0.5, 0.2, -0.2, 1.5, -1.4];
  const b = g.bootstrapMean(xs, { trials: 2000, seed: 8 });
  assert.ok(b.lower < 0, `lower=${b.lower}`);
  assert.ok(b.upper > 0, `upper=${b.upper}`);
  assert.ok(b.p > 0.3, `p=${b.p}`);
});

test('★ the bootstrap p-value can never be reported as exactly zero', () => {
  const b = g.bootstrapMean(new Array(12).fill(2), { trials: 500, seed: 1 });
  assert.ok(b.p > 0);
  assert.strictEqual(b.p, 1 / 501); // no resample can land at or below zero
});

test('an empty sample yields no interval rather than a fabricated one', () => {
  const b = g.bootstrapMean([]);
  assert.strictEqual(b.n, 0);
  assert.strictEqual(b.p, null);
  assert.strictEqual(b.lower, null);
});

// --- multiplicity ---------------------------------------------------------

test('BH cuts rank 1 at q/2 and rank 2 at q when m=2', () => {
  const r = g.benjaminiHochberg([0.03, 0.08], 0.1);
  assert.strictEqual(r.steps[0].cutoff, 0.05);
  assert.strictEqual(r.steps[1].cutoff, 0.1);
  assert.deepStrictEqual(r.significant, [true, true]);
});

test('★ BH is NOT "each p < 0.10": [0.09, 0.50] declares nothing', () => {
  // Under a naive two-independent-thresholds reading the first would be declared.
  const r = g.benjaminiHochberg([0.09, 0.5], 0.1);
  assert.deepStrictEqual(r.significant, [false, false]);
  assert.strictEqual(r.declared, 0);
});

test('★ BH is step-UP: rank 2 clearing its cutoff carries rank 1 with it', () => {
  // Deliberately asserted because it surprises readers who expect two
  // independent thresholds. 0.06 fails rank 1's own cutoff of 0.05.
  const r = g.benjaminiHochberg([0.06, 0.08], 0.1);
  assert.strictEqual(r.declared, 2);
  assert.deepStrictEqual(r.significant, [true, true]);
});

test('a lone surviving rank is declared alone', () => {
  const r = g.benjaminiHochberg([0.04, 0.5], 0.1);
  assert.deepStrictEqual(r.significant, [true, false]);
  assert.strictEqual(r.declared, 1);
});

test('★ a NULL p-value is never significant', () => {
  // `null <= 0.05` is TRUE in JS, so this test fails the moment the guard in
  // benjaminiHochberg is removed — which is the whole point of it.
  const r = g.benjaminiHochberg([0.03, null], 0.1);
  assert.strictEqual(r.significant[1], false);
  assert.strictEqual(r.declared, 1);
  assert.strictEqual(g.benjaminiHochberg([null, null], 0.1).declared, 0);
});

// --- gates ----------------------------------------------------------------

test('the gate reports which one it is waiting on', () => {
  const low = g.gateStatus({ totalCalls: 10, yesCount: 2 });
  assert.strictEqual(low.gate1, false);
  assert.strictEqual(low.waitingOn, 'calls');
  const mid = g.gateStatus({ totalCalls: 55, yesCount: 12 });
  assert.strictEqual(mid.gate1, true);
  assert.strictEqual(mid.gate2, false);
  assert.strictEqual(mid.waitingOn, 'yes');
  assert.match(mid.message, /12\/50/);
  const open = g.gateStatus({ totalCalls: 60, yesCount: 51 });
  assert.strictEqual(open.waitingOn, null);
  assert.match(open.message, /both gates open/);
});

// --- the gate itself ------------------------------------------------------

test('★ a closed gate computes NO test at all', () => {
  const report = g.evaluateShadowGate({
    signals: [row(), row({ id: 2, realisedR: 1.1 })],
    barsFor: () => bars,
  });
  assert.strictEqual(report.tests.run, false);
  assert.strictEqual(report.tests.family.length, 0);
  assert.strictEqual(report.bh, null);
  assert.strictEqual(report.verdict, 'not_ready');
  assert.match(report.tests.reason, /gate 1 waiting/);
  const md = g.renderReport(report);
  assert.match(md, /NOT RUN/);
  assert.doesNotMatch(md, /\bp\b.*0\.0\d/, 'no p-value may appear before the gate opens');
});

test('an open gate runs exactly two tests against B and C', () => {
  const signals = Array.from({ length: 60 }, (_, i) => row({
    id: i + 1,
    realisedR: 0.6 + ((i % 5) - 2) * 0.05,
    benchmarkLongR: 0.1,
    direction: i % 10 === 0 ? null : 'buy', // some calls carry no direction
  }));
  const report = g.evaluateShadowGate({ signals, barsFor: () => bars, trials: 800 });
  assert.strictEqual(report.tests.run, true);
  assert.strictEqual(report.tests.family.length, 2);
  assert.deepStrictEqual(report.tests.family.map((t) => t.id), ['shadow_vs_B', 'shadow_vs_C']);
  assert.strictEqual(report.bh.m, 2);
  for (const t of report.tests.family) {
    assert.ok(t.p > 0 && t.p <= 1, `p out of range: ${t.p}`);
    assert.ok(Number.isFinite(t.lower) && Number.isFinite(t.upper));
  }
  assert.ok(['promote', 'reject_at_this_n'].includes(report.verdict));
  // Non-directional calls are recorded but never enter the tested population.
  assert.strictEqual(report.counts.totalCalls, 60);
  assert.strictEqual(report.counts.yes, 54);
  assert.match(g.renderReport(report), /Baselines/);
});

test('both baselines are reported in the same R units as the call', () => {
  const signals = Array.from({ length: 55 }, (_, i) => row({ id: i + 1 }));
  const report = g.evaluateShadowGate({ signals, barsFor: () => bars, trials: 200 });
  assert.ok(Number.isFinite(report.baselines.B_unmirroredLong.meanR));
  assert.ok(Number.isFinite(report.baselines.C_randomEntry.meanR));
  assert.strictEqual(report.baselines.C_randomEntry.n, 55);
});

// --- baseline C -----------------------------------------------------------

test('baseline C needs room to enter elsewhere, and reports nothing when there is none', () => {
  const rng = g.mulberry32(3);
  const tight = bars.slice(0, 24); // exactly the horizon: the call's own entry only
  assert.strictEqual(g.randomEntryPct(row(), tight, rng), null);
  const roomy = g.randomEntryPct(row(), bars, rng);
  assert.ok(Number.isFinite(roomy));
});

test('baseline C averages its draws into one R per row', () => {
  const rows = [row(), row({ id: 2 })];
  const out = g.baselineCRows(rows, () => bars, { trials: 50, seed: 5 });
  assert.strictEqual(out.length, 2);
  for (const c of out) {
    assert.strictEqual(c.draws, 50);
    assert.ok(Number.isFinite(c.cR));
    // ★ NOT a fabricated zero. On the pre-fix code every draw was `rOf(null, risk)`,
    // which is 0 — so C's mean was 0 for every row and `isNum` still accepted it.
    assert.notStrictEqual(c.cR, 0, 'C must carry real returns, not the null-coercion zero');
  }
  // Deterministic: the same seed must reproduce the same C.
  const again = g.baselineCRows(rows, () => bars, { trials: 50, seed: 5 });
  assert.deepStrictEqual(again.map((c) => c.cR), out.map((c) => c.cR));
});

// --- purity and drift guards ---------------------------------------------

test('the horizon is the same one the ledger and the scorer use', () => {
  assert.strictEqual(g.GATE.HORIZON_BARS ?? shadow.HORIZON_BARS, shadow.HORIZON_BARS);
  assert.strictEqual(shadow.HORIZON_BARS, score.HORIZON_BARS);
});

test('the gate is pure — it reads no clock and no database', () => {
  const src = code('trading/agent/shadowGate.js');
  assert.doesNotMatch(src, /Date\.now\(/);
  assert.doesNotMatch(src, /new Date\(\)/);
  assert.doesNotMatch(src, /require\(.*store.*\)/);
});

test('the report carries the caveats, not just the numbers', () => {
  const md = g.renderReport(g.evaluateShadowGate({ signals: [], barsFor: () => [] }));
  assert.match(md, /conditional/i);
  assert.match(md, /does not\s+see moves early|does not see moves early/);
  assert.match(md, /CPI/);        // the honest scope limit
  assert.match(md, /FOMC/);
  assert.match(md, /real exits/); // counterfactual is not the desk's R
});
