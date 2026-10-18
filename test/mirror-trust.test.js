// test/mirror-trust.test.js — 2026-09-11: empty-venue read trust gate.
// Bitcoin #22 incident: the mirror must reconcile on a FLAT venue (phantom-
// flagging local-open rows whose venue position vanished), but a false-empty
// positions read must never phantom the ledger — the independent 1s account
// strip must agree (fresh + margin 0) before an empty read is trusted.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { assessEmptyTrust } = require('../trading/agent/mirrorPoller');

const NOW = Date.parse('2026-09-10T17:30:00.000Z');

test('empty read trusted when account strip is fresh and flat', () => {
  const r = assessEmptyTrust({ readAt: '2026-09-10T17:29:50.000Z', margin: 0, equity: 4000 }, NOW);
  assert.strictEqual(r.trusted, true);
  assert.strictEqual(r.reason, 'account_flat');
});

test('empty read NOT trusted when account strip is stale (>120s)', () => {
  const r = assessEmptyTrust({ readAt: '2026-09-10T17:27:59.999Z', margin: 0 }, NOW);
  assert.strictEqual(r.trusted, false);
  assert.strictEqual(r.reason, 'account_strip_stale');
});

test('empty read NOT trusted when margin is non-zero (venue holds a position)', () => {
  const r = assessEmptyTrust({ readAt: '2026-09-10T17:29:55.000Z', margin: 12.5 }, NOW);
  assert.strictEqual(r.trusted, false);
  assert.strictEqual(r.reason, 'margin_not_zero');
});

test('empty read NOT trusted without a strip or with unparsed margin', () => {
  assert.strictEqual(assessEmptyTrust(null, NOW).trusted, false);
  assert.strictEqual(assessEmptyTrust(null, NOW).reason, 'account_strip_missing');
  assert.strictEqual(assessEmptyTrust({ readAt: '2026-09-10T17:29:55.000Z', margin: null }, NOW).reason, 'margin_unknown');
});

test('boundary: exactly 120s old still trusted, 120.001s stale', () => {
  assert.strictEqual(assessEmptyTrust({ readAt: new Date(NOW - 120000).toISOString(), margin: 0 }, NOW).trusted, true);
  assert.strictEqual(assessEmptyTrust({ readAt: new Date(NOW - 120001).toISOString(), margin: 0 }, NOW).reason, 'account_strip_stale');
});
