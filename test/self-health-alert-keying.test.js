// test/self-health-alert-keying.test.js — TRD-65 + TRD-67, 2026-09-19/21.
//
// THE ROW AS WRITTEN: "the UI Fallback Pause latch survives recovery — entries stay blocked after
// recovery, a latch with no release", and "consecutiveFails back at 0 with no page to say so". Checked
// against the code, three of those clauses are false:
//
//   · there IS a release — `POST /api/trading/bridge/resume`, and `#btn-bridge-resume` in the Health
//     card, disabled unless the bridge is paused;
//   · the state IS rendered — `bridge-state` reads `PAUSED (UI fallback)` in negative colour;
//   · the health board DOES say so — the bridge check is `bad`, and the refusal itself carries the
//     remedy (`ui_fallback_pause: entries are blocked until the bridge pause is resumed`).
//
// The latch surviving recovery is deliberate: the 2026-09-11 patch exists precisely because a passing
// health check was silently clearing an active pause.
//
// WHAT IS TRUE IS WORSE THAN THE ROW SAYS. The pause does not PAGE. The alert fired only on a change of
// the coarse `overall` status, and `field_levels` has been permanently `bad` since it picked up one
// historical trade (`#1046`, realised R:R 0.22 against a 0.75 floor). So `overall` is 'bad' on every run,
// `prevStatus !== overall` is false on every run, and every later defect — a latched pause, a dead feed,
// a new kill — is muted. A health board whose alarm can be permanently disabled by one stuck row is the
// same failure it exists to catch.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const { offenderKey, pauseAgeLabel } = require('../trading/agent/selfHealth');

// --- the key that decides whether to page ------------------------------------

test('★ an ESCALATION on an existing offender changes the key too (the TRD-67 residual)', () => {
  // The case ids alone could not carry, and the one the desk is most likely to meet: `ticks` is already in
  // the set as `warn` (some symbols stale, or their session unknown), and then one symbol goes genuinely
  // DEAD. Same id, worse grade, and the board has to say so — otherwise "a dead feed never pages" is still
  // true, just narrower.
  const allStale = [{ id: 'ticks', status: 'warn' }, { id: 'bridge', status: 'bad' }];
  const oneDead = [{ id: 'ticks', status: 'bad' }, { id: 'bridge', status: 'bad' }];
  assert.notStrictEqual(offenderKey(allStale), offenderKey(oneDead),
    'warn -> bad on the same check IS the page: a symbol just died');
  assert.strictEqual(offenderKey(oneDead), 'bridge:bad,ticks:bad');

  // And the reverse direction is a recovery, which the key must also carry — it always did, because an id
  // leaving the set changed the id-only key as well. This pins that the behaviour was preserved, not added.
  assert.notStrictEqual(offenderKey(oneDead), offenderKey([{ id: 'bridge', status: 'bad' }]));
});

test('★ a new offender changes the key even while an old one stays red', () => {
  const stuck = [{ id: 'field_levels', status: 'bad' }, { id: 'bridge', status: 'ok' }];
  const plusPause = [{ id: 'field_levels', status: 'bad' }, { id: 'bridge', status: 'bad' }];
  assert.strictEqual(offenderKey(stuck), 'field_levels:bad');
  assert.strictEqual(offenderKey(plusPause), 'bridge:bad,field_levels:bad');
  assert.notStrictEqual(offenderKey(stuck), offenderKey(plusPause),
    'this inequality IS the alert: the coarse status was bad before and after, so it could never carry it');
});

test('the key is order-independent — a reshuffled board is not a change', () => {
  const a = [{ id: 'b', status: 'warn' }, { id: 'a', status: 'bad' }, { id: 'c', status: 'ok' }];
  const b = [{ id: 'a', status: 'bad' }, { id: 'b', status: 'warn' }];
  assert.strictEqual(offenderKey(a), 'a:bad,b:warn');
  assert.strictEqual(offenderKey(a), offenderKey(b));
});

test('an all-ok board has an empty key, and a status-less entry is not an offender', () => {
  assert.strictEqual(offenderKey([{ id: 'a', status: 'ok' }]), '');
  assert.strictEqual(offenderKey([]), '');
  assert.strictEqual(offenderKey(null), '');
  assert.strictEqual(offenderKey([null, undefined, { id: 'x' }]), '');
});

// --- STANDING rows (TRD-F20-EPOCH, 2026-09-28) --------------------------------
//
// A standing row is a documented condition that NO ACTION CLEARS: six mirrored positions the desk never placed,
// six rows opened before levels could be recorded, the risk dial being overridden by the notional cap, and (as of
// the same fix) the backtest name space. Because `overall` was `bad ? 'bad' : warn ? 'warn' : 'ok'` and the
// banner fires on `status !== 'ok'`, those rows held DESK DEGRADED on permanently — which devalues the case that
// IS new. These tests pin that a standing row is EXCLUDED from the key (so it can never page) while still being
// required to APPEAR in the snapshot, since hiding it would be the opposite failure.

test('★ a standing row never enters the offender key', () => {
  assert.strictEqual(offenderKey([{ id: 'stops', status: 'warn', standing: true }]), '');
  assert.strictEqual(offenderKey([{ id: 'stops', status: 'warn', standing: true }, { id: 'a', status: 'ok' }]), '');
});

test('a real offender beside a standing row still pages, and the key ignores only the standing one', () => {
  const board = [
    { id: 'stops', status: 'warn', standing: true },
    { id: 'field_backtest_ref', status: 'warn', standing: true },
    { id: 'bridge', status: 'bad' },
  ];
  assert.strictEqual(offenderKey(board), 'bridge:bad');
  assert.notStrictEqual(offenderKey(board), offenderKey([...board, { id: 'ticks', status: 'warn' }]),
    'adding a genuine offender must still change the key — otherwise this fix mutes the alarm it exists to keep');
});

test('`standing` is checked by TRUTHINESS, so an explicit false is not standing', () => {
  assert.strictEqual(offenderKey([{ id: 'a', status: 'bad', standing: false }]), 'a:bad');
  assert.strictEqual(offenderKey([{ id: 'a', status: 'bad', standing: 0 }]), 'a:bad');
});

// --- the pause's age ----------------------------------------------------------

test('the pause age is reported in the unit that makes it actionable', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  assert.strictEqual(pauseAgeLabel('2026-09-19T11:26:00Z', now), ' for 34m');
  assert.strictEqual(pauseAgeLabel('2026-09-19T09:00:00Z', now), ' for 3h0m');
  assert.strictEqual(pauseAgeLabel('2026-09-18T01:20:00Z', now), ' for 34h40m');
});

test('★ an unknown start says unknown, rather than defaulting to a zero we cannot claim', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  assert.strictEqual(pauseAgeLabel(null, now), ' (since unknown)');
  assert.strictEqual(pauseAgeLabel(undefined, now), ' (since unknown)');
  assert.strictEqual(pauseAgeLabel('not-a-date', now), ' (since unknown)');
  assert.strictEqual(pauseAgeLabel('2026-09-19T11:59:30Z', now), ' for 1m', 'rounds, so 30s is not "0m"');
});

// --- the wiring, pinned structurally ----------------------------------------

const src = code('trading/agent/selfHealth.js');

test('★ the alert no longer hangs on the overall status alone', () => {
  assert.match(src, /prevKey !== offenderKey\(checks\)/);
  assert.match(src, /const prevKey = lastEvent && lastEvent\.payload \? offenderKey\(lastEvent\.payload\.checks\) : null/,
    'the key must be compared against the PREVIOUS run, which is what makes it a transition');
});

test('the "once per change, never per run" discipline is preserved, not widened away', () => {
  // The fix changes WHAT counts as a change. It must not remove the requirement that there WAS one —
  // otherwise a stuck offender would page on every 15-minute tick.
  assert.match(src, /overall !== 'ok' && \(prevStatus !== overall \|\| prevKey !== offenderKey\(checks\)\)/);
});

test('★ the overall status is decided by the checks that describe an ACTIONABLE fault', () => {
  // ⚠ THE ONE CHANGE THAT COULD QUIETLY TURN THE BANNER OFF FOR EVERYTHING. It has to read `!c.standing` from
  // the same array it counts, and it has to KEEP the row: a fix that dropped standing rows from `checks` would
  // hide the documented condition instead of grading it, and the card would stop showing what it still shows.
  assert.match(src, /const active = checks\.filter\(\(c\) => !c\.standing\)/);
  assert.match(src, /const standing = checks\.length - active\.length/);
  assert.match(src, /const bad = active\.filter\(\(c\) => c\.status === 'bad'\)\.length/);
  assert.match(src, /const warn = active\.filter\(\(c\) => c\.status === 'warn'\)\.length/);
  assert.match(src, /const snapshot = \{ at: new Date\(\)\.toISOString\(\), status: overall, bad, warn, standing, checks \}/,
    'the standing count is persisted so a reader of the EVENT can tell a clean desk from a muted one');
  assert.doesNotMatch(src, /checks = checks\.filter\(/,
    'standing rows must not be removed from the snapshot — the card still has to render them');
});

test('the banner does not list a standing row as a reason the desk is degraded', () => {
  assert.match(src, /checks\.filter\(\(c\) => c\.status !== 'ok' && !c\.standing\)\.map\(\(c\) => `\$\{c\.label\}: \$\{c\.detail\}`\)/);
  assert.match(src, /standing row\(s\): documented, and no action clears them/);
});

test('the bridge check names the pause DURATION, not an impossible fail count', () => {
  assert.match(src, /pauseAgeLabel\(b\.pausedAt\)/);
  assert.ok(!/consecutiveFails \|\| '\?'/.test(src),
    'the count is 0 after recovery by design — the ? was naming the one number that cannot be nonzero');
  assert.match(src, /resume button clears it/, 'the detail must carry the remedy, like the refusal does');
});
