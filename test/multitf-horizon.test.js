// test/multitf-horizon.test.js — 2026-09-13: the multi-timeframe "chg" horizon.
//
// DEFECT. `multiTfSnapshot` computes chgPct as (last - first) / first over a FIXED
// 120-BAR lookback (limit: 120), then the prompt prints it beside the timeframe
// label: `5m: 99.20 (...) chg=-4.597%`. The horizon of that number is whatever the
// stored series spans, NOT the bar length of `tf`.
//
// EVIDENCE. On 2026-09-11 15:24 the `5m` row read chg=-4.597%, which reconciles to a
// first price of ~103.98 — Oil's level at 2026-09-10 23:35, about 16 HOURS earlier.
// The same code with the same limit reached back only ~10 hours the next day
// (chg=-2.18%). The true 5-minute move at that moment was -0.21%. Chairs read the
// 16-hour drift as a 5-minute flush and cited it to justify two exits.
//
// The fixture below reproduces that exact contradiction — chg ~= -4.597% over ~16h,
// last1 ~= -0.21% — and pins that the span is published and distinguishable.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const store = require('../trading/store');
const { multiTfSnapshot } = require('../trading/agent/quant');
const { buildBundle } = require('../trading/agent/promptBuilder');

// 120 bars at 8-minute spacing = 952 minutes = ~15.87h. A gap-ridden series is
// exactly how `limit: 120` produced a 16-hour horizon under a "5m" label.
function fiveMinRows({ spacingMin = 8, first = 103.98, last = 99.2, prev = 99.41, n = 120 } = {}) {
  const rows = [];
  const t0 = Date.UTC(2026, 8, 10, 23, 35, 0); // 2026-09-10 23:35 — the observed window start
  for (let i = 0; i < n; i++) {
    const c = i === 0 ? first : (i === n - 1 ? last : first + (prev - first) * (i / (n - 2)));
    rows.push({
      barStart: new Date(t0 + i * spacingMin * 60000).toISOString(),
      openPrice: c, high: c + 0.05, low: c - 0.05,
      closePrice: i === n - 2 ? prev : c,
    });
  }
  return rows;
}

let restore = null;
const stub = (rows) => {
  const orig = store.listBars;
  store.listBars = async () => rows;
  restore = () => { store.listBars = orig; };
};

test('the span behind chgPct is published, and is NOT the bar length (the -4.597% case)', async () => {
  stub(fiveMinRows());
  try {
    const rows = await multiTfSnapshot(1, 'Oil');
    const r = rows.find((x) => x.tf === '5m');
    assert.ok(r, 'a 5m row must be produced');

    assert.strictEqual(r.bars, 120, 'the lookback is a fixed BAR COUNT');
    assert.strictEqual(r.chgPct, -4.597, 'reproduces the value the chairs were given');

    // The whole point: 120 bars is ~16 hours here, not five minutes.
    assert.strictEqual(r.spanHours, 15.8667, 'the real horizon is published');
    assert.ok(r.spanHours > 10, 'a fixed bar count can span many hours — never assume the bar length');

    // And the true one-bar change is available, so a drift cannot impersonate a flush.
    assert.strictEqual(r.chgLast1Pct, -0.2112, 'true one-bar (5m) change');
    assert.notStrictEqual(r.chgPct, r.chgLast1Pct);
    assert.ok(Math.abs(r.chgPct) > 20 * Math.abs(r.chgLast1Pct), 'the lookback change dwarfs the real bar move');
  } finally { restore(); }
});

test('the same bar count with dense bars yields a short span (horizon is data-dependent)', async () => {
  stub(fiveMinRows({ spacingMin: 5 })); // true 5m cadence: 119 x 5m = 9.9167h
  try {
    const r = (await multiTfSnapshot(1, 'Oil')).find((x) => x.tf === '5m');
    assert.strictEqual(r.spanHours, 9.9167);
    assert.notStrictEqual(r.spanHours, 15.8667, 'identical code, different horizon — hence the label must carry the span');
  } finally { restore(); }
});

test('the prompt states the horizon and never presents chg as a one-bar move', () => {
  const quantResult = {
    symbols: [{
      symbol: 'Oil', venue: 'plus500', status: 'ok', price: 99.2, atr14: 0.7, adx14: 20,
      donchian: null, signal: null, flat: 'no cross', tickCount: 100,
      bigPicture: [{ tf: '5m', venue: 'yahoo', bars: 120, last: 99.2, chgPct: -4.597, spanHours: 15.8667, chgLast1Pct: -0.2112, adx14: 20.6, dc20: { lower: 99, upper: 101 }, pos: 'inside' }],
    }],
  };
  const text = buildBundle({
    trigger: 'schedule', now: new Date('2026-09-11T15:24:00Z'),
    session: { state: 'open', detail: 'market open' }, quantResult,
    openTrades: [], closedTrades: [],
  });

  assert.match(text, /chg=-4\.597% \(over 15\.8667h\)/, 'the span is printed next to the change');
  assert.match(text, /last1=-0\.2112%/, 'the true one-bar change is printed');
  assert.match(text, /NOT one bar/, 'the section warns that chg is a 120-bar lookback');
  assert.doesNotMatch(text, /chg=-4\.597% \|/, 'chg is never printed bare beside the tf label');
});

// --- TRD-78(a): the head must be CONSTANT, or no prefix can ever be cached (added 2026-09-20) --------
//
// Measured from the desk's own stored bundles: the common prefix between consecutive wakes was a mean of
// **44 characters out of ~51,000** (166 pairs, range 23-54), because `Trigger:` and `Generated:` sat on
// line 2. A prefix cache matches from byte zero, so a per-wake timestamp at character ~45 guaranteed that
// nothing after it could be reused. The model reads the whole bundle, so the timestamp costs it nothing at
// the end — and this test is the difference between "we moved it" and "the head can no longer vary".

test('★ the bundle head is identical across wakes — the timestamp and trigger live at the tail', () => {
  const mk = (now, trigger) => buildBundle({
    trigger, now: new Date(now),
    session: { state: 'open', detail: 'market open' },
    quantResult: { symbols: [] },
    openTrades: [], closedTrades: [],
  });
  const a = mk('2026-09-19T16:30:00Z', 'schedule');
  const b = mk('2026-09-19T16:41:00Z', 'micro');

  const head = (t) => t.slice(0, 120);
  assert.strictEqual(head(a), head(b), 'two wakes must share their opening bytes, or nothing after them can cache');
  assert.strictEqual(a.slice(0, 44), b.slice(0, 44), 'the old shape broke the match at ~44 characters');

  // The volatile facts must still BE there — moving them is not dropping them.
  assert.match(a, /Generated: 2026-09-19T16:30:00\.000Z/);
  assert.match(a, /Trigger: schedule/);
  assert.match(b, /Trigger: micro/);
  assert.ok(a.lastIndexOf('Generated:') > a.length * 0.9, 'and they must be at the very end, where a later fix cannot reintroduce the old shape');
  assert.doesNotMatch(head(a), /Generated:|Trigger:/, 'the head must carry neither');
});

