'use strict';
// TRD-LLM-1: the LLM ledger priced in MONEY, not only in tokens.
//
// WHY THIS FILE IS MOSTLY ABOUT ABSENCE. The defect is not that a rate is wrong — it is that the desk
// had no rate and no cost series, so "do the LLMs pay for themselves" was answered by whoever happened to
// do the converting. The dangerous version of the fix is a default rate or `costUsd: 0`, because BOTH
// render "unpriced" as "free" — and a free LLM is a conclusion, while "nobody has told me the price" is
// not. So half of these assertions are that the code writes NOTHING where it does not know.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const budget = require(path.join(__dirname, '..', 'trading', 'agent', 'budget'));

const RATES = { inputHitPerM: 0.07, inputMissPerM: 0.27, outputPerM: 1.10 };
const priced = (over = {}) => ({ budget: { pricing: { ...RATES, ...over } } });
// ⚠ `0.07 + 0.27 + 1.10` is `1.4400000000000002` in IEEE-754. `costOf` deliberately rounds money to 6
// decimals so a ledger does not accumulate float dust, so the EXPECTED value must be rounded the same way.
// My first version of this file compared against the raw sum and failed — the code was right.
const money = (n) => Math.round(n * 1e6) / 1e6;

test('★ pricingOf returns null when no rate is configured — it never invents one', () => {
  assert.equal(budget.pricingOf(null), null);
  assert.equal(budget.pricingOf({}), null);
  assert.equal(budget.pricingOf({ budget: {} }), null);
  assert.equal(budget.pricingOf({ budget: { pricing: null } }), null);
  // A HALF-configured price is not a price: two of three rates would silently price one bucket at zero.
  assert.equal(budget.pricingOf(priced({ outputPerM: undefined })), null);
  assert.equal(budget.pricingOf(priced({ inputHitPerM: null })), null);
  assert.equal(budget.pricingOf(priced({ inputMissPerM: 'free' })), null);
  // Non-vacuity: a complete price IS read, so the assertions above are not passing because the reader is dead.
  assert.deepEqual(budget.pricingOf(priced()), RATES);
});

test('★ costOf returns NULL when unpriced — not a zero-cost object', () => {
  // This is the whole point: `{costUsd: 0}` and `null` are different claims, and only one is true.
  assert.equal(budget.costOf({ completion: 1000, hit: 0, miss: 1000 }, null), null);
  const c = budget.costOf({ completion: 1e6, hit: 1e6, miss: 1e6 }, RATES);
  assert.ok(c, 'a priced call must produce a cost');
});

test('costOf prices the THREE buckets separately, per million tokens', () => {
  // 1M of each bucket at the three rates, so the arithmetic is explicit rather than inferred.
  const c = budget.costOf({ completion: 1e6, hit: 1e6, miss: 1e6 }, RATES);
  assert.equal(c.costUsd, money(0.07 + 0.27 + 1.10));
  // The rounding itself is the contract: money is written to 6dp so the ledger cannot drift on float dust.
  assert.equal(c.costUsd, 1.44, 'a money field is rounded to 6dp, not left as float accumulation');
  // And each bucket alone, so no bucket can be dropped without a failure.
  assert.equal(budget.costOf({ completion: 1e6, hit: 0, miss: 0 }, RATES).costUsd, 1.10);
  assert.equal(budget.costOf({ completion: 0, hit: 1e6, miss: 0 }, RATES).costUsd, 0.07);
  assert.equal(budget.costOf({ completion: 0, hit: 0, miss: 1e6 }, RATES).costUsd, 0.27);
  // Cache hits are the CHEAP bucket — if the split were collapsed to one rate this would not hold.
  assert.ok(budget.costOf({ completion: 0, hit: 1e6, miss: 0 }, RATES).costUsd
    < budget.costOf({ completion: 0, hit: 0, miss: 1e6 }, RATES).costUsd);
});

test('★ the stored cost is RE-DERIVABLE from the row\'s own tokens and the row\'s own rate', () => {
  // A recorded value that cannot be re-derived is an assertion. Carrying `pricingUsed` on the row is what
  // makes it re-derivable even after the settings rate changes.
  const tokens = { completion: 470877, hit: 1650000, miss: 282496 };
  const c = budget.costOf(tokens, RATES);
  assert.deepEqual(c.pricingUsed, RATES, 'the row carries the rate that priced it');
  const again = budget.costOf(c.tokens, c.pricingUsed);
  assert.equal(again.costUsd, c.costUsd, 're-pricing from the row alone must return the row\'s own cost');
});

test('★ breakevenRatePerM states a RATE, and refuses a claim it cannot support', () => {
  // The desk-owned form of "do the LLMs pay for themselves": above this $/M the spend would cancel the
  // whole gain. On TRD-LLM-1's own figures: $113.21 of gain over 7,115,691 tokens.
  const be = budget.breakevenRatePerM({ gainUsd: 113.21, tokens: 7115691 });
  assert.equal(Math.round(be.perMillionTokens * 100) / 100, 15.91);
  // Refusals: a non-positive gain has no breakeven rate, and neither does a zero token count.
  assert.equal(budget.breakevenRatePerM({ gainUsd: 0, tokens: 1e6 }), null);
  assert.equal(budget.breakevenRatePerM({ gainUsd: 100, tokens: 0 }), null);
  assert.equal(budget.breakevenRatePerM({ gainUsd: NaN, tokens: 1e6 }), null);
});

test('record() writes the cost AND the rate when priced, and NOTHING when not', async () => {
  // Driven against a stubbed store, so the assertion is on what WOULD BE WRITTEN rather than on a read.
  const store = require(path.join(__dirname, '..', 'trading', 'store'));
  const realLog = store.logEvent;
  const written = [];
  store.logEvent = async (_u, kind, payload) => { written.push({ kind, payload }); };

  try {
    // 1. UNPRICED — the default. No `costUsd` key at all, and an explicit marker instead.
    await budget.record(1, 'chair', { completionTokens: 500, promptCacheHitTokens: 1000, promptCacheMissTokens: 200 });
    assert.equal(written.length, 1);
    assert.equal(written[0].kind, 'llm_usage');
    assert.ok(!('costUsd' in written[0].payload), '★ an unpriced call must NOT carry a cost field — not even 0');
    assert.equal(written[0].payload.unpriced, true, 'and it must MARK that it is unpriced');

    // 2. PRICED — the cost and the rate that produced it both land on the row.
    written.length = 0;
    await budget.record(1, 'chair', { completionTokens: 500, promptCacheHitTokens: 1000, promptCacheMissTokens: 200 }, { settings: priced() });
    const p = written[0].payload;
    assert.ok(Number.isFinite(p.costUsd), 'a priced call records a cost');
    assert.deepEqual(p.pricingUsed, RATES);
    assert.ok(!('unpriced' in p), 'a priced call is not also marked unpriced');
    const expect = (1000 / 1e6) * 0.07 + (200 / 1e6) * 0.27 + (500 / 1e6) * 1.10;
    assert.equal(p.costUsd, money(expect));

    // 3. A zero-token call is skipped entirely, so the ledger has no empty priced rows.
    written.length = 0;
    await budget.record(1, 'chair', { completionTokens: 0, promptCacheHitTokens: 0, promptCacheMissTokens: 0 }, { settings: priced() });
    assert.equal(written.length, 0);
  } finally {
    store.logEvent = realLog;
  }
});

test('★ spend() separates PRICED from UNPRICED from PRE-COST-ERA — none of them is zero', async () => {
  const store = require(path.join(__dirname, '..', 'trading', 'store'));
  const realList = store.listEvents;
  store.listEvents = async () => ([
    { payload: { consumer: 'chair', completionTokens: 100, promptTokens: 1000, promptCacheHitTokens: 900, promptCacheMissTokens: 100, costUsd: 0.5, pricingUsed: RATES } },
    { payload: { consumer: 'chair', completionTokens: 100, promptTokens: 1000, promptCacheHitTokens: 900, promptCacheMissTokens: 100, unpriced: true } },
    { payload: { consumer: 'review', completionTokens: 50, promptTokens: 500, promptCacheHitTokens: 500, promptCacheMissTokens: 0 } },
  ]);
  try {
    const s = await budget.spend(1);
    assert.equal(s.calls, 3);
    assert.equal(s.pricedCalls, 1);
    assert.equal(s.unpricedCalls, 1, 'a call written with no rate configured is counted, not ignored');
    assert.equal(s.preCostEraCalls, 1, 'a row written before the field existed is counted separately');
    assert.equal(s.costUsd, 0.5, 'only the priced call contributes money');
    // ★ The defect this guards: folding the other two into 0 would report an unpriced era as a cheap one.
    assert.equal(s.pricedCalls + s.unpricedCalls + s.preCostEraCalls, s.calls, 'every call is accounted for in exactly one bucket');
    assert.equal(s.totalTokens, 1000 + 100 + 1000 + 100 + 500 + 50);
    assert.ok(s.coverage && /NOT zero/.test(s.coverage.note));
  } finally {
    store.listEvents = realList;
  }
});

test('spend() reports saturation rather than presenting a clamped page as a total', async () => {
  const store = require(path.join(__dirname, '..', 'trading', 'store'));
  const realList = store.listEvents;
  // The TRD-77 shape: the store clamps to a cap, so a full page means "at least this", never "this".
  store.listEvents = async () => new Array(store.EVENT_QUERY_CAP || 500).fill({ payload: { consumer: 'chair', completionTokens: 1, promptTokens: 1 } });
  try {
    const s = await budget.spend(1);
    assert.equal(s.truncated, true, 'a saturated page must say so');
    assert.equal(s.fetched, s.cap);
  } finally {
    store.listEvents = realList;
  }
});
