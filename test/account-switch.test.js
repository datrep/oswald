// 2026-09-11 (owner patch): ACCOUNT-SWITCH pins — a demo<->live account flip
// (4025 -> 22.28) must read as a switch, not as a -99% P&L move; ordinary
// moves and flickers must not.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isAccountSwitch } = require('../trading/agent/accountPoller');

test('demo -> live (4025 -> 22.28) is an account switch', () => {
  assert.equal(isAccountSwitch({ equity: 22.28 }, { equity: 4025.29 }), true);
});

test('live -> demo (22.28 -> 4025) is an account switch', () => {
  assert.equal(isAccountSwitch({ equity: 4025.29 }, { equity: 22.28 }), true);
});

test('normal P&L move is not a switch', () => {
  assert.equal(isAccountSwitch({ equity: 3941.98 }, { equity: 4024.36 }), false);
});

test('small flicker is not a switch', () => {
  assert.equal(isAccountSwitch({ equity: 4025.92 }, { equity: 4028.46 }), false);
});

test('factor-5x gain is treated as a switch', () => {
  assert.equal(isAccountSwitch({ equity: 600 }, { equity: 100 }), true);
});

test('79% drop stays a (harsh) P&L move', () => {
  assert.equal(isAccountSwitch({ equity: 21 }, { equity: 100 }), false);
});

test('first sample / zero previous equity is not a switch', () => {
  assert.equal(isAccountSwitch({ equity: 22.28 }, null), false);
  assert.equal(isAccountSwitch({ equity: 22.28 }, { equity: 0 }), false);
});
