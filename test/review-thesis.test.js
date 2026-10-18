'use strict';
// TRD-89 remainder (2026-09-18): the exit reviewer judged every position as a trend trade.
//
// Evidence that produced this: thirteen rsi2 positions closed inside one session, each reason reading
// like a trend verdict — "Strong bullish trend (price above MAs, overbought RSI/Stoch, Aroon up 100)
// breaks the short thesis" — while the strategy's premise is that an EXTREME FADES. The condition the
// reviewer called a break was the condition that opened the trade. Two components with opposite theses
// were both acting, and the reviewer's was the one that got to close.
//
// The fix: a strategy declares how its own positions must be judged, and the reviewer is told to use
// that thesis instead of a generic trend reading.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strategies = require('../trading/agent/strategies');

const MEAN_REVERSION = ['rsi2', 'meanrev', 'squeezerev'];

test('every mean-reversion strategy declares an exit thesis', () => {
  for (const id of MEAN_REVERSION) {
    const s = strategies.get(id);
    assert.ok(s, `${id} is not registered`);
    assert.equal(typeof s.exitThesis, 'string', `${id} has no exitThesis — the reviewer would judge it as a trend trade`);
    assert.ok(s.exitThesis.length > 80, `${id}'s exitThesis is too thin to change a verdict`);
  }
});

test('the thesis says the thing that was missing: against-the-move is the ENTRY, not a break', () => {
  for (const id of MEAN_REVERSION) {
    const t = strategies.get(id).exitThesis.toUpperCase();
    assert.match(t, /ENTRY CONDITION/, `${id}: the thesis must say that price continuing against the position is the entry condition`);
    assert.match(t, /MEAN REVERSION|SQUEEZE MEAN REVERSION/, `${id}: the thesis must name its own family`);
  }
});

test('the thesis reaches the reviewer through get(), which is the call the review loop makes', () => {
  // review.js does `require('./strategies').get(t.strategyId)` and reads `.exitThesis`; this asserts the
  // registry really serves it rather than relying on the module being required directly.
  for (const id of MEAN_REVERSION) {
    assert.equal(strategies.get(id).exitThesis, require(`../trading/agent/strategies/${id === 'squeezerev' ? 'squeezeMeanRev' : id}`).exitThesis);
  }
  assert.equal(strategies.get('nope-does-not-exist'), null, 'an unknown id must be null so the caller can state a fallback');
});

test('the reviewer builds its context from the strategy, and names a fallback when there is none', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'review.js'), 'utf8');
  assert.match(src, /require\('\.\/strategies'\)\.get\(t\.strategyId\)/, 'the review context must look the strategy up');
  assert.match(src, /strat\.exitThesis/, 'the declared thesis must be used');
  assert.match(src, /`EXIT THESIS \(/, 'the thesis must be labelled in the context so the chair knows what it is reading');
  // both absences must be stated, never silent — an unlabelled absence is the F32 defect class
  assert.match(src, /No exit thesis is declared for this strategy/, 'an unknown strategy must state its fallback');
  assert.match(src, /none recorded on this position/, 'a position with no strategyId must state its fallback');
});

test('the system prompt no longer equates a broken exit with a broken TREND', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'review.js'), 'utf8');
  const sys = src.split(/\r?\n/).find((l) => l.includes('You are the exit-review chair'));
  assert.ok(sys, 'the reviewer system prompt is gone');
  assert.doesNotMatch(
    sys,
    /the trend is broken/,
    'REGRESSION: a generic "trend is broken" instruction is what closed thirteen mean-reversion positions'
  );
  assert.match(sys, /THESIS/, 'the prompt must frame the exit around the position thesis');
  assert.match(sys, /mean-reversion position is SUPPOSED to be on the other side/, 'the prompt must name the category error explicitly');
});

test('trend strategies are NOT forced to declare a thesis — the requirement is family-specific', () => {
  // If this ever passes trivially, the test above has stopped meaning anything: a thesis on a trend
  // strategy would be a different sentence, not evidence about the mean-reversion fix.
  const trend = strategies.get('turtle');
  assert.ok(trend, 'turtle is not registered');
  assert.equal(trend.exitThesis, undefined, 'turtle declaring a mean-reversion thesis would mean this pin is misfiring');
});
