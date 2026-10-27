// ★★ TRD-EXE-19 (2026-10-01) — the size derivation was missing `pointValue`. A NINTH site, opposite sign.
//
// The first eight sites were NOTIONAL and their error made positions look too BIG, so the caps bound early.
// This one is the RISK and its error makes the position come out too SMALL, so the venue floor vetoes:
//
//     size = equity x riskPct / distance          // one quote unit treated as one unit of ACCOUNT currency
//     size = equity x riskPct / (distance x pointValue x fx)
//
// Soybeans quotes in CENTS (`pointValue 0.01`), so its size came out 1/0.0129 = **77.5x too small**: the dial
// wanted ~656 bushels, the desk computed **8.4641**, the venue floor is **15**, and every entry was refused on
// `venue_minimum` — with the desk's own arithmetic reframed as the venue's fault. The refusal even printed the
// tell: *"and NOTHING was capped: the size comes out below the minimum on its own"* was TRUE.
//
// ⚠ WHY THESE ARE SOURCE PINS AND NOT ARITHMETIC ASSERTIONS. `riskPctOf`/`sizeForRisk` are closures inside
// `evaluate` — they read `equity` and `notionalK` from its scope — so they are not reachable from a test, and
// this codebase's own convention for exactly this situation is a pin on the source. The pins below fail if any
// of the six sites goes back to spelling the product out, which is the regression that actually happened here:
// the same product written out at six sites, with `fx` fixed at some of them and `pointValue` at none.
//
// ⚠ AND THE BYTE-IDENTITY EVIDENCE IS THE REST OF THE SUITE, NOT THIS FILE. Every instrument on this desk
// except Soybeans has `pointValue === 1`, so `notionalK === 1` for all of them, so every number below must be
// unchanged — and the ~2000 other tests that exercise sizing are what prove it. A test here asserting
// "notionalK = 1 is the identity" would only be testing a copy of the arithmetic.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { code } = require('./_source');

// ⚠ CRLF: the sources here are CRLF and `.` does not match `\r`, so normalise before line-anchored patterns —
// the same helper `test/risk-unit-explained.test.js` uses.
const nl = (s) => s.replace(/\r\n/g, '\n');
const risk = nl(code('trading/agent/risk.js'));

test('★★ the BASE SIZING carries the contract scale — the 77.5x that vetoed Soybeans', () => {
  assert.match(
    risk,
    /let size = sizeForRisk\(riskPerTrade, expectedLossDist\)/,
    'the base size must go through sizeForRisk, which divides by notionalK'
  );
  assert.ok(
    !/let size = \(equity \* riskPerTrade\) \/ expectedLossDist/.test(risk),
    'the bare product must not come back: it treats one QUOTE unit as one unit of ACCOUNT currency'
  );
});

test('★ all six size<->risk sites go through the helpers — none re-spells the product', () => {
  // Each pattern is a site that WAS wrong. Any of them reappearing means a scale has been dropped again.
  const respelled = [
    [/let size = \(equity \* riskPerTrade\) \/ expectedLossDist/, 'base size'],
    [/const impliedRiskPct = \(size \* expectedLossDist\) \/ equity \* 100/, 'impliedRiskPct'],
    [/size = \(equity \* \(maxRiskPct \/ 100\)\) \/ expectedLossDist/, 'maxRiskPerTradePct clamp'],
    [/Math\.round\(\(floorUnits \* expectedLossDist \/ equity\) \* 100 \* 10000\)/, 'riskAtFloorPct (snap branch)'],
    [/Math\.round\(\(v\.size \* expectedLossDist \/ equity\) \* 100 \* 10000\)/, 'resolvedRiskPct'],
    [/\(equity \* \(Number\(risk\.riskPerTradePct \?\? 1\) \/ 100\)\) \/ \(2 \* atrV\)/, 'baseSize'],
  ];
  for (const [re, label] of respelled) {
    assert.ok(!re.test(risk), `${label} is spelling the product out again — it must use riskPctOf/sizeForRisk`);
  }
  // ...and the replacements are actually present.
  assert.match(risk, /riskPctOf\(size, expectedLossDist\)/, 'impliedRiskPct');
  assert.match(risk, /sizeForRisk\(maxRiskPct \/ 100, expectedLossDist\)/, 'risk cap clamp');
  assert.match(risk, /riskPctOf\(floorUnits, expectedLossDist\)/, 'riskAtFloorPct');
  assert.match(risk, /riskPctOf\(v\.size, expectedLossDist\)/, 'resolvedRiskPct');
  // ⚠ THE RULE IS "GOES THROUGH sizeForRisk", NOT "SPECIFIES 2 * atrV". The old pattern spelled the argument
  // out literally, so when `risk.atrStopMultiple` was wired (2026-10-18, it had been a dead dial) this pin
  // failed on a change that made the code MORE honest rather than less. The denominator is now any single
  // identifier/product; what may never come back is the bare `(equity * pct) / distance` above.
  assert.match(risk, /sizeForRisk\(Number\(risk\.riskPerTradePct \?\? 1\) \/ 100, [A-Za-z0-9_]+(?: \* [A-Za-z0-9_]+)?\)/, 'baseSize');
});

test('★ BOTH helpers carry notionalK, and it is defined ABOVE them — not re-derived', () => {
  const kDef = risk.search(/const notionalK = notionalFactor\(pointValue, fx\)/);
  const pctOf = risk.search(/const riskPctOf =/);
  const forRisk = risk.search(/const sizeForRisk =/);
  assert.ok(kDef > -1, 'notionalK must still be derived by notionalFactor');
  assert.ok(pctOf > kDef, 'riskPctOf must be defined AFTER notionalK, or it captures undefined');
  assert.ok(forRisk > kDef, 'sizeForRisk must be defined AFTER notionalK, or it captures undefined');
  // The scale is IN the arithmetic, not merely in a comment nearby.
  assert.match(risk, /\(\(n \* d \* notionalK\) \/ equity\) \* 100/, 'riskPctOf must multiply by notionalK');
  assert.match(risk, /\(equity \* f\) \/ \(d \* notionalK\)/, 'sizeForRisk must divide by notionalK');
});

test('★ the TWO riskAtFloorPct computations agreed with each other only after this fix', () => {
  // There are two. The veto branch derives it FROM `minNotionalPct`, which already carried `notionalK`; the snap
  // branch spelled the product out without it. Same quantity, two scales — so a reader comparing a refusal with a
  // successful ticket saw two different numbers for the same thing.
  const viaNotional = /minNotionalPct \* \(riskStopDist \/ Number\(price\)\)/;
  const viaHelper = /Math\.round\(riskPctOf\(floorUnits, expectedLossDist\) \* 10000\) \/ 10000/;
  assert.match(risk, viaNotional, 'the veto branch derives riskAtFloorPct from minNotionalPct (already scaled)');
  assert.match(risk, viaHelper, 'the snap branch must go through riskPctOf');
});

test('the `units` string describes the derivation the code actually used, without changing when the scale is 1', () => {
  // `units` is seat-facing ("the formula rides along so the size is never a mystery"). Once the derivation has a
  // scale in it, a string that omits it is the surface-that-looks-authoritative-and-isn't defect.
  assert.match(risk, /notionalK === 1\s*\n\s*\? `risk \$\{risk\.riskPerTradePct\}% \/ \(2 x ATR \$\{atrV\}\)`/,
    'the notionalK === 1 branch must stay byte-identical to the string that was here before');
  assert.match(risk, /x contract scale \$\{notionalK\.toFixed\(6\)\}/,
    'a scaled derivation must say so');
});

test('a null size is still caught by the EXISTING `size_zero` guard — no new veto path was added', () => {
  // ⚠ WORTH PINNING BECAUSE IT IS NOT OBVIOUS. `sizeForRisk` returns `null` where the old inline expression
  // produced `NaN`/`Infinity`. `null <= 0` is TRUE (it coerces to 0), so the guard already downstream catches it
  // — whereas `NaN <= 0` is FALSE and would have sailed through. The change therefore cannot introduce a size
  // that reaches the caps unguarded, and it needed no new veto code.
  assert.match(risk, /if \(size <= 0\) \{ veto\('size_zero'/, 'the existing zero-size guard must still be there');
  assert.ok(null <= 0, 'null coerces to 0, which is what makes the existing guard sufficient');
  // ⚠ Built via `Number(...)` rather than the literal `NaN`, because `use-isnan` rightly forbids comparing against
  // the literal — and the comparison IS the point here, so it has to be made through a value.
  const notANumber = Number('not-a-number');
  assert.ok(Number.isNaN(notANumber), 'the demonstration needs a real NaN');
  assert.ok(!(notANumber <= 0), 'NaN would NOT be caught — the pre-existing hole this fix does not widen');
});
