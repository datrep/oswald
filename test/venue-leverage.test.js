// test/venue-leverage.test.js — L1 (rev 5, 2026-09-29): the venue's LEVERAGE is a risk input.
//
// ★ THE GAP THIS CLOSES. `risk.js` computed a size, compared it to `maxEquityPerPositionPct` of eqity,
// and never once asked what the venue permits. The registry has stored `leverageRaw` since migration
// 045, and `parseLeverage` existed only to CHECK the venue's margin percent against it — the ratio was
// never consumed. That absence is why the desk could not state its own ceiling: the ceiling is
// `L x stopPct` (rev 4's finding), so Gold at 1:5 caps a 0.550% stop at 2.75% while Bitcoin at 1:1.67
// caps the SAME dial at 1.16%. A setting that is reachable on one symbol and unreachable on another is
// not a single setting, and no control on the desk could say so.
//
// ★ THE DECISION PINNED HERE: `purchasingPower = equity x leverage` and the two margin fields are
// REPORTED, not ACTED ON. L1 changes no size, no veto and no cap — the test below asserts that the
// field is written and never read, which is the only honest way to hold "data only" to its word.
//
// ★ THE INVERSION THIS FILE GUARDS. `Number(null) === 0`, the most repeated defect in this repo. An
// unread registry row must present as leverage UNKNOWN — present-and-null — never as leverage 0, or
// "we could not read the venue's capacity" becomes "the venue permits nothing" and then becomes
// whatever a downstream guard does with a zero denominator.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ins = require('../trading/agent/instruments');
const { code } = require('./_source');

// ⚠ COMMENTS ARE STRIPPED — and this file learned that the hard way, twice over. It used to read raw text, so
// when L4 added a comment quoting the very pattern this suite forbids (`v.venueFloor.leverage * stopPct`, cited
// as the mistake NOT to make), the negative assertion failed ON ITS OWN DOCUMENTATION. A positive assertion has
// the mirror-image failure: it can PASS on a comment. Both are the "test certifying prose" defect, in opposite
// directions, and stripping is the one repair that fixes both.
const read = (p) => code(p.replace(/^\.\.\//, ''));

test('the parsed ratio, not the raw string, is what a caller receives', () => {
  // The venue states leverage as '1:5'; the desk needs 5. The string stays the evidence.
  const v = ins.venueLeverage({ leverageRaw: '1:5' });
  assert.equal(v.leverage, 5);
  // Whitespace and the separator are presentation (the probe has produced '1 : 5').
  assert.equal(ins.venueLeverage({ leverageRaw: ' 1 : 10 ' }).leverage, 10);
  // A fractional ratio is real on this venue: Bitcoin is 1:1.67, NOT 1:5.
  assert.equal(ins.venueLeverage({ leverageRaw: '1:1.67' }).leverage, 1.67);
});

test('★ the two margin fields ride along, and are the venue\'s own statement of the same number', () => {
  // Gold, as the registry holds it: 20.00% initial margin against a 1:5 ratio. The invariant the desk
  // relies on is `initialMarginPct == 100 / leverage`; both are carried so a disagreement is visible.
  const v = ins.venueLeverage({ leverageRaw: '1:5', initialMarginPct: 20, maintenanceMarginPct: 10 });
  assert.equal(v.leverage, 5);
  assert.equal(v.initialMarginPct, 20);
  assert.equal(v.maintenanceMarginPct, 10);
  assert.equal(v.initialMarginPct, 100 / v.leverage, 'the cross-check the probe enforces');
  // The percent arrives as the venue's presentation string as often as a number.
  assert.equal(ins.venueLeverage({ initialMarginPct: '20.00%' }).initialMarginPct, 20);
});

test('★★ THE INVERSION: an absent row gives UNKNOWN leverage, never a leverage of ZERO', () => {
  // `Number(null) === 0`. If any of these ever returns 0, a downstream guard that divides by leverage
  // (the margin guard, L3) divides by zero and reports "unlimited capacity" at the exact moment the
  // desk knows nothing. Absence must survive as absence.
  for (const row of [null, undefined, {}]) {
    const v = ins.venueLeverage(row);
    assert.equal(v.leverage, null, `leverage for ${JSON.stringify(row)}`);
    assert.notEqual(v.leverage, 0, 'an absent ratio is not a ratio of zero');
    assert.equal(v.initialMarginPct, null);
    assert.equal(v.maintenanceMarginPct, null);
  }
  // A ratio the parser cannot read is unknown too — not zero, and not a guessed 1.
  for (const bad of ['', '5', '1:0', '1:-5', 'abc', 'Leverage 1:5', 5, true]) {
    const v = ins.venueLeverage({ leverageRaw: bad });
    assert.equal(v.leverage, null, `leverageRaw=${JSON.stringify(bad)} must not become a number`);
  }
  // A margin of 0% is NOT a missing margin, but it is also not leverage — and it must not be
  // silently overwritten by the ratio's inverse.
  assert.equal(ins.venueLeverage({ initialMarginPct: 0 }).initialMarginPct, 0);
});

test('★ the ceiling moves with the STOP — the finding that makes leverage a first-class input', () => {
  // `ceiling = L x stopPct`. Same symbol, same leverage, two stops: Gold's newest DECISION stop is
  // 0.550%, its live VENUE stop on Trades #1123 is 0.664%. Those two facts alone are 2.75% and 3.320%
  // of admissible risk — so "Gold's ceiling" is a phrase without a subject; the stop is the subject.
  const L = ins.venueLeverage({ leverageRaw: '1:5' }).leverage;
  assert.equal(+(L * 0.55).toFixed(3), 2.75, 'the decision stop gives 2.75%');
  assert.equal(+(L * 0.664).toFixed(3), 3.32, 'the venue stop gives 3.320%');
  // And the reason this is a per-SYMBOL limit and not a desk-wide one: Bitcoin's ratio is 1.67, so the
  // identical dial is capped at a third of Gold's. Rev 1 of the report had leverage wrong (assumed a
  // uniform 1:5) and printed SGX's ceiling 2.36x too low because of it.
  const btc = ins.venueLeverage({ leverageRaw: '1:1.67' }).leverage;
  assert.ok(btc < L, 'Bitcoin is less levered than Gold on this venue');
  assert.equal(+(btc * 0.664).toFixed(3), 1.109, 'the same stop on Bitcoin admits ~1.1%, vs 3.32% on Gold');
});

test('every FAILURE shape of resolve() still carries the ratio, present-and-null', () => {
  // The module's discipline is that a caller must not learn one half of the contract without seeing
  // whether the other half was known. Leverage is now one of those halves, so the ABSENT shapes carry
  // it too — otherwise `resolve()`'s shape would depend on how it failed, and a caller reading
  // `.leverage` off a failed resolution would get `undefined` (a value that survives arithmetic as
  // NaN) on one path and `null` on another.
  //
  // `resolve(1, {})` returns before touching the database (no symbol), so this is testable with no pool.
  return ins.resolve(1, {}).then((r) => {
    assert.equal(r.found, false);
    assert.equal(r.reason, 'symbol_required');
    for (const k of ['leverage', 'initialMarginPct', 'maintenanceMarginPct']) {
      assert.equal(k in r, true, `${k} must be present on an absent resolution`);
      assert.equal(r[k], null, `${k} must be null, not undefined and not 0`);
    }
  });
});

test('★ THE MARGIN FIELDS REACH EXACTLY ONE CONTROL, THROUGH EXACTLY ONE ACCESSOR', () => {
  // ⚠⚠ THIS TEST USED TO ASSERT "WRITTEN AND NEVER READ", AND ON 2026-09-29 IT STOPPED BEING TRUE WITHOUT
  // FAILING. That is worth more than the pin it replaces, so it is recorded here rather than quietly fixed.
  //
  // L1's claim was that leverage changed no behaviour, and this held it mechanically by scanning LINES for a
  // leverage read and asserting the line fed no size, veto or cap. L3 then DID read it — deliberately: it is
  // the margin guard's denominator — and the test kept passing, because L3 reads through the accessor
  // `marginRatePct(v.venueFloor)`, whose text contains neither `venueFloor.` nor `venueLev`. **So the pin was
  // certifying a claim it could no longer test — the same failure shape as the bridge-maintenance
  // `doesNotMatch` that matched only the comment explaining why the call was absent.** A structural pin that
  // does not fire when the structure changes is prose with an assertion around it.
  //
  // WHAT IS TRUE NOW, and is narrower and therefore stronger: the margin fields are read at EXACTLY ONE site,
  // through EXACTLY ONE accessor, so there is still a single place that decides a margin rate — and
  // `purchasingPower` is STILL written and never read.
  const risk = read('../trading/agent/risk.js');

  // 1) No line reaches into the record with a dot. The guard must go through the accessor, or the "one place
  //    that decides a rate" property is gone and instruments.js stops being the single source.
  const dotted = [...risk.matchAll(/venueFloor\s*\.\s*(leverage|initialMarginPct|maintenanceMarginPct)/g)];
  assert.strictEqual(dotted.length, 0,
    `the margin fields must be read through marginRatePct, not by dotting into the record: ${dotted.map((m) => m[0]).join(', ')}`);

  // 2) Exactly one call site. Two would be two places that could disagree about which field is authoritative —
  //    the L1 finding (stated margin vs derived 2dp ratio) re-opened one level up.
  const calls = [...risk.matchAll(/marginRatePct\s*\(/g)];
  assert.strictEqual(calls.length, 1, `exactly one marginRatePct call may exist in the gate; found ${calls.length}`);

  // 3) ★ AND THAT ONE READ FEEDS A CONTROL. Stated plainly, because L1's claim that it does not is no longer
  //    the design: this is the layer that made leverage load-bearing, on purpose.
  assert.match(risk, /marginRatePct\(v\.venueFloor/, 'the one read must be the guard\'s');
  assert.match(risk, /veto\('margin_utilisation'/, 'and the guard that consumes it must be able to refuse');

  // 4) `purchasingPower` is STILL write-only. It is reported so a human can see the desk's capacity; nothing
  //    sizes or refuses on it. A `.purchasingPower` read would mean a control now depends on a ratio that L1
  //    measured to be the DERIVED display rather than the stated margin.
  assert.ok(!/\.\s*purchasingPower/.test(risk), 'purchasingPower must remain written and never read');

  // 5) And the disclosure in `sizeCalc` is what makes the whole record answerable from a decision row.
  assert.match(risk, /venueFloor: v\.venueFloor \|\| null/);
});

test('the report is carried far enough to be read off a decision row', () => {
  // `sizeCalc.venueFloor` is the record a study reads. If the leverage report is not inside it, the
  // desk still cannot answer "what could this symbol have bought" from a logged decision.
  const risk = read('../trading/agent/risk.js');
  assert.match(risk, /purchasingPower:/);
  assert.match(risk, /leverage: venueLevKnown \? venueLev : null/);
  // The catch branch must match, or `sizeCalc.venueFloor` has two shapes and a reader has to know which.
  assert.match(risk, /leverage: null, initialMarginPct: null, maintenanceMarginPct: null, purchasingPower: null/);
});

test('the parser stays the single source of the reading', () => {
  // A second place to parse '1:5' is a second place to get it wrong. `agent/instruments.js` must read
  // the ratio through `instrumentSpec.parseLeverage`, and the module must still hold no SQL of its own.
  const src = read('../trading/agent/instruments.js');
  assert.match(src, /parseLeverage/);
  assert.equal(/getPool|query\(/.test(src), false, 'no ad-hoc SQL in agent/instruments');
  // NOTHING INVENTS A MULTIPLIER. The only place this module PRODUCES a numeric leverage is the one
  // `parseLeverage(r.leverageRaw)` call — no default of 1, no `Number(...) || 1`, no name lookup. The
  // raw string is also allowed to travel as evidence (`venueCostFacts` exposes it verbatim), which is a
  // different thing from turning it into a number.
  const produced = [...src.matchAll(/^\s*leverage:\s*(.+?),?$/gm)].map((m) => m[1]);
  assert.deepEqual(produced, ['parseLeverage(r.leverageRaw)'], 'exactly one producer, and it is the parser');
});
