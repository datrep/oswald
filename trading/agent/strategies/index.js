// trading/agent/strategies/index.js — strategy registry (TRD-10).
// Each strategy module exports {id, name, description, params[], liveSignal,
// backtest} (backtest-only/shadow-only strategies export whichever they have).
// Params resolve as settings.strategies.params[id] over module defaults.
'use strict';

const turtle = require('./turtleUltimate');
const multi = require('./multiFactor');
const congress = require('./congress');
const meanrev = require('./meanrev');
const macd = require('./macd');
const rsi2 = require('./rsi2');
const regturtle = require('./regimeTurtle'); // TRD-15: LAB-2 candidate
const squeezerev = require('./squeezeMeanRev'); // TRD-16: LAB-2 candidate
const mtftrend = require('./mtfTrend'); // TRD-19: LAB-3 candidate
const survGold = require('./survGold'); // TRD-29: demo-forward survivor (frozen)
const survOil = require('./survOil'); // TRD-29: demo-forward survivor (frozen)
const survGoldStruct = require('./survGoldStruct'); // S3 (2026-09-23): structure-gated clone of survgold — LAB CANDIDATE, not enabled, promotion gated
// 2026-09-25: the two PROVEN survivor sets reproduced on Silver/Sugar/Bitcoin/SGX — eight track-bound
// replicas. This REPLACES the earlier four cross-product wrappers: the owner ruled that the grid they were
// picked from was measured on a basis that predates the current policy set. See the header of survReplicas.js.
const survReplicas = require('./survReplicas');

const REGISTRY = {
  [turtle.id]: turtle,
  [multi.id]: multi,
  [congress.id]: congress,
  [meanrev.id]: meanrev,
  [macd.id]: macd,
  [rsi2.id]: rsi2,
  [regturtle.id]: regturtle,
  [squeezerev.id]: squeezerev,
  [mtftrend.id]: mtftrend,
  [survGold.id]: survGold,
  [survOil.id]: survOil,
  [survGoldStruct.id]: survGoldStruct,
  // Spread rather than enumerated so the eight arrive together with the metadata that describes them; the
  // replica table is the declaration and duplicating its ids here would let the two drift apart.
  ...survReplicas.REGISTRY,
};

function get(id) {
  return REGISTRY[id] || null;
}

// Metadata for the API/UI (params with defaults resolved).
//
// ★★ TRD-TUN-2 (#1393), fixed 2026-09-28: THIS FUNCTION USED TO RESOLVE INLINE, AND WRONGLY.
// It read `overrides[s.id][p.key] ?? p.def` over `settings.strategies.params` — the GLOBAL layer only — while
// the trading path resolves DEFAULTS -> params[id] -> symbolParams[symbol][id] via `paramsFor`. Two
// independent implementations of one documented order, and the tuner plus the Strategy tab read THIS one.
// Measured live before the fix: `Gold.turtle.adxGate` displayed as 20 while `paramsFor` returned 0, and
// `Oil.turtle.donchianPeriod` as 20 while `paramsFor` returned 5 — a 4x different breakout window and a
// regime filter on/off, shown wrongly on the operator's screen.
//
// It now delegates, so there is ONE implementation and no caller can read a layer that is not the effective
// one. `symbol` is optional and defaults to null, which reproduces the previous behaviour EXACTLY for every
// existing caller. `source` is part of the return on purpose: the defect above was invisible because the
// answer carried no provenance, so a reader could not tell an effective value from a shadowed one.
function list(settings, symbol = null) {
  const enabled = (settings && settings.strategies && settings.strategies.enabled) || ['turtle'];
  return Object.values(REGISTRY).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    enabled: enabled.includes(s.id),
    // TRD-89 (2026-09-18): who may CLOSE a position from this strategy — the exit chair ('decider') or
    // the strategy's own mechanical exit ('advisory'). Absent means decider, and the UI states which,
    // because a policy the operator cannot see is a policy the operator cannot correct.
    reviewAuthority: s.reviewAuthority === 'advisory' ? 'advisory' : 'decider',
    params: s.params.map((p) => ({
      ...p,
      value: resolveParam(settings, s.id, p.key, symbol, p.def),
      // WHICH LAYER SUPPLIED IT — the question the old inline resolver made unanswerable.
      source: paramSource(settings, s.id, p.key, symbol),
    })),
  }));
}

// The EFFECTIVE value for one parameter, from the single resolver `paramsFor` so this cannot drift from the
// trading path. `def` is the param descriptor's own default, used only when no layer mentions the key.
function resolveParam(settings, id, key, symbol, def) {
  const eff = paramsFor(settings, id, symbol);
  return eff[key] != null ? eff[key] : def;
}

// WHICH LAYER SUPPLIED THIS VALUE, from the same key space `paramsFor` reads.
// ⚠ Absence is `== null`, not falsiness: 0 and false are real parameter values (`adxGate: 0` is the whole
// point of the Gold override), and `if (!v)` would walk straight past them to a DIFFERENT layer's value.
function paramSource(settings, id, key, symbol = null) {
  const st = (settings && settings.strategies) || {};
  const perSymbol = (symbol && st.symbolParams && st.symbolParams[symbol] && st.symbolParams[symbol][id]) || {};
  if (perSymbol[key] != null) return 'symbolParams';
  const global = (st.params && st.params[id]) || {};
  if (global[key] != null) return 'params';
  const s = REGISTRY[id];
  if (s && s.DEFAULTS && s.DEFAULTS[key] != null) return 'DEFAULTS';
  return 'module-default';
}

// TRD-75: params resolve DEFAULTS -> params[id] (global) -> symbolParams[symbol][id] (per instrument).
// The per-symbol layer is the axis the config was missing. Without it, enabling ONE strategy on two
// instruments forced ONE param set on both - which the desk's own survivors say is wrong: survgold is
// dc20 with the ADX gate OFF and survoil is dc5 with the gate ON. Not a tuning detail: a 4x different
// breakout window and a regime filter on/off.
//
// `symbol` is optional so every existing caller keeps its old behaviour exactly.
// NOTE: a FROZEN strategy (params: []) ignores all of this - survGold/survoil spread their own
// DEFAULTS inside liveSignal, so an override aimed at them is a no-op by design (rule-L: retuning
// voids the candidate). agent/binding.js validate() flags that instead of letting it be silent.
function paramsFor(settings, id, symbol = null) {
  const s = REGISTRY[id];
  if (!s) return {};
  const st = (settings && settings.strategies) || {};
  const global = (st.params && st.params[id]) || {};
  const perSymbol = (symbol && st.symbolParams && st.symbolParams[symbol] && st.symbolParams[symbol][id]) || {};
  return { ...(s.DEFAULTS || {}), ...global, ...perSymbol };
}

// ★ TRD-TUN-2, second half (2026-09-28): THE TWO QUESTIONS A CALLER MUST ASK BEFORE IT PROPOSES A VALUE.
//
// The first half made the RESOLUTION single, so no caller can read a layer that is not the effective one.
// This is the other half: a caller that WRITES the GLOBAL layer must not write where the PER-SYMBOL layer
// shadows it, or the change is recorded, displayed and ignored — the defect the row was raised for.
//
// `watchlistSymbols` is an ARGUMENT rather than a require of `scopeResolution`, deliberately: that module
// lazily requires THIS one, so requiring it back here would be a cycle. The caller owns the symbol universe
// and passes it in, which also keeps both functions pure and testable.
//
// WHICH SYMBOLS CAN THIS STRATEGY RUN ON? TRD-91's rule: an explicit `symbolScope[symbol]` entry REPLACES the
// global `enabled` list for that symbol, so a strategy is reachable on a symbol iff that symbol's own entry
// names it, or the symbol has no entry and the global list does.
function scopedSymbols(settings, id, watchlistSymbols = []) {
  const st = (settings && settings.strategies) || {};
  const scope = st.symbolScope || {};
  const globalEnabled = Array.isArray(st.enabled) ? st.enabled : [];
  return (Array.isArray(watchlistSymbols) ? watchlistSymbols : []).filter((sym) => {
    const entry = Array.isArray(scope[sym]) ? scope[sym] : null;
    return entry ? entry.includes(id) : globalEnabled.includes(id);
  });
}

// WHICH PARAMS OF THIS STRATEGY RESOLVE DIFFERENTLY ACROSS THOSE SYMBOLS?
// A non-empty answer means the global layer cannot express this strategy's configuration, so a global write
// is shadowed on at least one symbol it trades. Returns [] with fewer than two symbols, because with one
// symbol there is nothing for it to disagree with.
function paramDivergence(settings, id, symbols = []) {
  const reg = REGISTRY[id];
  if (!reg || !Array.isArray(symbols) || symbols.length < 2) return [];
  const out = [];
  for (const p of (reg.params || [])) {
    const bySym = symbols.map((sym) => [sym, resolveParam(settings, id, p.key, sym, p.def)]);
    // ⚠ JSON.stringify, not ===: 0 and false are real values here, and a `!v` test would treat both as absent.
    const distinct = new Set(bySym.map(([, v]) => JSON.stringify(v == null ? null : v)));
    if (distinct.size > 1) out.push({ key: p.key, values: bySym.map(([symbol, value]) => ({ symbol, value })) });
  }
  return out;
}

module.exports = {
  REGISTRY, get, list, paramsFor, paramSource, scopedSymbols, paramDivergence,
  // One entry per instrument, holding the ids that replicate the two survivors on it. The scope script and the
  // report read THIS rather than restating the eight ids.
  REPLICA_SCOPE: survReplicas.SCOPE, REPLICA_IDS: survReplicas.MODULES.map((m) => m.id),
};
