// test/chair-prompt-order.test.js — TRD-78(b) (fix landed 2026-09-21; verified and pinned 2026-09-22).
//
// ★ THE DEFECT WAS A MESSAGE ORDER, AND AN ORDER IS INVISIBLE IN A DIFF.
//
// All three chairs receive a BYTE-IDENTICAL bundle, so seats 2 and 3 should hit a prefix cache for the whole
// thing. They could not, because the persona block sat INSIDE the system message — i.e. BEFORE the bundle — so
// the three requests diverged about 190 tokens in and every byte after that was paid at full price, three times
// per wake. The bundle itself was never the problem: it is identical across the three seats within a wake.
//
// MEASURED AFTER THE FIX, last 24h, from the `llm_call` events (label + flat cacheHit/cacheMiss fields):
//     chair:trend   29 calls   hit  41,725  miss 186,177  18.3%   <- pays the cold miss
//     chair:risk    26 calls   hit 204,544  miss   7,134  96.6%
//     chair:macro   30 calls   hit 240,128  miss   7,859  96.8%
// Seat 1 pays ~6,420 miss per call; seats 2 and 3 pay ~270. TRD-78's original measurement was hit 8,064
// (2,688 x 3) against miss 15,908 — the miss has more than halved, and "the shared context is paid in full
// three times" is no longer true: it is paid ONCE.
//
// WHY THIS IS PINNED RATHER THAN LEFT TO THE LEDGER. Nothing in a code review makes this ordering look load
// bearing — moving the persona back into the system message reads as tidying, and its only symptom is a cache
// ratio, which no unit test would otherwise check.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessages, PERSONAS } = require('../trading/agent/chair');

const BUNDLE = '=== OSWALD TRADING AGENT — TELEMETRY BUNDLE ===\n--- MARKET SNAPSHOT ---\nGold mid=4362.79';

test('the premise: there are several personas, and each is distinct', () => {
  // If the personas collapsed to one, the shared-prefix question disappears — and so does the reason the
  // fan-out exists (three seats with one voice waste tokens, TRD-12).
  const ids = Object.keys(PERSONAS);
  assert.ok(ids.length >= 2, `expected at least two personas, found ${ids.length}`);
  const texts = ids.map((id) => PERSONAS[id].join('\n'));
  assert.equal(new Set(texts).size, ids.length, 'personas must be DISTINCT, or the fan-out is three identical calls');
});

test('★ the SYSTEM message is byte-identical across seats (this IS the shared prefix)', () => {
  const ids = Object.keys(PERSONAS);
  const systems = ids.map((id) => buildMessages(BUNDLE, id)[0].content);
  assert.equal(new Set(systems).size, 1,
    'the system message must be identical for every seat, or the three requests diverge before the bundle cache');
  assert.equal(buildMessages(BUNDLE, null)[0].content, systems[0],
    'a chair with no persona must still share the same system prefix');
});

test('★ the bundle comes FIRST in the user message and the persona travels LAST', () => {
  for (const id of Object.keys(PERSONAS)) {
    const [, user] = buildMessages(BUNDLE, id);
    // The bundle must be present VERBATIM and at position 0 — a prefix cache matches from byte zero, so a
    // persona line in front of it is the same defect as putting it in the system message.
    assert.ok(user.content.startsWith(BUNDLE),
      `seat ${id}: the user message must OPEN with the bundle, not with the role`);
    const roleAt = user.content.indexOf('YOUR ROLE');
    assert.ok(roleAt > BUNDLE.length - 1,
      `seat ${id}: the role block must come AFTER the bundle`);
    // And the persona's own words must appear, so the seat is still differentiated.
    assert.ok(user.content.includes(PERSONAS[id][0]),
      `seat ${id}: its persona text must reach the prompt`);
  }
});

test('★ two seats share a LONG common prefix (the measurable form of the fix)', () => {
  // The cache question is "how many leading bytes are shared", so assert it directly rather than trusting the
  // structure above to imply it. The three user messages must agree for the whole bundle and diverge only at
  // the role marker.
  const a = buildMessages(BUNDLE, 'trend')[1].content;
  const b = buildMessages(BUNDLE, 'risk')[1].content;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  assert.ok(common >= BUNDLE.length,
    `seats should share at least the whole ${BUNDLE.length}-char bundle, but they diverge at char ${common}`);
  // And the divergence must be inside the short role tail, not somewhere in the middle of the bundle.
  assert.ok(a.length - common < 400, `the seats diverge ${a.length - common} chars from the end — the tail should be short`);
});
