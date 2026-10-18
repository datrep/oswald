'use strict';
// The logging redactor, and the defect the SWEEP found (2026-09-15).
//
// The original denylist matched `token` with no boundary, so it struck every token COUNTER the desk
// logs - completionTokens, promptTokens, promptCacheHitTokens, promptCacheMissTokens, inputTokens,
// outputTokens, tokens. Measured: 945 of 1002 llm_usage events stored "[REDACTED]" for exactly those
// fields, and all 57 clean ones predate 2026-09-10. budget.todayUsage() reads them with Number(...)||0,
// so the LLM budget metered ZERO - /api/trading/budget returned total: 0 with used: 0 for every
// consumer while the desk was making chair, review, shadow and pulse calls.
//
// These tests exist to keep the two halves of the fix honest: the pattern must not match a counter,
// and the redactor must not strike a NUMBER on a denylisted key - because a number is a count.
const test = require('node:test');
const assert = require('node:assert');
const { code } = require('./_source');
const log = require('../trading/agent/log');

const REDACTED = '[REDACTED]';

test('redaction: every REAL secret shape is still redacted', () => {
  const { value, removed } = log.redact({
    password: 'hunter2',
    passwd: 'hunter2',
    apiKey: 'sk-live-abc',
    access_token: 'eyJhbGciOi',
    refresh_token: 'rt-123',
    authorization: 'Basic abcdefg',
    signature: 'deadbeefcafe',
    cookie: 'sid=abc',
    sessionId: 'sess-1',
    credential: 'creds',
    secret: 'shh',
    nested: { deeper: { password: 'x' } },
  });
  for (const k of ['password', 'passwd', 'apiKey', 'access_token', 'refresh_token', 'authorization', 'signature', 'cookie', 'sessionId', 'credential', 'secret']) {
    assert.equal(value[k], REDACTED, `${k} must still be redacted`);
  }
  assert.equal(value.nested.deeper.password, REDACTED, 'redaction is recursive');
  assert.ok(removed.includes('access_token'), 'compound secret names must still match');
  assert.ok(removed.includes('refresh_token'));
});

test('redaction: a bearer string is redacted wherever it appears', () => {
  const { value } = log.redact({ note: 'retrying with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6', plain: 'Bearer abcdefgh1234' });
  assert.equal(value.note, REDACTED);
  assert.equal(value.plain, REDACTED);
});

test('redaction: ★ token COUNTERS survive, which is what the budget meter reads', () => {
  const { value, removed } = log.redact({
    completionTokens: 42,
    promptTokens: 100,
    promptCacheHitTokens: 5,
    promptCacheMissTokens: 7,
    inputTokens: 34,
    outputTokens: 34,
    tokens: 407,
  });
  assert.deepEqual(value, {
    completionTokens: 42, promptTokens: 100, promptCacheHitTokens: 5,
    promptCacheMissTokens: 7, inputTokens: 34, outputTokens: 34, tokens: 407,
  });
  assert.deepEqual(removed, [], `nothing should be removed here, got ${JSON.stringify(removed)}`);
});

test('redaction: a STRING on a counter-named key is still redacted (the name was not whitelisted)', () => {
  // Proves the fix is "a number is a count", not "these names are exempt".
  const { value } = log.redact({ tokens: 'eyJhbGciOiJIUzI1NiJ9', token: 'sk-live-xyz' });
  assert.equal(value.tokens, REDACTED);
  assert.equal(value.token, REDACTED);
});

test('THE REGRESSION THAT MATTERS: an llm_usage payload meters its real cost', () => {
  // End-to-end, mimicking budget.todayUsage() exactly - if this breaks again, the cap goes blind again.
  const enriched = log.enrich('llm_usage', { consumer: 'chair', completionTokens: 42, promptTokens: 100 });
  const tok = (Number(enriched.completionTokens) || 0) + (Number(enriched.promptTokens) || 0);
  assert.equal(tok, 142, 'the meter must read the real cost, not zero');
  assert.equal(enriched.consumer, 'chair');
  assert.equal(enriched.redacted, undefined, 'and nothing should be flagged as removed');
});

test('redaction: the removed-marker stays meaningful - only genuine strikes are recorded', () => {
  const clean = log.enrich('llm_usage', { consumer: 'chair', completionTokens: 10, promptTokens: 20 });
  assert.equal(clean.redacted, undefined, 'a clean payload must not claim a redaction');
  const dirty = log.enrich('note', { password: 'x', completionTokens: 10 });
  assert.deepEqual(dirty.redacted, ['password']);
});

test('the binding consumer is registered, or its calls are metered nowhere', () => {
  // budget.record() returns early for an unknown consumer, so a missing name is invisible in BOTH
  // directions - no per-consumer cap and no contribution to the daily total.
  const src = code('trading/agent/budget.js');
  const m = src.match(/const CONSUMERS = \[(.*?)\];/s);
  assert.ok(m, 'CONSUMERS must be a plain array literal for this test to read it');
  const names = m[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  for (const c of ['chair', 'review', 'shadow', 'binding']) assert.ok(names.includes(c), `CONSUMERS must include ${c}`);
});

test('redaction: camelCase secrets are redacted - the lookbehind false negative is CLOSED', () => {
  // Rev 2 narrowed the pattern to `(?<![a-z])token`, which correctly skipped `completionTokens` but also
  // skipped every camelCase secret. A false negative here leaks a credential silently; a false positive
  // only loses telemetry. So the pattern is broad again and the COUNTERS are excluded by value.
  const { value } = log.redact({
    token: 'a', access_token: 'b', sessionToken: 'c', accessToken: 'd',
    refreshToken: 'e', userToken: 'f', myToken: 'g', 'X-Auth-Token': 'h',
  });
  for (const k of ['token', 'access_token', 'sessionToken', 'accessToken', 'refreshToken', 'userToken', 'myToken', 'X-Auth-Token']) {
    assert.equal(value[k], REDACTED, `${k} is a credential and must be redacted`);
  }
});

test('redaction: a NUMERIC value on a non-count token key is still redacted (no numeric-secret hole)', () => {
  // The blanket "a number on a denylisted key is a count" rule would have let these through, and a bare
  // number is exactly what a numeric session id or an OTP looks like. The exception is scoped instead.
  const { value } = log.redact({ token: 123456, sessionToken: 987654 });
  assert.equal(value.token, REDACTED);
  assert.equal(value.sessionToken, REDACTED);
});

test('redaction: the count exception is scoped by key SUFFIX, and its limitation is stated', () => {
  const { value } = log.redact({ tokenCount: 5, tokens: 407, completionTokens: 42, inputTokens: 34, promptCacheHitTokens: 5, tokensPerBar: 3.2 });
  assert.equal(value.tokenCount, 5);
  assert.equal(value.tokens, 407);
  assert.equal(value.completionTokens, 42);
  assert.equal(value.inputTokens, 34);
  assert.equal(value.promptCacheHitTokens, 5);
  // The documented limitation, asserted so it cannot drift unnoticed: a numeric field whose token-ish
  // name ends in something other than a count word is STILL redacted. That direction costs a metric,
  // not a secret, which is the right way round.
  assert.equal(value.tokensPerBar, REDACTED);
});

test('redaction: the denylist stays broad on purpose; counters are excluded by VALUE, not by name', () => {
  const src = code('trading/agent/log.js');
  const m = src.match(/DENYLIST_KEY = (\/.*?\/[a-z]*);/);
  assert.ok(m, 'the denylist must be a plain regex literal');
  const lit = m[1];
  const re = new RegExp(lit.slice(1, lit.lastIndexOf('/')), lit.slice(lit.lastIndexOf('/') + 1));
  for (const k of ['token', 'access_token', 'sessionToken', 'completionTokens']) {
    assert.ok(re.test(k), `${k} must match the pattern - narrowing it by NAME is what caused the camelCase hole`);
  }
  assert.match(src, /COUNT_KEY = \/\(tokens\|count\|size\|length\)\$\/i/, 'the count exception must stay suffix-scoped');
});
