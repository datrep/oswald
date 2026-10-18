// test/bundle-stable-first.test.js — S1 (2026-10-02): THE STABLE-FIRST ORDER IS A PROPERTY, NOT A LAYOUT TASTE.
//
// A prefix cache matches from byte zero and stops at the FIRST changed byte, so every per-wake value must sit
// after every byte-stable section — otherwise the reusable prefix collapses to whatever precedes the first live
// number (measured before this change: ~171 tokens of a ~9,300-token bundle). The report
// (docs/llm-cache-attribution-and-stable-first-2026-10-02.md §9.1) measured the payoff of this exact sequence
// (mean cross-wake prefix ~3,029 tokens over 15 consecutive wakes; ~110-135k tokens/day off the desk's miss).
//
// This file pins the ORDER that produces it, plus the two facts a future refactor could silently undo:
//   1. the live equity line is NOT inside the stable block, and
//   2. the most-frequently-changing stable member (closed trades) sits LAST in the block.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildBundle } = require('../trading/agent/promptBuilder');

const SETTINGS = {
  risk: {
    riskPerTradePct: 2, maxEquityPerPositionPct: 80, exposureCapPct: 100, maxPositions: 10,
    maxNewTradesPerDay: 20, reentryCooldownBars: 0, maxAdversePct: 0.3, takeProfitOffsetPct: 5,
    maxCostShareOfR: 0.65, maxAdverseCostMultiple: 1.5,
  },
};
const FACTS = { symbol: 'Gold', minimumUnits: 0.025, unitKind: 'Troy Ounces', fundingBuyPct: -0.0319, fundingSellPct: -0.012 };

const build = ({ account = { equity: 4117.85, available: 3900.11, margin: 217.74, pnl: -12.4 }, price = 4362.79, now = '2026-10-02T06:00:00Z' } = {}) => buildBundle({
  userId: 1, trigger: 'schedule', now: new Date(now),
  session: { state: 'open', detail: 'test', scheduledEvents: [] },
  quantResult: { symbols: [{ symbol: 'Gold', venue: 'plus500', status: 'ok', price, atr14: 9.35, adx14: 27, donchian: { lower: 4200, upper: 4400 }, signal: null, flat: 'no cross' }] },
  openTrades: [], closedTrades: [],
  digest: { bullets: ['digest bullet'] },
  proposal: { type: 'entry', direction: 'buy', symbol: 'Gold', basis: 'donchian20 breakout up' },
  alert: null, stale: false,
  pulse: { headline: 'Oil leads', sentiment: 'mixed', movers: [{ symbol: 'Oil', pct: 2.1, why: 'supply' }], drivers: ['OPEC'], risks: ['USD'], at: '2026-10-02T05:30:00Z' },
  meta: null, multi: null, congress: null,
  whitepaper: { weekly: { period: 'W40', text: 'weekly baseline text' } },
  proposals: [], userInput: null, prevOutcomes: null,
  venueCostFacts: { Gold: FACTS },
  settings: SETTINGS, account,
});

// The measured order (report §9.1, order A). Every stable marker must precede the volatile block, and the
// sequence within the stable block is the one measured to maximise the prefix (closed trades last).
const ORDER = [
  '--- RISK PARAMETERS',
  '--- VENUE COST OF CARRY',
  '--- MARKET WHITE PAPER',
  '--- MARKET PULSE',
  '--- DAILY DIGEST',
  '--- LAST 3 CLOSED TRADES',
  '--- ACCOUNT (live)',
  '--- MARKET SNAPSHOT',
  '--- INDICATORS',
  '--- BIG PICTURE',
  '--- ACTIVE POSITIONS',
  'PROPOSED ACTION by quant',
  '--- BUNDLE FOOTER',
];

test('★ every byte-stable section precedes the first per-wake byte, in the measured order', () => {
  const text = build();
  let prev = -1;
  for (const marker of ORDER) {
    const at = text.indexOf(marker);
    assert.ok(at >= 0, `missing section marker: ${marker}`);
    assert.ok(at > prev, `${marker} must come after the previous marker — the stable-first order is broken`);
    prev = at;
  }
});

test('★ with only per-wake values differing, the common prefix covers the whole stable block', () => {
  // a vs b differ ONLY in values that change every wake: equity, a snapshot price, and the footer timestamp.
  const a = build();
  const b = build({ account: { equity: 2222.22, available: 1, margin: 0, pnl: 99 }, price: 9999.99, now: '2026-10-02T06:07:00Z' });
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const acctAt = a.indexOf('--- ACCOUNT (live) ---');
  assert.ok(i >= acctAt,
    `the common prefix (${i}) must cover the stable block (live-account header at ${acctAt}) — a per-wake value`
    + ' leaked into the cacheable prefix');
  // Non-vacuity + placement: the divergence really is the equity line, and it happens before the snapshot.
  assert.ok(i < a.indexOf('--- MARKET SNAPSHOT'), 'the divergence must occur inside the volatile block, not later');
  assert.ok(/equity/.test(a.slice(Math.max(0, a.lastIndexOf('\n', i)), i)), 'the divergence is the equity digits');
  assert.notStrictEqual(a.slice(i, i + 24), b.slice(i, i + 24), 'the two bundles must really differ at that point');
});
