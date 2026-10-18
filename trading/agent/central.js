// trading/agent/central.js — TRD-11: the CENTRAL AI for paper trading.
// One model, one seat: it receives EVERYTHING (quant per-symbol snapshot with
// indicators, open/closed paper positions, paper equity, market pulse, Meta
// verdict, multi-factor ranks, session state) and deliberates — with thinking
// (reasoning) ON by default (deepseek-v4-pro; 'deepseek-reasoner' is now flash-served)
// with step-by-step reasoning embedded in the JSON). Verdicts are stored in
// TradingPrompts (triggerType 'central') and drive the PAPER broker only —
// the live Plus500 demo path is untouched.
'use strict';

const { callChat, DEFAULT_MODEL } = require('./deepseek');
const store = require('../store');

const CENTRAL_SYSTEM = [
  'You are the CENTRAL AI of a paper-trading agent (simulated money, nothing real).',
  'You receive the full picture: per-symbol quant snapshots (price, ATR, ADX, Donchian,',
  'RSI, Bollinger, MACD, stochastic, SMA50/200), open and closed paper positions, paper',
  'equity, the market pulse narrative (why the market is moving), the Meta regime verdict,',
  'the multi-factor equity ranks, and session state.',
  'Congress flow (congressTop) shows US tickers that members of Congress recently',
  'BOUGHT in size — treat it as a sentiment/flow signal, not financial advice.',
  'RULES OF ENGAGEMENT:',
  '1. Open positions are listed in the context (openPositions) — if it says NONE,',
  '   you are FLAT. Never reason as if you hold something you do not.',
  '2. DELIBERATE PER SYMBOL: for EVERY watchlist symbol in the context, write one',
  '   reasoningStep starting with the symbol name: "SYMBOL: long|short|flat — why".',
  '   Do not fixate on a single symbol; the watchlist is the universe you judge.',
  '3. Only propose actions for symbols in the watchlist or positions you hold.',
  '4. ACT ON SIGNALS: the context lists live QUANT SIGNALS (entry signals with a',
  '   direction). The quant engine already gated these (Donchian breakout + ADX',
  '   trend filter) — do NOT re-litigate the gate. If a live entry signal exists,',
  '   you MUST propose an action for it (side = the signal direction, sizePct 5).',
  '   Only skip if the signal contradicts an open position you already hold.',
  '5. If you hold a position and the context shows an EXIT signal for it,',
  '   propose a close.',
  'THINK STEP BY STEP about what is happening and what a disciplined trader would do.',
  'Then reply with a single JSON object exactly in the shape:',
  '{"stance":"long|short|flat","confidence":0.5,"headline":"one sentence",',
  '"actions":[{"symbol":"Bitcoin","side":"buy|sell|close","sizePct":5,"reason":"short sentence"}],',
  '"risks":["..."],"reasoningSteps":["step 1","step 2"]}',
  'Rules: max 3 actions per verdict; sizePct 1-20 (percent of paper equity per position);',
  'use "close" to exit an existing paper position; prefer patience when data is thin;',
  'never invent prices. reasoningSteps is your visible chain of thought (at most 5 bullets).',
].join('\n');

// JSON verdict -> normalized shape (fail-secure: no actions on garbage).
function parseVerdict(text) {
  if (!text) return null;
  let candidate = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  let obj = null;
  try { obj = JSON.parse(candidate); } catch { /* fallthrough */ }
  if (!obj) {
    const m = candidate.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  if (!obj || typeof obj !== 'object') return null;
  const actions = (Array.isArray(obj.actions) ? obj.actions : [])
    .map((a) => ({
      symbol: String(a.symbol || '').trim(),
      side: ['buy', 'sell', 'close'].includes(a.side) ? a.side : null,
      // Default 5% when the model omits sizePct (never silently drop).
      sizePct: Number.isFinite(Number(a.sizePct)) && Number(a.sizePct) > 0 ? Number(a.sizePct) : 5,
      reason: String(a.reason || '').slice(0, 200),
    }))
    .filter((a) => a.symbol && a.side)
    .slice(0, 3);
  return {
    stance: ['long', 'short', 'flat'].includes(obj.stance) ? obj.stance : 'flat',
    confidence: Number.isFinite(Number(obj.confidence)) ? Math.max(0, Math.min(1, Number(obj.confidence))) : 0.5,
    headline: String(obj.headline || '').slice(0, 300),
    actions,
    risks: (Array.isArray(obj.risks) ? obj.risks : []).map(String).slice(0, 3),
    reasoningSteps: (Array.isArray(obj.reasoningSteps) ? obj.reasoningSteps : []).map(String).slice(0, 5),
  };
}

// Model choice caching: if the reasoner is unavailable (some keys/regions),
// fall back to deepseek-v4-pro with embedded reasoning for the session.
let reasonerOk = true;

function fallbackSystem(sys, useThinking) {
  return useThinking ? sys : sys; // same instructions; reasoningSteps still collected
}

async function callModel(messages, cfg, userId = null) {
  if (cfg.thinking && reasonerOk) {
    try {
      const r = await callChat(messages, {
        model: cfg.model || DEFAULT_MODEL,
        temperature: 0.3,
        // GOTCHA (verified 2026-09-09): max_tokens covers reasoning + answer
        // together on the reasoner — a small budget leaves an EMPTY answer.
        maxTokens: 8000,
        timeoutMs: 180000,
        jsonMode: false, // reasoner: plain text, JSON extracted by parser
        userId,
        label: 'central',
      });
      if (r.text && String(r.text).trim()) return r;
      // Reasoning consumed the whole budget: retry once via chat with
      // embedded reasoning steps instead of returning an empty verdict.
      reasonerOk = false;
    } catch (e) {
      const msg = String(e.message || e);
      if (/HTTP 400|not found|not supported|invalid|does not exist/i.test(msg)) {
        reasonerOk = false; // remember for the session
      } else {
        throw e; // real failure (402 balance, network) — propagate
      }
    }
  }
  return callChat(messages, {
    model: cfg.model || DEFAULT_MODEL,
    temperature: 0.3,
    maxTokens: 1500,
    timeoutMs: 90000,
    jsonMode: true,
    userId,
  });
}

// Central deliberation. ctx: {now, session, quantResult, openPaper, closedPaper,
// equity, pulse, meta, multi}. Returns a verdict + promptId; fail-secure
// (empty actions) on parse failure / transport error.
async function centralDeliberate(userId, settings, ctx) {
  const c = settings.central || {};
  const thinking = c.thinking !== false;

  // TRD-12 Phase 1: unified context module (was hand-rolled here).
  const context = require('./context').centralContext(ctx);

  const messages = [
    { role: 'system', content: fallbackSystem(CENTRAL_SYSTEM, thinking) },
    { role: 'user', content: 'Full picture JSON: ' + JSON.stringify(context) },
  ];

  const started = Date.now();
  const stub = (settings.llm || {}).stub;
  let r = null;
  // TRD-12 Phase 2: token budget soft-gate — over cap, central returns a
  // flat fail-secure verdict without spending tokens.
  const budget = require('./budget');
  const gate = await budget.allow(userId, settings, 'central');
  if (!gate.allowed) {
    r = { text: '{"stance":"flat","confidence":0.5,"headline":"budget cap — central skipped","actions":[],"risks":["budget"],"reasoningSteps":["budget cap"],"model":"budget"}', model: 'budget', reasoning: null, usage: { promptCacheHitTokens: 0, promptCacheMissTokens: 0, completionTokens: 0 } };
  } else if (stub) {
    r = { text: '{"stance":"flat","confidence":0.5,"headline":"stub central verdict","actions":[],"risks":["stub"],"reasoningSteps":["stub"],"model":"stub"}', model: 'stub', reasoning: null, usage: { promptCacheHitTokens: 3, promptCacheMissTokens: 50, completionTokens: 10 } };
  } else {
    r = await callModel(messages, { thinking, model: c.model || null }, userId);
    if (r.usage) { budget.record(userId, 'central', r.usage, { settings }).catch(() => {}); budget.maybeWarn(userId, settings).catch(() => {}); }
  }
  const latencyMs = Date.now() - started;

  const verdict = parseVerdict(r.text);
  if (!verdict) {
    // Fail-secure: a broken central AI makes NO trades.
    const fail = { stance: 'flat', confidence: 0, headline: 'central parse failure — no actions', actions: [], risks: [], reasoningSteps: [] };
    const promptId = await store.createPrompt(userId, {
      triggerType: 'central', bundle: { context },
      response: r.text, decision: { ...fail, parseFailure: true },
      model: r.model, usage: r.usage, latencyMs,
    });
    await store.logEvent(userId, 'central', { promptId, parseFailure: true, model: r.model, actor: `llm:${r.model}:${promptId}` });
    return { ...fail, promptId, model: r.model, reasoning: null, latencyMs, parseFailure: true };
  }

  const reasoning = r.reasoning ? String(r.reasoning).slice(0, 2000) : null;
  const promptId = await store.createPrompt(userId, {
    triggerType: 'central', bundle: { context },
    response: r.text,
    decision: { ...verdict, reasoning },
    model: r.model, usage: r.usage, latencyMs,
  });
  await store.logEvent(userId, 'central', {
    promptId, stance: verdict.stance, confidence: verdict.confidence,
    headline: verdict.headline, actions: verdict.actions.length, model: r.model, thinking,
    actor: `llm:${r.model}:${promptId}`, rationale: verdict.headline,
  });
  return { ...verdict, promptId, model: r.model, reasoning, latencyMs };
}

module.exports = { centralDeliberate, parseVerdict };
