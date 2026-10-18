'use strict';
// TRD-89 (2026-09-18): the rsi2 overbought fade is off by default, and the regime gate fails CLOSED.
//
// Evidence that produced this: 18/09, rsi2 opened thirteen Bitcoin shorts in 4.5 hours — 2 wins,
// -14.19, average hold 20.5 minutes. Each was closed by the review loop (4ms after the close event
// the verdict reads "strong bullish trend, price above MAs, Aroon up 100, short thesis broken"), and
// the next wake re-entered. The protective gate had said 'range' on 30 of 32 wakes.
//
// Two defects, both pinned here:
//   1. The SHORT arm is not the canonical rule (Connors RSI-2 is a long-only dip-buy inside an
//      uptrend) and it is the arm that churns.
//   2. quant's regime gate read `opts.regime && opts.regime !== 'range'`, so a NULL regime — what
//      wakePipeline passes when the meta engine is unavailable — short-circuited it and PERMITTED the
//      fade. The desk was most permissive exactly when it knew least.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rsi2 = require('../trading/agent/strategies/rsi2');

const rising = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];  // RSI(2) -> 100 (extreme HIGH)
const falling = [109, 108, 107, 106, 105, 104, 103, 102, 101, 100]; // RSI(2) -> 0   (extreme LOW)

test('the short arm is OFF by default — the overbought fade does not fire', () => {
  const r = rsi2.liveSignal({ closes: rising, params: {} });
  assert.equal(r.type, null);
  assert.equal(r.suppressed, 'short_disabled', 'a suppressed setup must SAY it was suppressed, not read as "no setup"');
  assert.ok(r.rsi2.rsi2 > 90, `the setup really was extreme (rsi2=${r.rsi2.rsi2}) — the arm is off, not the trigger`);
});

test('the suppression is named, so it cannot be mistaken for an absence of signal', () => {
  const r = rsi2.liveSignal({ closes: rising, params: {} });
  assert.notEqual(r.suppressed, undefined);
  assert.notEqual(r.suppressed, null);
  assert.equal(typeof r.suppressed, 'string');
});

test('the LONG arm is untouched — the canonical dip-buy still fires', () => {
  const r = rsi2.liveSignal({ closes: falling, params: {} });
  assert.equal(r.type, 'entry');
  assert.equal(r.direction, 'buy');
  assert.match(r.basis, /stretched down/);
});

test('allowShort restores the symmetric fade when an owner asks for it', () => {
  const r = rsi2.liveSignal({ closes: rising, params: { allowShort: true } });
  assert.equal(r.type, 'entry');
  assert.equal(r.direction, 'sell');
  assert.match(r.basis, /stretched up/);
  assert.equal(r.suppressed, undefined, 'an allowed short is not a suppression');
});

test('the bool param is read as a bool, not through Number()', () => {
  const on = rsi2.liveSignal({ closes: rising, params: { allowShort: 'true' } });
  assert.equal(on.direction, 'sell', "a form that posts the string 'true' must be honoured");
  const off = rsi2.liveSignal({ closes: rising, params: { allowShort: 'false' } });
  assert.equal(off.type, null, "the string 'false' must NOT read as truthy");
  assert.equal(off.suppressed, 'short_disabled');
  // and a falsy-but-present value must not fall through to the default in a surprising way
  assert.equal(rsi2.liveSignal({ closes: rising, params: { allowShort: 0 } }).type, null);
});

test('an exit still beats the entry arms, and is unaffected by allowShort', () => {
  const open = { direction: 'sell', peak: 110, trough: 100 };
  // price (109) is ABOVE the SMA5 for a short, so the exit rule does not fire; the short arm does not
  // fire either because it is off — an exit-capable call must not be blocked by a param about entries.
  const noExit = rsi2.liveSignal({ closes: rising, params: {}, openTrade: open });
  assert.equal(noExit.suppressed, 'short_disabled');
});

test('quant gates mean-reversion on a POSITIVE range verdict (regression: the fail-open guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'quant.js'), 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.includes("id === 'meanrev' || id === 'rsi2'"));
  assert.ok(line, 'the mean-reversion regime gate is gone — rsi2 would now fade in any regime');
  assert.match(line, /opts\.regime !== 'range'/, `the gate must require 'range' positively, got: ${line.trim()}`);
  assert.doesNotMatch(
    line,
    /opts\.regime &&/,
    'REGRESSION: `opts.regime &&` lets a NULL regime (meta unavailable) through — that is the fail-open hole that produced 13 churned entries'
  );
  // and the reason a null is reachable at all, stated where it happens
  const wp = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'wakePipeline.js'), 'utf8');
  assert.match(wp, /regime: null/, 'wakePipeline no longer passes a null regime — re-check this pin');
});

test('squeezerev is deliberately NOT in the outer gate — it self-gates', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'quant.js'), 'utf8');
  const line = src.split(/\r?\n/).find((l) => l.includes("id === 'meanrev' || id === 'rsi2'"));
  assert.doesNotMatch(line, /squeezerev/, 'squeezerev applies its own bar-causal regime check; gating it twice hides which gate refused');
  const sq = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'strategies', 'squeezeMeanRev.js'), 'utf8');
  assert.match(sq, /regime/, 'squeezerev no longer mentions a regime — the exclusion above is now wrong');
});

test('the rsi2 params expose allowShort to the UI, defaulting to the tested rule', () => {
  const p = rsi2.params.find((x) => x.key === 'allowShort');
  assert.ok(p, 'allowShort is not declared — the owner could not reverse this decision from the Strategy tab');
  assert.equal(p.type, 'bool');
  assert.equal(p.def, false, 'the default must be the rule with evidence behind it, not the one without');
  assert.equal(rsi2.DEFAULTS.allowShort, false);
});
