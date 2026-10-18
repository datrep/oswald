// test/entry-drift-factor.test.js — TRD-EXE-13 (2026-10-01): the entry-side twin of the stop-slippage factor.
//
// WHAT IS PINNED, AND WHY STRUCTURALLY. `expectedLossDist` lives inside `risk.evaluate`, which needs a store, a
// settings row and the live poller before it will run — so the thing that can actually be asserted here is the
// SOURCE of the arithmetic, which is the same reason `_source.js` exists at all. The assertions are therefore
// chosen to pin the FORM and the failure behaviour rather than to re-implement the formula, and the numbers
// themselves are pinned separately in `test/fx-rate.test.js` (the measured vectors) and in the investigation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { code, read } = require('./_source');

const RISK = 'trading/agent/risk.js';
const STORE = 'trading/store.js';

test('★★ the factor is INERT BY DEFAULT — 1 is the decision, not a missing value', () => {
  const store = code(STORE);
  assert.match(store, /\n\s*entryDriftFactor: 1,/, 'the default is exactly 1');
  assert.doesNotMatch(store, /entryDriftFactor: 1\.[0-9]/, 'and the measured 1.083 is NOT shipped as the default');
  // The default must be present in the risk block, not merely mentioned - a default that lives only in prose is
  // the "missing key silently disabled a guard" shape this repo has hit before.
  const riskBlock = store.slice(store.indexOf('stopSlippageFactor'), store.indexOf('entryDriftFactor') + 40);
  assert.match(riskBlock, /entryDriftFactor: 1,/);
});

test('★★ it composes with the EXIT-side factor, and each message reports only its OWN component', () => {
  const src = code(RISK);
  // the two components must be named separately, or one factor's effect gets labelled with the other's number
  assert.match(src, /const entryLossDist = riskStopDist \* lossFactor;/, 'the exit-side component');
  assert.match(src, /const expectedLossDist = entryLossDist \* driftFactor;/, 'and the sum the sizing uses');
  // the exit-side message quotes `entryLossDist`, NOT the combined figure
  const exitMsg = src.slice(src.indexOf('sized on the MEASURED LOSS distance'), src.indexOf('sized on the ENTRY DRIFT'));
  assert.ok(exitMsg.length > 100, 'the slice must actually bound the exit-side message');
  assert.match(exitMsg, /entryLossDist \/ price/, 'the exit message uses its own component');
  assert.doesNotMatch(exitMsg, /expectedLossDist \/ price/, 'and must NOT quote the combined one');
  // the entry-side message uses the combined one, which is correct there
  const entryMsg = src.slice(src.indexOf('sized on the ENTRY DRIFT'));
  assert.match(entryMsg.slice(0, 900), /expectedLossDist \/ price/, 'the entry message states the resulting risk unit');
});

test('★★ below 1 is REFUSED and REPORTED, never silently clamped — the house discipline', () => {
  const src = code(RISK);
  assert.match(src, /const driftUsable = Number\.isFinite\(driftRaw\) && driftRaw >= 1;/);
  assert.match(src, /const driftFactor = driftUsable \? driftRaw : 1;/, 'an unusable value falls back to 1');
  assert.match(src, /entryDriftFactor \$\{driftRaw\} is below 1 and was IGNORED/, 'and it is SAID, in the open');
  // ⚠ an ABSENT setting is not an unusable one: it must fall through to 1 silently, or every decision on a
  // settings row that predates this key would carry a spurious warning
  assert.match(src, /if \(Number\.isFinite\(driftRaw\) && !driftUsable\)/,
    'the warning is gated on the value being PRESENT but unusable');
});

test('★ the factor travels with the decision, so "was the drift modelled?" is answerable from the record', () => {
  const src = code(RISK);
  assert.match(src, /v\.entryDriftFactor = driftFactor;/, 'recorded on the verdict');
  // and it must be recorded NEXT TO the distance it modifies, not somewhere unrelated
  const around = src.slice(src.indexOf('v.effectiveStopDistance'), src.indexOf('v.entryDriftFactor') + 40);
  assert.match(around, /v\.effectiveStopDistance[\s\S]*v\.entryDriftFactor/);
});

test('★ the measurement is carried in the code, not only in a document', () => {
  // The number a future reader needs to re-derive the choice is 74% adverse / 1.083x mean / 2.518x max over 73
  // entries. A settings key whose comment does not say where the value came from is a number nobody can revisit.
  const store = read(STORE);
  const block = store.slice(store.indexOf('TRD-EXE-13'), store.indexOf('entryDriftFactor'));
  for (const fact of ['74%', '1.083x', '2.518x', '73']) {
    assert.ok(block.includes(fact), `the comment must carry ${fact}`);
  }
  // and the sample size behind it, so the reader can judge it
  assert.match(block, /entry_reanchored/, 'and name the event kind it was measured from');
});
