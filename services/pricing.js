'use strict';
// services/pricing.js — peak/off-peak window computation + API usage stats.
//
// Peak windows and per-model rates live in the dashboard settings
// (public/js/api/settings.json -> pricing), merged over the defaults below.
// The in-memory counters survive DB downtime; token counters stay at 0 until
// an actual LLM client records usage via recordUsage().

const { readDashboardSettings } = require('../shared/config');

const DEFAULTS = {
  // ★ VERIFIED LIVE 2026-10-02 (#1505, owner ask "check the actual api"): GET /models returns exactly
  // ["deepseek-flash","deepseek-v4-pro"] and the provider's pricing page matches BOTH rows below to the cent.
  // `deepseek-flash` IS the DeepSeek-V4.1-Flash model ; 'deepseek-v4-flash' is a RETIRED legacy id (still
  // accepted, served by V4.1-Flash at flash price) and is deliberately NOT kept as a key here.
  // The card names THE MODEL THE DESK BILLS (trading/agent/deepseek.js DEFAULT_MODEL = 'deepseek-flash').
  model: 'deepseek-flash',
  effectiveFrom: '2026-08-16T16:00:00Z',
  peakWindows: [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ],
  models: {
    // Rates below verified against the provider's live pricing page 2026-10-02 (peak 01:00-04:00 & 06:00-10:00
    // UTC Mon-Fri; off-peak is exactly half). Flash row: off-peak 0.003 / 0.15 / 0.60. Pro row: off-peak
    // 0.022 / 0.66 / 1.98 — it SAT unverified in #1505 and the live page confirms it exactly; no change needed.
    'deepseek-flash': {
      peak: { cacheHit: 0.006, cacheMiss: 0.30, output: 1.20 },
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.60 },
    },
    'deepseek-v4-pro': {
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    },
  },
};

const stats = {
  requests: 0,
  inputCacheHitTokens: 0,
  inputCacheMissTokens: 0,
  outputTokens: 0,
};

function config() {
  const s = readDashboardSettings().pricing || {};
  return {
    model: s.model || DEFAULTS.model,
    effectiveFrom: s.effectiveFrom || DEFAULTS.effectiveFrom,
    peakWindows: Array.isArray(s.peakWindows) && s.peakWindows.length ? s.peakWindows : DEFAULTS.peakWindows,
    models: { ...DEFAULTS.models, ...(s.models || {}) },
  };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// windowAt: 'peak' when now (UTC) falls inside any [start, end) interval.
function windowAt(now, windows) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  for (const w of windows) {
    const s = toMinutes(w.start);
    const e = toMinutes(w.end);
    const inside = e > s ? mins >= s && mins < e : mins >= s || mins < e;
    if (inside) return 'peak';
  }
  return 'off-peak';
}

function nextChangeAt(now, windows) {
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  const points = new Set();
  for (const w of windows) {
    points.add(toMinutes(w.start));
    points.add(toMinutes(w.end));
  }
  const sorted = [...points].sort((a, b) => a - b);
  let next = sorted.find((p) => p > cur);
  if (next === undefined) next = sorted[0] + 1440; // roll into tomorrow
  const deltaMin = next - cur;
  return new Date(now.getTime() + deltaMin * 60000).toISOString();
}

function effectiveRates(now, cfg) {
  const window = windowAt(now, cfg.peakWindows);
  const model = cfg.models[cfg.model] || Object.values(cfg.models)[0];
  const r = window === 'peak' ? model.peak : model.offPeak;
  return {
    model: cfg.model,
    window,
    inputCacheHitPer1M: r.cacheHit,
    inputCacheMissPer1M: r.cacheMiss,
    outputPer1M: r.output,
  };
}

function estimateCost(st, rates) {
  return (
    (st.inputCacheHitTokens / 1e6) * rates.inputCacheHitPer1M +
    (st.inputCacheMissTokens / 1e6) * rates.inputCacheMissPer1M +
    (st.outputTokens / 1e6) * rates.outputPer1M
  );
}

function snapshot() {
  const now = new Date();
  const cfg = config();
  const rates = effectiveRates(now, cfg);
  const cost = estimateCost(stats, rates);
  return {
    now: now.toISOString(),
    window: rates.window,
    isPeak: rates.window === 'peak',
    nextChangeAt: nextChangeAt(now, cfg.peakWindows),
    rates,
    stats: {
      requests: stats.requests,
      inputCacheHitTokens: stats.inputCacheHitTokens,
      inputCacheMissTokens: stats.inputCacheMissTokens,
      outputTokens: stats.outputTokens,
      estimatedCost: Math.round(cost * 1e6) / 1e6,
    },
  };
}

function recordRequest() {
  stats.requests++;
}

// Future hook for an LLM client: recordUsage({ cacheHit, cacheMiss, output })
function recordUsage(usage = {}) {
  if (Number.isFinite(usage.cacheHit)) stats.inputCacheHitTokens += usage.cacheHit;
  if (Number.isFinite(usage.cacheMiss)) stats.inputCacheMissTokens += usage.cacheMiss;
  if (Number.isFinite(usage.output)) stats.outputTokens += usage.output;
}

module.exports = { snapshot, recordRequest, recordUsage, config, windowAt, nextChangeAt, effectiveRates };
