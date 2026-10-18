// Pins for the TRD-26 gate automation (trading/agent/trd26.js): readiness
// math, the fire-decision table, and the findings report skeleton.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const t = require('../trading/agent/trd26');
const { code, read } = require('./_source');

test('seriesDaysNeeded: ceil(200 / rate); rate 0 -> Infinity', () => {
  assert.equal(t.seriesDaysNeeded(0.5), 400);
  assert.equal(t.seriesDaysNeeded(0.651), 308);
  assert.equal(t.seriesDaysNeeded(0.405), 494);
  assert.equal(t.seriesDaysNeeded(0), Infinity);
});

test('freshnessCapDays: 10 * (elapsed - safety), floored', () => {
  assert.equal(t.freshnessCapDays(50), 490);
  assert.equal(t.freshnessCapDays(0.25), -8);
});

test('decide(): fire only when READY and not gated; INSUFFICIENT re-fires', () => {
  assert.equal(t.decide({ ready: false, priorVerdict: null }), 'skip_not_ready');
  assert.equal(t.decide({ ready: true, priorVerdict: null }), 'fire');
  assert.equal(t.decide({ ready: true, priorVerdict: 'INSUFFICIENT-DATA' }), 'fire');
  assert.equal(t.decide({ ready: true, priorVerdict: 'PASS' }), 'skip_gated');
  assert.equal(t.decide({ ready: true, priorVerdict: 'FAIL' }), 'skip_gated');
});

test('renderReport: table + candidate notes + FINAL marker on conclusion', () => {
  const md = t.renderReport({
    at: '2026-10-12T00:00:00Z',
    final: false,
    rows: [
      { id: 20, label: 'Gold turtle {dc20}', verdict: null, ready: false, earliest: '2026-10-31', seriesDays: 494, rate: 0.405 },
      { id: 21, label: 'Oil turtle {dc5,g0}', verdict: 'PASS', n: 27, pf: 1.32, p: 0.041, firedAt: '2026-10-12T01:00:00Z' },
    ],
  });
  assert.ok(md.includes('# TRD-26 fresh-data gate'));
  assert.ok(!md.includes('(FINAL)'));
  assert.ok(md.includes('PASS'));
  assert.ok(md.includes('fdrAvailable:false'));
  assert.ok(md.includes('| 20 |'));
  assert.ok(md.includes('| 21 |'));
  const mf = t.renderReport({ at: 'x', final: true, rows: [] });
  assert.ok(mf.includes('(FINAL)'));
});

test('reportPlan: idempotent; FINAL once all terminal; never again after final', () => {
  const three = [{ id: 20, verdict: 'PASS' }, { id: 21, verdict: 'FAIL' }, { id: 22, verdict: 'PASS' }];
  // all terminal -> final now
  assert.deepEqual(t.reportPlan({ verdicts: three, last: null, total: 3 }), { write: true, final: true });
  // partial first report
  assert.deepEqual(t.reportPlan({ verdicts: three.slice(0, 1), last: null, total: 3 }), { write: true, final: false });
  // unchanged -> no write
  assert.deepEqual(t.reportPlan({ verdicts: three.slice(0, 1), last: { final: false, verdicts: three.slice(0, 1) }, total: 3 }), { write: false, final: false });
  // new/second verdict (fire happened) -> write again
  assert.deepEqual(t.reportPlan({ verdicts: three.slice(0, 2), last: { final: false, verdicts: three.slice(0, 1) }, total: 3 }), { write: true, final: false });
  // recovered verdict (original report interrupted) -> write
  assert.deepEqual(t.reportPlan({ verdicts: three.slice(1, 2), last: { final: false, verdicts: [] }, total: 3 }), { write: true, final: false });
  // after final -> never again
  assert.deepEqual(t.reportPlan({ verdicts: three, last: { final: true, verdicts: three }, total: 3 }), { write: false, final: false });
});

// ---------------------------------------------------------------------------
// 2026-09-24 — STRUCTURAL PINS FOR TWO MISREADINGS THIS GATE HAS ALREADY CAUSED.
//
// Both are pinned structurally rather than by behaviour because checkAndFire
// needs a live DB pool (store.getLabCandidate / listLabReleases). These assert
// the CALL SITES, which is the only thing that can be read statically.
//
// (1) "TRD-26 is a `1y` gate that can never fire." It is not: the Lab's family
//     paths (loadLabSeries) hard-code range:'1y', and this gate is NOT one of
//     them - it passes seriesDays, and retestCandidate turns that into
//     range:null. A report asserted the opposite by reading the pre-registration's
//     window table as if it described TRD-26.
// (2) "Its subjects were withdrawn, so it cannot resolve." They are `archived`,
//     and archived is this path's REQUIRED status - the archive only removes a
//     pair from the family RELEASE.
// ---------------------------------------------------------------------------

test('TRD-26 sizes the series explicitly — it is NOT a `1y` gate', () => {
  const gate = code('trading/agent/trd26.js');
  // The gate must pass seriesDays to the retest...
  assert.match(gate, /retestCandidate\(userId,\s*id,\s*\{\s*seriesDays:\s*needed\s*\}\)/);
  // ...and must NOT call the family loader, which is the path that hard-codes 1y.
  assert.doesNotMatch(gate, /loadLabSeries/);
  // The other half of the pin: seriesDays is what selects range:null.
  const sb = code('trading/agent/lab/scoreboard.js');
  assert.match(sb, /range:\s*days\s*\?\s*null\s*:\s*'1y'/);
  // And it is the FAMILY paths, not this gate, that hard-code the shallow window.
  assert.match(sb, /range:\s*'1y'/);
});

test('the retest subject status is recorded — `archived` is by design, not withdrawal', () => {
  const gate = code('trading/agent/trd26.js');
  assert.match(gate, /row\.subjectStatus\s*=\s*cand\.status/);
  // The two facts that make `archived` the retest path's required status, asserted
  // against the source rather than against prose in a plan.
  const sb = code('trading/agent/lab/scoreboard.js');
  assert.match(sb, /statuses:\s*\[\s*'registered'\s*,\s*'frozen'\s*\]/);
  const raw = read('trading/agent/lab/scoreboard.js');
  assert.match(raw, /fresh-data gate on an archived candidate/i);
});

test('the check row cannot be read as carrying the gate sample size', () => {
  const gate = code('trading/agent/trd26.js');
  // The density fields are named `series*` first (unambiguous) and only then
  // aliased to the published names the existing events use.
  assert.match(gate, /row\.seriesW4n\s*=\s*m\.w4\.n/);
  assert.match(gate, /row\.seriesW25n\s*=\s*m\.w25\.n/);
  assert.match(gate, /row\.w4n\s*=\s*row\.seriesW4n/);
  assert.match(gate, /row\.w25n\s*=\s*row\.seriesW25n/);
  // gateN starts null and is only ever copied from `n` (which comes from the
  // lockbox, i.e. only after a fire) — never from a density field.
  assert.match(gate, /row\.gateN\s*=\s*null/);
  assert.equal((gate.match(/row\.gateN\s*=\s*row\.n/g) || []).length, 2);
  assert.doesNotMatch(gate, /row\.gateN\s*=\s*row\.(w4n|w25n|seriesW4n|seriesW25n)/);
  assert.doesNotMatch(gate, /row\.gateN\s*=\s*m\./);
});
