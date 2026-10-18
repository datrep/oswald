// test/net-edge-provenance.test.js — TRD-117 (2026-09-22): the net-edge screen REPORTS circularity.
//
// `maeSource = 'close'` means the adverse extreme WAS the exit price, so that row's maePct restates where
// the trade ended instead of measuring an excursion — 15 of the 21 labelable rows on the live book.
//
// THE DECISION THIS FILE PINS: the screen reports that and does NOT gate on it. Exclusion was rejected
// because it would be CONFOUNDED BY RETENTION — provenance can only be labelled where the ticks still
// exist, so a recent pair would have its circular rows removed while an older pair would keep them, and
// the screen's number would move with data AGE rather than with edge. It also feeds a live refusal
// (`bindingProposer.scopeEdgeScreen`), so changing it is a separate decision with its own evidence.
//
// A test that only counted labels would not protect that decision. So the load-bearing test here is the
// one asserting that IDENTICAL NUMBERS WITH DIFFERENT PROVENANCE PRODUCE AN IDENTICAL VERDICT.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const store = require('../trading/store');
const analytics = require('../trading/agent/analytics');

// Same stub discipline as autopsy-metrics.test.js: analytics resolves trades through the store aggregate,
// so patching the repository underneath has no effect — and a silent fallthrough would grade the LIVE
// database. The stub counts its calls so a broken stub fails loudly instead of quietly using real trades.
let calls = 0;
const mockTrades = (rows) => {
  const orig = store.listClosedTradesForStats;
  store.listClosedTradesForStats = async () => { calls++; return rows; };
  return () => { store.listClosedTradesForStats = orig; };
};

// 12 closes on one pair, all measurable, which clears minTrades=10 and minMeasurableShare=0.5.
const trade = (i, over = {}) => ({
  id: i, strategyId: 'survgold', symbol: 'Gold', direction: 'sell',
  openPrice: 4000, stopPrice: 4012, grossPnl: -1,
  openAt: new Date('2026-09-01T00:00:00Z'), closeAt: new Date('2026-09-01T01:00:00Z'),
  mfePct: 0.5, maePct: -0.5,
  ...over,
});

const pair = (over = {}) => Array.from({ length: 12 }, (_, i) => trade(1000 + i, over));

const run = async (rows) => {
  calls = 0;
  const restore = mockTrades(rows);
  try {
    const out = await analytics.netEdge(1, { days: 90 });
    assert.strictEqual(calls, 1, 'stub must be used, not the live trade table');
    return out.find((r) => r.strategy === 'survgold' && r.symbol === 'Gold');
  } finally { restore(); }
};

test('non-circular rows report all_mid and make no circular claim', async () => {
  const r = await run(pair({ maeSource: 'mid', mfeSource: 'mid' }));
  assert.strictEqual(r.anchoredMae, 0);
  assert.strictEqual(r.unlabelledMae, 0);
  assert.strictEqual(r.maeBasis, 'all_mid');
  assert.doesNotMatch(r.why, /CIRCULAR/, 'a clean pair must not cry wolf');
});

test('circular rows are COUNTED and NAMED in the verdict text', async () => {
  // 5 of the 12 exits are the adverse extreme — the stop-out shape.
  const rows = pair().map((t, i) => (i < 5 ? { ...t, maeSource: 'close' } : { ...t, maeSource: 'mid' }));
  const r = await run(rows);
  assert.strictEqual(r.anchoredMae, 5);
  assert.strictEqual(r.unlabelledMae, 0);
  assert.strictEqual(r.maeBasis, 'mixed');
  assert.match(r.why, /5 of 12 MAE value\(s\) are the EXIT RESTATED/);
  assert.match(r.why, /partly CIRCULAR/);
});

test('★ THE DECISION: identical numbers with different provenance give an IDENTICAL verdict', async () => {
  // This is the test that protects "report, do not gate". If someone later makes maeSource filter or
  // down-weight the screen, the two verdicts below stop matching and this fails.
  const clean = await run(pair({ maeSource: 'mid' }));
  const circular = await run(pair({ maeSource: 'close' }));
  assert.strictEqual(circular.netEdgePct, clean.netEdgePct, 'the number must not move');
  assert.strictEqual(circular.verdict, clean.verdict, 'nor may the verdict');
  assert.strictEqual(circular.avgAbsMaePct, clean.avgAbsMaePct, 'nor the terms it is built from');
  // ...while the provenance still distinguishes them, which is the whole point of labelling.
  assert.notStrictEqual(circular.maeBasis, clean.maeBasis);
});

test('rows that cannot be labelled yet are counted separately, not assumed clean', async () => {
  // maeSource absent is the 19-row retention class on the live book: the ticks are gone, so provenance is
  // UNKNOWN. Unknown is not 'mid', and a reader must be able to see the size of the part not yet judgeable.
  const rows = pair().map((t, i) => (i < 4 ? { ...t } : { ...t, maeSource: 'mid' }));
  delete rows[0].maeSource;
  const r = await run(rows);
  assert.strictEqual(r.unlabelledMae, 4);
  assert.strictEqual(r.anchoredMae, 0);
  assert.strictEqual(r.maeBasis, 'partial_unknown', 'no circular rows, but the basis is not fully known');
  assert.doesNotMatch(r.why, /CIRCULAR/, 'unknown provenance is not itself a circularity claim');
});

test('mixed wins over partial_unknown — a confirmed circular row outranks an unknown one', async () => {
  const rows = pair().map((t, i) => {
    if (i === 0) return { ...t, maeSource: 'close' };
    if (i < 4) return { ...t };
    return { ...t, maeSource: 'mid' };
  });
  const r = await run(rows);
  assert.strictEqual(r.anchoredMae, 1);
  assert.strictEqual(r.unlabelledMae, 3);
  assert.strictEqual(r.maeBasis, 'mixed');
});

test('a pair with no measurable close carries no basis at all', async () => {
  const rows = pair().map((t) => ({ ...t, mfePct: null, maePct: null }));
  const r = await run(rows);
  assert.strictEqual(r.verdict, 'unmeasurable');
  assert.strictEqual(r.maeBasis, null, 'nothing contributed, so there is no basis to describe');
  assert.strictEqual(r.anchoredMae, 0);
});
