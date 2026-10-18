// test/equity-window.test.js — 2026-09-24. The equity strip grew 6h / 1d / 3d / 1w.
//
// The owner asked for four more windows. Adding the buttons is three lines; making them TRUE is
// the actual work, and three separate things stood between the buttons and an honest chart. All
// three were found by measuring first, not by reading the code:
//
//   1. THE SEED WAS TWO DAYS DEEP. `renderEquity` asked for `hours=48`. A 1w button over a 48h
//      seed draws a week-wide axis with three days of nothing on the left — and because the right
//      edge is pinned to NOW (F7, 2026-09-12), that reads as "flat", not as "missing".
//   2. THE SERVER WAS CAPPED AT 40,000 ROWS, SILENTLY. `listEquityTicks` is
//      `TOP(@limit) ... ORDER BY at DESC`, and the route never forwarded a limit, so the store
//      default applied. MEASURED 2026-09-24 (EquityTicks, userId 1, 135,375 rows from 2026-09-11):
//      6h = 2,303 · 12h = 4,390 · 1d = 11,401 · 3d = 42,581 · 1w = 80,220.
//      So 3d lost its oldest 2,581 rows and 1w lost HALF its rows — newest-first, so the loss was
//      always the LEFT edge, which is exactly where a new long window looks.
//   3. THE LIVE BUFFER DELETED ITS OLDEST POINTS. `if (arr.length > 7200) arr.splice(0, ...)`.
//      Against the old 7,200-point tail that was a trim. Against a week-long seed it is amnesia:
//      the first tick after seeding would have thrown ~90% of it away.
//
// WHAT IS PINNED HERE: the two pure helpers that now own 2 and 3 (behaviourally, extracted from
// the bundle and run for real), plus the structural facts that 1 and 2 cannot silently regress.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { read, code } = require('./_source');

const APP = 'trading/public/js/app.js';
const appSrc = code(APP);

// The equity helpers live in a browser bundle that cannot be `require`d, so the functions are
// lifted out and executed. Brace matching is safe on `code()` output because comments are already
// gone, and neither helper contains a brace inside a string literal.
function extract(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in ${APP}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const ctx = vm.createContext({});
vm.runInContext(`${extract(appSrc, 'eqDecimate')}\n${extract(appSrc, 'eqTrim')}\n`, ctx);
const { eqDecimate, eqTrim } = ctx;

// ~5s spacing and ~13k rows/day match the MEASURED EquityTicks cadence, so the sizes below are the
// real ones rather than convenient ones.
const START = Date.UTC(2026, 8, 17);
const series = (n, stepMs = 5000) => Array.from({ length: n }, (_, i) => ({ x: START + i * stepMs, y: 4000 + Math.sin(i / 500) * 40 }));
const seriesWithGaps = (n, every = 9000) => {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0 && i % every === 0) out.push({ x: out[out.length - 1].x + 1, y: null });
    out.push({ x: START + i * 5000, y: 4000 });
  }
  return out;
};
const countNulls = (a) => a.filter((p) => p.y == null).length;

// --- ★ eqTrim: a fixed-size HISTORY, not a sliding window ---------------------

test('★ eqTrim holds the cap while keeping the SPAN — it never deletes the oldest points', () => {
  const a = series(80220);                      // the measured 1w row count
  const firstX = a[0].x;
  const lastX = a[a.length - 1].x;
  eqTrim(a, 24000);
  assert.ok(a.length <= 24000, `cap not respected: ${a.length}`);
  assert.strictEqual(a[0].x, firstX,
    'the LEFT edge moved — 1d/3d/1w would draw a full-width axis over data that no longer exists');
  assert.strictEqual(a[a.length - 1].x, lastX, 'the right edge must never move');
  assert.ok(a.length > 1000, `history crushed to ${a.length} points — degradation should be gradual`);
});

test('★ eqTrim never drops a null gap marker', () => {
  const a = seriesWithGaps(80220);
  const nulls = countNulls(a);
  assert.ok(nulls >= 8, `fixture should carry gaps, got ${nulls}`);
  eqTrim(a, 24000);
  assert.strictEqual(countNulls(a), nulls,
    'dropping a gap marker joins two segments the desk deliberately refused to connect');
});

test('eqTrim is a no-op while the series is under the cap', () => {
  const a = series(5000);
  const copy = a.slice();
  eqTrim(a, 24000);
  assert.deepStrictEqual(a, copy);
});

// --- ★ eqDecimate: fit a week into a canvas ----------------------------------

test('★ eqDecimate holds the budget and anchors BOTH edges', () => {
  const raw = series(80220);
  const out = eqDecimate(raw, 16000);
  assert.ok(out.length <= 16000 + 16, `budget blown: ${out.length}`);
  assert.ok(out.length >= 16000 - 16, `over-decimated: ${out.length}`);
  assert.strictEqual(out[0].x, raw[0].x, 'the left edge must survive decimation');
  assert.strictEqual(out[out.length - 1].x, raw[raw.length - 1].x,
    'the newest seed point must survive, or the seed hangs off the live feed on a hole');
});

test('eqDecimate keeps x strictly increasing (Chart.js runs parsing:false)', () => {
  const out = eqDecimate(seriesWithGaps(80220), 16000);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i].x > out[i - 1].x, `x not increasing at ${i}: ${out[i - 1].x} -> ${out[i].x}`);
  }
});

test('eqDecimate never drops a null gap marker either', () => {
  const raw = seriesWithGaps(80220);
  const out = eqDecimate(raw, 16000);
  assert.strictEqual(countNulls(out), countNulls(raw));
});

test('eqDecimate is a no-op under budget, so short windows keep full resolution', () => {
  const raw = series(11401);                    // the measured 1d row count
  assert.strictEqual(eqDecimate(raw, 16000), raw);
});

// --- the structural facts that cannot regress silently ------------------------

test('the equity strip offers 6h, 1d, 3d and 1w', () => {
  const html = read('trading/public/index.html');
  for (const [ms, label] of [['21600000', '6h'], ['86400000', '1d'], ['259200000', '3d'], ['604800000', '1w']]) {
    assert.match(html, new RegExp(`data-eqwin="${ms}"[^>]*>${label}<`), `the ${label} window is missing`);
  }
  // the pre-existing windows must survive the change
  for (const [ms, label] of [['1800000', '30m'], ['7200000', '2h'], ['43200000', '12h'], ['all', 'all']]) {
    assert.match(html, new RegExp(`data-eqwin="${ms}"[^>]*>${label}<`), `the ${label} window was lost`);
  }
});

test('★ the live buffer no longer DELETES its oldest points', () => {
  assert.ok(!/arr\.splice\(0,\s*arr\.length - 7200\)/.test(appSrc),
    'splicing the oldest points away makes a week-long window draw a full axis over missing data');
  assert.match(appSrc, /eqTrim\(arr, EQ_POINT_CAP\)/, 'the trim must go through the span-preserving helper');
});

test('★ the seed reaches a week and the server is allowed to serve it', () => {
  assert.match(appSrc, /const EQ_SEED_HOURS = 168/, 'a 1w window needs a 1w seed');
  assert.match(appSrc, /hours=\$\{EQ_SEED_HOURS\}&tickLimit=\$\{EQ_TICK_LIMIT\}/,
    'the request must carry both the window and an explicit tick cap');
  const routes = code('trading/routes.js');
  assert.match(routes, /listEquityTicks\(req\.user\.userID, \{ hours, limit: tickLimit \}\)/,
    'without forwarding a limit the store default (40,000) silently cuts a 1w window to ~2.4 days');
  // and the events cap must NOT be reused for ticks — 4,000 rows would cut a week to under a day
  assert.ok(!/listEquityTicks\(req\.user\.userID, \{ hours, limit \}\)/.test(routes),
    'the coarse events limit must not be reused as the fine tick limit');
});

test('★ the response says when the series was clipped', () => {
  const routes = code('trading/routes.js');
  assert.match(routes, /truncated: \{ ticks:/, 'a truncated window is the silent lie this guards');
  assert.match(appSrc, /eqState\.seedTruncated = !!/, 'the client must read it');
});

test('the panel states how deep the series actually goes', () => {
  assert.match(read('trading/public/index.html'), /id="eq-span"/, 'the readout must exist');
  assert.match(appSrc, /function eqRenderNote\(\)/);
  assert.match(appSrc, /\$\('eq-span'\)/, 'and the app must populate it');
});

// --- ★ the depth readout, run for real against a stubbed DOM -------------------

const eqRenderNote = (() => {
  const src = extract(appSrc, 'eqRenderNote');
  return (live, windowMs, seedTruncated = false) => {
    const el = { textContent: '', title: '' };
    const c = vm.createContext({ eqState: { live, windowMs, seedTruncated }, $: (id) => (id === 'eq-span' ? el : null) });
    vm.runInContext(src, c);
    c.eqRenderNote();
    return el;
  };
})();
const heldSeries = (days) => {
  const n = 200;
  const end = Date.now();
  return Array.from({ length: n }, (_, i) => ({ x: end - (days * 86400000) * (1 - i / (n - 1)), y: 4000 }));
};

test('★ a window wider than the series is CALLED OUT, from the data alone', () => {
  // 7 days asked for, 2.4 held — the measured shape of a 1w window served by the old 40k cap.
  const note = eqRenderNote(heldSeries(2.4), 604800000);
  assert.match(note.textContent, /⚠/, 'a full-width axis over a partial series must not look complete');
  assert.match(note.textContent, /7\.0d window over 2\.4d held/, `got: ${note.textContent}`);
  assert.match(note.title, /LEFT edge is empty/);
});

test('the same readout is quiet when the series really does cover the window', () => {
  const note = eqRenderNote(heldSeries(7), 604800000);
  assert.ok(!/⚠/.test(note.textContent), `a covered window must not warn: ${note.textContent}`);
  assert.match(note.textContent, /7\.0d held/);
});

test('"all" never warns, and the point count is always reported', () => {
  const note = eqRenderNote(heldSeries(0.4), 0);
  assert.ok(!/⚠/.test(note.textContent), 'the all-window has no width to fall short of');
  assert.match(note.textContent, /pts$/);
});

test('the seed-cap cause is named separately from the shortfall', () => {
  const note = eqRenderNote(heldSeries(2.4), 604800000, true);
  assert.match(note.textContent, /seed clipped at the row cap/);
  assert.match(note.title, /row cap/);
});

test('an empty series renders nothing rather than "0.0d held"', () => {
  assert.strictEqual(eqRenderNote([], 7200000).textContent, '');
});

test('a 1d window labels ticks with a DATE, not bare HH:MM', () => {
  // At exactly 24h, two ticks a full day apart printed the identical label.
  assert.match(appSrc, /eqState\.windowMs >= 86400000/, 'the date threshold must include the 1d window');
});

// ============================================================================================
// 2026-09-30 — A BREAK IN *LEVEL*, NOT ONLY IN TIME. THE OWNER SAW THE CURVE GO FLAT.
//
// `eqWithBreaks` refused to connect two samples separated by a missing STRETCH OF TIME. Nothing
// refused to connect two samples separated by an impossible JUMP IN VALUE, so a 186x discontinuity
// was drawn as a vertical line — and, because Chart.js sizes the y-axis to EVERY non-null point and
// the seed is fetched once at 168h and never re-fetched when the window changes, one excursion
// flattened the curve for every window at once.
//
// MEASURED 2026-09-30 (EquityTicks, userId 1, 66,099 rows in the 168h seed): **30 consecutive rows at
// `equity = 22.28`**, 2026-09-29T07:54:22.520Z .. 07:56:56.860Z (154 s), against ~4,149 either side.
// 22.28 is the MINIMUM OF THE WHOLE SEED (max 4,159.49) while the week's LARGEST REAL hourly swing is
// **74.97** — so the outlier is ~55x the biggest genuine move. The desk detected it and said so:
// `account_switch {from: 22.28, to: 4149.67, ratio: 186.2509}` at 07:57:00.866Z.
//
// WHY EVERY GUARD PASSED IT, ON PURPOSE:
//   * `agent/accountPoller.js` `isPlausibleSample` returns TRUE for a >5x break by design —
//     `if (isAccountSwitch(acc, prev)) return true;` ("account change — never a strip flicker") — and
//     the SAME iteration then calls `addEquityTick` unconditionally. That module's own header names this
//     exact value and this exact harm: "live: 4025 -> 22.28 in one poll ... and the equity curve
//     recorded the $22 dip". It re-baselines the RISK baselines and leaves the TELEMETRY harm it names.
//   * `eqDespike` only bites when `pnl === 0` AND the stripped-balance identity holds; here
//     |22.28 - 4149| is ~4,127, far outside its tolerance, so the point is kept.
//   * `eqWithBreaks` sees samples 5 s apart — no time gap at all.
//
// The POLLER IS RIGHT to accept the new level (a real switch must not leave the desk blind), so the fix
// belongs in the chart: draw a switch as a GAP, which is what `eqDecimate`'s own comment already
// demands — "removing one joins two segments the desk deliberately refused to connect".
// ============================================================================================

const lvlCtx = vm.createContext({ eqState: {} });
vm.runInContext([
  'const EQ_LEVEL_BREAK_LO = 0.2;',
  'const EQ_LEVEL_BREAK_HI = 5;',
  `const EQ_LEVEL_MIN_MS = ${/const EQ_LEVEL_MIN_MS = ([^;]+);/.exec(appSrc)[1]};`,
  extract(appSrc, 'eqIsLevelBreak'),
  extract(appSrc, 'eqBreakOnLevel'),
].join('\n'), lvlCtx);
const { eqIsLevelBreak } = lvlCtx;

// ⚠ THE FUNCTION RETURNS THE ARRAY, NOT A BAG. Its contract is `out` as the return value PLUS
// `eqState.levelBreaks` / `eqState.levelSuppressed` as the counts the panel reads — because
// `renderEquity` wants the series and `eqRenderNote` wants the totals. My first version of these tests
// asserted a `{ out, breaks, suppressed }` object the function has never returned, and read `undefined`.
// The wrapper below exercises the REAL contract instead of a shape invented here.
const breakOnLevel = (pts) => {
  lvlCtx.eqState.levelBreaks = 0;
  lvlCtx.eqState.levelSuppressed = 0;
  const out = lvlCtx.eqBreakOnLevel(pts);
  return { out, breaks: lvlCtx.eqState.levelBreaks, suppressed: lvlCtx.eqState.levelSuppressed };
};

// A 154 s excursion at 22.28, at the measured cadence, into an otherwise ~4,149 series.
// ⚠ THE TAIL IS PART OF THE FIXTURE AND WAS MISSING AT FIRST. Ending the series immediately after the return
// made the return trip a ONE-SAMPLE run (runMs 0), which the persistence rule correctly treats as an
// unconfirmed flicker and withholds — so the test failed on its own fixture, not on the code. A real series
// resumes at the old level for hours, and only then is the return a sustained level. Fix the fixture.
const excursion = (ms, y = 22.28, step = 5000, tailMs = 15 * 60 * 1000) => {
  const out = [{ x: START, y: 4149.76, pnl: 0 }];
  for (let t = 0; t <= ms; t += step) out.push({ x: START + step + t, y, pnl: 0 });
  for (let t = step; t <= tailMs; t += step) out.push({ x: START + step + ms + t, y: 4149.67, pnl: 0 });
  return out;
};

test('the level-break threshold IS the poller\'s own account-switch definition', () => {
  // One definition, two consumers. If the poller's rule moves, this test fails rather than the chart
  // silently keeping a different idea of what a switch is.
  const poller = read('trading/agent/accountPoller.js');
  assert.match(poller, /ratio < 0\.2 \|\| ratio > 5/, 'the poller rule moved — re-derive the chart rule');
  assert.match(appSrc, /EQ_LEVEL_BREAK_LO = 0\.2/);
  assert.match(appSrc, /EQ_LEVEL_BREAK_HI = 5/);
});

test('a TRANSIENT excursion is withheld from the plot, not drawn and not scaled against', () => {
  const { out, breaks, suppressed } = breakOnLevel(excursion(150000));
  assert.strictEqual(breaks, 1, 'one excursion is one break');
  assert.strictEqual(suppressed, 31, 'every sample of a sub-10-minute excursion is withheld');
  const plotted = out.filter((p) => p.y != null).map((p) => p.y);
  assert.ok(plotted.every((y) => y > 1000), `no excursion value may reach the axis: ${Math.min(...plotted)}`);
  assert.ok(out.some((p) => p.y == null), 'and a gap must be left where it was');
});

test('a PERSISTENT excursion is ADOPTED after a gap — a real switch is never hidden', () => {
  const { out, breaks, suppressed } = breakOnLevel(excursion(30 * 60 * 1000));
  // ⚠ TWO breaks, not one — and that is correct behaviour rather than a defect: once the sustained level is
  // adopted as the new baseline, the RETURN to the old level is a fresh 186x break of its own. Each direction
  // gets its own gap, so the chart shows three segments — old level, new level, old level — with no fabricated
  // line between any of them. My first version asserted 1, which would have required the return trip to be
  // silently joined to the new level.
  assert.strictEqual(breaks, 2, 'a switch out and back is two breaks');
  assert.strictEqual(suppressed, 0, 'a sustained level is the account, so nothing is withheld');
  assert.ok(out.some((p) => p.y === 22.28), 'the new level must be plotted');
  const gaps = out.map((p, i) => (p.y == null ? i : -1)).filter((i) => i >= 0);
  assert.strictEqual(gaps.length, 2, 'and BOTH transitions must be separated by a gap');
  const firstNew = out.findIndex((p) => p.y === 22.28);
  assert.ok(gaps[0] < firstNew && gaps[1] > firstNew, 'the new segment sits between the two gaps');
});

test('CONTROL: a real move is never broken — the week\'s largest measured swing survives intact', () => {
  // 74.97 is the largest hourly swing measured in the seed window (2026-09-29 08: 4,074.91..4,149.88).
  const real = [{ x: 1, y: 4149.11, pnl: 0 }, { x: 2, y: 4074.91, pnl: -74.2 }, { x: 3, y: 4159.49, pnl: 10 }];
  assert.strictEqual(breakOnLevel(real).breaks, 0, 'a P&L move must never be gapped');
  assert.strictEqual(eqIsLevelBreak(4149.11, 4074.91), false);
  assert.strictEqual(eqIsLevelBreak(4074.91, 4159.49), false);
  // and the threshold cannot be tightened into ordinary movement: a 20% move is still real P&L.
  assert.strictEqual(eqIsLevelBreak(100, 80), false);
  assert.strictEqual(eqIsLevelBreak(100, 120), false);
  // the documented excursion, both directions.
  assert.strictEqual(eqIsLevelBreak(4149.76, 22.28), true);
  assert.strictEqual(eqIsLevelBreak(22.28, 4149.67), true);
});

test('a zero or negative equity is NOT this fault and is left alone', () => {
  // `Number(null) === 0` is this repo's most repeated defect; a 0/missing reading must not be silently
  // reclassified as a level break, and must not divide by zero.
  assert.strictEqual(eqIsLevelBreak(0, 4149), false);
  assert.strictEqual(eqIsLevelBreak(4149, 0), false);
  assert.strictEqual(eqIsLevelBreak(null, 4149), false);
  assert.strictEqual(eqIsLevelBreak(4149, null), false);
});

test('the seed path applies the level rule, and the live path HOLDS a breaking tick', () => {
  // Structural, because the two call sites are what make the helper reach the screen.
  assert.match(appSrc, /const raw = eqBreakOnLevel\(eqWithBreaks\(/, 'the seed must run the level rule');
  assert.match(appSrc, /eqState\.pending = \{ from: lastReal\.y, at: x, samples: \[\{ x, y \}\] \}/,
    'a live breaking tick must be parked, not plotted');
  assert.match(appSrc, /if \(x - pend\.at >= EQ_LEVEL_MIN_MS\)/,
    'and the live rule must use the SAME persistence test as the seed, not a second idea of it');
});

test('the break is NAMED on screen, so a gapped chart is not read as missing data', () => {
  assert.match(appSrc, /eqState\.levelBreaks/, 'the count must reach the panel');
  assert.match(appSrc, /withheld/, 'and the withheld sample count must be visible');
  assert.match(appSrc, /NOTHING IS LOST/, 'the note must say the readings survive in the record');
});

