// test/llm-truncation.test.js — 2026-09-11 chair-offline incident: thinking
// models (deepseek-v4-pro) bill reasoning_content INSIDE max_tokens; hitting
// the cap mid-think returns EMPTY content (finish_reason 'length') before the
// JSON answer is emitted. This signature drives the retry-with-headroom logic
// in askDecision + reviewOne.
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isTruncatedEmpty } = require('../trading/agent/deepseek');

const usage = (n) => ({ usage: { completionTokens: n } });

test('empty content at the cap = truncation (the exact chair-offline case)', () => {
  assert.strictEqual(isTruncatedEmpty({ text: '', ...usage(500), finishReason: 'length' }, 500), true);
  assert.strictEqual(isTruncatedEmpty({ text: '', ...usage(500) }, 500), true);
});

test('finish_reason=length marks truncation even below the usage heuristic', () => {
  assert.strictEqual(isTruncatedEmpty({ text: '', ...usage(460), finishReason: 'length' }, 500), true);
});

test('empty content well under the cap is NOT truncation (genuine failure stays fail-secure)', () => {
  assert.strictEqual(isTruncatedEmpty({ text: '', ...usage(300) }, 500), false);
});

test('non-empty content is never treated as truncated', () => {
  assert.strictEqual(isTruncatedEmpty({ text: '{"decision":"yes"}', ...usage(500), finishReason: 'length' }, 500), false);
});

test('missing usage or empty reply is not a truncation signature', () => {
  assert.strictEqual(isTruncatedEmpty({ text: '' }, 500), false);
  assert.strictEqual(isTruncatedEmpty(null, 500), false);
});

test('boundary: used = cap-2 truncates, cap-3 does not (without finish_reason)', () => {
  assert.strictEqual(isTruncatedEmpty({ text: '', ...usage(498) }, 500), true);
  assert.strictEqual(isTruncatedEmpty({ text: '', ...usage(497) }, 500), false);
});
