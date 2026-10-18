// test/llm-usage-metering.test.js — TRD-78, 2026-09-20.
//
// WHY THIS EXISTS. The desk stored ONE `usage` object per WAKE, so the numbers were a sum over everything
// that ran and could not be attributed to a call, a chair or a persona. Measured 2026-09-20: the stored rows
// read `hit 8,192` on a wake whose shared system prefix is ~190 tokens, and NOTHING in the record could say
// which call that came from — so "the fan-out pays 5.3k miss tokens three times" was measurable while "what
// is actually being cached" was not. The provider's own `prompt_tokens` was also being DISCARDED, leaving no
// denominator to compare a hit against. Both are pinned here, because a measurement instrument that quietly
// stops measuring is worse than none: it is believed.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const deepseek = require('../trading/agent/deepseek');
const store = require('../trading/store');

test('★ recordCallUsage writes one row per call, carrying BOTH sides of the ratio', async (t) => {
  const log = store.logEvent;
  t.after(() => { store.logEvent = log; });
  let seen = null;
  store.logEvent = async (uid, kind, payload) => { seen = { uid, kind, payload }; };

  deepseek.recordCallUsage(1, {
    label: 'chair:trend', model: 'deepseek-flash', maxTokens: 2000, promptChars: 51000, latencyMs: 4200,
    usage: { promptTokens: 8080, promptCacheHitTokens: 2731, promptCacheMissTokens: 5349, completionTokens: 120 },
  });

  assert.strictEqual(seen.kind, 'llm_call',
    'NOT `llm_usage`: budget.js sums every llm_usage row as spend, so a second row per call double-counts the day');
  assert.strictEqual(seen.uid, 1);
  assert.strictEqual(seen.payload.label, 'chair:trend', 'a row has to belong to a CALLER');
  assert.strictEqual(seen.payload.promptChars, 51000, 'what we sent — countable on our side');
  assert.strictEqual(seen.payload.promptTokens, 8080, "the provider's denominator");
  assert.strictEqual(seen.payload.cacheHit, 2731);
  assert.strictEqual(seen.payload.cacheMiss, 5349);
});

test('a call with no known owner is NOT logged — the desk never mis-attributes', () => {
  assert.match(code('trading/agent/deepseek.js'),
    /if \(uid == null \|\| !Number\.isFinite\(uid\)\) return;/);
});

test('★ the row cannot be mistaken for BUDGET spend — it is a different kind from the ledger', () => {
  const src = code('trading/agent/deepseek.js');
  assert.match(src, /store\.logEvent\(uid, 'llm_call', \{/);
  assert.ok(!/store\.logEvent\(uid, 'llm_usage'/.test(src),
    'budget.js reads kind = llm_usage to compute spentToday; a second row per call double-counts the cap');
  assert.match(code('trading/agent/budget.js'), /kind: 'llm_usage'/,
    'and budget.js must still be the only writer of that kind');
});

test('★ the provider prompt size is captured rather than discarded', () => {
  const src = code('trading/agent/deepseek.js');
  assert.match(src, /promptTokens: data\.usage\?\.prompt_tokens \?\? null/,
    'a missing denominator must read as MISSING (null), not as 0');
  assert.match(src, /recordCallUsage\(userId, \{/);
  assert.match(src, /promptChars: \(messages \|\| \[\]\)\.reduce/);
});

test('the label reaches callChat from the chair, or every row reads "unlabelled"', () => {
  assert.match(code('trading/agent/chair.js'), /label: `chair:\$\{persona \|\| 'none'\}`/);
  assert.match(code('trading/agent/deepseek.js'), /label: opts\.label \|\| 'decision'/);
  const src = code('trading/agent/deepseek.js');
  assert.match(src, /if \(!stub\) return askDecision\(userId, messages, settings, opts\);/,
    'the stub wrapper must forward opts, or the label is dropped on the path the tests use');
});
