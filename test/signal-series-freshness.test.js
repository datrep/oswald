// test/signal-series-freshness.test.js — TRD-68 direction (c) (2026-09-22).
//
// ★ WHY A SECOND FEED CHECK EXISTS AT ALL. The tick check and this one are structurally blind to each other.
// `ticksRepo.latestTick` answers "are ticks arriving"; it says nothing about the SIGNAL SERIES. China Shenhua
// reported 3 ticks per sweep with `captured:36, missing:[]` — an empty missing list — while its 1h
// `plus500_chart` series sat 456 minutes old. quant renders no price and returns no signal for a stale series,
// so that symbol was silently excluded from evaluation forever while still costing a scout slot and riding in
// every chair bundle, and a bare `stale` on a panel was the only trace. Verified live before this change: the
// tick check said all ≤15m; there was no check that could have said anything else.
//
// THE GRADING IS TRD-67's (deadFeedVerdict / tickSeverity), deliberately reused rather than reimplemented, so
// the fresh/stale/dead/venue_closed semantics cannot diverge between the two feeds. What differs is the SLA,
// because the cadence differs: a 1h series held to the 15-minute tick SLA would report every healthy symbol as
// stale. The SLA and the venue preference order are both TAKEN FROM quant (`BAR_FRESH_MS`, `IND_VENUE_PREF`)
// so this check cannot drift from the thing it is checking.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const selfHealth = require('../trading/agent/selfHealth');
const quant = require('../trading/agent/quant');

const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'selfHealth.js'), 'utf8');
const codeOnly = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
const code = codeOnly(src);

test('the premise: quant still exports the freshness line and the venue preference order', () => {
  // These are the two facts this check imports instead of restating. If either disappears, the check below is
  // either broken or has silently grown its own copy of the desk's policy.
  assert.equal(typeof quant.BAR_FRESH_MS, 'number', 'quant.BAR_FRESH_MS must stay exported');
  assert.ok(quant.BAR_FRESH_MS > 0);
  assert.ok(Array.isArray(quant.IND_VENUE_PREF) && quant.IND_VENUE_PREF.length,
    'quant.IND_VENUE_PREF must stay exported, or the check measures a series nobody trades');
  assert.ok(Array.isArray(quant.IND_VENUE_PREF), 'IND_VENUE_PREF must stay an array');
  assert.equal(quant.BAR_FRESH_MS, 4 * 3600000, 'BAR_FRESH_MS moved — the grade boundaries below are stated in its terms');
});

test('★ the grade boundaries for a 1h series, stated in cadences', () => {
  const slaMin = quant.BAR_FRESH_MS / 60000; // 240
  const v = (mins, open) => selfHealth.deadFeedVerdict({ mins, open, slaMin });
  // Inside the desk's own not-tradable line: nothing to report.
  assert.equal(v(45, true), 'fresh', 'a series inside the SLA is fresh');
  // Past it, venue trading: stale. This is the China Shenhua case (456m) — 7 missed hourly bars.
  assert.equal(v(456, true), 'stale', 'a 456m-old 1h series against a 240m SLA is stale, not dead');
  // 3x the SLA with the venue open is the fault grade — the same multiple TRD-67 uses for ticks.
  assert.equal(v(slaMin * 3, true), 'dead');
  assert.equal(v(456, true) === 'dead', false, '456m must NOT be dead — the boundary is 3x, not 2x');
  // Silence while the venue is shut is EXPECTED, not a fault. This is why the grade cannot be age alone.
  assert.equal(v(5000, false), 'venue_closed');
  // An unknown session is deliberately not called dead: "we cannot tell" and "it is broken" are different facts.
  assert.equal(v(5000, null), 'stale_unknown_session');
  assert.equal(v(5000, null) === 'dead', false, 'an unknown session must not page at 3am');
  // A symbol with no series at all is its own fact and must not be averaged into an age.
  assert.equal(v(null, true), 'never_captured');
});

test('★ only dead is a fault, for this feed as for the tick feed', () => {
  assert.equal(selfHealth.tickSeverity(['fresh', 'fresh']), 'ok');
  assert.equal(selfHealth.tickSeverity(['stale']), 'warn');
  assert.equal(selfHealth.tickSeverity(['venue_closed', 'stale_unknown_session']), 'warn');
  assert.equal(selfHealth.tickSeverity(['stale', 'dead']), 'bad');
  assert.equal(selfHealth.tickSeverity(['dead']), 'bad');
  assert.equal(selfHealth.tickSeverity(['venue_closed', 'fresh']), 'ok', 'a closed venue alone is not a warning');
});

test('★ the check is WIRED into the board and takes its policy from quant', () => {
  // A check that is computed but never pushed is exactly the defect this whole task is about: computed,
  // discarded, invisible.
  assert.match(code, /check\('signal_series'/, 'the check must be pushed to the board');
  assert.match(code, /const barSlaMin = quant\.BAR_FRESH_MS \/ 60000/,
    'the SLA must be DERIVED from quant, not restated — a copy drifts silently');
  assert.match(code, /for \(const v of quant\.IND_VENUE_PREF\)/,
    'the venue order must come from quant, or this measures a series nobody trades');
  // The two feeds stay distinct: one id each, so "ticks fine, series dead" cannot collapse into one verdict.
  assert.match(code, /check\('ticks'/, 'the tick check must remain');
  assert.doesNotMatch(code, /check\('tick_series'|check\('signal_ticks'/,
    'the two feeds must not be merged into one check');
  // The message must QUANTIFY the gap in cadences: an age alone does not say how many bars were missed.
  assert.match(code, /missed hourly bar\(s\)/, 'the report must state the missed cadences');
  // And the SLA must not reappear as a literal, which is how a derived constant silently stops being derived.
  assert.doesNotMatch(code, /slaMin: 240/, 'the SLA must not be hardcoded at the call site');
});
