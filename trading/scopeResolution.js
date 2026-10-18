// trading/scopeResolution.js — THE SCOPE RULE, IN EXACTLY ONE PLACE (TRD-116, 2026-09-25).
//
// WHY THIS FILE EXISTS. The rule "which strategies may run on this symbol" is one sentence:
//
//     explicit symbolScope entry  >  default key ('others' / '*')  >  strategies.enabled
//
// and then the applicability filter (registered + can signal + not track-bound away). Before this module it
// was implemented THREE times — `quant.scopedStrategyIds`, `binding.inScopeIds`, and two separate
// re-statements inside `selfHealth.scopeEnabledVerdict` and `analytics.strategyLiveness` — and the
// re-statements DISAGREED with the resolver the desk actually runs on. Measured 2026-09-25 against the real
// resolver (temp/scope-resolver-probe.js), the re-statements were wrong in THREE ways, all in the same
// direction (they call things unreachable that are reachable):
//
//   B. enabled=['survgold'], symbolScope={}          resolver: reachable on Gold.  check said "can never
//                                                    trade". An ABSENT key falls back to the global list.
//   C. enabled=['survgold'], scope={Silver:['turtle']} resolver: reachable on Gold. check said unreachable.
//                                                    Enumerating OTHER symbols says nothing about this one.
//   F. scope={Bitcoin:['rsi2']}, rsi2 NOT enabled     resolver: rsi2 IS live on Bitcoin. check said the
//                                                    assignment "can never fire". That is the DELIBERATE
//                                                    override — TRD-91's whole point, and TRD-116's own row
//                                                    already corrected this premise on 2026-09-24.
//
// So the check written to catch "a setting that does nothing" was itself reporting settings that work fine.
// A guard that fires on legitimate configurations gets ignored, and then it is not a guard.
//
// ★ AND THE APPLICABILITY FILTER IS NOT DECORATION — measured, not assumed. `survoil` is enabled AND named by
// the global list, so on an ABSENT-scope symbol the resolution keeps it; but `survoil.symbols = ['Oil']`
// (a track-bound frozen wrapper), so `applicableOn` drops it everywhere except Oil. A reachability test that
// read only the two lists would have called survoil reachable on SX5E while the desk could not trade it
// there. This is why the filter lives here and every caller shares it.
'use strict';

const DEFAULT_KEYS = Object.freeze(['others', '*']);

// Lazily resolved so this module has NO eager dependencies — `store.js` requires it, and `agent/strategies`
// eventually requires `store`, so an eager require here would close a cycle at load time.
let defaultRegistry = null;
function registryOr(registry) {
  if (registry) return registry;
  if (!defaultRegistry) defaultRegistry = require('./agent/strategies');
  return defaultRegistry;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

// THE APPLICABILITY PREDICATE: registered, can produce a live signal, not track-bound away from this symbol.
// Same rule as the old `quant.symbolEligible` and `binding.eligibleOn`; those two now delegate here.
function applicableOn(id, symbol, registry) {
  const reg = registryOr(registry);
  const strat = reg && typeof reg.get === 'function' ? reg.get(id) : null;
  if (!strat || !strat.liveSignal) return false;
  if (Array.isArray(strat.symbols) && strat.symbols.length && !strat.symbols.includes(symbol)) return false;
  return true;
}

// THE DEFAULT KEY'S LIST, or null when neither 'others' nor '*' is present.
// ★ `null` IS NOT `[]`. An ABSENT default key means "fall through to the global list"; an EMPTY one means
// "nothing here". Conflating them is the defect this module exists to end, so the lookup is exported and
// every caller reads it from here rather than restating the `has('others') ? ... : has('*') ? ...` chain.
function defaultEntryFor(symbolScope) {
  const scope = symbolScope || {};
  for (const k of DEFAULT_KEYS) {
    if (has(scope, k)) return scope[k];
  }
  return null;
}

// THE RESOLUTION, BEFORE FILTERING, WITH ITS PROVENANCE.
//
// `raw` is the list the settings name; `source` says WHICH branch produced it, because "explicit entry",
// "default key" and "global list" are three different facts and a reader must not have to infer which one
// applied. An explicit `null` entry falls through to the global list, matching the resolver exactly.
function resolveEntry(globalIds, symbolScope, symbol) {
  const scope = symbolScope || {};
  const explicit = has(scope, symbol);
  const defaultKey = DEFAULT_KEYS.find((k) => has(scope, k)) || null;
  const entry = explicit ? scope[symbol] : (defaultKey ? scope[defaultKey] : null);
  const raw = entry != null ? (Array.isArray(entry) ? entry : []) : (globalIds || []);
  const source = explicit ? 'explicit' : (entry != null ? 'default_key' : 'global_list');
  return { raw, source, defaultKey };
}

// What the desk may ACTUALLY run on this symbol: the resolution, then the applicability filter.
function scopeIdsFor(globalIds, symbolScope, symbol, registry) {
  return resolveEntry(globalIds, symbolScope, symbol).raw.filter((id) => applicableOn(id, symbol, registry));
}

// ★ WHICH SYMBOLS CAN THIS STRATEGY RUN ON? The question the old check answered without asking.
function symbolsForId(globalIds, symbolScope, id, symbols, registry) {
  const universe = Array.isArray(symbols) ? symbols : [];
  return universe.filter((s) => scopeIdsFor(globalIds, symbolScope, s, registry).includes(id));
}

// The same question BEFORE the applicability filter, so a caller can tell the two causes apart:
// "the settings never name it" and "the settings name it but the registry is track-bound away" are a
// SETTINGS fact and a REGISTRY fact, and a reader given only the verdict cannot tell which to go fix.
function namedForId(globalIds, symbolScope, id, symbols) {
  const universe = Array.isArray(symbols) ? symbols : [];
  return universe.filter((s) => resolveEntry(globalIds, symbolScope, s).raw.includes(id));
}

// ★ THE ONE REAL DIRECTION OF TRD-116. An enabled strategy that can run on NO symbol in the universe is a
// setting that does nothing, and every surface showing `enabled` alone will read it as live. The OTHER
// direction the old check reported — a scope entry naming a strategy absent from `enabled` — is NOT a defect:
// an explicit entry REPLACES the global list, so it is live and tradeable (TRD-91). It is not reported here.
function unreachableEnabled(enabledList, symbolScope, symbols, registry) {
  const universe = Array.isArray(symbols) ? symbols : [];
  const out = [];
  for (const id of (Array.isArray(enabledList) ? enabledList : [])) {
    if (symbolsForId(enabledList, symbolScope, id, universe, registry).length) continue;
    const named = namedForId(enabledList, symbolScope, id, universe);
    out.push({
      id,
      namedFor: named,
      why: named.length
        ? `named for ${named.join(', ')} but the registry entry is track-bound away from ${named.length === 1 ? 'that symbol' : 'those symbols'}`
        : `no symbol in the universe resolves to a list containing it`,
    });
  }
  return out;
}

// ★ THE WRITE-TIME QUESTION (TRD-116 option (b)): which enabled strategies did THIS WRITE newly orphan?
//
// The desk's own convention is that an event is a SIGNAL and not a stream. A state-based warning would
// re-fire on every settings write forever, and `accountPoller` writes settings whenever a position's sample
// lands — so the guard reports the WRITE THAT CREATED the dead setting and stays quiet afterwards.
//
// An unknown universe returns [] rather than every id: with no watchlist, reachability is UNMEASURED, and an
// unmeasured absence is not a finding. It fails quiet, so a caller that forgets to check under-reports
// instead of inventing a defect — and `reportDeadScopeWrite` in store.js is where the loud version lives.
function newlyDeadIds(beforeSettingsLike, afterSettingsLike, symbols, registry) {
  const universe = Array.isArray(symbols) ? symbols : [];
  if (!universe.length) return [];
  const deadIn = (settingsLike) => {
    const st = (settingsLike && settingsLike.strategies) || {};
    return unreachableEnabled(st.enabled || [], st.symbolScope || {}, universe, registry).map((p) => p.id);
  };
  const was = new Set(deadIn(beforeSettingsLike));
  return deadIn(afterSettingsLike).filter((id) => !was.has(id));
}

// The symbol universe that can actually trade: the watchlist. Accepts either `[{symbol, venue}]` or `['X']`.
function watchlistSymbols(watchlist) {
  const list = (watchlist && watchlist.symbols) || watchlist;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => (x && typeof x === 'object' ? x.symbol : x)).filter(Boolean))];
}

module.exports = {
  DEFAULT_KEYS,
  applicableOn,
  defaultEntryFor,
  resolveEntry,
  scopeIdsFor,
  symbolsForId,
  namedForId,
  unreachableEnabled,
  newlyDeadIds,
  watchlistSymbols,
};
