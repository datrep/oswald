// test/chair-prompt-cache.test.js — TRD-78(b): the shared prefix comes first (2026-09-21).
//
// THE FINDING THIS PINS. The three chairs receive a BYTE-IDENTICAL bundle, so seats 2 and 3 should be able to
// hit a prefix cache for essentially the whole prompt. They could not, because the persona block lived inside
// the SYSTEM message — i.e. before the bundle — so the requests diverged ~190 tokens in and every byte after
// that was paid at full price, three times per wake.
//
// And the measurement was already in the record, in the retry path: when a chair reply is truncated,
// `askDecision` retries with a bigger budget and that call is a byte-identical repeat. On 2026-09-20 the
// retry reported cacheHit **8,448 of 8,591** prompt tokens (98%) while a fresh chair call in the same wake
// reported **384** (4.5%). The ceiling was the ordering, not the provider and not the bundle's volatility.
//
// WHAT MUST STAY TRUE, and is pinned as an INVARIANT rather than as a string: the system message is shared,
// the bundle comes before anything seat-specific, each seat still gets its OWN role text, and the answer
// contract stays in the shared prefix where every seat reads it.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const chair = require('../trading/agent/chair');

const SEATS = ['trend', 'risk', 'macro'];
const BUNDLE = '=== OSWALD TRADING AGENT — TELEMETRY BUNDLE ===\nAccount: DEMO (paper).\nHARD RULE: ...\nGold (plus500): mid=4372.36 ...';

test('★ all three chairs share ONE prefix: the bundle, not the persona', () => {
  const msgs = SEATS.map((p) => chair.buildMessages(BUNDLE, p));

  // 1. The system message is IDENTICAL across seats — that is what makes the shared prefix start at byte 0.
  assert.strictEqual(new Set(msgs.map((m) => m[0].content)).size, 1,
    'a per-persona system message is exactly what broke the cache');
  // ...and none of them carries a persona HEADER. The assertion targets the persona, not the bare word: the
  // shared preamble says "the risk modules are deterministic code", so /risk/ would match legitimately.
  for (const seat of SEATS) {
    assert.ok(!new RegExp(`${seat} chair`, 'i').test(msgs[0][0].content),
      `the "${seat} chair" persona must not be in the shared prefix`);
  }

  // 2. The bundle comes BEFORE anything seat-specific, in every seat's user message.
  for (const [i, m] of msgs.entries()) {
    const user = m[1].content;
    assert.ok(user.startsWith(BUNDLE), `seat ${SEATS[i]}: the bundle must stay first in the user message`);
    const at = user.indexOf('--- YOUR ROLE');
    assert.ok(at > BUNDLE.length, `seat ${SEATS[i]}: the persona block must sit AFTER the bundle`);
    assert.ok(new RegExp(`${SEATS[i]} chair`, 'i').test(user.slice(at)),
      `seat ${SEATS[i]}: and it must name its own seat`);
  }

  // 3. The role blocks must DIFFER — that was the whole point of the personas (TRD-12, 2026-09-10), and
  //    moving them must not quietly collapse the three voices into one.
  const roleBlocks = msgs.map((m) => m[1].content.slice(m[1].content.indexOf('--- YOUR ROLE')));
  assert.strictEqual(new Set(roleBlocks).size, SEATS.length, 'each seat still gets its OWN role text');
});

test('the answer contract stays in the shared prefix, where every seat reads it', () => {
  const m = chair.buildMessages(BUNDLE, 'trend');
  assert.match(m[0].content, /Answer with a single JSON object exactly in the shape:/);
  assert.match(m[0].content, /"decision":"yes\|no"/);
  // The seat instruction is still in the shared preamble — only the persona moved.
  assert.match(m[0].content, /Reason from YOUR assigned role only/);
});

test('a chair with no persona gets the bare bundle — no re-rendering, no suffix', () => {
  const m = chair.buildMessages(BUNDLE, null);
  assert.strictEqual(m[1].content, BUNDLE, 'byte-for-byte the bundle, so a persona-less call is unchanged');
  assert.ok(!/YOUR ROLE/.test(m[1].content));
});

test('the ordering is pinned structurally, so a refactor cannot put the persona back in front', () => {
  const src = code('trading/agent/chair.js');
  assert.match(src, /const roleLines = persona \? \(PERSONAS\[persona\] \|\| \[String\(persona\)\]\) : \[\];/,
    'the persona is collected SEPARATELY from the system lines');
  assert.match(src, /\$\{bundleText\}\\n\\n--- YOUR ROLE/, 'the bundle is interpolated BEFORE the role block');
  assert.ok(!/if \(persona\) \{\s*const p = PERSONAS\[persona\];\s*lines\.push/.test(src),
    'the old "push the persona into the system lines" shape must be gone, not merely bypassed');
});
