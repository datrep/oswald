// test/margin-guard-units.test.js — TRD-RSK-14 (2026-09-30): the guard's ceiling is a ceiling on a MODEL.
//
// ★ WHAT THIS FILE PINS AND WHY IT IS A NAMING TEST RATHER THAN AN ARITHMETIC ONE.
// The L3 guard computes `Σ(notional_i × marginRate_i)`. The registry's rate is CORRECT. What the guard gets
// wrong is the CURRENCY: the notional is denominated in the INSTRUMENT's currency (USD, for every symbol this
// desk trades) while the venue withholds margin in the ACCOUNT's (SGD).
//
// MEASURED over every readable book on file, with `impliedFx = (equity - available) / Σ(notional × rate)`:
//   * median **1.2812**, p10 1.2757, p90 1.2847, and **99.2% of ~5,000 books within 0.02 of that median**;
//   * and it does NOT track the rate — Gold-only (20% rate) x1.2795 against Bitcoin-containing (60%) x1.2822.
// A book holding a 60%-margin instrument and a book holding only 20% ones give the SAME multiplier, so this is
// one multiplicative factor and not a second margin policy: 1.28 is USD per SGD.
//
// SO `maxMarginUtilisationPct = 80` means **102.50%** of equity in the margin the venue really withholds —
// above 100, i.e. the venue liquidates before the guard stops the desk. The defect is LATENT (the 35%/50% caps
// reach only 26.91%), and the arithmetic fix needs a number only the owner can set, so what is pinned here is
// that the model can never again be READ as the venue's figure. `initialMarginHeld` is present-and-null
// precisely so that "the guard does not have this" stays distinguishable from "it is zero".
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { read, code } = require('./_source');

const riskSrc = read('trading/agent/risk.js');
const riskCode = code('trading/agent/risk.js');

test('the guard names its MODELLED margin as modelled, and leaves the venue\'s figure present-and-null', () => {
  // A reader of a decision must not have to know that `usedMargin` is a model. It is kept because pins and
  // readers hold it; the named twin is what removes the ambiguity.
  assert.match(riskCode, /modelledInitialMargin:/);
  assert.match(riskCode, /initialMarginHeld:/);

  // ⚠ PRESENT-AND-NULL, AND LITERALLY SO. `Number(null) === 0` is the most repeated defect in this repo, and
  // here it would turn "the guard does not read the venue's withheld margin" into "the venue withholds nothing"
  // — the guard's most permissive possible reading of its worst input. The field is therefore initialised to the
  // literal null in the shape object and is NEVER assigned from a variable at the spread.
  //
  // ⚠ MATCHED AGAINST `code()`, NOT `read()`. The first version of this pin used the raw text and the prose
  // comment that EXPLAINS the field name tripped it — the mirror of this repo's own lesson that a comment-\n  // stripping pin cannot test a comment.
  assert.match(riskCode, /modelledInitialMargin: null,\s*\n\s*initialMarginHeld: null,/);
  const assigned = [...riskCode.matchAll(/initialMarginHeld\s*:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  // It belongs in the SHAPE, which every later spread inherits via `...v.marginGuard`, so ONE declaration is the
  // correct count — and every declaration that exists must be the literal null.
  assert.equal(assigned.length, 1, `expected exactly one declaration (the shape, inherited by every spread), found ${assigned.length}`);
  for (const a of assigned) {
    assert.equal(a, 'null', `initialMarginHeld must only ever be the literal null, found: ${a}`);
  }
});

test('the modelled figure is the SAME number as usedMargin — one quantity, two names, no third value', () => {
  // If these two could diverge, a decision would carry two different "margins" and the reader would be back
  // where TRD-RSK-14 found them: three quantities all called margin.
  assert.match(riskCode, /modelledInitialMargin: mg\.usedMargin != null \? \+mg\.usedMargin\.toFixed\(2\) : null/);
  // And `usedMargin` itself must still be filled, or the twin would be the only surviving field.
  assert.match(riskCode, /usedMargin: mg\.usedMargin != null \? \+mg\.usedMargin\.toFixed\(2\) : null/);
});

test('the unit caveat is stated WHERE IT MATTERS — the branch where this control made the size', () => {
  // A warning that only lives in a comment is a warning the decision log does not carry. The guard's ceiling is
  // only wrong ABOUT something once it is the control that bound the ticket, so that is where it is said.
  const caveat = riskCode.indexOf('applied to the MODELLED initial margin');
  assert.ok(caveat > 0, 'the caveat must be real code, not prose — it has to reach the decision log');
  const bound = riskCode.indexOf("boundBy = 'margin_utilisation'");
  assert.ok(bound > 0, 'the fitted branch must still declare what bound the ticket');
  assert.ok(caveat > bound, 'the caveat belongs INSIDE the branch where the guard made the size, not before it');
  assert.match(riskCode.slice(caveat), /1\.2812/);
  assert.match(riskCode.slice(caveat), /TRD-RSK-14 \(#1477\)/);
});

test('the evidence for the factor is cited where the reader will be, not only in this file', () => {
  // The three claims a sceptical reader needs: the factor, that it does not track the rate, and the consequence.
  assert.match(riskSrc, /1\.2812x?/);
  assert.match(riskSrc, /does not move with the registry/);
  assert.match(riskSrc, /102\.50%/);
  // And the reason it is NOT fixed here, stated as a reason rather than left implied.
  assert.match(riskSrc, /changes the arithmetic of the one control/);
});
