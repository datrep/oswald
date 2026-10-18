// test/risk-margin-guard.test.js — L3 (rev 5, 2026-09-29): the MARGIN guard.
//
// ★ WHY THIS LAYER EXISTS AT ALL. Every sizing control the desk had was denominated in NOTIONAL, and a
// notional is not a margin. Gold at 1:5 costs 20% of its notional in margin; Bitcoin at 1:1.67 costs 60%;
// SGX at 1:10 costs 10%. So the book can be inside every notional cap and still have no room to open
// anything, and the reverse. The venue's real limit is
//
//     Σ (notional_i x marginRate_i)  ≤  equity x maxMarginUtilisationPct
//
// and the guard that enforces it is the LAST sizing control, because that is the only position from which
// it can see the size that will ACTUALLY be sent — including a clamp UP to the venue's minimum
// (`risk.acceptVenueFloor`), which happens after the exposure budget and can therefore exceed it.
//
// ★ ITS ACCEPTANCE TEST IS INERTNESS, and this file states the arithmetic rather than a hope: with
// `maxEquityPerPositionPct = 80` the largest possible notional is 80% of equity, whose margin is at most
// 80% x 60% = 48% (Bitcoin, the least levered symbol) and 16% on Gold — under any ceiling of 80%. The guard
// cannot fire until L2 raises that cap, which is precisely what makes L3 safe to land BEFORE L2.
//
// ★ THE DEFECT THIS FILE IS WRITTEN IN THE SHADOW OF. `Number(null) === 0` is the most repeated defect in
// this repo, and this guard has THREE inputs where it would be catastrophic: an unreadable venue rate, an
// unreadable open-position margin, and an unreadable equity. Coercing any of them to 0 turns "we know
// nothing" into "there is infinite room", i.e. the guard reports the most permission at the moment it has
// the least information. `unknown` is a THIRD OUTCOME, never a failure to decide.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const risk = require('../trading/agent/risk');
const ins = require('../trading/agent/instruments');
const pb = require('../trading/agent/promptBuilder');
const store = require('../trading/store');
const { code } = require('./_source');

// ────────────────────────────────────────────────────────────────────────────────────────────────
// A. The pure fitter — the rule, tested without a database.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test('a ticket that fits is left EXACTLY as the dial sized it, and reports its final utilisation', () => {
  const mg = risk.fitMarginBudget({ size: 10, price: 100, marginRatePct: 20, usedMargin: 10, capPct: 80, equity: 1000 });
  assert.equal(mg.fitted, false, 'a fitting ticket must not be "fitted down"');
  assert.equal(mg.full, false);
  assert.equal(mg.unknown, false);
  assert.equal(mg.size, 10, 'the size must be untouched, not re-derived');
  assert.equal(mg.capMargin, 800);
  assert.equal(mg.wantedMargin, 200);
  assert.equal(mg.usedPct, 1, '10 of 1000 equity is already committed');
  assert.equal(mg.finalMargin, 210);
  assert.equal(mg.finalPct, 21);
});

test('a ticket that does not fit is SIZED DOWN, never refused — the exposure budget precedent', () => {
  // used 700 (70%), wanted 200 (20%) against an 80% ceiling. The desk must take the trade smaller, because
  // the 2026-09-11 incident is exactly what happens when a portfolio budget vetoes where it could resize.
  const mg = risk.fitMarginBudget({ size: 10, price: 100, marginRatePct: 20, usedMargin: 700, capPct: 80, equity: 1000 });
  assert.equal(mg.fitted, true);
  assert.equal(mg.full, false, 'there was remaining room, so this is not the "book is full" case');
  assert.equal(mg.remainingMargin, 100);
  assert.equal(mg.size, 5, 'the largest size whose margin fits the remaining 100 (5 x 100 x 20% = 100)');
  assert.equal(mg.finalMargin, 800);
  assert.equal(mg.finalPct, 80, 'and it lands EXACTLY on the ceiling, never above it');
});

test('★★ THE INVARIANT: the guard can never land ABOVE its own ceiling — and the pin is non-vacuous', () => {
  // The claim §L3.c builds on is `P <= u by construction`, which requires that the sum of position margins
  // cannot exceed the ceiling. `fitExposureBudget` ROUNDS to 4dp, and rounding here would put the guard
  // 1.2e-5% above its own ceiling — small, and enough to invalidate the proof. It FLOORS.
  const mg = risk.fitMarginBudget({ size: 100, price: 7.3, marginRatePct: 20, usedMargin: 0, capPct: 1, equity: 500 });
  assert.equal(mg.fitted, true);
  assert.ok(mg.finalPct <= 1, `the guard landed at ${mg.finalPct}% of a 1% ceiling`);

  // NON-VACUITY: computed the way `fitExposureBudget` computes, the same inputs DO exceed the ceiling. Without
  // this half the assertion above would pass for any implementation, including one that never resizes.
  const remaining = 5; // 1% of 500
  const rounded = Math.round(((remaining / 0.2) / 7.3) * 10000) / 10000;
  const roundedPct = ((rounded * 7.3 * 0.2) / 500) * 100;
  assert.ok(roundedPct > 1, `the rounded form must exceed the ceiling, else this pin is worthless (${roundedPct}%)`);
  assert.equal(+roundedPct.toFixed(7), 1.0000124, 'and by the margin measured in the code comment');
  assert.equal(mg.size, 3.4246, 'the floored size');
});

test('a book with NO room left is the one case that refuses, and it names itself with `full`', () => {
  const mg = risk.fitMarginBudget({ size: 10, price: 100, marginRatePct: 20, usedMargin: 800, capPct: 80, equity: 1000 });
  assert.equal(mg.full, true, 'the caller needs a distinguishable "no room" so it can refuse with a reason');
  assert.equal(mg.fitted, false);
  assert.equal(mg.size, 0);
  assert.equal(mg.finalMargin, 800, 'what the book already holds is the final state');
  assert.equal(mg.finalPct, 80);
});

test('★ an unreadable rate, book, equity, size or price is `unknown` — never a silent pass', () => {
  const base = { size: 10, price: 100, marginRatePct: 20, usedMargin: 10, capPct: 80, equity: 1000 };
  const cases = {
    'no venue rate': { marginRatePct: null },
    'a zero rate (free margin is an inversion, not a measurement)': { marginRatePct: 0 },
    'an unreadable open book': { usedMargin: null },
    'no equity': { equity: 0 },
    'no size': { size: 0 },
    'no price': { price: null },
  };
  for (const [why, patch] of Object.entries(cases)) {
    const mg = risk.fitMarginBudget({ ...base, ...patch });
    assert.equal(mg.unknown, true, `${why} must be unknown`);
    assert.equal(mg.full, false, `${why}: unknown is not "full" either`);
    assert.equal(mg.finalPct, null, `${why}: no verdict may be published off a missing input`);
  }
});

test('★ `usedMargin: null` IS NOT A ZERO-MARGIN BOOK — checked BEFORE the coercion', () => {
  // The single most dangerous input: `Number(null) === 0`, so a naive implementation reads an unreadable book
  // as an EMPTY one and grants the full ceiling. This asserts the exact inversion is absent.
  const mg = risk.fitMarginBudget({ size: 10, price: 100, marginRatePct: 20, usedMargin: null, capPct: 80, equity: 1000 });
  assert.equal(mg.unknown, true);
  assert.notEqual(mg.usedMargin, 0, 'an unreadable book must not be restated as zero committed margin');
  assert.equal(mg.usedMargin, null);
  assert.equal(mg.finalMargin, null);
  // And a REAL zero is still a real number — the guard must not treat a flat desk as unreadable.
  const flat = risk.fitMarginBudget({ size: 10, price: 100, marginRatePct: 20, usedMargin: 0, capPct: 80, equity: 1000 });
  assert.equal(flat.unknown, false);
  assert.equal(flat.usedMargin, 0);
  assert.equal(flat.finalPct, 20);
});

test('★ an UNARMED ceiling is not the same state as an unreadable one', () => {
  // Off/absent/nonsense = the guard does not exist, exactly as an absent `exposureCapPct` does not. It must NOT
  // report `unknown`, or the caller would refuse every entry on a desk that simply switched the control off.
  for (const capPct of [undefined, null, 0, -1, 'nonsense']) {
    const mg = risk.fitMarginBudget({ size: 10, price: 100, marginRatePct: 20, usedMargin: 10, capPct, equity: 1000 });
    assert.equal(mg.unknown, false, `cap ${JSON.stringify(capPct)} must not read as unknown`);
    assert.equal(mg.fitted, false);
    assert.equal(mg.full, false);
    assert.equal(mg.size, 10, 'and the size must pass through untouched');
    assert.equal(mg.capPct, null);
  }
});

test('the fitted size never INCREASES as the book commits more margin', () => {
  // A monotonicity property: more margin already used can never buy a bigger ticket. Stated as a property
  // rather than three examples, because the failure mode this catches (a sign or a denominator slip) shows up
  // as a single non-monotone step somewhere in the range.
  let prev = Infinity;
  for (const used of [0, 100, 400, 600, 700, 795, 800]) {
    const mg = risk.fitMarginBudget({ size: 10, price: 100, marginRatePct: 20, usedMargin: used, capPct: 80, equity: 1000 });
    const size = mg.full ? 0 : mg.size;
    assert.ok(size <= prev + 1e-9, `usedMargin ${used} produced size ${size}, larger than the previous ${prev}`);
    prev = size;
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// B. The denominator — which of the venue's two statements of the margin is authoritative.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test('the venue\'s STATED margin percent is what the guard prices capacity with', () => {
  const r = ins.marginRatePct({ initialMarginPct: 20, maintenanceMarginPct: 10, leverage: 5 });
  assert.equal(r.pct, 20);
  assert.equal(r.from, 'initialMarginPct', 'the answer must name which statement supplied it');
  // The percent arrives as the venue's presentation string as often as a number.
  assert.equal(ins.marginRatePct({ initialMarginPct: '20.00%' }).pct, 20);
});

test('★ MAINTENANCE MARGIN IS NEVER THE GUARD\'S DENOMINATOR', () => {
  // Measured on the registry: maintenance is exactly HALF of initial on every row (60/30, 20/10, 10/5). The
  // venue opens a position against the INITIAL requirement, so pricing capacity off maintenance would
  // understate every position by 2x and let the book commit twice the margin the guard believes it has.
  const row = { initialMarginPct: 20, maintenanceMarginPct: 10 };
  assert.equal(ins.marginRatePct(row).pct, 20);
  // A row carrying ONLY maintenance has no usable rate: the guard must not fall back to it.
  assert.equal(ins.marginRatePct({ maintenanceMarginPct: 10 }).pct, null);
});

test('★ the 2dp DISPLAY is the fallback, and the measurement is why', () => {
  // Bitcoin is the case that proves the ordering. The venue states `1:1.67` and 60.00%, and `100/1.67` is
  // 59.8802 — 0.12 points adrift, which is 12x the tolerance the old validator allowed. The stated figure wins
  // when both are present; the ratio is used only when the venue did not state a percent, and `from` says so.
  const both = ins.marginRatePct({ initialMarginPct: 60, leverage: 1.67 });
  assert.equal(both.pct, 60, 'the stated percent, not 59.8802');
  assert.equal(both.from, 'initialMarginPct');
  const ratioOnly = ins.marginRatePct({ leverage: 1.67 });
  assert.equal(ratioOnly.from, 'leverage');
  assert.equal(ratioOnly.pct, 59.8802, 'the derived figure is reported AS derived, never silently substituted');
});

test('★ an absent margin is UNKNOWN, never 0% — a 0% rate is free trading', () => {
  for (const row of [null, undefined, {}, { leverageRaw: '1:5' }, { initialMarginPct: 0, maintenanceMarginPct: 0 }]) {
    const r = ins.marginRatePct(row);
    assert.equal(r.pct, null, `margin for ${JSON.stringify(row)}`);
    assert.notEqual(r.pct, 0, 'Number(null) === 0 would make this position consume no margin at all');
    assert.equal(r.from, null);
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// C. The open book's rates — the ambiguity rule, and absence-is-an-answer.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test('an empty book costs no read at all', async () => {
  // The early return matters operationally: the guard runs inside every wake, and a flat desk must not pay a
  // registry query to learn that it holds nothing. No database is touched on this path.
  assert.deepEqual(await ins.marginRatesFor(1, []), {});
  assert.deepEqual(await ins.marginRatesFor(1, [null, undefined, '']), {}, 'and blanks are not symbols');
});

test('★ THE AMBIGUITY RULE IS THE SAME ONE `resolve()` USES, so the two cannot disagree', () => {
  // Options are excluded BY CLASS: twenty Gold option rows share one symbol, so a symbol-keyed lookup cannot
  // name a contract — the exact reason `resolve()` needs a venue id to size an option. And a symbol with more
  // than one SPOT row is refused rather than guessed, because a confident answer picked off an unordered list
  // is worse than no answer.
  const src = code('trading/agent/instruments.js');
  assert.match(src, /String\(row\.instrumentClass \|\| 'spot'\) !== 'spot'/, 'options must be filtered out by class');
  assert.match(src, /spots\.get\(s\) \|\| \[\]/, 'the per-symbol rows must be collected, not the first one used');
  assert.match(src, /if \(list\.length !== 1\) \{ out\[s\] = null; continue; \}/,
    'exactly one spot row is priced; anything else is null');
  // ★ (2026-10-01) AND THE CONTRACT SCALE TRAVELS WITH THE RATE. The caller's two book-wide sums need it, and
  // these are the rows that supply the rate — returning it here keeps `pointValue` on the accessor path instead
  // of letting a second reader re-derive it.
  assert.match(src, /out\[s\] = \{ \.\.\.marginRatePct\(lev\), pointValue:/,
    'the contract scale travels with the rate on the one accessor');
});

test('★ a symbol the registry cannot price maps to NULL, never to zero and never to a default', () => {
  // `null` is what makes the caller FAIL CLOSED. A symbol with no row would otherwise be "0% margin", i.e. the
  // guard's most permissive reading of its worst input; a default (say 20%) would be a fabricated fact about a
  // contract the desk never read.
  const src = code('trading/agent/instruments.js');
  assert.ok(!/out\[s\]\s*=[^;]*\?\?/.test(src), 'no default may be substituted for an unpriceable symbol');
  assert.ok(!/\|\|\s*20\b/.test(src), 'and no hard-coded rate may stand in for the venue\'s own');
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// D. The wiring — and the two things this layer lost once, which is why they are pinned here.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test('★★★ THE STORE DEFAULT IS PART OF THE CONTROL, AND ITS ABSENCE DISARMS THE GUARD SILENTLY', () => {
  // THIS IS NOT A STYLE PIN. `risk.js` arms the guard only when the number is finite and positive, so an
  // absent key is indistinguishable from a switched-off control — it is the `maxRiskPerTradePct` precedent,
  // where a missing default disabled a guard while the code read as though it were armed. Restored 2026-09-29
  // after the VS Code crash took it, together with the two accessors below.
  const cap = store.DEFAULT_SETTINGS.risk.maxMarginUtilisationPct;
  assert.equal(cap, 80, 'the owner\'s decision (§L3.c): reachable on 4 of 7 symbols, and one position at a time');
  assert.ok(Number.isFinite(cap) && cap > 0, 'and the guard ARMS on it — a null here is a dead control');
  // The two vetos must be reachable from the default, i.e. the guard must be armed for a desk with no key in
  // its stored settings — the state the live desk was actually in on 2026-09-29.
  const armed = risk.fitMarginBudget({ size: 1, price: 100, marginRatePct: 20, usedMargin: 0, capPct: cap, equity: 1000 });
  assert.equal(armed.unknown, false, 'an unarmed ceiling on the live desk would have made L3 dead code');
});

test('★ THE ACCESSORS EXIST AND ARE EXPORTED — `risk.js` calls two of them', () => {
  // The other half of the same loss: the guard body survived while `marginRatePct`/`marginRatesFor` did not,
  // so `inst.marginRatePct(...)` would have thrown at the first armed wake. Nothing tested the pair, which is
  // why the suite stayed green while the layer was dead.
  assert.equal(typeof ins.marginRatePct, 'function');
  assert.equal(typeof ins.marginRatesFor, 'function');
  const src = code('trading/agent/instruments.js');
  assert.match(src, /module\.exports = \{[^}]*marginRatePct/, 'exported, or the guard cannot reach it');
  assert.match(src, /module\.exports = \{[^}]*marginRatesFor/, 'both halves of the read must be reachable');
});

test('★ the guard is the LAST sizing control, and that placement is load-bearing', () => {
  const src = code('trading/agent/risk.js');
  const exposure = src.indexOf('fitExposureBudget({');
  const wholeSale = src.indexOf('const fit = fitExposureBudget({');
  const floorClamp = src.indexOf('const acceptFloor');
  const guard = src.indexOf('const mg = fitMarginBudget({');
  assert.ok(exposure > 0 && floorClamp > 0 && guard > 0, 'all three sites must be findable, or this pin is blind');
  assert.ok(guard > wholeSale, 'the margin guard must run after the exposure budget');
  assert.ok(guard > floorClamp,
    'and after the clamp UP to the venue minimum, which can exceed the exposure budget — a guard placed '
    + 'earlier would inspect a size the venue never receives');
});

test('★ the whole guard is gated on being ARMED, and each veto has exactly one emission site', () => {
  const src = code('trading/agent/risk.js');
  assert.match(src, /const marginArmed = Number\.isFinite\(marginCapPctRaw\) && marginCapPctRaw > 0/);
  assert.match(src, /if \(marginArmed\) \{/, 'the read, the fit and both vetos must sit inside the armed branch');
  for (const c of ['margin_utilisation', 'margin_guard_unusable']) {
    const n = (src.match(new RegExp(`veto\\('${c}'`, 'g')) || []).length;
    assert.equal(n, 1, `${c} must be emitted from exactly one site, or a report cannot attribute it to a rule`);
  }
  // FAIL CLOSED: an unusable guard refuses, and says which input failed.
  assert.match(src, /if \(mg\.unknown\) \{[\s\S]{0,600}?veto\('margin_guard_unusable'/,
    'unknown must refuse, not pass');
});

test('★ the decision carries the guard, so a size can be explained after the fact', () => {
  const src = code('trading/agent/risk.js');
  assert.match(src, /sizeCalc = \{[\s\S]{0,1200}?marginGuard: v\.marginGuard \|\| null/,
    'after L2 the guard is the only control that binds, so an un-inspectable guard is the §1.1b defect again');
  assert.match(src, /v\.marginGuard = \{[\s\S]{0,400}?armed: marginArmed/,
    'and the ARMED flag must ride along, or a report cannot tell "inert" from "missing"');
});

test('★ the seat hears both rules WHEN ARMED, and hears neither when the ceiling is off', () => {
  const armed = pb.riskParameterLines({ risk: { maxMarginUtilisationPct: 80 } }).join('\n');
  assert.match(armed, /the book's margin utilisation is already at the 80% ceiling/);
  assert.match(armed, /the margin guard cannot be evaluated \(the venue's margin rate or an open position's notional is unreadable\)/);
  // NON-VACUITY: an unarmed control cannot refuse anything, so printing its rule would describe a gate that
  // does not exist — the same rule the cooldown clause already follows.
  const off = pb.riskParameterLines({ risk: {} }).join('\n');
  assert.ok(!/margin guard cannot be evaluated/.test(off), 'an unarmed ceiling must not print a refusal rule');
  assert.ok(!/margin utilisation is already at/.test(off));
});
