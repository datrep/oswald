// test/decision-parse-fallback.test.js — TRD-113: a rescued reply is not a parsed answer (2026-09-21).
//
// THE DEFECT, measured live. 2026-09-20T23:28Z, wake promptId 4622: chair-2 ("risk") returned a reply whose
// completionTokens came back **pinned at the 2000 cap** — the thinking budget was exhausted and the JSON
// object never arrived intact. Because the content was NOT empty, `isTruncatedEmpty` returned false, so no
// retry widened the budget; and `parseDecision`'s last-resort regex then pulled a "no" out of the wreckage.
// `chairVotes`' abstain test matches `llm_error|parse_failure|budget_cap` — which does not match
// "regex-fallback" — so a FORMATTING FAILURE was blended as a FULL-WEIGHT REASONED DISSENT (weight 1 of 3).
// Six decisions carry such a vote.
//
// THE FIX IS IN THREE PLACES, and all three are pinned here, because any one of them alone would leave the
// hole: the tag (so the fact can travel), the retry (so the budget that starved the answer is widened), and
// the blend (so no future path can feed one in).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const { parseDecision } = require('../trading/agent/deepseek');

const DEEPSEEK = 'trading/agent/deepseek.js';
const AGGREGATOR = 'trading/agent/aggregator.js';

// --- the tag ------------------------------------------------------------------

test('a rescued reply is TAGGED, and never looks like a parse', () => {
  // The shape the rescue actually fires on: the `"decision":` key is present but the object is not parseable
  // — a truncated JSON object, which is what a cap-pinned reply produces.
  const truncatedObject = '{"decision":"no","confidence":0.5,"reason":"the bar closed inside the band, so this';
  const r = parseDecision(truncatedObject);
  assert.ok(r, 'the rescue still recovers the bit that was there');
  assert.strictEqual(r.decision, 'no');
  assert.strictEqual(r.confidence, 0.5, 'a rescued answer carries no confidence of its own');
  assert.strictEqual(r.reason, 'regex-fallback');
  assert.strictEqual(r.regexRescue, true, '★ THE TAG IS THE FIX: without it the caller cannot tell');
});

test('a real parse is NOT tagged — the rescue must stay rare and visible', () => {
  const strict = parseDecision('{"decision":"yes","confidence":0.7,"reason":"trend intact"}');
  assert.strictEqual(strict.decision, 'yes');
  assert.strictEqual(strict.confidence, 0.7);
  assert.strictEqual(strict.regexRescue, undefined, 'the strict path is unchanged');

  // A fenced reply is stripped before parsing, so it is a parse.
  const fenced = parseDecision('```json\n{"decision":"no","confidence":0.6,"reason":"chop"}\n```');
  assert.strictEqual(fenced.decision, 'no');
  assert.strictEqual(fenced.regexRescue, undefined);

  // So is a JSON object embedded in prose — the first {...} span parses.
  const embedded = parseDecision('I think {"decision":"no","confidence":0.4,"reason":"range-low false break"} overall.');
  assert.strictEqual(embedded.decision, 'no');
  assert.strictEqual(embedded.regexRescue, undefined);
});

test('the reply that cannot be rescued still fails closed (no accidental rescue)', () => {
  // The `stub: 'garbage'` mode produces `"decision": "maybe"`, which the rescue cannot match (yes|no only).
  assert.strictEqual(parseDecision('```json\n{"decision": "maybe", "confidence": 99, }\n'), null);
  assert.strictEqual(parseDecision(''), null);
  assert.strictEqual(parseDecision(null), null);
});

// --- where the tag is honoured -------------------------------------------------

test('★ askDecision refuses a rescue, retries it, and then fails closed', () => {
  const src = code(DEEPSEEK);
  assert.match(src, /const rescued = !!\(parsed && parsed\.regexRescue\);/,
    'the tag has to be READ where the decision is made, not only written');
  assert.match(src, /if \(parsed && !rescued\) \{/, 'a rescued answer must not be returned as the decision');
  assert.match(src, /if \(truncated \|\| rescued \|\| capped\) maxTokens = Math\.max\(maxTokens \* 4, maxTokens \+ 1500\);/,
    'a rescue and a cap must both widen the budget and retry ONCE');
  assert.match(src, /reason: 'parse_failure'/, 'two failures land on parse_failure — the answer every caller reads as "did not answer"');
});

test('★ the ROOT is pinned too: a non-empty reply that hit the cap counts as truncated', () => {
  const src = code(DEEPSEEK);
  assert.match(src, /const capped = r\.finishReason === 'length' && String\(r\.text \|\| ''\)\.length > 0;/,
    "isTruncatedEmpty returns false the moment there is ANY content, which is why the cap-pinned reply never widened the budget");
  // and the empty-only detector is still there for the case it was written for
  assert.match(src, /function isTruncatedEmpty\(reply, maxTokens\)/);
});

test('★ the chair blend abstains on a rescued vote, independently of deepseek.js', () => {
  const src = code(AGGREGATOR);
  assert.match(src, /\^\(llm_error\|parse_failure\|budget_cap\|regex-fallback\)/,
    'a rescued vote is the model NOT having answered; it must not reach the weighted blend');
});

test('the defect stated as a regression: the OLD pattern counted a rescue as a reasoned vote', () => {
  const old = /^(llm_error|parse_failure|budget_cap)/;
  assert.strictEqual(old.test('regex-fallback'), false,
    'this false IS the bug — a malformed reply was blended as dissent');
  const next = /^(llm_error|parse_failure|budget_cap|regex-fallback)/;
  assert.strictEqual(next.test('regex-fallback'), true);
  assert.strictEqual(next.test('deliberation approved'), false, 'and the new pattern does not over-match');
  assert.strictEqual(next.test('budget_cap: chair over its daily cap'), true, 'the existing cases still match');
});
