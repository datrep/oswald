// test/watchdog-login-plan.test.js — 2026-09-13: TRD-47.
//
// The watchdog's login check used to navigate the shared bridge tab to /trade every 5 minutes,
// unconditionally, with no pageLock. Measured consequences: the mirror poller correctly stands down
// under a hard kill (zero navigation by design) yet the tab still moved from about:blank to
// app.plus500.com/trade, and every operator navigation was silently reverted within 5 minutes —
// which destroyed three consecutive instrument-probe reads.
//
// The replacement policy reads the page ALREADY LOADED before deciding to move it, and is
// deliberately asymmetric about evidence: a POSITIVE in-place read is trusted, a NEGATIVE is not,
// because isLoggedIn looks for the account banner and a route that does not render it would read as
// "signed out" — and this module PAGES THE OWNER on that verdict. These pins exist mainly to stop
// anyone "simplifying" that asymmetry away.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decideLoginCheck } = require('../trading/agent/watchdog');

test('a positive in-place read is trusted and does NOT navigate', () => {
  const r = decideLoginCheck({ fastLoggedIn: true, hardKill: false });
  assert.strictEqual(r.action, 'report_alive');
  assert.strictEqual(r.reason, 'in_place_read');
});

test('a negative read is NOT a death verdict — it navigates to verify', () => {
  const r = decideLoginCheck({ fastLoggedIn: false, hardKill: false });
  assert.strictEqual(r.action, 'navigate');
  assert.strictEqual(r.reason, 'negative_needs_verification');
});

test('a negative under a hard kill neither navigates nor pages', () => {
  const r = decideLoginCheck({ fastLoggedIn: false, hardKill: true });
  assert.strictEqual(r.action, 'skip');
  assert.strictEqual(r.reason, 'kill_switch_hard_unverified');
});

test('the asymmetry is the point: identical evidence, opposite handling, only kill differs', () => {
  // If someone makes the negative branch report death, or makes hardKill skip a POSITIVE, this fails.
  const alive = decideLoginCheck({ fastLoggedIn: true, hardKill: true });
  assert.strictEqual(alive.action, 'report_alive', 'a hard kill must not blind the pager to a known-alive session');

  const unknown = decideLoginCheck({ fastLoggedIn: false, hardKill: true });
  assert.notStrictEqual(unknown.action, 'report_alive');
  assert.notStrictEqual(unknown.action, 'navigate', 'hard kill means zero bridge navigation');
});

test('no input can produce a dead verdict without a navigation', () => {
  // The only action that can reach reactToLogin with loggedIn=false is 'navigate'. There is no
  // 'report_dead' — that is the property that keeps a false login-death page off the wire.
  const reachable = new Set();
  for (const fastLoggedIn of [true, false]) {
    for (const hardKill of [true, false]) {
      reachable.add(decideLoginCheck({ fastLoggedIn, hardKill }).action);
    }
  }
  assert.deepStrictEqual([...reachable].sort(), ['navigate', 'report_alive', 'skip']);
  assert.ok(!reachable.has('report_dead'));
});

test('every branch explains itself', () => {
  for (const fastLoggedIn of [true, false]) {
    for (const hardKill of [true, false]) {
      const r = decideLoginCheck({ fastLoggedIn, hardKill });
      assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'a decision with no reason is unauditable');
    }
  }
});
