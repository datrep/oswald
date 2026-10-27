// test/deepseek-reasoning-controls.test.js — 2026-10-20.
//
// THE CLIENT SENT NEITHER SWITCH FOR EIGHT WEEKS. The API documents `thinking` and `reasoning_effort`
// (none|low|high|max, 'none' disables thinking, default 'high'); deepseek.js sent neither, so every call ran on
// the server default with no way to ask otherwise. The fix passes both through — and the load-bearing property is
// that NOTHING IS SENT UNLESS ASKED, so the desk's behaviour is byte-identical until a caller opts in. A client
// that silently changed the reasoning mode of every decision would be a policy change disguised as a refactor.
const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');

const src = code('trading/agent/deepseek.js').replace(/\r\n/g, '\n');
const bodyOfCallChat = () => {
  const start = src.indexOf('async function callChat');
  assert.ok(start > -1, 'callChat must exist');
  return src.slice(start, src.indexOf('\nfunction recordCallUsage', start));
};

test('★★ the reasoning controls are only added to the body when a caller asks', () => {
  const body = bodyOfCallChat();
  // the guarded insertions, in this order, and nowhere else
  assert.match(body, /if \(typeof thinking === 'boolean'\) body\.thinking = \{ type: thinking \? 'enabled' : 'disabled' \};/);
  assert.match(body, /if \(effort\) body\.reasoning_effort = effort;/);
  // the base literal must not carry either key: slice only the object literal itself, up to its closing brace
  const litStart = body.indexOf('const body = {');
  const base = body.slice(litStart, body.indexOf('};', litStart) + 2);
  assert.ok(!/reasoning_effort|thinking/.test(base), `the base body must stay clean: ${base}`);
});

test('★ defaults are undefined, so the pre-change behaviour is preserved exactly', () => {
  const sig = bodyOfCallChat().split('\n')[0];
  assert.match(sig, /thinking = undefined/, 'thinking must default to undefined (server default)');
  assert.match(sig, /reasoningEffort = undefined/, 'effort must default to undefined (server default)');
});

test('★ the four documented efforts are accepted and the aliases are mapped', () => {
  assert.match(src, /REASONING_EFFORTS = Object\.freeze\(\['none', 'low', 'high', 'max'\]\)/);
  assert.match(src, /EFFORT_ALIASES = Object\.freeze\(\{ minimal: 'low', medium: 'high', xhigh: 'high' \}\)/);
  const body = bodyOfCallChat();
  assert.match(body, /EFFORT_ALIASES\[reasoningEffort\] \|\| reasoningEffort/, 'aliases resolve before validation');
  assert.match(body, /REASONING_EFFORTS\.includes\(wantedEffort\)/, 'an unknown effort is ignored, not sent');
});

test('★ an unknown effort cannot take the chair offline — it is dropped, not thrown', () => {
  const body = bodyOfCallChat();
  const effortBlock = body.slice(body.indexOf('const wantedEffort'), body.indexOf('if (jsonMode)'));
  assert.ok(!/throw/.test(effortBlock), 'no throw on a bad effort: the desk must keep trading on a typo');
  assert.match(effortBlock, /\? wantedEffort\s*:\s*null|: null;/, 'invalid values collapse to null');
});

test('★ the ledger records the reasoning mode and the reasoning-token split', () => {
  assert.match(src, /reasoningTokens: data\.usage\?\.completion_tokens_details\?\.reasoning_tokens \?\? null/);
  assert.match(src, /reasoningTokens: usage\.reasoningTokens/, 'it reaches the llm_call row');
  assert.match(src, /reasoningEffort,\n\s+thinkingDisabled:/, 'the row names the mode that actually ran');
});

test('★ promptChars counts an image as the provider image cap, not as "[object Object]"', () => {
  const { promptCharsOf } = require('../trading/agent/deepseek');
  assert.equal(promptCharsOf([{ role: 'user', content: 'hello' }]), 5);
  const withImage = promptCharsOf([{ role: 'user', content: [{ type: 'text', text: 'abc' }, { type: 'image_url', image_url: { url: 'data:...' } }] }]);
  assert.equal(withImage, 3 + 1024, 'text plus one image ceiling');
  assert.equal(promptCharsOf(null), 0);
  assert.equal(promptCharsOf([{ role: 'user', content: [{ type: 'text', text: 'xy' }] }]), 2);
});
