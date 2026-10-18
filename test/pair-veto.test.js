// test/pair-veto.test.js — TRD-17: the pairId correlation-veto exemption gate.
// The exemption skips the veto ONLY between the two legs of the same pair
// (both sides must carry the same non-null pairId); everything else still
// faces the 30-day log-returns veto. The forced-pair POSITIVE CONTROL against
// real Gold/Silver data runs in temp/trd17-pair-control.js.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { pairExempt } = require('../trading/agent/risk');

test('pairExempt: same non-null pairId on BOTH sides -> exempt', () => {
  assert.strictEqual(pairExempt({ pairId: 'P1' }, { pairId: 'P1' }), true);
  assert.strictEqual(pairExempt({ pairId: 42 }, { pairId: '42' }), true); // string-compared
});

test('pairExempt: anything short of a matching non-null pair is NOT exempt', () => {
  assert.strictEqual(pairExempt({ pairId: 'P1' }, { pairId: 'P2' }), false);
  assert.strictEqual(pairExempt({ pairId: 'P1' }, {}), false);
  assert.strictEqual(pairExempt({}, { pairId: 'P1' }), false);
  assert.strictEqual(pairExempt({ pairId: null }, { pairId: null }), false);
  assert.strictEqual(pairExempt(null, { pairId: 'P1' }), false);
  assert.strictEqual(pairExempt({ pairId: 'P1' }, null), false);
});
