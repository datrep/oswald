// test/exposure-budget-per-wake.test.js — TRD-EXE-7 (#1475).
//
// ★ THE DEFECT. `fitExposureBudget` is checked ONCE PER PROPOSAL against `v.exposurePct`, which is read from the
// OPEN book — and open positions only exist AFTER a wake places them. So every non-vetoed proposal in a wake was
// sized as though it were the only one.
//
// Measured 2026-09-29, wake #5661: cap 50%, book Gold-only at 12.71%, so `remaining = 37.29%` and Silver (34.15%)
// fitted. Sugar (34.15%) was then checked against THE SAME 12.71% and also fitted. Book: 81.01% — a 31-point
// overshoot, from one wake, with neither ticket carrying an exposure-budget reason.
//
// ★ THE FIX, and why the two numbers are kept apart: the caller threads `opts.committedPct` (the running notional%
// this wake has already accepted), the budget is checked against the SUM, and `exposureCommittedPct` is recorded.
// `v.exposurePct` STILL means the TRUE open exposure — a report asking "how exposed is the book" must not be
// answered with a number that includes tickets never filled.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const risk = require('../trading/agent/risk');
const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const riskSrc = nl(code('trading/agent/risk.js'));
const aggSrc = nl(code('trading/agent/aggregator.js'));

const EQUITY = 1000, PRICE = 10, CAP = 50;
// A ticket wanting 34.15% of equity: size x price / equity x 100 === 34.15
const WANT_SIZE = 34.15;

test('THE INSTANCE: the first entry fits, the second is now RESIZED instead of fitting too', () => {
  const open = 12.71, committedAfterFirst = 34.15;

  // Entry 1 — looked at the open book only. This is correct and must NOT change.
  const first = risk.fitExposureBudget({ size: WANT_SIZE, price: PRICE, exposurePct: open, exposureCapPct: CAP, equity: EQUITY });
  assert.equal(first.fitted, false, 'the first entry fits and is not resized');
  assert.equal(first.full, false);
  assert.equal(first.size, WANT_SIZE);

  // Entry 2 — the SAME wake, so the budget must see entry 1. Under the old code this call received `open` alone and
  // also returned `fitted: false`, which is exactly how the book reached 81.01%.
  const second = risk.fitExposureBudget({ size: WANT_SIZE, price: PRICE, exposurePct: open + committedAfterFirst, exposureCapPct: CAP, equity: EQUITY });
  assert.equal(second.fitted, true, 'the second entry must be RESIZED, not waved through');
  assert.ok(second.size < WANT_SIZE, `resized below the wanted size (got ${second.size})`);
  // remaining = 50 - 46.86 = 3.14% of 1000 at price 10 = 3.14 units
  assert.ok(Math.abs(second.size - 3.14) < 0.0002, `expected ~3.14 units of room, got ${second.size}`);

  // And the sum can no longer exceed the cap: 46.86 + 3.14 = 50.00 exactly.
  const finalPct = (open + committedAfterFirst) + (second.size * PRICE / EQUITY * 100);
  assert.ok(finalPct <= CAP + 1e-9, `the wake must end at or under the cap, ended at ${finalPct}%`);
});

test('an ALREADY-OVER-BUDGET wake vetoes rather than resizing, exactly as before', () => {
  const full = risk.fitExposureBudget({ size: WANT_SIZE, price: PRICE, exposurePct: CAP + 0.1, exposureCapPct: CAP, equity: EQUITY });
  assert.equal(full.full, true);
  assert.equal(full.size, 0);
  assert.equal(full.fitted, false);
});

// --- the wiring --------------------------------------------------------------------------------------

test('the gate accepts a committed figure, folds it into the BUDGET, and records it separately', () => {
  assert.match(riskSrc, /async function evaluate\(userId, settings, proposal, openTrades, closedTrades = \[\], opts = \{\}\) \{/,
    'evaluate must take the options bag the caller threads');
  assert.match(riskSrc, /const committedPct = Number\.isFinite\(Number\(opts && opts\.committedPct\)\) \? Math\.max\(0, Number\(opts\.committedPct\)\) : 0;/);
  assert.match(riskSrc, /v\.exposureCommittedPct = committedPct;/, 'the committed figure must be on the record');
  assert.match(riskSrc, /const budgetPct = v\.exposurePct \+ committedPct;/, 'the budget must see the SUM');
  assert.match(riskSrc, /exposurePct: budgetPct,/, 'and the sum is what the budget is checked against');
});

test('★ `exposurePct` STILL MEANS THE TRUE OPEN BOOK — the sum must not overwrite it', () => {
  // If this fails, every report that asks "how exposed is the book" would silently start including tickets that
  // were approved but never filled. The whole reason the two figures are separate.
  // ⚠ UPDATED 2026-10-01: the assignment now SPANS TWO LINES — both scales are applied through one helper — so a
  // `[^\n;]*` capture, which cannot cross a newline, stopped matching a statement that is still correct. The
  // INTENT IS UNCHANGED and is still pinned below: it must remain the sum over the OPEN trades, and it must not
  // pick up the committed figure.
  const assign = riskSrc.match(/v\.exposurePct\s*=\s*([\s\S]*?);/);
  assert.ok(assign, 'the exposure assignment must exist');
  assert.ok(!/budgetPct|committedPct/.test(assign[1]), `v.exposurePct is assigned from ${assign[1]} — it must stay the true open book`);
  assert.match(riskSrc, /v\.exposurePct = open\.reduce\(/, 'and it is still the sum over the OPEN trades');
});

test('the gate PUBLISHES the ticket its own notional so the caller never recomputes it', () => {
  assert.match(riskSrc, /notionalPct: Number\(equity\) > 0 && Number\.isFinite\(Number\(v\.size\)\)/);
});

test('the caller declares, passes, and accumulates the per-wake figure', () => {
  assert.match(aggSrc, /let committedPct = 0;/, 'the accumulator must be declared once per wake');
  // ⚠ UPDATED 2026-10-01: the bag now carries `pointValue` and `pointValueBySymbol` too, so pinning it as
  // EXACTLY `{ committedPct }` would forbid the very threading this fix exists to add. The intent — the committed
  // figure must reach the gate — is pinned by requiring it to be PRESENT, not by requiring it to be ALONE.
  assert.match(aggSrc, /riskMod\.evaluate\(userId, settings, proposal, openTrades, cooldownClosed, \{\s*committedPct\b/,
    'it must be passed into the gate');
  assert.match(aggSrc, /committedPct \+= Number\(risk\.sizeCalc\.notionalPct\);/, 'and incremented by each accepted ticket');
  // the accumulation must sit AFTER the veto return, or a refused ticket would consume budget it never used
  const acc = aggSrc.indexOf('committedPct += Number(risk.sizeCalc.notionalPct);');
  const veto = aggSrc.indexOf('if (risk.veto) {');
  assert.ok(veto > 0 && acc > veto, 'the accumulator must come after the veto branch');
  // ...and BEFORE the committee, so a later proposal in the same wake sees it
  const verdict = aggSrc.indexOf('const verdict = committeeVerdict({');
  assert.ok(verdict > acc, 'the accumulator must come before the committee verdict');
});

test('the reason text names the committed component when there IS one', () => {
  // ⚠ COUNTED, NOT PATTERN-MATCHED. The first version of this test used a regex spelling out the nested template
  // literal's inner backticks and quotes, and it failed against source that plainly contained the text — the
  // assertion was over-specified about a detail that does not matter. Both the resize path and the veto path must
  // name it; how they punctuate it is not the property under test.
  const hits = (riskSrc.match(/committed this wake/g) || []).length;
  assert.equal(hits, 2, `both the resize reason and the veto reason must name the committed component (found ${hits})`);
  assert.match(riskSrc, /exposure budget full: /, 'the veto path must still say why it refused');
});
