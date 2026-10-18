// test/price-provenance.test.js — TRD-PRC-1, 2026-09-14.
//
// Two things are pinned here, and the second one is the reason this file exists.
//
// 1. WHERE THE PRICE CAME FROM. The venue loop always computed the tick's age (it needed it
//    to decide freshness) but threw the timestamp away, then stamped `latest.capturedAt` with
//    the BAR's barStart. So the bundle printed a live tick beside bar-derived numbers with no
//    ages on either, and a chair comparing them found a "price conflict" that was really
//    staleness. `priceSource` / `priceAsOf` / `priceAgeSec` are the fix.
//
// 2. ★ WHICH VENUE'S TICK ACTUALLY GOT USED — a live defect found by adding (1).
//
//    The old loop, inline in a DB-bound function, was:
//        if (m > 0 && ageMs <= TICK_SLA_MS) { tickPx = m; }
//        if (tickPx == null && m > 0)        { tickPx = m; }   // accept ANY age
//        if (tickPx != null) break;                             // ...and STOP LOOKING
//
//    It broke out on the first tick of ANY age, so a dead venue feed priced the whole desk
//    while fresh provider ticks sat unread. Measured live 2026-09-14: plus500 ticks stopped at
//    11:10:27 UTC (2h26m), the shared page having left the trade view and tripped the UI
//    Fallback Pause. Gold was quoted at 4294.50 while yahoo said 4312.90 — 18.4 points, ATR14
//    12.03, i.e. 1.5x ATR — for 2.4 hours. The open Gold short #1037 read floatingPnl +4.56
//    when the true price put it ~11.6 down, and at the true price its own 2xATR trailing stop
//    (4305.97) is HIT.
//
//    The bridge's own contract (plus500/health.js) says the pause means "no new entries,
//    positions held, EXTERNAL (Binance/OKX) CAPTURE CONTINUES" — so falling through to a
//    fresh provider tick is what the desk already promised to do.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pickTick, TICK_SLA_MS } = require('../trading/agent/quant');

const MIN = 60000;
const at = (minsAgo) => new Date(Date.now() - minsAgo * MIN).toISOString();
const cand = (venue, mid, minsAgo) => ({ venue, mid, capturedAt: at(minsAgo), ageMs: minsAgo * MIN });

// --- the live defect, reproduced -------------------------------------------

test('★ a DEAD venue of record is NOT replaced by another venue\'s price', () => {
  // THE FIRST VERSION OF THIS FIX GOT THIS BACKWARDS, and live data caught it. It preferred
  // "a fresh tick from any venue" and selected YAHOO for Gold — 4312.90 — when the venue's own
  // live quote was 4268.35 and the stale plus500 tick was 4294.50. Yahoo sits 31 points off
  // binance/okx (which agree with each other and with the venue): its "Gold" is a DIFFERENT
  // INSTRUMENT. Substituting it flipped the open Gold short's trailing stop (4305.97) to a
  // false hit. A stale price of the right instrument beats a fresh price of the wrong one.
  const r = pickTick([
    cand('plus500', 4294.50, 146),
    cand('yahoo', 4312.90, 6),
    cand('binance', 4281.65, 2),
  ], { primary: 'plus500' });
  assert.strictEqual(r.venue, 'plus500', 'the venue of record supplies the executable price');
  assert.strictEqual(r.mid, 4294.50, 'a stale venue price must not be swapped for another instrument');
  assert.strictEqual(r.stale, true, 'but it MUST be flagged stale');
  assert.strictEqual(r.substituted, false, 'this is not a substitution — it is the right instrument');
});

test('★ the stale venue is still reported, so the outage stays attributable', () => {
  const r = pickTick([cand('plus500', 4294.50, 146), cand('yahoo', 4312.90, 6)], { primary: 'plus500' });
  assert.deepStrictEqual(r.staleVenues, [{ venue: 'plus500', ageMin: 146 }]);
  assert.match(r.reason, /older than the SLA/);
});

test('a fresh venue-of-record tick is used and not flagged', () => {
  const r = pickTick([cand('plus500', 4294.50, 1), cand('yahoo', 4312.90, 1)], { primary: 'plus500' });
  assert.strictEqual(r.venue, 'plus500');
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.substituted, false);
  assert.strictEqual(r.reason, null);
});

test('★ a SUBSTITUTE is used only when the venue of record has NO tick, and is labelled', () => {
  // The pre-existing fallback ("fresh tick mid (any venue)"), kept — but now a reader can tell
  // it apart from an executable price.
  const r = pickTick([cand('yahoo', 4312.90, 6), cand('binance', 4281.65, 2)], { primary: 'plus500' });
  assert.strictEqual(r.venue, 'yahoo', 'freshness decides among substitutes');
  assert.strictEqual(r.substituted, true, 'a substituted price MUST be flagged');
  assert.strictEqual(r.stale, false, 'the substitute itself was fresh');
  assert.match(r.reason, /no tick from the venue of record/);
});

test('among substitutes, a fresh one beats a stale one', () => {
  const r = pickTick([cand('yahoo', 4312.90, 146), cand('binance', 4281.65, 2)], { primary: 'plus500' });
  assert.strictEqual(r.venue, 'binance');
  assert.strictEqual(r.substituted, true);
});

test('among stale substitutes the LEAST stale wins, and it is flagged both ways', () => {
  const r = pickTick([cand('yahoo', 4312.90, 146), cand('binance', 4281.65, 20)], { primary: 'plus500' });
  assert.strictEqual(r.venue, 'binance');
  assert.strictEqual(r.substituted, true);
  assert.strictEqual(r.stale, true);
});

test('a stale venue-of-record tick beats a FRESH substitute — staleness is not a licence to swap', () => {
  // This is the assertion that would have caught the first, wrong version of the fix.
  const r = pickTick([cand('plus500', 4294.50, 146), cand('yahoo', 4312.90, 1)], { primary: 'plus500' });
  assert.strictEqual(r.venue, 'plus500');
});

test('the SLA boundary is inclusive', () => {
  const exact = pickTick([cand('plus500', 100, TICK_SLA_MS / MIN)], { primary: 'plus500' });
  assert.strictEqual(exact.stale, false, 'exactly at the SLA is still fresh');
  const over = pickTick([cand('plus500', 100, TICK_SLA_MS / MIN + 0.01)], { primary: 'plus500' });
  assert.strictEqual(over.stale, true);
});

test('with no venue of record named, freshness decides (the pure-function contract)', () => {
  const r = pickTick([cand('plus500', 4294.50, 146), cand('yahoo', 4312.90, 6)]);
  assert.strictEqual(r.venue, 'yahoo');
  assert.strictEqual(r.substituted, false, 'nothing was substituted — no primary was declared');
});

// --- degenerate input --------------------------------------------------------

test('no candidates yields no price rather than a zero', () => {
  const r = pickTick([], { primary: 'plus500' });
  assert.strictEqual(r.mid, null);
  assert.strictEqual(r.venue, null);
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.substituted, false);
  assert.deepStrictEqual(r.staleVenues, []);
  assert.match(r.reason, /no tick from any venue/);
});

test('a non-positive mid is not a price', () => {
  // mid() returns 0 for a tick with no sides; treating 0 as a price would quote zero.
  const r = pickTick([cand('plus500', 0, 1), cand('yahoo', 4312.90, 6)], { primary: 'plus500' });
  assert.strictEqual(r.venue, 'yahoo');
  assert.strictEqual(r.substituted, true, 'the venue of record had no usable price');
});

test('an unparseable age is treated as infinitely stale, not as fresh', () => {
  // A NaN age must not sneak through `ageMs <= slaMs` (NaN comparisons are false).
  const r = pickTick([{ venue: 'plus500', mid: 7, capturedAt: null, ageMs: NaN }], { primary: 'plus500' });
  assert.strictEqual(r.stale, true, 'an unusable age falls back to stale, flagged');
  assert.strictEqual(r.mid, 7);
  assert.strictEqual(r.substituted, false);
});

test('the SLA constant is the documented 15 minutes', () => {
  assert.strictEqual(TICK_SLA_MS, 15 * 60000);
});

// --- provenance fields on the snapshot (structural: evaluateSymbol needs the DB) ---

test('the snapshot renamed the lying field and added the provenance set', () => {
  const { code } = require('./_source');
  const src = code('trading/agent/quant.js');
  // `tickAgeSec` held the BAR's age under a name that said tick — that name must be gone.
  assert.ok(!/tickAgeSec/.test(src), 'tickAgeSec (which actually held the bar age) must not return');
  assert.match(src, /barAgeSec/, 'the bar age must travel under an honest name');
  for (const f of ['priceSource', 'priceAsOf', 'priceAgeSec', 'priceVenue', 'priceTickStale', 'priceStaleVenues']) {
    assert.match(src, new RegExp(`${f}`), `the snapshot must carry ${f}`);
  }
  assert.match(src, /prevPriceSource: 'bar_close'/, 'prevPrice is ALWAYS a bar close — say so');
});

test('nothing still reads the removed field', () => {
  const { code } = require('./_source');
  for (const f of ['trading/agent/context.js', 'trading/agent/promptBuilder.js', 'trading/public/js/app.js']) {
    assert.ok(!/tickAgeSec/.test(code(f)), `${f} still reads the removed tickAgeSec`);
  }
});
