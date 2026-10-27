// test/atr-stop-multiple-wiring.test.js — 2026-10-18: a settings dial that nothing read.
//
// THE DEFECT THIS PINS. `risk.atrStopMultiple` has been in `TradingSettings.risk` (value 2) since the schema,
// and `risk.js` hard-coded `2 * atrV` for the stop distance. So the one setting a reader would reach for to
// change stop width did nothing, while looking exactly like the dial that decides it.
//
// WHY THAT IS WORTH A TEST AND NOT JUST A FIX. Measured 2026-10-19 across 17,868 historical breakouts, stop
// width is the largest lever the desk has: mean net R improves monotonically from -0.105 at 2xATR to -0.017 at
// 8xATR, because cost-in-R = spread% / stop% and widening the stop is the only term that shrinks. A dead dial
// on exactly that quantity is worse than no dial: it invites an owner (or an agent) to "make the change" and
// record an era boundary for a setting that cannot alter a single decision.
//
// The assertions are deliberately split: one that the setting is READ, one that the literal is GONE, and one
// that the diagnostic beside it cannot drift from the decision it describes. The last one is the class of bug
// this file has already met twice (`baseSize` re-spelling the product with a different denominator).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RISK = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'risk.js'), 'utf8');

test('★ risk.atrStopMultiple is READ, with 2 as the fallback rather than as the rule', () => {
  assert.match(RISK, /const atrMultiple = Number\(risk\.atrStopMultiple\) > 0 \? Number\(risk\.atrStopMultiple\) : 2/,
    'the stop multiple must come from settings, defaulting to 2 when absent/invalid/non-positive');
  assert.match(RISK, /Math\.max\(atrMultiple \* atrV, minN \* spread\)/,
    'the spread floor and the ATR stop must be compared using the SAME multiple');
});

test('★ the hard-coded 2xATR stop is gone from the sizing path', () => {
  // `2 * atrV` may survive in comments (it is quoted there on purpose), but never as the arithmetic.
  const codeLines = RISK.split(/\r?\n/).filter((l) => !l.trim().startsWith('//'));
  const offenders = codeLines.filter((l) => /(Math\.max\(|:\s*)\s*2 \* atrV/.test(l));
  assert.deepStrictEqual(offenders, [],
    `the stop distance must not be hard-coded to 2xATR: ${JSON.stringify(offenders)}`);
});

test('★ the baseSize diagnostic reads the same multiple as the decision it describes', () => {
  assert.match(RISK, /baseSize: Math\.round\(sizeForRisk\(Number\(risk\.riskPerTradePct \?\? 1\) \/ 100, atrMultiple \* atrV\)/,
    'baseSize must use atrMultiple — two denominators for one quantity is the defect this repo keeps meeting');
  assert.ok(!/baseSize: Math\.round\(sizeForRisk\([^)]*2 \* atrV\)/.test(RISK),
    'baseSize must not re-derive the stop with a literal 2xATR');
});

test('★ the widening reason names the multiple it actually used', () => {
  assert.match(RISK, /\$\{atrMultiple\}xATR/,
    'the "stop widened" reason must report the configured multiple, not a hard-coded 2');
});
