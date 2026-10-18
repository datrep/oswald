// TRD-RSK-17 (#1503, 2026-10-02): the account-switch CONFIRMATION gate.
// Pins the decision in both directions (the measured 06:54Z flash must NOT rebase; a persistent level MUST),
// and pins the ONE-decider invariant across the TWO call sites — the module's own history is a two-writers
// defect (P1b: "the first version patched only acceptSample").
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { switchDecision, SWITCH_CONFIRM_READS } = require('../trading/agent/accountPoller');

const DEMO = { equity: 3955.57, pnl: -1.01 };
const REAL = { equity: 22.28, pnl: 0 }; // the real-money account level — the measured flash value
const src = fs.readFileSync(path.join(__dirname, '..', 'trading', 'agent', 'accountPoller.js'), 'utf8');

test('a single wild read is PENDING, never a switch (the 06:54Z flash)', () => {
  const d = switchDecision(REAL, DEMO, null);
  assert.equal(d.action, 'pending');
  assert.equal(d.pending.reads, 1);
  assert.equal(d.pending.eq.equity, 22.28);
});

test('the wild level must persist across consecutive reads to CONFIRM', () => {
  const first = switchDecision(REAL, DEMO, null);
  const second = switchDecision({ equity: 22.30 }, DEMO, first.pending);
  assert.equal(second.action, 'confirm');
  assert.equal(second.confirmedAfterReads, 2);
  assert.equal(second.pending, null);
});

test('returning to the old level is a FLASH — logged with both levels, not rebased', () => {
  const first = switchDecision(REAL, DEMO, null);
  const back = switchDecision({ equity: 3955.46 }, DEMO, first.pending);
  assert.equal(back.action, 'flash');
  assert.equal(back.flash.from, 3955.57);
  assert.equal(back.flash.to, 22.28);
  assert.ok(back.flash.heldMs >= 0);
  assert.equal(back.pending, null);
});

test('a DIFFERENT wild level restarts the window (no rebase on either)', () => {
  const first = switchDecision(REAL, DEMO, null);
  const other = switchDecision({ equity: 500 }, DEMO, first.pending);
  assert.equal(other.action, 'pending');
  assert.equal(other.pending.reads, 1);
  assert.equal(other.pending.eq.equity, 500);
});

test('non-vacuity: ordinary moves pass as none, and boot/zero samples cannot switch', () => {
  assert.equal(switchDecision({ equity: 3941.98 }, DEMO, null).action, 'none');
  assert.equal(switchDecision({ equity: 4025.92 }, DEMO, null).action, 'none');
  assert.equal(switchDecision(REAL, null, null).action, 'none'); // first sample of a session
  assert.equal(switchDecision({ equity: 0 }, DEMO, null).action, 'none');
});

test('at ANY constant, read #1 may never rebase (mutation check on SWITCH_CONFIRM_READS)', () => {
  assert.ok(SWITCH_CONFIRM_READS >= 2);
  assert.equal(switchDecision(REAL, DEMO, null).action, 'pending');
});

test('ONE decider, BOTH sites: the confirmation rule cannot diverge', () => {
  const calls = src.match(/switchDecision\(acc, lastAccepted, pendingSwitch\)/g) || [];
  assert.equal(calls.length, 2, 'both switch sites must call the pure decider (two-writers defect, P1b)');
  const rebases = src.match(/await rebaselineForSwitch\(/g) || [];
  assert.equal(rebases.length, 2, 'rebaselineForSwitch is reachable only from the two gated sites');
  const flashes = src.match(/await logSwitchFlash\(userId, sw/g) || [];
  assert.equal(flashes.length, 2, 'the flash row is written from both sites');
  const clears = src.match(/pendingSwitch = sw\.pending;/g) || [];
  assert.equal(clears.length, 2, 'both sites advance the pending window');
});
