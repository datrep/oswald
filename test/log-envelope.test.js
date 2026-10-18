// 2026-09-12 (v1.2 audit): envelope pins — stream registry coverage, level
// mapping and enrich defaults. These pin the reviewer findings: unmapped kinds
// defaulted to app.*, levels were two-valued, and actor/causation behaviour
// was undocumented.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { streamFor, levelFor, enrich } = require('../trading/agent/log');

test('stream registry covers the kinds the codebase writes (v1.2 additions)', () => {
  assert.equal(streamFor('tune'), 'sec');
  assert.equal(streamFor('tune_revert'), 'sec');
  assert.equal(streamFor('llm_model_mismatch'), 'sec');
  assert.equal(streamFor('order_attempt'), 'act');
  assert.equal(streamFor('discover_signal'), 'act');
  assert.equal(streamFor('politician_alert'), 'act');
  assert.equal(streamFor('account_switch'), 'state');
  assert.equal(streamFor('fill_telemetry'), 'state');
  assert.equal(streamFor('multi_tf_backfill'), 'market');
  assert.equal(streamFor('trd26_gate'), 'act');
  assert.equal(streamFor('something_brand_new'), 'app'); // unknown kinds stay app.*
});

test('levels: warn where the semantics warrant it; error stays error', () => {
  assert.equal(levelFor('order_rejected'), 'warn');
  assert.equal(levelFor('phantom_fill'), 'warn');
  assert.equal(levelFor('account_switch'), 'warn');
  assert.equal(levelFor('budget_warn'), 'warn');
  assert.equal(levelFor('divergence_alert'), 'warn');
  assert.equal(levelFor('error'), 'error');
  assert.equal(levelFor('wake'), 'info');
});

test('enrich: actor defaults to system; an explicit call-site actor wins; causationId defaults null', () => {
  const a = enrich('wake', { reason: 'x' });
  assert.equal(a.actor, 'system');
  assert.equal(a.causationId, null);
  const b = enrich('central', { actor: 'llm:deepseek-v4-pro:82', rationale: 'headline' });
  assert.equal(b.actor, 'llm:deepseek-v4-pro:82');
  assert.equal(b.rationale, 'headline');
});

test('enrich is idempotent: existing envelope fields win over defaults', () => {
  const first = enrich('wake', { actor: 'llm:x:1', stream: 'act' });
  const second = enrich('wake', first);
  assert.equal(second.actor, 'llm:x:1');
  assert.equal(second.stream, 'act');
});
