// trading/agent/deepseek.js — DeepSeek chat adapter + fail-secure decision parsing.
// Amendment A11: JSON mode with regex fallback; 2 consecutive parse failures ->
// default NO (veto); raw malformed responses -> PromptErrors table; hard retry
// cap (settings.llm.maxRetries, default 2) per wake cycle.
// Amendment A2: this is the ONLY LLM in the pipeline (the chair).
'use strict';

const { loadEnv } = require('../../shared/config');
const { dashboardPost } = require('../lib/http');
const store = require('../store');

loadEnv();

const API_URL = 'https://api.deepseek.com/chat/completions';

// REROUTE 2026-09-12 — ONE source of truth for the desk's LLM id.
// Live probe of GET /models returns exactly: `deepseek-flash` | `deepseek-v4-pro`.
// Both are served AS REQUESTED (no alias drift) and BOTH are THINKING models —
// reasoning_tokens bill INSIDE max_tokens (at cap 5: empty answer, finish_reason=length).
// So the per-consumer caps + isTruncatedEmpty retry are correct at either tier;
// never lower them. NOTE: `deepseek-v4.1-flash` does NOT exist (HTTP 400
// invalid_request_error: "The supported API model names are deepseek-flash,
// deepseek-v4-pro"). Override without a code change: DEEPSEEK_MODEL=<id>.
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';

// 2026-09-10: continuous served-model assertion. api.deepseek.com silently
// aliases requested models (deepseek-chat/deepseek-reasoner -> deepseek-flash),
// and server-side aliasing can change with any deploy. Every call compares the
// SERVED model against the REQUESTED model; drift logs a throttled
// llm_model_mismatch event that self-health check #9 alarms on.
const MODEL_MISMATCH_LOG_MIN_MS = 15 * 60 * 1000;
let lastMismatchLog = 0;

async function callChat(messages, { model = DEFAULT_MODEL, temperature = 0.1, maxTokens = 500, timeoutMs = 30000, jsonMode = true, userId = null, label = 'unlabelled' } = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY missing');
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    };
    // TRD-11: jsonMode=false for plain-text reasoning paths (the caller extracts
    // JSON itself). 2026-09-12: BOTH served tiers are thinking models, so the
    // tier no longer implies JSON-mode support — the CALLER decides.
    if (jsonMode) body.response_format = { type: 'json_object' };
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    // TRD-94 (2026-09-21): THE STATUS CODE IS THE DIAGNOSIS, SO IT TRAVELS ON THE ERROR RATHER THAN ONLY
    // INSIDE ITS MESSAGE. `DeepSeek HTTP 402 Insufficient Balance` has been recurring since 2026-09-10 and
    // was recorded ONLY as a prompt error row plus a vote reason — so a desk whose seats were abstaining on
    // CREDIT looked, on every surface the dashboard reads, exactly like a desk whose chairs disagreed.
    if (!res.ok) {
      const err = new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 160)}`);
      err.status = res.status;
      err.provider = 'deepseek';
      throw err;
    }
    const data = JSON.parse(text);
    const msg = data.choices?.[0]?.message ?? {};
    const served = data.model || model;
    const usage = {
      promptCacheHitTokens: data.usage?.prompt_cache_hit_tokens ?? 0,
      promptCacheMissTokens: data.usage?.prompt_cache_miss_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      // Kept even when the provider omits it (null, not 0) — a missing denominator must read as missing.
      promptTokens: data.usage?.prompt_tokens ?? null,
    };
    recordCallUsage(userId, {
      label, model: served, usage, maxTokens,
      promptChars: (messages || []).reduce((a, m) => a + String((m && m.content) || '').length, 0),
      latencyMs: Date.now() - startedAt,
    });
    if (served !== model) {
      const now = Date.now();
      if (now - lastMismatchLog >= MODEL_MISMATCH_LOG_MIN_MS) {
        lastMismatchLog = now;
        // v1.2 (2026-09-12 audit): was hardcoded `userId 1` — now owner-scoped
        // via the caller. Skip (never mis-attribute) when no owner is known.
        const uid = userId == null ? null : Number(userId);
        if (uid != null && Number.isFinite(uid)) {
          store.logEvent(uid, 'llm_model_mismatch', { requested: model, served, at: new Date().toISOString() }).catch(() => {});
        }
      }
    }
    return {
      text: msg.content ?? '',
      reasoning: msg.reasoning_content ?? msg.reasoning ?? null, // TRD-11: thinking ON
      model: served,
      modelMismatch: served !== model,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      usage,
    };
  } catch (e) {
    // ★ TRD-94b (2026-10-02): REPORT THE PROVIDER FAILURE AT THE CHOKE POINT, NOT AT ONE CALLER.
    //
    // TRD-94 put `logProviderError` inside `askDecision` — but `askDecision` is only the CHAIR's entry point.
    // Ten other consumers call `callChat` directly (review, pulse, central, ask, autopsy, bindingProposer,
    // shadowCall, tuner, waker, whitepaper), and not one of them reaches that line. Measured 2026-10-02: of the
    // 30 `llm_provider_error` rows the desk has EVER written, every single one is a `chair:*` — while the same
    // failure class was recorded 18 times under `position_review` and 4 under `pulse` as a GENERIC `error` row,
    // which is the one kind self-health check #13 does not read. So the review path was dead for 65 minutes
    // (2026-10-01 20:23-21:28Z: a 60s abort every ~5 min) and the check built to catch exactly that reported
    // "no provider errors in 24h". Logging HERE makes the property hold for every consumer, present and
    // future, because there is no way to reach the provider except through this function.
    logProviderError(userId, { label, error: e, latencyMs: Date.now() - startedAt });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ★ ONE ROW PER CALL, WHICH IS WHAT THE CACHE QUESTION NEEDED ALL ALONG (TRD-78, 2026-09-20).
//
// WHY THIS EXISTS. The desk stored ONE `usage` object per WAKE on the prompt row, so the counts were a sum
// over everything that ran — and the cache ratio could not be attributed to a call, a chair or a persona.
// That is why "the 3-chair fan-out pays ~5.3k miss tokens three times" was measurable while "what is actually
// being cached" was not: measured 2026-09-20, the stored rows read `hit 8,192` on a wake where the shared
// system prefix is ~190 tokens, and nothing in the record could say which call that came from.
//
// Two fields make it answerable: `promptChars` (what WE sent, countable on our side) next to the provider's
// own `promptTokens` with hit/miss, and a `label` (chair:trend / decision / ...) so a row belongs to a caller.
// The plain `prompt_tokens` was being DISCARDED by this module before today — without it there was no
// denominator to compare a hit against.
//
// Fire-and-forget: this sits on the hot path of every LLM call and must never delay or fail one.
// ⚠ THE KIND IS `llm_call`, NOT `llm_usage`, and that is a correctness detail rather than taste: `budget.js`
// READS every `llm_usage` row to compute the day's spend (`spentToday`), and `budget.record` already writes one
// per billed call. Logging this row under that kind would have added a SECOND row for the same tokens and
// double-counted the day against a cap — a number that does not mean what it says, in the budget.
function recordCallUsage(userId, { label, model, usage, maxTokens, promptChars, latencyMs }) {
  const uid = userId == null ? null : Number(userId);
  if (uid == null || !Number.isFinite(uid)) return;
  store.logEvent(uid, 'llm_call', {
    label, model, maxTokens, promptChars, latencyMs,
    promptTokens: usage.promptTokens, cacheHit: usage.promptCacheHitTokens,
    cacheMiss: usage.promptCacheMissTokens, completionTokens: usage.completionTokens,
  }).catch(() => {});
}

// TRD-94 (2026-09-21): A PROVIDER FAILURE THAT IS RECORDED BUT NOT SURFACED. "DeepSeek HTTP 402 Insufficient
// Balance" has recurred since 2026-09-10 and was written only to a prompt-error row plus a vote reason — so a
// desk whose seats were abstaining on CREDIT looked, on every surface the dashboard reads, exactly like a desk
// whose chairs disagreed. This puts the failure into the event stream, with the status the classification needs.
//
// `kind` is separate from the status because the two failure classes need different actions and different
// people: a 402 is the ACCOUNT needing credit — it cannot fix itself, a retry is pointless, and only the owner
// can act — while a 5xx or a timeout is transient and a retry is the right answer. Collapsing both into one
// "llm_error" string is how a dead account reads as a model that kept changing its mind.
function classifyProviderError(err) {
  const status = Number(err && err.status);
  if (Number.isFinite(status) && status > 0) {
    const payment = status === 402 || status === 401;
    return {
      status,
      kind: payment ? 'payment' : status === 429 ? 'rate_limit' : 'provider',
      retryable: !payment, // a payment error fails identically on every retry, until someone tops up
    };
  }
  const msg = String((err && err.message) || err || '');
  if (/timeout|aborted|ECONNRESET|ENOTFOUND|fetch failed/i.test(msg)) return { status: null, kind: 'transport', retryable: true };
  return { status: null, kind: 'unknown', retryable: true };
}

function logProviderError(userId, { label, error, latencyMs }) {
  const uid = userId == null ? null : Number(userId);
  if (uid == null || !Number.isFinite(uid)) return;
  const c = classifyProviderError(error);
  const ms = Number(latencyMs);
  store.logEvent(uid, 'llm_provider_error', {
    label,
    provider: (error && error.provider) || 'deepseek',
    status: c.status,
    // ⚠ NAMED `errorKind`, NOT `kind`. The event's own `kind` column is `llm_provider_error`; putting the
    // classification under the same word means one name for two different things in one payload, which is how
    // a reader ends up filtering on the wrong one — as the first version of check 13 did.
    errorKind: c.kind,
    retryable: c.retryable,
    // ⚠ THE HANG IS THE ONE THING THE LATENCY TABLE CANNOT SEE (2026-10-02). `recordCallUsage` writes an
    // `llm_call` row ONLY on a call that SUCCEEDS, so a call that hangs and is aborted leaves no latency row
    // at all — which is why `review` reported a max latency of 14,778ms while the review path was in fact
    // aborting at its 60,000ms timeout for 65 minutes straight (2026-10-01 20:23-21:28Z). The duration of a
    // FAILED call is only recordable here, so it is recorded here.
    latencyMs: Number.isFinite(ms) ? ms : null,
    message: String((error && error.message) || error || '').slice(0, 200),
  }).catch(() => {});
}

// Meter usage into the dashboard pricing service (best effort — never blocks).
async function meterUsage(model, usage) {
  try {
    await dashboardPost('/api/pricing/usage', {
      model,
      cacheHit: usage.promptCacheHitTokens || 0,
      cacheMiss: usage.promptCacheMissTokens || 0,
      output: usage.completionTokens || 0,
    }, 4000);
  } catch { /* metering is advisory */ }
}

// Parse a JSON decision out of an LLM reply. Returns null when unparseable.
function parseDecision(text) {
  if (!text) return null;
  let candidate = String(text).trim();
  // strip markdown fences
  candidate = candidate.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  // try strict JSON first
  try {
    const obj = JSON.parse(candidate);
    if (obj && typeof obj === 'object') return normalizeDecision(obj);
  } catch { /* fall through */ }
  // find the first {...} span
  const m = candidate.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && typeof obj === 'object') return normalizeDecision(obj);
    } catch { /* fall through */ }
  }
  // last resort: regex the decision field. ⚠ TRD-113 (2026-09-21): THIS IS NOT A PARSE, and it must not be
  // allowed to read as one.
  //
  // Measured 2026-09-20 23:28Z: chair-2 (risk) replied in prose, this regex rescued a "no" out of it, and the
  // vote was counted as a FULL-WEIGHT REASONED DISSENT (weight 1 of 3, confidence 0.5) by `chairVotes`,
  // whose abstain test matches `llm_error|parse_failure|budget_cap` and therefore did not match this. The root
  // is visible in the same payload: the reply's completionTokens came back pinned at the 2000 cap — the
  // thinking budget — and because the content was NOT empty, `isTruncatedEmpty` did not fire, so no retry
  // happened and a formatting failure was promoted to an opinion. It has since happened 6 times.
  //
  // The tag is what fixes it: `askDecision` refuses to accept a rescued decision, retries once with headroom
  // (which is what a starved thinking budget needs), and a second rescue becomes `parse_failure` — which
  // every caller already treats as "the model did not answer".
  const dm = candidate.match(/"(?:decision|vote)"\s*:\s*"?(yes|no)"?/i);
  if (dm) return { decision: dm[1].toLowerCase() === 'yes' ? 'yes' : 'no', confidence: 0.5, reason: 'regex-fallback', regexRescue: true };
  return null;
}

function normalizeDecision(obj) {
  const raw = String(obj.decision ?? obj.vote ?? '').trim().toLowerCase();
  const decision = raw === 'yes' || raw === 'true' ? 'yes' : raw === 'no' || raw === 'false' ? 'no' : null;
  if (!decision) return null;
  const conf = Number(obj.confidence ?? obj.score);
  return {
    decision,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
    reason: String(obj.reason ?? obj.rationale ?? '').slice(0, 300),
  };
}

// 2026-09-11 (chair-offline incident): deepseek-v4-pro is a THINKING model —
// reasoning_content bills INSIDE max_tokens. When thinking alone exhausts the
// cap, the API returns 200 with EMPTY content (finish_reason 'length') before
// the JSON answer is ever emitted -> parseDecision(null) -> parse_failure.
// Signature: empty content + completionTokens pinned at the cap. The fix in
// callers: retry ONCE with a bigger budget instead of re-failing at the cap.
function isTruncatedEmpty(reply, maxTokens) {
  const text = String((reply && reply.text) || '');
  const used = Number((reply && reply.usage && reply.usage.completionTokens) || 0);
  if (text.length > 0) return false;
  if (used <= 0) return false;
  return (reply && reply.finishReason === 'length') || used >= Number(maxTokens) - 2;
}

// Fail-secure decision request. Returns {decision:'no', confidence:0, reason:'parse_failure'}
// after 2 consecutive parse failures (never trade on gibberish — A11).
async function askDecision(userId, messages, settings, opts = {}) {
  const llm = settings.llm || {};
  const maxAttempts = 1 + Math.max(0, Number(llm.maxRetries) || 0); // 1 + retry cap
  let maxTokens = Number(llm.maxTokens) || 500;
  let parseFailures = 0;
  let lastRaw = '';
  let lastError = '';
  let lastUsage = null;
  let lastModel = llm.model || DEFAULT_MODEL;
  let latencyMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const r = await callChat(messages, {
        model: llm.model || DEFAULT_MODEL,
        temperature: Number(llm.temperature ?? 0.1),
        maxTokens,
        timeoutMs: llm.timeoutMs || 30000,
        userId,
        label: opts.label || 'decision',
      });
      latencyMs = Date.now() - started;
      lastRaw = r.text;
      lastUsage = r.usage;
      lastModel = r.model;
      const parsed = parseDecision(r.text);
      // TRD-113: a regex RESCUE is not a parsed answer, so it does not get to be one. See parseDecision.
      const rescued = !!(parsed && parsed.regexRescue);
      if (parsed && !rescued) {
        await meterUsage(lastModel, lastUsage);
        return { ...parsed, model: lastModel, usage: lastUsage, latencyMs, raw: r.text };
      }
      parseFailures++;
      const truncated = isTruncatedEmpty(r, maxTokens);
      // ⚠ AND A NON-EMPTY REPLY THAT HIT THE CAP IS TRUNCATED TOO — this is the ROOT, not the rescue.
      // `isTruncatedEmpty` returns false the moment there is ANY content (`if (text.length > 0) return false`),
      // so a JSON object cut off mid-field (finishReason 'length', completionTokens pinned at the cap) never
      // widened the budget — which is why the retry it did get was spent at the same cap and truncated the
      // same way. Measured on chair-2 at 2026-09-20T23:28Z: completionTokens 2000, pinned.
      const capped = r.finishReason === 'length' && String(r.text || '').length > 0;
      lastError = truncated ? 'unparseable response (thinking budget exhausted)'
        : rescued ? 'unparseable response (a truncated object or prose — the JSON never arrived intact)'
          : 'unparseable response';
      await store.logPromptError(userId, { raw: r.text, error: lastError });
      if (parseFailures >= 2) {
        // Fail-secure: two consecutive parse failures -> default NO. No more calls.
        return { decision: 'no', confidence: 0, reason: 'parse_failure', model: lastModel, usage: lastUsage, latencyMs, raw: lastRaw };
      }
      // Retry with headroom: the budget, not the prompt, starved the answer. A rescued reply and a capped one
      // are the SAME signal one step later — the JSON never arrived intact — so they widen the budget too.
      if (truncated || rescued || capped) maxTokens = Math.max(maxTokens * 4, maxTokens + 1500);
    } catch (e) {
      latencyMs = Date.now() - started;
      lastError = String(e.message || e).slice(0, 255);
      await store.logPromptError(userId, { error: lastError });
      // TRD-94: THE EVENT STREAM is the only thing the dashboard and self-health read. A provider failure is a
      // DESK-HEALTH fact, not a model opinion: an abstention is a legitimate "no answer", but it must be
      // possible to tell "this seat had nothing to say" from "this seat could not speak", and a 402 is neither
      // transient nor an opinion — it is the account needing credit.
      //
      // ⚠ TRD-94b (2026-10-02): THE WRITE NOW HAPPENS IN `callChat`, NOT HERE. This comment is what the move
      // was for, so it stays — but the LOG CALL moved to the choke point, because this line only ever ran for
      // the chair. See the `catch` in `callChat` for the measurement that proved it.
      if (attempt >= maxAttempts) {
        return { decision: 'no', confidence: 0, reason: `llm_error: ${lastError.slice(0, 80)}`, model: lastModel, usage: lastUsage, latencyMs, raw: lastRaw };
      }
    }
  }
  return { decision: 'no', confidence: 0, reason: 'parse_failure', model: lastModel, usage: lastUsage, latencyMs, raw: lastRaw };
}

// Stub modes for offline testing (settings.llm.stub): '1' yes, 'no', 'garbage'.
function stubDecision(stub) {
  if (stub === 'garbage') return { text: '```json\n{"decision": "maybe", "confidence": 99, }\n', model: 'stub', usage: { promptCacheHitTokens: 3, promptCacheMissTokens: 40, completionTokens: 6 } };
  if (stub === 'no') return { text: '{"decision":"no","confidence":0.9,"reason":"stub veto"}', model: 'stub', usage: { promptCacheHitTokens: 3, promptCacheMissTokens: 40, completionTokens: 6 } };
  return { text: '{"decision":"yes","confidence":0.6,"reason":"stub approval"}', model: 'stub', usage: { promptCacheHitTokens: 3, promptCacheMissTokens: 40, completionTokens: 6 } };
}

async function askDecisionWithStub(userId, messages, settings, opts = {}) {
  const stub = (settings.llm || {}).stub;
  if (!stub) return askDecision(userId, messages, settings, opts);
  const r = stubDecision(stub);
  const parsed = parseDecision(r.text);
  await meterUsage('stub', r.usage);
  if (!parsed) {
    await store.logPromptError(userId, { raw: r.text, error: 'unparseable stub response' });
    return { decision: 'no', confidence: 0, reason: 'parse_failure', model: 'stub', usage: r.usage, latencyMs: 0, raw: r.text };
  }
  return { ...parsed, model: 'stub', usage: r.usage, latencyMs: 0, raw: r.text };
}

module.exports = { callChat, parseDecision, askDecision, askDecisionWithStub, recordCallUsage, meterUsage, isTruncatedEmpty, DEFAULT_MODEL, classifyProviderError };
