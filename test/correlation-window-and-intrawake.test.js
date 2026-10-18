// test/correlation-window-and-intrawake.test.js — TRD-RSK-3 (#1451) and TRD-RSK-5 (#1456) pins.
//
//   TRD-RSK-3: "the window is the one the refusal names." The gate said "30d log-returns" and read 12,000
//   hourly bars with no date filter, i.e. 733 days. Measured on Gold|Silver: 11,476 return pairs over 733
//   days -> rho 0.7763, against 435 pairs over 28.3 days -> rho 0.688. That difference DECIDED a live
//   refusal, because 0.688 is under the 0.7 threshold and 0.7763 is over it.
//
//   TRD-RSK-5: "one wake, one book decision." The correlation veto is evaluated against the book snapshot
//   taken once at wake start, so two entries deliberated in the same wake were never compared to each
//   other. Measured: wake #105365 was handed a 1-position book and opened Gold AND Silver together, 12
//   seconds after the same gate refused Silver against an open Gold.
//
// `returnsCorrelation` and `correlationClash` are tested BEHAVIOURALLY by patching the store's bar read.
// That is the seam that matters: the rule is about which bars it looks at, and stubbing the read is the
// only way to assert that without a database. The suite runs one child process per file, and the patch is
// restored afterwards so nothing else is affected.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const store = require('../trading/store');
const risk = require('../trading/agent/risk');
const { correlation } = require('../trading/agent/indicators');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ---------------------------------------------------------------------------------------------
// A stub for the ONE thing the rule reads: the bar series.
// ---------------------------------------------------------------------------------------------

// ⚠ THE CALLBACK IS AWAITED BEFORE THE STUB IS RESTORED. The first version called `fn()` and restored in
// `finally`, which puts the real read back as soon as the callback returns its PROMISE — so every assertion
// after the first `await` inside it ran against the live database, where symbols 'A'/'B' do not exist and
// every call returns null. That made the exemption test pass for exactly the wrong reason.
async function withBars(seriesBySymbol, fn) {
  const real = store.listBars;
  assert.equal(typeof real, 'function', 'store.listBars must be exported for this test to mean anything');
  store.listBars = async (userId, { symbol } = {}) => seriesBySymbol[symbol] || [];
  try { return await fn(); } finally { store.listBars = real; }
}

const HOUR = 3600000;
const DAY = 24 * HOUR;

// Build bars from a log-return sequence, ending `endOffsetMs` before `newest`.
function seriesFromReturns(sym, returns, { newest, stepMs = HOUR }) {
  const rows = [];
  let p = 100;
  for (let i = 0; i < returns.length; i++) {
    p = p * Math.exp(returns[i]);
    rows.push({ symbol: sym, barStart: new Date(newest - (returns.length - 1 - i) * stepMs), closePrice: +p.toFixed(8) });
  }
  return rows;
}

// ★ THE FIXTURE IS BUILT SO THE WINDOWED AND UNWINDOWED READINGS DISAGREE LOUDLY. A pair that is
// near-perfectly correlated over the last 30 days and near-perfectly ANTI-correlated before it: the old
// code blended 733 days of the two; the corrected code must report the recent regime only. Each test
// asserts both readings, so it cannot pass by measuring nothing.
function regimeFlipFixture({ recentBars = 720, oldBars = 1280, stepMs = HOUR } = {}) {
  const newest = Date.parse('2026-09-28T05:00:00.000Z');
  const n = recentBars + oldBars;
  const ra = [], rbFull = [], rbRecent = [];
  for (let i = 0; i < n; i++) {
    const r = Math.sin(i * 0.7) * 0.01 + Math.cos(i * 0.11) * 0.004;
    ra.push(r);
    const isRecent = i >= oldBars;
    rbFull.push(isRecent ? r : -r);      // what the old code averaged over
    rbRecent.push(r);                    // and what the last 30 days actually are
  }
  void rbRecent;
  return {
    newest,
    A: seriesFromReturns('A', ra, { newest, stepMs }),
    B: seriesFromReturns('B', rbFull, { newest, stepMs }),
    ra,
    rbFull,
    recentCount: recentBars,
  };
}

test('returnsCorrelation reads the window its own message names, not 12,000 bars', async () => {
  const f = regimeFlipFixture();
  const res = await withBars({ A: f.A, B: f.B }, () => risk.returnsCorrelation(1, 'A', 'B'));

  // Non-vacuity: the fixture must be one where the OLD behaviour gave a different answer.
  const full = correlation(f.ra, f.rbFull);
  assert.ok(full < 0, `fixture must make the unwindowed reading disagree (got ${full})`);
  assert.ok(res != null, 'a dense 30-day window must produce a number');
  // The last 30 days of this fixture are rho = +1 by construction.
  assert.ok(res > 0.9, `expected the recent regime (~1.0), got ${res} — the window is not being applied`);
  console.log(`      windowed rho=${res} vs unwindowed rho=${Number(full).toFixed(4)}`);
});

test('the window is 30 days, anchored at the NEWEST PAIRED BAR and not at the clock', () => {
  assert.equal(risk.CORR_WINDOW_DAYS, 30, 'the constant the message quotes');
  // Anchoring on the clock would empty the window for a stale feed and return null, which this gate reads
  // as "no opinion" — so a dead capture would silently DISABLE the veto. The data's own newest bar is used.
  const src = code('trading/agent/risk.js');
  assert.match(src, /const newest = paired\.reduce\(/, 'the right edge comes from the data');
  assert.doesNotMatch(src, /newest\s*=\s*Date\.now\(\)/, 'never from the clock');
  assert.match(src, /p\.t >= from/, 'and the window filters on it');
});

test('a series too SPARSE for a 30-day reading returns null instead of a years-long average', async () => {
  // 300 bars spaced 3 days apart span ~900 days. Under the old code that is ~299 return pairs and a
  // confident answer; inside a true 30-day window it is ~10 bars, which is below CORR_MIN_BARS.
  const newest = Date.parse('2026-09-28T05:00:00.000Z');
  const n = 300, stepMs = 3 * DAY;
  const ra = [], rb = [];
  for (let i = 0; i < n; i++) { const r = Math.sin(i * 0.7) * 0.01; ra.push(r); rb.push(r); }
  const A = seriesFromReturns('A', ra, { newest, stepMs });
  const B = seriesFromReturns('B', rb, { newest, stepMs });
  const res = await withBars({ A, B }, () => risk.returnsCorrelation(1, 'A', 'B'));
  // Non-vacuity: unwindowed, this fixture is a perfect correlation and would have been reported as one.
  assert.ok(Math.abs(correlation(ra, rb) - 1) < 1e-9, 'fixture must be a perfect unwindowed correlation');
  assert.equal(res, null, 'a reading the window cannot support must be null, not an older average');
});

test('a series shorter than the window is used whole — the rule does not invent a floor', async () => {
  const newest = Date.parse('2026-09-28T05:00:00.000Z');
  const ra = [], rb = [];
  for (let i = 0; i < 200; i++) { const r = Math.sin(i * 0.7) * 0.01; ra.push(r); rb.push(r); }
  const A = seriesFromReturns('A', ra, { newest, stepMs: HOUR });
  const B = seriesFromReturns('B', rb, { newest, stepMs: HOUR });
  const res = await withBars({ A, B }, () => risk.returnsCorrelation(1, 'A', 'B'));
  assert.ok(res != null && res > 0.99, `200 hourly bars is ~8 days and must still read (got ${res})`);
});

// ---------------------------------------------------------------------------------------------
// correlationClash — the rule the wake re-asks
// ---------------------------------------------------------------------------------------------

test('correlationClash reports a clash with the EXACT sentence the gate already prints', async () => {
  const f = regimeFlipFixture();
  const res = await withBars({ A: f.A, B: f.B }, () =>
    risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', [{ symbol: 'B' }]));
  assert.ok(res, 'a +1 pair under a 0.7 threshold must clash');
  assert.equal(res.code, 'correlation');
  assert.equal(res.withSymbol, 'B');
  // ⚠ Pinned verbatim: readers (and the owner) key on this sentence, and TRD-RSK-3 exists precisely so the
  // "30d log-returns" claim in it is true. Rewording it in passing would break both.
  assert.equal(res.text, `correlation ${res.c} (30d log-returns) with open position B >= 0.7`);
});

test('correlationClash honours the CONFIGURED threshold, and the same symbol is not a question', async () => {
  const f = regimeFlipFixture();
  await withBars({ A: f.A, B: f.B }, async () => {
    assert.equal(await risk.correlationClash(1, { correlationVeto: 1.5 }, 'A', [{ symbol: 'B' }]), null,
      'a threshold above 1 can never be breached by a correlation coefficient');
    assert.equal(await risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', [{ symbol: 'A' }]), null,
      'the same symbol is an already_held question, not a correlation one');
    assert.equal(await risk.correlationClash(1, { correlationVeto: 0.7 }, null, [{ symbol: 'B' }]), null,
      'no symbol means no question');
    assert.equal(await risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', []), null,
      'an empty book cannot clash');
    assert.equal(await risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', [null, {}]), null,
      'and a malformed position row must not throw');
  });
});

test('the pair exemption still applies, and only to a shared non-null pairId', async () => {
  const f = regimeFlipFixture();
  await withBars({ A: f.A, B: f.B }, async () => {
    const pos = { symbol: 'B', pairId: 'P1' };
    assert.equal(await risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', [pos],
      { proposal: { symbol: 'A', pairId: 'P1' } }), null, 'declared pair legs are meant to be correlated');
    assert.ok(await risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', [pos],
      { proposal: { symbol: 'A', pairId: 'P2' } }), 'a DIFFERENT pairId is not an exemption');
    assert.ok(await risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', [{ symbol: 'B' }],
      { proposal: { symbol: 'A', pairId: 'P1' } }), 'a one-sided pairId is not an exemption');
  });
});

test('correlationClash is a SOFT layer: a broken bar read returns null, never a thrown veto', async () => {
  const real = store.listBars;
  store.listBars = async () => { throw new Error('bar store down'); };
  try {
    const res = await risk.correlationClash(1, { correlationVeto: 0.7 }, 'A', [{ symbol: 'B' }]);
    assert.equal(res, null, 'an error must not become a new way for an approved entry to die');
  } finally { store.listBars = real; }
});

// ---------------------------------------------------------------------------------------------
// The wiring: one implementation, and the wake re-asks it
// ---------------------------------------------------------------------------------------------

test('the correlation rule has ONE implementation — evaluate does not keep an inline copy', () => {
  const src = code('trading/agent/risk.js');
  assert.match(src, /const clash = await correlationClash\(userId, risk, proposal\.symbol, open, \{ proposal \}\)/,
    'evaluate must delegate');
  // The inline loop that used to live in evaluate is gone; a second copy is how the two drift apart.
  // ⚠ Anchored on CODE, not on a section comment — `code()` strips comments, so the first draft of this
  // test searched for a marker that could never be present and failed a correct implementation.
  const evalIdx = src.indexOf('async function evaluate');
  const endIdx = src.indexOf("require('./instruments').checkSize(", evalIdx);
  assert.ok(evalIdx > -1 && endIdx > evalIdx, 'the evaluate body must be locatable from code alone');
  const body = src.slice(evalIdx, endIdx);
  assert.doesNotMatch(body, /await returnsCorrelation\(/, 'evaluate must not call the primitive directly any more');
  assert.match(body, /veto\('correlation', clash\.text\)/, 'the veto text still comes from the shared rule');
});

test('the wake re-asks the correlation question against a book that includes its own approvals', () => {
  const src = code('trading/agent/wakePipeline.js');
  const idx = src.indexOf("require('./risk').correlationClash(");
  assert.ok(idx > -1, 'the wake must re-ask the rule before submitting');
  const submit = src.indexOf("require('./executor').openTrade(", idx);
  assert.ok(submit > idx, 'the re-check must run BEFORE openTrade');
  // Slice from the re-check to the submit it guards — a wider window would sweep in unrelated refusals.
  const block = src.slice(idx - 300, submit);
  assert.match(block, /settings\.risk \|\| \{\}/,
    'the RISK sub-object must be passed, not the whole settings — otherwise an owner-set threshold is ignored');
  assert.match(block, /freshOpen\.concat\(approvedThisWake\)/, 'the book must include the entries this wake approved');
  assert.match(block, /blocked: true/, 'and it must be a POLICY refusal, or self-health reports it as drift');
  assert.match(block, /log\.write\(userId, 'order_blocked'/, 'a policy refusal logs order_blocked');
  assert.doesNotMatch(block, /order_rejected/, 'never order_rejected — the breaker and self-health read that');
  assert.doesNotMatch(block, /maybeTripBreaker/, 'and it must not trip the circuit breaker');
});

test("the wake records each placed entry so the next entry in the same wake can see it", () => {
  const src = code('trading/agent/wakePipeline.js');
  assert.match(src, /const approvedThisWake = \[\];/, 'the list must exist');
  const push = src.indexOf('if (execution && execution.placed) approvedThisWake.push(');
  const spread = src.indexOf("executions.push({ symbol: d.symbol, action: 'entry', ...execution");
  assert.ok(push > -1, 'a placed entry must be recorded');
  assert.ok(spread > -1 && push > spread, 'and recorded AFTER the execution that placed it');
  // The list is only needed because a fill may not have landed yet — assert the CODE that consumes it, not
  // the prose explaining it (`code()` strips comments, so a prose anchor here would test nothing).
  const refusal = src.indexOf("reason: 'correlation_intrawake'");
  assert.ok(refusal > -1, 'the refusal block must be locatable');
  const rb = src.slice(refusal, refusal + 900);
  assert.match(rb, /approvedThisWake\.map\(/, 'the refusal must report which entries this wake approved');
  assert.match(rb, /bookSize:/, 'and the size of the book it was judged against');
});
