// trading/agent/shadowCall.js — TRD-SHW-1 (2026-09-14). The thin runner.
//
// Rules live in shadow.js (pure, testable). This file does the I/O: pick a symbol,
// build the stripped prompt, ask, record, journal. It NEVER places an order and is
// not imported by any trading path.
//
// ONE SYMBOL PER WAKE, round-robin. Coverage accumulates across wakes instead of
// spending a full board per call, which keeps the cost bounded and the rows
// independent (one row = one symbol = one question).
//
// FIRE-AND-FORGET on the wake path: an awaited call would add 10-30s to every wake,
// which is the very latency the desk is trying to reduce elsewhere. Failures go to
// the error journal rather than disappearing.
'use strict';

const store = require('../store');
const shadow = require('./shadow');

const MAX_PER_DAY = 200;

// The model bills reasoning INSIDE max_tokens, and 2000 already proved too small for
// a chair's answer — a shadow reply with a short JSON answer needs far more room for
// the thinking than for the text, so budget generously and retry once at double.
const SHADOW_MAX_TOKENS = 6000;

// ON unless explicitly disabled. This is a deliberate departure from the desk's
// usual default-off discipline, and the reason is that the capability places no
// orders and touches no trading path — the only cost is tokens, which the daily cap
// bounds. `PUT /settings {"shadow":{"enabled":false}}` turns it off.
function isEnabled(settings) {
  return ((settings && settings.shadow) || {}).enabled !== false;
}
function maxPerDay(settings) {
  const n = Number(((settings && settings.shadow) || {}).maxPerDay);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : MAX_PER_DAY;
}

async function runShadow(userId, settings, quantResult, { sessionState = null, at = new Date() } = {}) {
  if (!isEnabled(settings)) return { skipped: 'disabled' };

  const usable = ((quantResult && quantResult.symbols) || [])
    .filter((s) => s && s.symbol && s.status === 'ok');
  if (!usable.length) return { skipped: 'no_usable_symbol' };

  const stats = await store.shadowSignalStats(userId).catch(() => null);
  if (stats && Number(stats.callsLast24h) >= maxPerDay(settings)) return { skipped: 'daily_cap', callsLast24h: stats.callsLast24h };

  const budget = require('./budget');
  const gate = await budget.allow(userId, settings, 'shadow');
  if (!gate || !gate.allowed) return { skipped: 'budget_cap' };

  // Round-robin: the symbol after the most recent one. One cheap query, no state.
  const recent = await store.listShadowSignals(userId, { limit: 1 }).catch(() => []);
  const lastSymbol = recent && recent[0] ? recent[0].symbol : null;
  const lastIdx = lastSymbol ? usable.findIndex((s) => s.symbol === lastSymbol) : -1;
  const pick = usable[(lastIdx + 1) % usable.length];

  const stripped = shadow.stripContext({ quantResult: { symbols: [pick] }, session: sessionState });
  const promptText = shadow.buildPrompt(stripped, pick.symbol);

  // Session state is derived from the symbol itself rather than trusting a caller
  // shape: quant sets `session` when a venue market is closed, which is the fact the
  // row wants. An explicit override still wins.
  const sessState = (sessionState && sessionState.state)
    || (pick.session ? (pick.session.open === false ? 'closed' : 'open') : null);

  const events = await store.listCorporateEvents(userId, { days: 3 }).catch(() => []);
  const scheduledEvent = shadow.scheduledEventFor(events, at);

  const messages = [
    { role: 'system', content: 'You answer one question about market structure. Reply with JSON only.' },
    { role: 'user', content: promptText },
  ];

  // ★ THE SHADOW CALL MUST NOT GO THROUGH askDecisionWithStub. That helper is
  // DECISION-shaped: it parses with parseDecision, so a perfectly good
  // {"evidence":...} reply registers as a PARSE FAILURE, it writes a PromptError for
  // a correct answer, and its loop is maxAttempts = 1 + llm.maxRetries — unset means
  // ONE attempt, so it returns before the truncation retry can fire. That is exactly
  // how the first live row came back empty at out=2000 (a cap-pinned empty reply).
  // Found 2026-09-14T11:25Z on shadow row 1; the desk's decision machinery is for
  // decisions, and this is not one.
  const llm = settings.llm || {};
  const deepseek = require('./deepseek');
  const ask = (maxTokens) => deepseek.callChat(messages, {
    model: llm.model || undefined,
    temperature: 0.2,
    maxTokens,
    timeoutMs: llm.timeoutMs || 60000,
    jsonMode: true,
    userId,
    label: 'shadow',
  });

  let reply = null;
  try {
    reply = await ask(SHADOW_MAX_TOKENS);
    if (deepseek.isTruncatedEmpty(reply, SHADOW_MAX_TOKENS)) {
      reply = await ask(SHADOW_MAX_TOKENS * 2);
    }
  } catch (e) {
    await store.logEvent(userId, 'telemetry', {
      source: 'shadow_error', symbol: pick.symbol, error: String(e.message || e).slice(0, 200), at: at.toISOString(),
    }).catch(() => {});
    return { error: String(e.message || e).slice(0, 200), symbol: pick.symbol };
  }

  const parsed = shadow.parseAnswer(reply && reply.text);
  const usage = (reply && reply.usage) || {};
  const inputTokens = (Number(usage.promptCacheMissTokens) || 0) + (Number(usage.promptCacheHitTokens) || 0);
  const outputTokens = Number(usage.completionTokens) || 0;
  if (reply && reply.usage) {
    budget.record(userId, 'shadow', reply.usage, { settings }).catch(() => {});
    deepseek.meterUsage(reply.model, reply.usage).catch(() => {});
  }

  const id = await store.addShadowSignal(userId, {
    promptVersion: shadow.PROMPT_VERSION,
    horizonBars: shadow.HORIZON_BARS,
    symbol: pick.symbol,
    venue: pick.venue || null,
    evidence: parsed.evidence,
    direction: parsed.direction,
    confidence: parsed.confidence,
    basis: parsed.basis,
    rawResponse: reply ? reply.text : null,
    priceAtCall: pick.price != null ? pick.price : null,
    atr14: pick.atr14 != null ? pick.atr14 : null,
    adx14: pick.adx14 != null ? pick.adx14 : null,
    regime: pick.regime || null,
    sessionState: sessState,
    scheduledEvent,
    inputTokens, outputTokens,
  });

  await store.logEvent(userId, 'shadow_signal', {
    id, promptVersion: shadow.PROMPT_VERSION, symbol: pick.symbol, venue: pick.venue || null,
    ok: parsed.ok, reason: parsed.reason || null,
    evidence: parsed.evidence, direction: parsed.direction, confidence: parsed.confidence,
    basis: parsed.basis, scheduledEvent, inputTokens, outputTokens,
  }, { actor: 'system:shadow' }).catch(() => {});

  return { id, symbol: pick.symbol, parsed };
}

module.exports = { runShadow, isEnabled, maxPerDay, MAX_PER_DAY, SHADOW_MAX_TOKENS };
