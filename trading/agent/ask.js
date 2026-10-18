// trading/agent/ask.js — owner Q&A ("what are you doing?").
// Builds a compact self-status context from the state tree and answers with
// DeepSeek. Fact-grounded: the LLM may only use the context, never invent.
'use strict';

const deepseek = require('./deepseek');
const { buildStateTree } = require('./stateTree');
const strategies = require('./strategies');
const store = require('../store');

let lastAt = 0;
const MIN_GAP_MS = 3000;
const MAX_QUESTION = 500;

async function askQuestion(userId, question) {
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (!q) { const e = new Error('question is required'); e.status = 400; throw e; }

  const now = Date.now();
  if (now - lastAt < MIN_GAP_MS) {
    const e = new Error(`Rate limited — wait ${Math.ceil((MIN_GAP_MS - (now - lastAt)) / 1000)}s between questions`);
    e.status = 429;
    throw e;
  }
  lastAt = now;

  const tree = await buildStateTree(userId);
  // TRD-12 Phase 1: unified context module (was hand-rolled here).
  const settings = await store.getSettings(userId);
  // TRD-12 follow-up: the AI must be able to answer about ANY watchlist
  // symbol (e.g. "what do you think of gold?"), so feed the latest quant
  // snapshot (prices, ATR/ADX, signals) — not just open positions.
  let market = null;
  try {
    const q = await require('./quant').evaluate(userId, settings, await store.getOpenTrades(userId));
    market = q.symbols || null;
  } catch { /* market snapshot optional — desk facts still answer */ }
  const base = require('./context').deskFacts(tree, strategies, market);
  // TRD-12 Phase 2: market white paper (grounded baseline) for the answer.
  const wp = await require('./whitepaper').bundleSections(userId).catch(() => null);
  const ctx = wp && wp.weekly
    ? base + `\nMARKET WHITE PAPER (weekly): ${String(wp.weekly.text).slice(0, 600)}`
    : base;

  // TRD-12 Phase 2: token budget soft-gate.
  const budget = require('./budget');
  const gate = await budget.allow(userId, settings, 'ask');
  if (!gate.allowed) {
    return { answer: 'LLM budget cap reached — ask again after the daily reset (or raise the cap / set a boost in Settings).', model: 'budget', usage: null, at: new Date().toISOString() };
  }

  const system = 'You are the OSWALD trading agent\'s self-awareness module. The owner asks what you are doing or about your state, strategies, positions, or recent decisions. Answer ONLY from the context below — never invent numbers or events that are not in it. First person ("I am…"). Concise, at most 120 words, plain text. If the context cannot answer, say exactly what information is missing.';
  const r = await deepseek.callChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: `CONTEXT:\n${ctx}\n\nOWNER QUESTION: ${q}` },
    ],
    { model: deepseek.DEFAULT_MODEL, temperature: 0.2, maxTokens: 1200, jsonMode: false, timeoutMs: 30000, userId, label: 'ask' }
  );
  deepseek.meterUsage(r.model, r.usage).catch(() => {});
  // TRD-LLM-1: `settings` travels with the record so the call is PRICED AT WRITE TIME from the rate in
  // force now. A later rate change must not rewrite what this call cost.
  require('./budget').record(userId, 'ask', r.usage, { settings }).catch(() => {});
  await require('./log').write(userId, 'ask', {
    question: q.slice(0, 300),
    answer: (r.text || '').slice(0, 500),
    model: r.model,
    tokens: (r.usage && r.usage.completionTokens) || 0,
  }, { actor: `human:${userId}`, correlationId: require('./log').corrId('ask'), rationale: q.slice(0, 200) });
  return { answer: r.text || '', model: r.model, usage: r.usage, at: new Date().toISOString() };
}

module.exports = { askQuestion };
