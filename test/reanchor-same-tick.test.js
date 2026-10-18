// test/reanchor-same-tick.test.js — TRD-EXE-15 (2026-10-01): the re-anchor was reading the same tick twice.
//
// THE DEFECT. `quant.js` builds the DECISION price from `ticks.latestTick`. The executor then reads
// `ticks.latestTick` again for the "fresh" price. For an instrument the desk does NOT hold, nothing writes a new
// tick in between — plus500's ticks come from `position_poll`, so they exist only for positions the desk already
// has — and both reads return the SAME ROW. `reanchorLevels` computes `shift = fresh - decision`, so the shift is
// 0 BY CONSTRUCTION, not because the market was calm.
//
// THE MEASUREMENT. 73 `entry_reanchored` events, 73 with `shift = 0` — every one. On the same entries the fill
// drift was 74% adverse at 1.083x realised/sized risk, and the newest tick at each open was 39-132 seconds old.
// The control was measuring the desk against itself.
//
// ⚠ WHAT THIS TEST DOES *NOT* CLAIM. It does not make the re-anchor work — the input is still the desk's own
// series, and fixing that needs a venue-side price read at submit time. What it fixes is the CLAIM: an inert
// control that reports success is indistinguishable from a working one (F32), which is how four entries came to
// be summarised as "the re-anchor ran" when it had measured nothing at all.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { staleTickForDecision, reanchorLevels } = require('../trading/agent/exitLevels');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('★★ the measured case: a tick captured AT the decision is not fresh', () => {
  const at = '2026-09-30T15:22:48.000Z';
  assert.equal(staleTickForDecision({ capturedAt: at }, at), true,
    'the same instant means the same row — the exact case that produced 73 shifts of zero');
});

test('a tick OLDER than the decision is stale too (the desk is reading backwards)', () => {
  assert.equal(staleTickForDecision(
    { capturedAt: '2026-09-30T15:20:00.000Z' }, '2026-09-30T15:22:48.000Z'), true);
});

test('a genuinely NEWER tick is not stale — the control must still be able to work', () => {
  assert.equal(staleTickForDecision(
    { capturedAt: '2026-09-30T15:23:10.000Z' }, '2026-09-30T15:22:48.000Z'), false);
});

test('★ UNKNOWN IS NOT STALE — absence must never manufacture a refusal', () => {
  // ⚠ THIS IS THE SAFETY DIRECTION. A helper that read a missing field as "stale" would convert a data gap into
  // a changed entry path. Every unknown returns FALSE, which is exactly today's behaviour.
  assert.equal(staleTickForDecision(null, '2026-09-30T15:22:48.000Z'), false, 'no tick');
  assert.equal(staleTickForDecision({}, '2026-09-30T15:22:48.000Z'), false, 'tick with no capturedAt');
  assert.equal(staleTickForDecision({ capturedAt: '2026-09-30T15:22:48.000Z' }, null), false, 'no decision time');
  assert.equal(staleTickForDecision({ capturedAt: '2026-09-30T15:22:48.000Z' }, ''), false, 'empty decision time');
  assert.equal(staleTickForDecision({ capturedAt: 'not-a-date' }, '2026-09-30T15:22:48.000Z'), false, 'unparseable');
});

test('★ WHY IT MATTERS: `shift = 0` reads as agreement, which is the whole bug', () => {
  // The arithmetic is NOT wrong — feeding it the same price on both sides really does produce a zero shift, and
  // the function faithfully reports `ok: true`. That is precisely why the defect survived: the control was green
  // and its input was hollow. This test pins that the ARITHMETIC is fine, so nobody "fixes" the wrong half.
  const same = '2026-09-30T15:22:48.000Z';
  const ra = reanchorLevels({ stopPrice: 4183.089, takeProfitPrice: 4125.1912, decisionPrice: 4159.065, freshPrice: 4159.065 });
  assert.equal(ra.ok, true, 'the module is not at fault');
  assert.equal(ra.shift, 0);
  assert.equal(ra.stopPrice, 4183.089, 'and a zero shift changes no level at all');
  // and the guard that must now catch it
  assert.equal(staleTickForDecision({ capturedAt: same }, same), true, 'the new guard is what must catch it');
});

test('the executor calls the guard, and only AFTER a usable price exists', () => {
  const exec = code('trading/agent/executor.js');
  const usable = exec.indexOf("'no_fresh_tick' : 'fresh_tick_has_no_price'");
  const guard = exec.indexOf('staleTickForDecision(fresh, decisionPriceAsOf)');
  const call = exec.indexOf('reanchorLevels({ stopPrice: stop.value');
  assert.ok(usable > -1 && guard > -1 && call > -1);
  assert.ok(usable < guard, 'an unusable price is its own named reason and must be reported as such');
  assert.ok(guard < call, 'the freshness check must precede the shift it invalidates');
});

test('★ the freshness guard applies ONLY to the desk-tick source, not to a venue read', () => {
  const exec = code('trading/agent/executor.js');
  // ⚠ A venue price read off the live page is fresh BY CONSTRUCTION — it is the venue's current quote. Applying
  // `staleTickForDecision` to it would compare it against the decision timestamp and refuse the very improvement
  // the change exists to provide. The guard is a statement about the DESK'S OWN SERIES, and it must stay scoped
  // to that series.
  assert.match(exec, /freshSource === 'desk_tick' && staleTickForDecision\(fresh, decisionPriceAsOf\)/,
    'the stale guard must be scoped to the desk-tick source');
});

test('★ the SOURCE of the fresh price is recorded, not inferred from a zero shift', () => {
  const exec = code('trading/agent/executor.js');
  // ⚠ A venue price that happens to equal the decision price and an old tick both give shift = 0 — and they are
  // very different facts. The first says the market did not move; the second says nothing was measured. Reading
  // one from the other is how this control looked healthy for 73 events.
  assert.match(exec, /freshSource = venuePx != null \? 'venue_page' : 'desk_tick'/);
  assert.match(exec, /reanchor = \{ \.\.\.ra, freshSource, venuePx, gate: frozen\.reason \}/, 'and it travels on the re-anchor record');
});

test('★★ the venue-price path is GATED to non-frozen strategies and defaults OFF', () => {
  const exec = code('trading/agent/executor.js');
  // ⚠ It MOVES THE STOP LEVEL, so the frozen forward candidate (TRD-29) must not have its levels moved. Absent
  // setting means OFF, exactly as EXE-14's plan requires.
  assert.match(exec, /risk\.reanchorToLive === true/, 'absent must mean off');
  // ★ S5 (2026-10-01): the gate is no longer a local list. It is the SHARED implementation, because two inline
  // lists is how a gate becomes two gates that disagree.
  assert.match(exec, /!frozen\.frozen/, 'a frozen strategy must be excluded, and by the shared gate');
  assert.match(exec, /require\('\.\/frozenTrack'\)/, 'the gate has one implementation');
  assert.ok(!exec.includes('FROZEN_STRATEGIES'),
    'the inline list must be gone — it was the placeholder S5 replaced');
});

test('a probe that fails falls back rather than throwing', () => {
  const exec = code('trading/agent/executor.js');
  // ⚠ `code()` strips comments, so this asserts on SHAPE not prose: the venue read is optional, its result is
  // deliberately nullable, and the desk's own tick is still read unconditionally underneath it.
  const probe = exec.indexOf('getConnector(settings).probeSession(settings, symbol)');
  const nullable = exec.indexOf('venuePx = probe && probe.venueMid != null ? probe.venueMid : null', probe);
  const tick = exec.indexOf('await ticks.latestTick(userId, symbol, priceVenue)', nullable);
  assert.ok(probe > -1, 'the venue price is read');
  assert.ok(nullable > probe, 'and a venue that answers nothing yields null, not a throw');
  assert.ok(tick > nullable, 'the desk tick path must still run — the venue read is an improvement, not a replacement');
});

test('★ the guard DEGRADES, it does not GATE', () => {
  const exec = code('trading/agent/executor.js');
  const guard = exec.indexOf('staleTickForDecision(fresh, decisionPriceAsOf)');
  // ⚠ SCOPE THIS TO THE GUARD'S OWN BRANCH — from the guard to the shift it bypasses. A wider window also
  // contains the pre-existing `anchor_stale` refusal (the price moved more than a full stop distance), which is a
  // DIFFERENT control that legitimately does return `{ placed: false }`. Widening the window makes this assertion
  // fire on the neighbour rather than on the guard. (A test bug, found by the test — which is the right order.)
  const call = exec.indexOf('const ra = reanchorLevels(', guard);
  assert.ok(call > guard, 'the guard must sit in front of the shift it invalidates');
  const branch = exec.slice(guard, call);
  // ⚠ A refusal HERE would stop the desk entering: the venue tick series moves slowly BY CONSTRUCTION, so
  // `no_tick_since_decision` would be the COMMON case, not the exception. It must record and continue, exactly as
  // the sibling `no_fresh_tick` already does.
  assert.ok(!/return \{ placed: false/.test(branch),
    'this must not block entries — it is a degradation of the record, not of the order');
  assert.match(branch, /reanchorNote = 'no_tick_since_decision'/, 'it sets the note');
  assert.match(branch, /'reanchor_no_tick'/, 'and records why, so the rate is measurable');
  // and the levels are still whatever the decision snapshot produced — an unchanged shift changes nothing
  assert.ok(!/levels = \{\s*stop: ra\.stopPrice/.test(branch), 'the guard branch must not assign levels');
});
