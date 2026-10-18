// test/binding-event-payload.test.js — the crash that let the reviewer propose exactly once.
//
// THE DEFECT (found 2026-09-15, by the first forced proposal since 2026-09-14):
//
//     const lastSig = last && last.payload ? (JSON.parse(last.payload).inputSig || null) : null;
//
// `store.listEvents` ALREADY parses payloads via `safeJson`, so `last.payload` is an OBJECT and
// `JSON.parse` receives "[object Object]" and throws. It could not fire on the FIRST proposal (there was
// no prior event), so it survived review, tests and a live run — and from the second proposal onward it
// crashed before `shouldPropose` was ever consulted, inside a bare `catch`, so the reviewer was dead for
// every wake with NO log, NO event and NO alert. A control that fails silently, again.
//
// The shapes are THREE, not one, and that is why this is a helper rather than an inline expression:
// safeJson returns an object, or the RAW STRING when the JSON is invalid, or null when the payload is
// empty. A guard that assumes the object shape is the original bug; a guard that assumes the string shape
// is the same bug inverted. These tests pin all three.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const bp = require('../trading/agent/bindingProposer');

test('the payload reader handles all three shapes safeJson can return', () => {
  // 1. The REAL shape from store.listEvents - already parsed. This is what crashed.
  assert.deepEqual(bp.eventPayload({ payload: { inputSig: 'abc123' } }), { inputSig: 'abc123' });
  // 2. The shape a caller who has only ever seen the raw column would expect.
  assert.deepEqual(bp.eventPayload({ payload: '{"inputSig":"abc123"}' }), { inputSig: 'abc123' });
  // 3. Empty / absent payloads: null, never a throw and never a fabricated object.
  assert.equal(bp.eventPayload({ payload: null }), null);
  assert.equal(bp.eventPayload({}), null);
  assert.equal(bp.eventPayload(null), null);
  // 4. Unparseable text returns null rather than propagating a SyntaxError into a wake.
  assert.equal(bp.eventPayload({ payload: 'not json at all' }), null);
  // 5. A non-object scalar cannot pretend to be a payload.
  assert.equal(bp.eventPayload({ payload: 42 }), null);
});

test('reading the previous signature never throws — the whole point', () => {
  // The exact expression that used to be inline. Every one of these must yield a value or null.
  const read = (ev) => (bp.eventPayload(ev) || {}).inputSig || null;
  assert.equal(read({ payload: { inputSig: 'sig1' } }), 'sig1');
  assert.equal(read({ payload: '{"inputSig":"sig1"}' }), 'sig1');
  assert.equal(read({ payload: null }), null);
  assert.equal(read({ payload: 'garbage' }), null);
  assert.equal(read(undefined), null);
  // A payload that is the REDACTED-string shape from the earlier field-name bug still reads cleanly.
  assert.equal(read({ payload: { signature: '[REDACTED]' } }), null, 'the old field name must not resurrect a match');
});

test('a second proposal is not blocked by the presence of a first — the regression this pins', () => {
  // `shouldPropose` is the gate that decides, and it depends on lastSig. Before the fix the code never
  // reached it. With a prior event present and the SAME signature, the floor must hold (no proposal);
  // that is only reachable if reading the prior signature succeeded.
  const prior = { payload: { inputSig: 'a'.repeat(16) } };
  const lastSig = (bp.eventPayload(prior) || {}).inputSig || null;
  assert.equal(lastSig, 'a'.repeat(16));
  const held = bp.shouldPropose({ sig: 'a'.repeat(16), lastSig, lastAt: new Date().toISOString(), minIntervalH: 12, maxStaleH: 168 });
  assert.equal(held.propose, false, 'same input inside the floor => no proposal');

  // ...and a MOVED signature proposes once the FLOOR has elapsed, so the reviewer is alive on the
  // second run. (Inside the floor it must NOT: a busy day must not become a proposal per wake.)
  const recent = new Date(Date.now() - 1 * 3600000).toISOString();
  const tooSoon = bp.shouldPropose({ sig: 'b'.repeat(16), lastSig, lastAt: recent, minIntervalH: 12, maxStaleH: 168 });
  assert.equal(tooSoon.propose, false);
  assert.match(tooSoon.why, /input moved but only/);

  const later = new Date(Date.now() - 20 * 3600000).toISOString();
  const moved = bp.shouldPropose({ sig: 'b'.repeat(16), lastSig, lastAt: later, minIntervalH: 12, maxStaleH: 168 });
  assert.equal(moved.propose, true);
  assert.equal(moved.why, 'input changed');

  // The ceiling still fires when nothing moved at all — the half a pure change-trigger gets wrong.
  const stale = bp.shouldPropose({ sig: 'a'.repeat(16), lastSig, lastAt: new Date(Date.now() - 200 * 3600000).toISOString(), minIntervalH: 12, maxStaleH: 168 });
  assert.equal(stale.propose, true);
  assert.match(stale.why, /stale/);
});
