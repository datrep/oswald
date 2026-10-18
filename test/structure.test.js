// test/structure.test.js — S1a: the structure engine's determinism and anti-lookahead contract.
//
// ★ WHAT THIS FILE IS ACTUALLY PROTECTING. The design doc
// (docs/structure-engine-design-2026-09-22.md §7, §9) names ONE failure as the most likely way this
// quietly produces a great backtest and a bad desk:
//
//   "Lookahead through confirmation lag — the single most likely way this silently produces a great
//    backtest and a bad desk."
//
// A swing high at bar `i` is only knowable at `i + k`, and a liquidity sweep needs `m` more bars. If the
// engine ever reports a fact as if it were available EARLIER than it was, the backtest trades on
// information the live desk would not have had — and it does so invisibly, because the output looks
// correct. Every non-trivial test below exists to make that failure impossible to introduce silently.
//
// ★ THE CENTRAL ONE IS THE PREFIX PROPERTY:
//
//   for every `n`:  the facts CONFIRMED at asOf = n
//     must equal    the facts a full-history run says were confirmed by n
//
// Not a subset — EQUAL. Fewer means facts were dropped (an engine that forgets), more means facts were
// used early (an engine that cheats), and the two failures look nothing alike but are caught by one
// assertion. This is possible only because `computeStructure` confines itself to bars[0..asOf]: a swing
// confirmed at i+k <= asOf has its whole defining window inside the view, so its status cannot change
// when more data arrives. If someone ever widens that view, this test is what fails.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeStructure, DEFAULTS } = require('../trading/agent/structure');

const MODULE_PATH = path.join(__dirname, '..', 'trading', 'agent', 'structure.js');
const SRC = fs.readFileSync(MODULE_PATH, 'utf8');
// Strip comments before scanning for forbidden calls: the header DISCUSSES volume and lookahead at
// length, and a pin that matches prose instead of code fails on correct code (the TRD-68 lesson).
const stripComments = (s) => s.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const CODE = stripComments(SRC);

const B = { venue: 'plus500_chart', timeframe: '1h', sourceIntervalSec: 3600 };
// The DEFAULT parameter set — whatever the registered defaults are. The generator-based tests use this, so
// they exercise the REAL defaults rather than a copy that can drift away from them.
const P = { ...DEFAULTS, minBars: 40 };
// ★ And the hand-built fixtures state k=2 EXPLICITLY, because they were constructed for a 5-bar window and
// hand-verified at it. Relying on the default made them silently dependent on a value that is a
// pre-registered parameter — i.e. one that is EXPECTED to change after measurement (and did: k=2 -> k=4).
// A test that pins behaviour must pin its inputs.
const P2 = { ...DEFAULTS, k: 2, minBars: 40 };

// A triangle wave: peaks at i % 8 === 4, troughs at i % 8 === 0. Turning points are known by
// construction, so the expected swings are derived from the generator rather than pasted in — which
// means this fixture cannot drift out of step with its own assertion.
function zigzag(n, { period = 8, base = 100, amp = 10 } = {}) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const t = i % period;
    const tri = t <= period / 2 ? t : period - t;
    const mid = base + tri * (amp / (period / 2));
    bars.push({
      barStart: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
      openPrice: mid - 0.4, high: mid + 0.5, low: mid - 0.5, closePrice: mid + 0.4,
    });
  }
  return bars;
}

// A triangle wave WITH DRIFT: peaks at i % 8 === 4, troughs at i % 8 === 0, and each pair higher than
// the last, so `direction` resolves to bullish and the BOS/MSS paths are actually reachable.
function driftingZigzag(n, { period = 8, base = 100, scale = 2.5, drift = 0.5 } = {}) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const t = i % period;
    const tri = t <= period / 2 ? t : period - t;
    bars.push(mk(base + drift * i + tri * scale, i));
  }
  return bars;
}

const iso = (i) => new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString();
const mk = (mid, i, { bull = true, wick = 0 } = {}) => ({
  barStart: iso(i),
  openPrice: bull ? mid - 0.4 : mid + 0.4,
  high: mid + 0.5 + wick,
  low: mid - 0.5,
  closePrice: bull ? mid + 0.4 : mid - 0.4,
});

// Every `confirmedAtIndex` in the result that is NOT part of a provisional swing. Provisional facts are
// allowed to point past the decision bar BY DEFINITION — that is what "provisional" means, and they are
// labelled so the caller cannot mistake them for known. Confirmed facts have no such excuse.
function confirmationIndices(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const x of node) confirmationIndices(x, acc); return acc; }
  if (node.status === 'provisional') return acc;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'confirmedAtIndex' && Number.isInteger(v)) acc.push(v);
    else if (v && typeof v === 'object') confirmationIndices(v, acc);
  }
  return acc;
}

// ---------------------------------------------------------------------------
test('premise: asOf is required, and it is required because a default would be the lookahead path', () => {
  const bars = zigzag(80);
  assert.throws(() => computeStructure({ bars }), /asOf is required/,
    'a missing asOf must throw — defaulting it to "the last bar" is the bug this engine exists to avoid');
  assert.throws(() => computeStructure({ bars, asOf: 'nope' }), /asOf is required/);
  assert.throws(() => computeStructure({ bars, asOf: 999 }), /outside/);
  assert.throws(() => computeStructure({ bars, asOf: 79, params: { k: 0 } }), /k must be an integer/);
  // ...and the happy path is reachable from the same call shape.
  assert.equal(computeStructure({ bars, asOf: 79, params: P, basis: B }).state, 'ok');
});

test('insufficient_history is its OWN state, never an empty structure', () => {
  // §4.3/§7 rule 3: a blank structure is indistinguishable from "no structure", and that distinction
  // already cost this desk once (TRD-66's not_demo / blank).
  const r = computeStructure({ bars: zigzag(20), asOf: 19, params: { ...DEFAULTS, minBars: 60 }, basis: B });
  assert.equal(r.state, 'insufficient_history');
  assert.match(r.reason, /< minBars/);
  assert.deepEqual(r.swings, [], 'the shape of an insufficient result must not depend on WHY (§4.3)');
  assert.deepEqual(r.basis, {
    ...B,
    // Added 2026-09-22 with the venue question: the basis names WHICH series the levels came from and WHY
    // it was chosen (`trading/scripts/repro/venue-fidelity-audit.js`). Always PRESENT and null when the
    // caller resolved no venue — this file's own rule is the reason they are not conditionally added: a
    // shape that depends on the inputs is the thing §4.3 forbids one line up.
    venueWhy: null,
    venueBars: null,
    asOf: 19,
    asOfBarStart: zigzag(20)[19].barStart,
  });
  // ...and when the caller DOES supply them they must survive `outBasis`, which is built field-by-field.
  const resolved = computeStructure({
    bars: zigzag(20), asOf: 19, params: { ...DEFAULTS, minBars: 60 },
    basis: { ...B, venueWhy: 'chart_series_faithful', venueBars: 300 },
  });
  assert.equal(resolved.basis.venueWhy, 'chart_series_faithful');
  assert.equal(resolved.basis.venueBars, 300);
});

test('swings are found at the generator\'s turning points, and each reports when it became true', () => {
  const bars = zigzag(120);
  const asOf = 119;
  const r = computeStructure({ bars, asOf, params: P, basis: B });
  assert.equal(r.state, 'ok');

  const confirmed = r.swings.filter((s) => s.status === 'confirmed');
  const highs = confirmed.filter((s) => s.kind === 'high').map((s) => s.index);
  const lows = confirmed.filter((s) => s.kind === 'low').map((s) => s.index);
  const expectHighs = []; const expectLows = [];
  for (let i = P.k; i + P.k <= asOf; i++) (i % 8 === 4 ? expectHighs : (i % 8 === 0 && i > 0 ? expectLows : null))?.push(i);
  assert.deepEqual(highs, expectHighs, 'peaks of the triangle wave');
  assert.deepEqual(lows, expectLows, 'troughs of the triangle wave');

  for (const s of confirmed) {
    assert.equal(s.confirmedAtIndex, s.index + P.k, 'confirmation lag is exactly k');
    assert.equal(s.lagBars, asOf - s.confirmedAtIndex, 'lagBars is measured from the decision bar');
    assert.ok(s.lagBars >= 0);
    assert.ok(s.barStart && s.confirmedAtBarStart, 'every fact carries its basis (§3)');
  }
});

test('★ the confirmation boundary: a swing at i is NOT knowable at i+k-1, and is provisional there', () => {
  const bars = zigzag(120);
  const peak = 4; // first turn of the triangle wave; with k=2 it is confirmed at 6
  // minBars has to come DOWN for this test: the question is about bar 5, and the production 60-bar floor
  // would turn the whole answer into `insufficient_history` and hide the thing being tested.
  const small = { ...P2, minBars: 5 };
  assert.equal(small.k, 2, 'this fixture is built for a 5-bar window and says so');

  const before = computeStructure({ bars, asOf: peak + small.k - 1, params: small, basis: B });
  const at = computeStructure({ bars, asOf: peak + small.k, params: small, basis: B });

  // ★ At i+k-1 the engine CANNOT yet claim a confirmed swing — there is none to claim — and it says so
  // with its own state rather than by returning an empty structure (§4.3). But it does NOT throw away what
  // it did find: the candidate is still reported, labelled provisional. That distinction is the whole point
  // of this test in both directions — not confirmed too early, and not invisible either.
  assert.equal(before.state, 'insufficient_history');
  assert.match(before.reason, /no confirmed swing/);
  const candidate = before.swings.filter((s) => s.index === peak);
  assert.equal(candidate.length, 1, 'the candidate is still visible — insufficient_history is not a blank');
  assert.equal(candidate[0].status, 'provisional',
    'at i+k-1 it must be PROVISIONAL: the window is not closed, so it is knowable as a candidate only');
  assert.equal(before.swings.filter((s) => s.index === peak && s.status === 'confirmed').length, 0,
    'it must not be CONFIRMED one bar early — this is the lookahead the doc calls the likeliest way to be wrong');

  assert.equal(at.state, 'ok');
  const nowAt = at.swings.find((s) => s.index === peak && s.status === 'confirmed');
  assert.ok(nowAt, 'at i+k it is confirmed');
  assert.equal(nowAt.lagBars, 0, 'and it is brand new — lag 0, not a negative lag');
});

test('★ the equal-high plateau collapses to ONE swing, with the documented tie-break order', () => {
  // Three consecutive equal highs are ONE level. Emitting three would manufacture HH/LL labels out of
  // nothing (§3). Tie-break as this file defines it and documents in its header: higher close wins, then
  // the later index — the only ordering under which the close can break a tie at all.
  const highs = [10, 11, 12, 13, 13, 13, 12, 11, 10, 9, 8, 8, 8, 9, 10, 11, 12, 13, 14, 13];
  const bars = highs.map((h, i) => ({
    barStart: new Date(Date.UTC(2026, 0, 1) + i * 3600000).toISOString(),
    openPrice: h - 1, high: h, low: h - 2,
    // close is higher at index 4 than at 3 or 5, so 4 must win even though 5 is LATER
    closePrice: i === 4 ? h + 0.9 : h - 0.1,
  }));
  const r = computeStructure({ bars, asOf: 19, params: { ...P2, minBars: 6 }, basis: B });
  const plateauSwings = r.swings.filter((s) => s.kind === 'high' && s.price === 13);
  assert.equal(plateauSwings.length, 1, 'one swing per plateau, not one per bar');
  assert.equal(plateauSwings[0].index, 4, 'the higher close wins over the later index');
  assert.deepEqual(plateauSwings[0].plateau, [3, 4, 5], 'and the collapsed plateau is reported, not hidden');
});

test('★ THE PREFIX PROPERTY: a fact confirmed at n is exactly the fact a full run says was confirmed by n', () => {
  const bars = zigzag(200);
  const asOfFull = bars.length - 1;
  const full = computeStructure({ bars, asOf: asOfFull, params: P, basis: B });
  const key = (s) => `${s.kind}:${s.index}:${s.price}:${s.label}:${s.status}`;

  let checked = 0;
  for (let n = P.minBars; n < bars.length; n++) {
    const at = computeStructure({ bars, asOf: n, params: P, basis: B });
    if (at.state !== 'ok') continue;

    const shortConfirmed = at.swings.filter((s) => s.status === 'confirmed').map(key);
    const fullConfirmedByNow = full.swings
      .filter((s) => s.status === 'confirmed' && s.confirmedAtIndex <= n).map(key);

    // EQUAL, not subset. Fewer = the engine forgets; more = the engine cheats.
    assert.deepEqual(shortConfirmed, fullConfirmedByNow,
      `at asOf=${n} the confirmed set differs from the full run's confirmed-by-${n} set — this is the lookahead defect`);

    // The same, stated once at the level of the whole result rather than the swing list: NO confirmed
    // fact anywhere in the object may claim to have become true after the decision bar.
    for (const idx of confirmationIndices(at)) {
      assert.ok(idx <= n, `a confirmed fact at asOf=${n} claims confirmedAtIndex=${idx} — it is from the future`);
    }
    checked++;
  }
  assert.ok(checked > 100, `the prefix property must actually be exercised across the series (checked ${checked})`);
});

test('★ direction, protected level, BOS and MSS are consistent with each other at every step', () => {
  const bars = zigzag(200);
  for (let n = P.minBars; n < bars.length; n++) {
    const r = computeStructure({ bars, asOf: n, params: P, basis: B });
    if (r.state !== 'ok') continue;

    if (r.direction === 'range') {
      assert.equal(r.protected, null, 'with no prevailing direction there is nothing to protect');
      assert.equal(r.bos, null, 'and BOS is undefined rather than invented (§3 has no range case)');
      assert.equal(r.mss, null);
      continue;
    }

    assert.ok(r.protected, `${r.direction} must name a protected level`);
    // The protected level is AGAINST the trend: bull holds on a swing LOW, bear on a swing HIGH.
    assert.equal(r.protected.side, r.direction === 'bullish' ? 'low' : 'high');

    // BOS continues the trend, MSS breaks it — so if both exist they cannot be the same bar at the same
    // level. (§3's MSS row calls them "the same event"; this engine deliberately disagrees, and the
    // header says so. If that is ever "fixed" back, this assertion is what objects.)
    if (r.bos && r.mss) {
      assert.notEqual(r.bos.index, r.mss.index,
        'BOS and MSS must not be reported as the same bar — they are different levels on different sides');
    }
    if (r.bos) {
      const c = Number(bars[r.bos.index].closePrice);
      assert.ok(r.direction === 'bullish' ? c > r.bos.level : c < r.bos.level,
        `BOS must be a CLOSE beyond its level, not a wick (§3)`);
    }
    if (r.mss) {
      const c = Number(bars[r.mss.index].closePrice);
      assert.ok(r.direction === 'bullish' ? c < r.mss.level : c > r.mss.level,
        'MSS must be a close AGAINST the trend, through the protected level');
    }
  }
});

test('displacement requires BOTH conditions, and an order block requires a displacement to exist behind it', () => {
  // A fixture DELIBERATELY BUILT for this: the plain triangle wave has a constant body, so it can never
  // displace and the test would pass vacuously. Two bars are overridden — 57 made BEARISH (the opposing
  // candle) and 58 given a large BULLISH body that closes above the last confirmed swing high.
  const bars = driftingZigzag(70);
  bars[57] = mk(131, 57, { bull: false });
  bars[58] = { barStart: iso(58), openPrice: 131.5, high: 146, low: 131, closePrice: 145 };

  const asOf = 58;
  const r = computeStructure({ bars, asOf, params: P2, basis: B });
  assert.equal(r.state, 'ok');

  // Condition 1 (>= d * ATR14) and condition 2 (>= r * mean body) are BOTH required — each alone flags
  // noise (§3), so the result must report both ratios rather than a verdict.
  assert.ok(r.displacement, 'the fixture must actually displace, or this test is vacuous');
  assert.equal(r.displacement.index, asOf);
  assert.ok(r.displacement.body >= P.d * r.displacement.atr14, 'condition 1: body >= d * ATR14');
  assert.ok(r.displacement.body >= P.r * r.displacement.meanBody, 'condition 2: body >= r * mean body');

  assert.ok(r.bos, 'and the same bar closes beyond the last confirmed swing high, which is a BOS');
  assert.equal(r.bos.index, asOf);
  assert.ok(r.orderBlock, 'an order block exists because a displacement AND a BOS exist behind it');
  assert.equal(r.orderBlock.index, 57, 'it is the last OPPOSING candle before the leg — bar 57, made bearish');
  assert.equal(r.orderBlock.kind, 'bearish');
});

test('a sweep is only knowable once the close has come back inside — the worst lag in the set (§3)', () => {
  // The triangle wave's peak at index 52 is the last confirmed swing high (confirmed at 54). Bar 58 then
  // wicks ABOVE it but CLOSES above it too — so the wick is visible and the sweep is NOT: a sweep is a
  // wick whose CLOSE returns inside, and until that close exists there is nothing to report. Bar 59 is the
  // bar that closes back inside. Everything here is about bar 52's level, because OTHER swings in this
  // fixture may legitimately sweep too and a total count would be a fragile proxy for the property.
  const bars = driftingZigzag(70);
  const level = Number(bars[52].high); // 136.5
  bars[58] = { barStart: iso(58), openPrice: 136.5, high: level + 3.5, low: 135, closePrice: level + 0.5 };
  bars[59] = { barStart: iso(59), openPrice: level + 0.4, high: level + 1, low: level - 2.5, closePrice: level - 1.5 };

  const before = computeStructure({ bars, asOf: 58, params: P2, basis: B });
  const after = computeStructure({ bars, asOf: 59, params: P2, basis: B });

  assert.equal(before.sweeps.filter((x) => x.swingIndex === 52).length, 0,
    'the wick alone is not a sweep — it closed ABOVE the level, so nothing has been swept yet');
  const s = after.sweeps.find((x) => x.swingIndex === 52);
  assert.ok(s, 'the sweep becomes knowable on the bar that closes back inside');
  assert.equal(s.swingKind, 'high');
  assert.equal(s.sweepIndex, 58, 'the wick was made at 58');
  assert.equal(s.closeBackInsideIndex, 59, 'and it returned inside at 59 — one bar later');
  assert.equal(s.lagBars, 0, 'lag is measured from the bar it became knowable, not the wick');
});

test('the module is PURE: no I/O, no clock, no randomness, and never a volume read', () => {
  // S1 is volume-free by design (§4.2, §6 P2 item 1) — the venue's volume column is unusable AND
  // historically empty (§4.1). A structure engine that quietly started reading volume would be picking up
  // a field that is zero for every row written since 2026-09-15.
  for (const forbidden of [/require\(['"][^'"]*store/, /require\(['"][^'"]*db['"]/, /getPool/, /Date\.now/, /new Date\(/, /Math\.random/]) {
    assert.doesNotMatch(CODE, forbidden, `structure.js must be pure — found ${forbidden}`);
  }
  assert.doesNotMatch(CODE, /volume/i, 'structure.js must not read volume (S1 is volume-free)');
  const requires = [...CODE.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepEqual(requires, ['./indicators'], 'the only dependency is the existing indicator math');
});

test('the result shape is stable, and every field that can be absent says so explicitly', () => {
  const bars = zigzag(120);
  const r = computeStructure({ bars, asOf: 119, params: P, basis: B });
  assert.deepEqual(Object.keys(r).sort(), [
    'basis', 'bos', 'dealingRange', 'direction', 'displacement', 'fvg', 'mss',
    'orderBlock', 'ote', 'params', 'position', 'protected', 'state', 'sweeps', 'swings',
  ].sort(), 'a consumer reading bundleObj-style must not get a different picture than the prompt');
  assert.equal(r.basis.venue, 'plus500_chart');
  // ★ sourceIntervalSec travels with the result because tfMap maps BOTH 1800 and 3600 to '1h' — a '1h'
  // row has two possible provenances and this is the only field that distinguishes them (§4.1).
  assert.equal(r.basis.sourceIntervalSec, 3600);
  assert.equal(r.params.k, P.k, 'the params actually used are echoed back, so no run is ambiguous later');
  assert.ok(Array.isArray(r.sweeps) && Array.isArray(r.fvg) && Array.isArray(r.swings));
});
