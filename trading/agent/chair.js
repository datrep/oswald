// trading/agent/chair.js — the ONLY LLM agent (amendment A2).
// Receives the telemetry bundle and votes YES/NO with a confidence score on the
// quant's proposed action. Qualitative context only — no math.
'use strict';

const { askDecisionWithStub } = require('./deepseek');

// Distinct personas per chair (TRD-12 fix 2026-09-10): three chairs voting
// with the SAME system prompt produce near-identical reasons — wasted tokens.
// Each persona looks through a different lens and must name its own evidence.
const PERSONAS = {
  trend: [
    'YOU are the TREND chair. Judge the setup against price structure ONLY:',
    'breakout level, ADX trend strength, higher-high/lower-low structure, and',
    'whether the entry direction matches the dominant bar direction. Do NOT',
    'discuss risk or macro — leave those to the other chairs.',
  ],
  risk: [
    'YOU are the RISK chair (skeptic). Your job is to find what KILLS this',
    'trade: adverse volatility regime, correlation with an existing position,',
    'tight stop vs ATR (bad R:R), overheated positioning, or a contradicting',
    'alert. If the risk notes raise none of these, approve — but say which',
    'risk you checked.',
  ],
  macro: [
    'YOU are the MACRO chair (consensus-breaker). Weigh the market pulse,',
    'news digests, session state and any congress/politician signals in the',
    'bundle. If the herd (quant + other chairs) misses a macro contradiction,',
    'vote NO and name it. If nothing contradicts, approve from YOUR lens only.',
  ],
};

const PERSONA_TEMP = { trend: 0.5, risk: 0.8, macro: 0.9 };

// ★ TRD-78(b) (2026-09-21): THE SHARED BUNDLE COMES FIRST; THE PERSONA TRAVELS LAST.
//
// WHY. All three chairs receive a BYTE-IDENTICAL bundle, so seats 2 and 3 should be able to hit a prefix
// cache for the whole thing. They could not, because the persona block sat INSIDE the system message — i.e.
// BEFORE the bundle — so the three requests diverged about 190 tokens in and every byte after that was paid
// at full price, three times per wake.
//
// MEASURED, NOT ASSUMED — and the measurement had been sitting in the retry path all along. When a chair
// reply comes back truncated, `askDecision` retries with a bigger budget, and THAT call is a byte-identical
// repeat of the first. On 2026-09-20 the retry reported **cacheHit 8,448 of 8,591 prompt tokens (98%)** while
// a FRESH chair call in the same wake reported **384 (4.5%)**. So the ceiling is neither the provider nor the
// bundle's volatility across wakes — it is this ordering. Moving the persona out of the prefix should take
// seats 2 and 3 from 384 to ~8,448: about 16k tokens per wake re-priced from miss to hit.
//
// WHAT MOVED, EXACTLY: the system message is now IDENTICAL for all three chairs (preamble + the answer
// contract), and the persona lines are appended to the USER message, after the bundle. The shared prefix is
// therefore [system][bundle], and the three requests differ only in their last ~150 tokens.
//
// ⚠ THE COST, STATED RATHER THAN SMOOTHED: the persona is now the LAST thing a chair reads instead of the
// first, which changes what it attends to. That is the A/B. The cache half is measured automatically
// (`llm_call` by label: hit/miss per persona); the quality half is read off the next decisions' reasons,
// where the chairs must stay role-DIFFERENTIATED rather than converging on one voice.
function buildMessages(bundleText, persona = null) {
  const system = [
    'You are a CHAIR of a disciplined trading committee for a DEMO (paper) trading account.',
    'The quant and risk modules are deterministic code; you provide qualitative context only.',
    'You receive a telemetry bundle with a proposed action.',
    'The quant engine already gated the proposal (Donchian + ADX) and the risk module',
    'already approved it — do NOT re-litigate those gates. If a proposal is presented,',
    'your default is YES unless you can name a specific, concrete contradiction in the',
    'bundle (e.g. a conflicting alert, session halt, or a position you already hold).',
    'If no proposal is presented, vote no.',
    'Reason from YOUR assigned role only and cite the specific bundle evidence you used',
    '— never repeat a generic phrase another chair would also write.',
    'Answer with a single JSON object exactly in the shape:',
    '{"decision":"yes|no","confidence":0.0,"reason":"one short sentence"}',
  ].join('\n');
  const roleLines = persona ? (PERSONAS[persona] || [String(persona)]) : [];
  const user = roleLines.length
    ? `${bundleText}\n\n--- YOUR ROLE (argue from this seat only, and cite the bundle evidence you used) ---\n${roleLines.join('\n')}`
    : bundleText;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function vote(userId, bundleText, settings, { id = null, model = null, temperature = null, persona = null } = {}) {
  // TRD-12 Phase 2: token budget soft-gate — over cap, the chair abstains
  // (an abstention reads as chair-offline, never as a "no").
  const budget = require('./budget');
  const gate = await budget.allow(userId, settings, 'chair');
  if (!gate.allowed) return { decision: 'abstain', confidence: 0, reason: 'budget_cap', model: 'budget', latencyMs: 0, raw: null };
  const messages = buildMessages(bundleText, persona);  // Per-chair overrides (model/temperature/persona) on top of settings.llm.
  const llmOverrides = { ...(settings.llm || {}) };
  if (model) llmOverrides.model = model;
  const t = temperature != null ? Number(temperature) : (PERSONAS[persona] ? PERSONA_TEMP[persona] : undefined);
  if (t != null) llmOverrides.temperature = t;
  const effSettings = { ...settings, llm: llmOverrides };
  const result = await askDecisionWithStub(userId, messages, effSettings, { label: `chair:${persona || 'none'}` });
  if (result.usage) { budget.record(userId, 'chair', result.usage, { settings }).catch(() => {}); budget.maybeWarn(userId, settings).catch(() => {}); }
  if (id) result.chairId = id;
  return result; // {decision, confidence, reason, model, usage, latencyMs, raw}
}

module.exports = { vote, buildMessages, PERSONAS, PERSONA_TEMP };
