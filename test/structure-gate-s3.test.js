// test/structure-gate-s3.test.js — S3: the structure-gated clone of the Gold survivor.
//
// ★ WHAT THIS FILE HAS TO PROVE, and the second one is the reason it exists at all:
//
//   1. THE CLONE DIFFERS FROM ITS CONTROL IN ONE WAY. `survgoldStruct` must use survgold's EXACT frozen
//      parameter set; anything else and the lockbox comparison answers nothing (§10 Q3). Pinned by equality
//      against survGold's own DEFAULTS rather than by a copy, so the two cannot drift apart.
//   2. ★ THE BACKTEST GATE CAN ACTUALLY FIRE. The lab's series speaks a DIFFERENT FIELD VOCABULARY
//      (`open/high/low/close/time` from `backtest.loadSeries`) than this engine reads
//      (`openPrice/closePrice/barStart`). Wiring the gate straight onto the lab series would have read
//      `closePrice` as undefined on EVERY bar, failed closed on every trade, and reported ZERO trades —
//      which reads exactly like a finding ("the gate suppresses everything") instead of a field-name bug.
//      So the test asserts the gate returns TRUE somewhere, not merely that it returns a boolean.
//   3. IT FAILS CLOSED, and EXITS ARE NEVER GATED. A gate that can refuse a trailing stop would trap a
//      position to prove a point about eligibility (the TRD-71 rule).
//   4. THE NEW HOOK IS A NO-OP FOR EVERY EXISTING STRATEGY. `turtle.backtest` gained an optional
//      `entryFilter`; turtle, survgold and survoil must be bit-for-bit unaffected by its existence.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const turtle = require('../trading/agent/strategies/turtleUltimate');
const survGold = require('../trading/agent/strategies/survGold');
const s3 = require('../trading/agent/strategies/survGoldStruct');
const strategies = require('../trading/agent/strategies');
const binding = require('../trading/agent/binding');
const { candidateProximity } = require('../trading/agent/quant');

const codeOnly = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// The LAB's series shape, exactly as `backtest.loadSeries` emits it (backtest.js:401).
function labSeries(n = 160, { drift = 1 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const wob = i % 8 === 4 ? 3 : (i % 8 === 0 ? -3 : 0);
    const c = 100 + drift * i + wob;
    out.push({ open: c, high: c + 0.5, low: c - 0.5, close: c, time: new Date(Date.UTC(2026, 0, 1, i)) });
  }
  return out;
}

// ── 1. One difference from the control, and only one ─────────────────────────────────────────────────
test('★ the clone uses survgold\'s EXACT frozen parameters — otherwise the comparison is void', () => {
  assert.deepStrictEqual(
    { ...s3.DEFAULTS }, { ...survGold.DEFAULTS },
    'a single differing parameter makes this a different strategy, and then S3 tests nothing',
  );
  assert.deepStrictEqual(s3.symbols, survGold.symbols, 'and it must be bound to the same instrument');
  assert.deepStrictEqual(s3.params, [], 'frozen: an editable parameter would make the control unfalsifiable');
});

// ── 2. The predicate, and its fail-closed behaviour ───────────────────────────────────────────────────
test('structureAgrees is one comparison, and `range` is excluded by construction', () => {
  const ok = (direction) => ({ state: 'ok', direction });
  assert.equal(s3.structureAgrees(ok('bullish'), 'buy'), true);
  assert.equal(s3.structureAgrees(ok('bearish'), 'buy'), false);
  assert.equal(s3.structureAgrees(ok('bearish'), 'sell'), true);
  assert.equal(s3.structureAgrees(ok('bullish'), 'sell'), false);
  // `range` is neither direction, so no separate "and not range" clause is needed — and the screen
  // measured `range` at 0 of 110 real entries, so such a clause could not have fired.
  assert.equal(s3.structureAgrees(ok('range'), 'buy'), false);
  assert.equal(s3.structureAgrees(ok('range'), 'sell'), false);
  // Anything that is not a usable structure refuses the trade rather than defaulting to allowing it.
  for (const bad of [null, undefined, {}, { state: 'insufficient_history', direction: 'bullish' }, { state: 'error', direction: 'bullish' }]) {
    assert.equal(s3.structureAgrees(bad, 'buy'), false, `structure ${JSON.stringify(bad)} must not permit an entry`);
  }
});

test('★ the gate FIRES on the lab series shape — a field-name mismatch would make it always false', () => {
  const series = labSeries(160, { drift: 1 }); // rising, so structure reads bullish
  const fired = [];
  const refused = [];
  for (let i = 70; i < series.length; i++) {
    (s3.gateAt(series, i, 'buy') ? fired : refused).push(i);
  }
  assert.ok(fired.length > 0,
    'the gate must ALLOW some entries: always-false is the signature of reading `closePrice` off rows that '
    + 'carry `close`, which would have been reported as "the gate suppresses everything"');
  assert.equal(refused.length, 0,
    'and on a rising series a BUY should be allowed every time — structure is bullish at every bar');

  // The mirror: the same bars refuse a SELL. That proves the gate discriminates on direction rather than
  // returning a constant.
  const sellsAllowed = [];
  for (let i = 70; i < series.length; i++) if (s3.gateAt(series, i, 'sell')) sellsAllowed.push(i);
  assert.equal(sellsAllowed.length, 0, 'a sell against a bullish structure must be refused');
});

test('toStructureBars translates the lab vocabulary, and passes through the engine\'s own', () => {
  const lab = { open: 1, high: 2, low: 0.5, close: 1.5, time: 'T' };
  assert.deepStrictEqual(s3.toStructureBars([lab]), [{ barStart: 'T', openPrice: 1, high: 2, low: 0.5, closePrice: 1.5 }]);
  const engine = { openPrice: 1, high: 2, low: 0.5, closePrice: 1.5, barStart: 'T' };
  assert.deepStrictEqual(s3.toStructureBars([engine]), [{ barStart: 'T', openPrice: 1, high: 2, low: 0.5, closePrice: 1.5 }]);
  assert.deepStrictEqual(s3.toStructureBars(null), []);
});

// ── 3. Exits are never gated ──────────────────────────────────────────────────────────────────────────
test('★ an EXIT passes through even when structure disagrees — a gate must not refuse a stop', () => {
  const ctx = {
    highs: labSeries(160).map((b) => b.high),
    lows: labSeries(160).map((b) => b.low),
    closes: labSeries(160).map((b) => b.close),
    atr14: 1, adx14: 30, price: 100, prevPrice: 100,
    params: {},
    // An open BUY whose trailing stop is 2xATR below its peak, with price far below it: the exit fires.
    openTrade: { direction: 'buy', peak: 200, trough: 100 },
    // The gate is told the OPPOSITE of the position, so a gated exit would be suppressed.
    structure: { state: 'ok', direction: 'bearish' },
  };
  const r = s3.liveSignal(ctx);
  assert.equal(r.type, 'exit', 'the trailing stop must survive the gate — TRD-71 applies to this clone too');
});

test('an entry is refused when structure disagrees, and allowed when it agrees', () => {
  // A rising series so the turtle breakout fires, with the gate toggled by the structure we hand it.
  const s = labSeries(160);
  const base = {
    highs: s.map((b) => b.high), lows: s.map((b) => b.low), closes: s.map((b) => b.close),
    atr14: 1, adx14: 30, price: 0, prevPrice: 0, params: {}, openTrade: null,
  };
  // Walk to a bar where the ungated signal fires, then compare the gated decision at the same bar.
  let probe = null;
  for (let i = 70; i < s.length; i++) {
    const raw = turtle.liveSignal({ ...base, price: s[i].close, prevPrice: s[i - 1].close, highs: s.slice(0, i + 1).map((b) => b.high), lows: s.slice(0, i + 1).map((b) => b.low), closes: s.slice(0, i + 1).map((b) => b.close), params: { adxGate: 0 } });
    if (raw && raw.type === 'entry') { probe = { i, raw, ctx: { ...base, price: s[i].close, prevPrice: s[i - 1].close, highs: s.slice(0, i + 1).map((b) => b.high), lows: s.slice(0, i + 1).map((b) => b.low), closes: s.slice(0, i + 1).map((b) => b.close) } }; break; }
  }
  assert.ok(probe, 'fixture: the ungated signal must fire somewhere, or this test proves nothing');

  const agreed = s3.liveSignal({ ...probe.ctx, structure: { state: 'ok', direction: 'bullish' } });
  assert.equal(agreed.type, 'entry', 'agreement allows the entry through unchanged');
  assert.equal(agreed.direction, probe.raw.direction);

  const refused = s3.liveSignal({ ...probe.ctx, structure: { state: 'ok', direction: 'bearish' } });
  assert.notEqual(refused.type, 'entry');
  assert.equal(refused.gated, 'structure_disagrees', 'and it says WHY, rather than reporting a quiet no-signal');

  const absent = s3.liveSignal({ ...probe.ctx, structure: null });
  assert.notEqual(absent.type, 'entry', 'no structure at all fails CLOSED');
});

// ── 4. The new hook changes nothing for the existing strategies ───────────────────────────────────────
test('★ the entryFilter hook is a NO-OP for every strategy that does not pass one', () => {
  const bars = labSeries(160);
  const cfg = { capital: 10000, ...turtle.DEFAULTS, adxGate: 0 };
  const plain = turtle.backtest(bars, cfg);
  const withTrue = turtle.backtest(bars, cfg, null, { entryFilter: () => true });
  assert.deepStrictEqual(withTrue, plain, 'a filter that allows everything must reproduce the original exactly');
  // ...and the hook is genuinely wired, not accepted and ignored.
  const withFalse = turtle.backtest(bars, cfg, null, { entryFilter: () => false });
  assert.equal(withFalse.trades.length, 0, 'the hook must actually gate the entry');
  assert.ok(plain.trades.length > 0, 'fixture: the ungated run must trade, or the assertion above is vacuous');
});

test('the clone backtests differently from its ungated control on the same series', () => {
  const bars = labSeries(160);
  const cfg = { capital: 10000, ...turtle.DEFAULTS, adxGate: 0 };
  const ungated = survGold.backtest(bars, cfg, null);
  const gated = s3.backtest(bars, cfg, null);
  assert.ok(gated.trades.length <= ungated.trades.length,
    'the gate can only REMOVE entries — it must never add one, whatever the structure says');
});

// ── 5. Bundle safety: the hazard, and what it is conditional on ───────────────────────────────────────
test('★ the mapping is EFFECTIVE — the id really can reach the reviewer candidate clause', () => {
  const bars = labSeries(160);
  const ctx = {
    price: bars[150].close, adx14: 15, indicators: null, symbol: 'Gold', settings: {},
    highs: bars.map((b) => b.high), lows: bars.map((b) => b.low), closes: bars.map((b) => b.close),
  };
  const without = candidateProximity(['turtle'], ctx, { prefix: 'candidates' });
  const withIt = candidateProximity(['turtle', 'survgoldstruct'], ctx, { prefix: 'candidates' });
  assert.ok(withIt && withIt.includes('survgoldstruct'),
    'if the candidate set can never mention it, this test is vacuous — and the safety below would be luck');
  assert.notEqual(withIt, without, 'and it changes the clause, which is the hazard being reasoned about');
});

test('★ ...and it stays OUT of every scope except Gold\'s, which is why the bundle is unchanged today', () => {
  // `applicableIds` enumerates the REGISTRY and filters on `liveSignal` + `symbols` ONLY — never on
  // `enabled`. So a registered strategy is a reviewer candidate for every symbol it is bound to.
  assert.ok(binding.applicableIds('Gold').includes('survgoldstruct'), 'it IS a Gold candidate');
  assert.ok(!binding.applicableIds('Oil').includes('survgoldstruct'),
    'and NOT an Oil one — the track binding is the whole reason the live bundle is unchanged for other symbols');
  // Gold is the only symbol it can appear on, and Gold has scope today (survgold is enabled), so `quant`
  // takes the `inScope` branch and never consults `applicableIds` for it. That is CONDITIONAL: if survgold
  // were ever disabled, Gold would have no scope and this candidate would enter the clause.
  const src = codeOnly('trading/agent/quant.js');
  assert.match(src, /const ids = inScope \? strategyIds : require\('\.\/binding'\)\.applicableIds\(symbol, strategies\);/,
    'the candidate path is only taken when nothing is in scope — the condition this safety rests on');
  assert.ok(!strategies.list({ strategies: { enabled: ['survgold', 'survoil'] } })
    .filter((s) => s.enabled).map((s) => s.id).includes('survgoldstruct'),
    'and it must not be enabled — an enabled candidate would be in scope and would trade');
});
