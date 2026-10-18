// test/exit-refusal-counterfactual.test.js — TRD-EXI-1b (#1490).
//
// The floor under a near-stop cut was justified by the 25 cuts the desk TOOK. The cuts it now DECLINES produced
// no close, so no autopsy, so no counterfactual — the one population that could falsify the floor was the one it
// could not see. These tests pin the machinery that makes a refusal measurable, and they pin the three ways it
// could lie instead:
//
//   1. an OPEN window read as "the levels were never reached"  (missing data as a negative finding)
//   2. a settle imported from a level that MOVED after the refusal  (answering a question not asked)
//   3. a gate suppression counted where the MIRROR policy was the decider  (crediting the floor with a decision
//      it did not make, then measuring the floor against it)
//
// The tick feed is stubbed at `store.ticksSince` — the same seam `test/autopsy-metrics.test.js` uses, because
// autopsy resolves ticks THROUGH the store aggregate and patching store/ticks.js has no effect.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const store = require('../trading/store');
const autopsy = require('../trading/agent/autopsy');
const { refusalIdFor, refusalOutcomes } = require('../trading/agent/exitPolicy');
const { decideClose } = require('../trading/agent/review');

// Gold #1137 — the trade that started the whole investigation. sell, entry 4,169.81, stop 4,184.7868,
// target 4,145.5944. R = 14.9768.
const GOLD = { entry: 4169.81, stopPrice: 4184.7868, takeProfitPrice: 4145.5944, direction: 'sell' };
const GOLD_R = 14.9768;

const mock = (impl) => {
  const orig = {};
  for (const k of Object.keys(impl)) {
    orig[k] = store[k];
    store[k] = impl[k];
  }
  return () => { for (const k of Object.keys(orig)) store[k] = orig[k]; };
};

// ── the arithmetic ───────────────────────────────────────────────────────────────────────────────────────────
test('a refusal the venue stopped out COSTS exactly the saving the refused cut would have banked', () => {
  const savingR = 3.2368 / GOLD_R; // 4,184.7868 - 4,181.55, over R
  const { cutOutcomeR, refusalValueR } = refusalOutcomes({ ...GOLD, savingR, heldOutcomeR: -1 });
  assert.ok(Math.abs(savingR - 0.2161) < 1e-3);
  assert.ok(Math.abs(cutOutcomeR - -0.7839) < 1e-3); // the cut banks -0.784R where the stop costs a full -1.0R
  assert.ok(Math.abs(refusalValueR - -savingR) < 1e-3, 'refusing cost the saving, and nothing else');
});

test('a refusal that kept a winner GAINS the target plus the R the cut would have surrendered', () => {
  const savingR = 0.158;
  const tpR = 2.7;
  const { refusalValueR, cutOutcomeR } = refusalOutcomes({ entry: 100, stopPrice: 99, takeProfitPrice: 102.7, savingR, heldOutcomeR: tpR });
  // the swing is measured from the CUT, not from entry: the cut banks -(1-s) and holding banks +tpR
  assert.ok(Math.abs(refusalValueR - (tpR + 1 - savingR)) < 1e-3);
  assert.ok(Math.abs(refusalValueR - 3.542) < 1e-3);
  assert.ok(Math.abs(cutOutcomeR - -0.842) < 1e-3);
});

test('a refusal with no readable geometry is UNJUDGED rather than worth zero', () => {
  for (const bad of [{ entry: null }, { stopPrice: null }, { savingR: null }]) {
    const o = refusalOutcomes({ ...GOLD, savingR: 0.2, heldOutcomeR: -1, ...bad });
    assert.strictEqual(o.refusalValueR, null, `${JSON.stringify(bad)} must not produce a confident number`);
  }
});

test('a saving of 0 is a REAL value and must survive as 0', () => {
  // the price sitting exactly on the stop: the cut banks the whole R and saves nothing
  const o = refusalOutcomes({ ...GOLD, savingR: 0, heldOutcomeR: -1 });
  assert.strictEqual(o.cutOutcomeR, -1);
  assert.strictEqual(o.refusalValueR, 0);
});

test('a refusal is identified by its INSTANT, not by its trade', () => {
  // a position parked near its stop is reviewed repeatedly at different prices, and each is a separate decision
  const a = refusalIdFor(1137, '2026-09-30T07:00:00.000Z');
  const b = refusalIdFor(1137, '2026-09-30T07:05:00.000Z');
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, refusalIdFor(1137, new Date('2026-09-30T07:00:00.000Z')));
  assert.match(a, /^1137-\d+$/);
});

// ── who the floor actually decided ───────────────────────────────────────────────────────────────────────────
test('the floor is credited only when IT decided - a mirrored suppression is not a refused cut', () => {
  const verdict = { action: 'close', confidence: 0.9 };
  const gate = { refuse: true, savingR: 0.158, minSavingR: 0.3, reason: 'saving_below_floor' };
  const base = { verdict, minConfidence: 0.7, cutGate: gate, closeMirrored: false };

  // the desk would have cut, and the floor is the only thing that stopped it
  const enforced = decideClose({ ...base, mirrored: false, authority: 'decider' });
  assert.strictEqual(enforced.canClose, true);
  assert.strictEqual(enforced.cutSuppressed, true);
  assert.strictEqual(enforced.cutEnforced, true);

  // the mirror policy already forbade the close: the floor's opinion changed nothing
  const mirrored = decideClose({ ...base, mirrored: true, authority: 'decider' });
  assert.strictEqual(mirrored.canClose, false);
  assert.strictEqual(mirrored.cutSuppressed, true);
  assert.strictEqual(mirrored.cutEnforced, false, 'the mirror decided, not the floor');

  // the strategy owns its own exit: same reasoning
  const advisory = decideClose({ ...base, mirrored: false, authority: 'advisory' });
  assert.strictEqual(advisory.cutEnforced, false);

  // and with the gate passing, nothing is suppressed at all
  const passed = decideClose({ ...base, mirrored: false, authority: 'decider', cutGate: { refuse: false, savingR: 0.5, minSavingR: 0.3, reason: null } });
  assert.strictEqual(passed.cutEnforced, false);
  assert.strictEqual(passed.close, true);
});

// ── the window ───────────────────────────────────────────────────────────────────────────────────────────────
test('an OPEN window cannot say the levels were never reached', async () => {
  const restore = mock({ ticksSince: async () => [] });
  try {
    const cf = await autopsy.counterfactualFrom(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'buy',
      stopPrice: 98, takeProfitPrice: 104,
      fromAt: new Date(Date.now() - 30 * 60000).toISOString(), // half an hour into a 24h horizon
    });
    assert.strictEqual(cf.windowComplete, false);
    assert.strictEqual(cf.verdict, 'open:neither');
  } finally { restore(); }
});

test('a window that ENDED on the position close is complete, not 4% of a horizon', async () => {
  const restore = mock({ ticksSince: async () => [] });
  try {
    const from = '2026-09-20T00:00:00.000Z';
    const cf = await autopsy.counterfactualFrom(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'buy',
      stopPrice: 98, takeProfitPrice: 104,
      fromAt: from, capAt: '2026-09-20T03:00:00.000Z',
    });
    assert.strictEqual(cf.windowComplete, true);
    assert.strictEqual(cf.windowEndedBy, 'cap');
    // three hours of ticks and neither level touched: that IS the answer, not a missing one
    assert.strictEqual(cf.verdict, 'neither');
  } finally { restore(); }
});

test('the tick feed races the levels, and the FIRST touch wins', async () => {
  const ticks = [
    { bid: 100.98, ask: 101.02, capturedAt: '2026-09-20T01:00:00.000Z' },
    { bid: 103.99, ask: 104.01, capturedAt: '2026-09-20T02:00:00.000Z' }, // target first
    { bid: 97.99, ask: 98.01, capturedAt: '2026-09-20T05:00:00.000Z' }, // stop later
  ];
  const restore = mock({ ticksSince: async () => ticks });
  try {
    const cf = await autopsy.counterfactualFrom(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'buy',
      stopPrice: 98, takeProfitPrice: 104,
      fromAt: '2026-09-20T00:00:00.000Z',
    });
    assert.strictEqual(cf.verdict, 'target_first');
    assert.strictEqual(cf.minutesToTarget, 120);
    assert.strictEqual(cf.minutesToStop, 300);
    assert.strictEqual(cf.ticksAfter, 3);
    assert.strictEqual(cf.lastMid, 98);
  } finally { restore(); }
});

test('a touch the feed never sampled can be SETTLED by the venue, and says so', async () => {
  const restore = mock({ ticksSince: async () => [] });
  try {
    const cf = await autopsy.counterfactualFrom(1, {
      symbol: 'Gold', venue: 'plus500', direction: 'sell',
      stopPrice: 102, takeProfitPrice: 96,
      fromAt: '2026-09-20T00:00:00.000Z',
      capAt: '2026-09-20T03:00:00.000Z',
      settled: [{ level: 'stop', at: '2026-09-20T01:00:00.000Z' }],
    });
    assert.strictEqual(cf.verdict, 'stop_only');
    assert.strictEqual(cf.minutesToStop, 60);
    assert.strictEqual(cf.settledBy, 'venue_stop', 'the record must say the level came from outside the feed');
  } finally { restore(); }
});

// ── the settlement of a refusal ──────────────────────────────────────────────────────────────────────────────
const refusalPayload = (over = {}) => ({
  refusalId: '5-1790000000000',
  tradeId: 5, symbol: 'Gold', venue: 'plus500', direction: 'sell',
  entry: GOLD.entry, stopPrice: GOLD.stopPrice, takeProfitPrice: GOLD.takeProfitPrice,
  price: 4181.55, savingR: 3.2368 / GOLD_R, minSavingR: 0.3, gateReason: 'saving_below_floor',
  horizonHours: 24, at: '2026-09-20T00:00:00.000Z',
  ...over,
});

test('a refusal the venue then stopped out is settled as a COST, at the size of the saving', async () => {
  const logged = [];
  const restore = mock({
    ticksSince: async () => [],
    getTradeById: async () => ({
      ...GOLD, id: 5, status: 'closed', openPrice: GOLD.entry,
      closePrice: GOLD.stopPrice, closeAt: '2026-09-20T01:00:00.000Z',
    }),
    logEvent: async (userId, kind, payload) => { logged.push({ kind, payload }); },
    listEventsAll: async (userId, { kind }) => ({
      rows: [...(kind === 'cut_refused' ? [{ payload: refusalPayload() }] : []), ...logged.filter((e) => e.kind === kind)],
      pages: 1, truncated: false, pageSize: 500,
    }),
  });
  try {
    const out = await autopsy.resolveCutRefusals(1);
    assert.strictEqual(out.resolved, 1);
    assert.strictEqual(out.deferred, 0);
    const rec = logged.find((e) => e.kind === 'cut_refusal_resolved').payload;
    assert.strictEqual(rec.verdict, 'stop_only');
    assert.strictEqual(rec.settledBy, 'venue_stop');
    assert.strictEqual(rec.heldOutcomeSource, 'actual_close');
    assert.strictEqual(rec.heldOutcomeR, -1);
    assert.ok(Math.abs(rec.cutOutcomeR - -0.7839) < 1e-3);
    assert.ok(Math.abs(rec.refusalValueR - -0.2161) < 1e-3, 'the refusal cost exactly the saving it gave up');
    assert.strictEqual(rec.savingR, 3.2368 / GOLD_R);
    assert.strictEqual(rec.resolvedBy, 'sweep');
  } finally { restore(); }
});

test('a refusal still inside its horizon is DEFERRED, never answered from a partial window', async () => {
  const logged = [];
  const restore = mock({
    ticksSince: async () => [],
    getTradeById: async () => ({ ...GOLD, id: 5, status: 'open', openPrice: GOLD.entry }),
    logEvent: async (userId, kind, payload) => { logged.push({ kind, payload }); },
    listEventsAll: async (userId, { kind }) => ({
      rows: kind === 'cut_refused' ? [{ payload: refusalPayload({ at: new Date(Date.now() - 30 * 60000).toISOString() }) }] : [],
      pages: 1, truncated: false, pageSize: 500,
    }),
  });
  try {
    const out = await autopsy.resolveCutRefusals(1);
    assert.strictEqual(out.deferred, 1);
    assert.strictEqual(out.resolved, 0);
    assert.strictEqual(logged.filter((e) => e.kind === 'cut_refusal_resolved').length, 0);
  } finally { restore(); }
});

test('a settle is REFUSED when the level moved - the refusal was about the stop it named', async () => {
  const logged = [];
  const restore = mock({
    ticksSince: async () => [],
    // closed at 4,190, and its stop now READS 4,190: a trail relocated it after the refusal at 4,184.7868
    getTradeById: async () => ({
      ...GOLD, id: 5, status: 'closed', openPrice: GOLD.entry,
      stopPrice: 4190, closePrice: 4190, closeAt: '2026-09-20T01:00:00.000Z',
    }),
    logEvent: async (userId, kind, payload) => { logged.push({ kind, payload }); },
    listEventsAll: async (userId, { kind }) => ({
      rows: [...(kind === 'cut_refused' ? [{ payload: refusalPayload() }] : []), ...logged.filter((e) => e.kind === kind)],
      pages: 1, truncated: false, pageSize: 500,
    }),
  });
  try {
    await autopsy.resolveCutRefusals(1);
    const rec = logged.find((e) => e.kind === 'cut_refusal_resolved').payload;
    assert.strictEqual(rec.settleSkipped, 'levels_moved');
    assert.strictEqual(rec.settledBy, null, 'a level that did not exist at the refusal cannot settle it');
    // the outcome still comes from where the trade ACTUALLY ended
    assert.ok(Math.abs(rec.heldOutcomeR - -1.3479) < 1e-3);
  } finally { restore(); }
});

test('a refusal is settled ONCE - a second sweep has nothing left to do', async () => {
  const logged = [];
  const restore = mock({
    ticksSince: async () => [],
    getTradeById: async () => ({
      ...GOLD, id: 5, status: 'closed', openPrice: GOLD.entry,
      closePrice: GOLD.stopPrice, closeAt: '2026-09-20T01:00:00.000Z',
    }),
    logEvent: async (userId, kind, payload) => { logged.push({ kind, payload }); },
    listEventsAll: async (userId, { kind }) => ({
      rows: [...(kind === 'cut_refused' ? [{ payload: refusalPayload() }] : []), ...logged.filter((e) => e.kind === kind)],
      pages: 1, truncated: false, pageSize: 500,
    }),
  });
  try {
    const first = await autopsy.resolveCutRefusals(1);
    const second = await autopsy.resolveCutRefusals(1);
    assert.strictEqual(first.resolved, 1);
    assert.strictEqual(second.resolved, 0);
    assert.strictEqual(second.pending, 0);
    assert.strictEqual(logged.filter((e) => e.kind === 'cut_refusal_resolved').length, 1);
  } finally { restore(); }
});

test('the sweep is scoped to ONE trade when the close asks for it', async () => {
  const logged = [];
  const restore = mock({
    ticksSince: async () => [],
    getTradeById: async () => ({
      ...GOLD, id: 5, status: 'closed', openPrice: GOLD.entry,
      closePrice: GOLD.stopPrice, closeAt: '2026-09-20T01:00:00.000Z',
    }),
    logEvent: async (userId, kind, payload) => { logged.push({ kind, payload }); },
    listEventsAll: async (userId, { kind }) => ({
      rows: [...(kind === 'cut_refused' ? [
        { payload: refusalPayload() },
        { payload: refusalPayload({ refusalId: '9-1790000000000', tradeId: 9, symbol: 'Oil' }) },
      ] : []), ...logged.filter((e) => e.kind === kind)],
      pages: 1, truncated: false, pageSize: 500,
    }),
  });
  try {
    const out = await autopsy.resolveCutRefusals(1, { tradeId: 5, resolvedBy: 'close' });
    assert.strictEqual(out.resolved, 1);
    assert.strictEqual(out.pending, 1, 'the other trade is left to the standing sweep');
    assert.strictEqual(logged[0].payload.resolvedBy, 'close');
  } finally { restore(); }
});

test('recording a refusal writes the id the resolver will key on', async () => {
  const logged = [];
  const restore = mock({ logEvent: async (userId, kind, payload) => { logged.push({ kind, payload }); } });
  try {
    const at = '2026-09-30T07:00:00.000Z';
    const rec = await autopsy.recordCutRefusal(1, { tradeId: 1137, symbol: 'Gold', savingR: 0.2161, at });
    assert.strictEqual(logged[0].kind, 'cut_refused');
    assert.strictEqual(rec.refusalId, refusalIdFor(1137, at));
    assert.strictEqual(logged[0].payload.refusalId, rec.refusalId);
    assert.strictEqual(logged[0].payload.horizonHours, autopsy.COUNTERFACTUAL_HORIZON_HOURS);
  } finally { restore(); }
});
