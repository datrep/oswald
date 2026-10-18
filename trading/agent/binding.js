// trading/agent/binding.js — the instrument <-> (strategy, params) BINDING, per instrument (TRD-75).
//
// THE GAP THIS CLOSES. The desk could express two of the three things a binding needs, and the missing
// one was the axis that matters:
//     settings.strategies.enabled      = ["survgold","survoil","turtle"]   which strategies may run
//     settings.strategies.symbolScope  = { Gold: ["survgold","turtle"] }   ...on which instruments
//     settings.strategies.params       = { turtle: { donchianPeriod: 20 } } ...with WHAT VALUES - by
//                                                                          STRATEGY ID, with NO
//                                                                          per-symbol axis at all.
// So enabling generic `turtle` on Gold AND Oil applied ONE param set to both, even though the desk own
// evidence says they need different ones: survgold is dc20/ADX-gate-0 and survoil is dc5/ADX-gate-20.
// That is not a tuning detail - a 4x difference in breakout window and a regime filter on/off.
//
// WHY A GLOBAL LIST CANNOT EXPRESS IT (measured 2026-09-15): paramsFor() read
// settings.strategies.params[id], so `turtle` resolved to ONE object regardless of symbol. Adding
// Turtle to both symbols therefore ran an UNVALIDATED configuration on both, differing from each
// survivor in a different way (Gold: the gate would be ON where the survivor has it OFF; Oil: the
// window 4x slower than the survivor). Which is why the owner chose A-prime: make the PAIR
// configurable instead of the strategy.
//
// THE NEW AXIS: settings.strategies.symbolParams = { "<symbol>": { "<strategyId>": { k: v } } }
// Resolution order, most specific last:
//     module DEFAULTS  ->  params[id] (global)  ->  symbolParams[symbol][id] (per instrument)
//
// FROZEN SURVIVORS ARE NOT TUNABLE, and this module reports that rather than silently ignoring it.
// survgold/survoil declare params: [] and spread their FROZEN set inside liveSignal, so a per-symbol
// override aimed at them is a NO-OP (rule-L: any retuning voids the candidate). A tuning UI that
// accepted such an edit would be lying to its operator, so validate() flags it as a hard problem.
'use strict';

const DEFAULT_KEYS = ['others', '*'];

// TRD-116 (2026-09-25): the resolution and the applicability predicate are NOT restated here any more. This
// module's comment used to say it was "mirroring scopedStrategyIds exactly" — which it was, but a mirror is
// only as good as the discipline of whoever edits it next, and the same rule re-stated in selfHealth and
// analytics had ALREADY drifted. Both now call the one implementation.
const scopeResolution = require('../scopeResolution');

const st = (settings) => (settings && settings.strategies) || {};

// ★ THE APPLICABILITY PREDICATE, IN ONE PLACE INSIDE THIS MODULE (2026-09-15). A strategy may run on a
// symbol when it is registered, can produce a live signal, and is not track-bound away from it. This is
// the same rule as quant.symbolEligible, and it now backs BOTH the scope resolver and the reviewer
// candidate set: if they could disagree, the reviewer would be offered a candidate that the scope
// resolver then silently drops - a proposal that looks accepted and does nothing.
function eligibleOn(id, symbol, registry) {
  return scopeResolution.applicableOn(id, symbol, registry);
}

// Every strategy that COULD run on this symbol, whether or not it is in scope. This is the set the
// reviewer is asked to choose FROM; `inScopeIds` is the set already chosen. Requires a registry that can
// be ENUMERATED (`REGISTRY`), which is why it is a separate call rather than a flag on inScopeIds - a
// `{ get }`-only stub can answer the second question and not the first.
function applicableIds(symbol, registry = null) {
  const reg = registry || require('./strategies');
  const all = Object.values((reg && reg.REGISTRY) || {});
  return all.filter((s) => s && eligibleOn(s.id, symbol, reg)).map((s) => s.id);
}

// Which strategies is this symbol allowed to run, and WHY - mirroring scopedStrategyIds exactly
// (explicit entry > 'others'/'*' default > global enabled list).
function inScopeIds(settings, symbol, registry) {
  const s = st(settings);
  const resolved = scopeResolution.resolveEntry(s.enabled || ['turtle'], s.symbolScope || {}, symbol);
  // `raw` is COPIED because the caller owns the returned object and a global-list resolution hands back the
  // settings' own array — a caller that mutated it would edit the settings blob in memory.
  return {
    ids: resolved.raw.filter((id) => eligibleOn(id, symbol, registry)),
    raw: resolved.raw.slice(),
    source: resolved.source,
  };
}

// The binding for ONE (symbol, strategy) pair, with the provenance of every parameter value.
function resolveBinding(settings, symbol, id, registry) {
  const strat = registry.get(id);
  if (!strat) return null;
  const s = st(settings);
  const defaults = strat.DEFAULTS || {};
  const global = (s.params && s.params[id]) || {};
  const perSymbol = (s.symbolParams && s.symbolParams[symbol] && s.symbolParams[symbol][id]) || {};

  const params = {};
  for (const k of new Set([...Object.keys(defaults), ...Object.keys(global), ...Object.keys(perSymbol)])) {
    const sym = Object.prototype.hasOwnProperty.call(perSymbol, k);
    const glo = Object.prototype.hasOwnProperty.call(global, k);
    params[k] = {
      value: sym ? perSymbol[k] : (glo ? global[k] : defaults[k]),
      source: sym ? 'symbol' : (glo ? 'global' : 'default'),
    };
  }

  return {
    symbol, strategy: id,
    name: strat.name || id,
    params,
    tuned: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.value])),
    overriddenHere: Object.keys(perSymbol).length > 0,
    trackBound: Array.isArray(strat.symbols) && strat.symbols.length > 0,
    // params: [] means NOTHING here is editable - the frozen survivors set DEFAULTS and spread them
    // inside liveSignal, so a settings edit aimed at them does nothing. Surfaced instead of hidden.
    tunable: Array.isArray(strat.params) && strat.params.length > 0,
  };
}

// The whole table: one row per in-scope (symbol, strategy) pair. This IS the "instrument <->
// (strategy, params) binding" as a single readable object - the artefact an AI would fill in, and the
// thing that makes the currently-IMPLICIT binding explicit.
function bindingTable(settings, { symbols = [], registry = null } = {}) {
  const reg = registry || require('./strategies');
  const s = st(settings);
  const out = [];
  for (const symbol of symbols) {
    const scope = inScopeIds(settings, symbol, reg);
    out.push({
      symbol,
      scopeSource: scope.source,
      scopeConfigured: scope.raw,
      strategies: scope.ids.map((id) => resolveBinding(settings, symbol, id, reg)).filter(Boolean),
    });
  }
  return {
    symbols: out,
    perSymbolParamsPresent: Object.keys(s.symbolParams || {}),
    globalParamsPresent: Object.keys(s.params || {}),
    // A strategy can only be bound per symbol if it is scope-able at all; note the ones the config
    // mentions nowhere, so "why is nothing running here" is answerable from this object alone.
    enabled: s.enabled || ['turtle'],
  };
}

// Config problems that would otherwise be SILENT. Every check here exists because the corresponding
// mistake makes the config look applied while doing nothing.
function validate(settings, { symbols = [], registry = null } = {}) {
  const reg = registry || require('./strategies');
  const s = st(settings);
  const problems = [];
  const known = new Set(symbols);
  const enabled = new Set(s.enabled || ['turtle']);

  for (const [symbol, byStrategy] of Object.entries(s.symbolParams || {})) {
    if (!known.has(symbol)) {
      problems.push({ level: 'warn', symbol, reason: `symbolParams names "${symbol}", which is not on the watchlist - the binding is inert` });
    }
    for (const [id, vals] of Object.entries(byStrategy || {})) {
      const strat = reg.get(id);
      if (!strat) { problems.push({ level: 'error', symbol, strategy: id, reason: `symbolParams targets unknown strategy "${id}"` }); continue; }
      if (!enabled.has(id)) {
        // ★ REACHABLE ANOTHER WAY? An explicit symbolScope entry REPLACES the global enabled list FOR THAT
        // SYMBOL (see inScopeIds, and quant.scopedStrategyIds which mirrors it), so params aimed at a
        // strategy outside `enabled` are perfectly live when the symbol names it. Warning unconditionally
        // called a RUNNING configuration "inert" - and the binding reviewer reads these warnings and
        // reasons about them: the live Gold proposal of 2026-09-15 quoted this sentence as a reason.
        const scopedHere = Array.isArray(s.symbolScope?.[symbol]) && s.symbolScope[symbol].includes(id);
        if (!scopedHere) {
          problems.push({ level: 'warn', symbol, strategy: id, reason: `symbolParams tunes "${id}", which is neither in strategies.enabled nor named by ${symbol}'s symbolScope - the values are inert until one of them says so` });
        }
      }
      // An EMPTY override object is not a retune - there are no values in it. Flagging it made "keep this
      // frozen binding as it is" indistinguishable from "retune the survivor", and the reviewer emits the
      // former on purpose. The check is about the VALUES, so it is about whether there are any.
      if ((!Array.isArray(strat.params) || strat.params.length === 0) && Object.keys(vals || {}).length) {
        problems.push({ level: 'error', symbol, strategy: id, reason: `"${id}" is FROZEN (params: []): retuning voids the candidate, so liveSignal spreads its own DEFAULTS and this override does NOTHING` });
      }
      if (Array.isArray(strat.symbols) && strat.symbols.length && !strat.symbols.includes(symbol)) {
        problems.push({ level: 'error', symbol, strategy: id, reason: `"${id}" is track-bound to ${JSON.stringify(strat.symbols)}; a binding on ${symbol} can never run` });
      }
      for (const k of Object.keys(vals || {})) {
        const declared = (strat.params || []).find((p) => p.key === k);
        if (!declared) { problems.push({ level: 'error', symbol, strategy: id, reason: `unknown parameter "${k}" - it is not in the strategy's params[] and would be ignored` }); continue; }
        const v = Number(vals[k]);
        if (!Number.isFinite(v)) { problems.push({ level: 'error', symbol, strategy: id, reason: `parameter "${k}" = ${JSON.stringify(vals[k])} is not a number` }); continue; }
        if (declared.min != null && v < declared.min) problems.push({ level: 'error', symbol, strategy: id, reason: `"${k}" = ${v} is below min ${declared.min}` });
        if (declared.max != null && v > declared.max) problems.push({ level: 'error', symbol, strategy: id, reason: `"${k}" = ${v} is above max ${declared.max}` });
      }
    }
  }

  for (const [symbol, ids] of Object.entries(s.symbolScope || {})) {
    if (DEFAULT_KEYS.includes(symbol)) continue;
    if (!known.has(symbol)) problems.push({ level: 'warn', symbol, reason: `symbolScope names "${symbol}", which is not on the watchlist` });
    for (const id of ids || []) {
      const strat = reg.get(id);
      if (!strat) { problems.push({ level: 'error', symbol, strategy: id, reason: `symbolScope names unknown strategy "${id}"` }); continue; }
      // A scope entry is how a pair is CREATED, so it is the one place where an impossible pairing can be
      // introduced and then never run. `symbols` declares the instruments a strategy may run on.
      if (Array.isArray(strat.symbols) && strat.symbols.length && !strat.symbols.includes(symbol)) {
        problems.push({ level: 'error', symbol, strategy: id, reason: `symbolScope puts "${id}" on ${symbol}, but it is track-bound to ${JSON.stringify(strat.symbols)} - it would never run` });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// TIGHTEN-ONLY (B5, decision A+B): which proposed operations may be applied with NO human in the loop?
// ---------------------------------------------------------------------------------------------------
//
// WHY THE DIRECTION HAS TO BE DECLARED, and why "tighten-only" cannot be read off a patch.
//
// The settings writer is a deep MERGE, and `store.deepMerge` has no delete path (arrays ARE replaced -
// `!Array.isArray` is a precondition for recursion - but keys are never removed). So a patch can only
// ADD or OVERWRITE. Which means the only way a param change narrows anything is by moving a VALUE, and
// whether a higher value narrows a strategy is DOMAIN KNOWLEDGE the number does not carry:
//
//     donchianPeriod 20 -> 50    tighter   slower breakout, fewer signals
//     adxGate        20 -> 40    tighter   stronger trend required (0 = gate OFF = loosest)
//     rsiLow         30 -> 45    LOOSER    a less extreme oversold level trades MORE
//     rsiHigh        70 -> 95    tighter   a more extreme overbought level trades LESS
//     adxPeriod / atrPeriod / atrStopMultiple   NEITHER - the effect on trade count is not monotonic
//
// So each knob declares its own direction in its strategy's params[] as
//     tightens: 'higher' | 'lower'        ("a HIGHER/LOWER value makes this strategy trade LESS")
// and anything UNDECLARED is NEVER applied automatically. FAIL CLOSED: an undeclared knob is a human
// decision, not a guess. Booleans stay undeclared even where the intent looks obvious - deciding that
// true > false numerically is the `Number(true) === 1` coercion this codebase has already been bitten
// by, so a bool is a human's call.
//
// WHAT IS AUTO-APPLIABLE, exhaustively:
//   * `unbind`     - stop a strategy trading a symbol. Can only remove, so it is always a narrowing.
//                    ONLY when the symbol already has its OWN scope list; when it inherits the global
//                    enabled list or the 'others' entry, writing a narrowed list would also pin the
//                    symbol and stop it following future global changes - a policy change, so human.
//   * `setParams`  - change values on a pairing that ALREADY exists, where EVERY key is declared and
//                    moves tighter (or not at all). An addition is not a narrowing. A pair not in scope
//                    is inert. One widening or one undeclared key disqualifies the whole operation.
//   * `bind`       - put a pair IN SCOPE. Never auto-appliable, and deliberately so: it is a WIDENING by
//                    construction - the desk starts trading an instrument it did not trade - and the whole
//                    point of the direction model is that widening is a human decision. It is CLASSIFIED
//                    here rather than left out so that it cannot be mistaken for `setParams` and dropped
//                    as `inert`, which is precisely what used to happen: the reviewer could not widen even
//                    in principle, because the only way it could express a new pairing was a value change
//                    on a pairing that did not exist yet.
const OPS = ['unbind', 'setParams', 'bind'];

function directionOf(strat, key) {
  const list = (strat && Array.isArray(strat.params)) ? strat.params : [];
  const p = list.find((x) => x && x.key === key);
  if (!p) return { declared: false, reason: `"${key}" is not in the strategy params[]` };
  if (p.type && p.type !== 'number') return { declared: false, reason: `"${key}" is type ${p.type}; only number knobs are auto-appliable` };
  if (p.tightens !== 'higher' && p.tightens !== 'lower') return { declared: false, reason: `"${key}" declares no tightens direction` };
  return { declared: true, tighterWhen: p.tightens };
}

// One value change, judged. `from === undefined` means the key is not currently bound anywhere.
function judgeParam(strat, key, from, to) {
  const base = { key, from: from === undefined ? null : from, to };
  if (from === undefined || from === null) {
    return { ...base, verdict: 'addition', reason: `"${key}" is not currently bound here - introducing a knob is not a narrowing` };
  }
  const dir = directionOf(strat, key);
  if (!dir.declared) return { ...base, verdict: 'undeclared', reason: dir.reason };
  const a = Number(from), b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ...base, verdict: 'undeclared', reason: 'a side is not numeric' };
  if (a === b) return { ...base, verdict: 'noop', reason: 'value unchanged' };
  const tighter = dir.tighterWhen === 'higher' ? b > a : b < a;
  return { ...base, verdict: tighter ? 'tightening' : 'widening', reason: `${key} ${a} -> ${b} is ${tighter ? 'tighter' : 'LOOSER'} (declared: tighter when ${dir.tighterWhen})` };
}

function judgeOp(settings, op, registry) {
  const op0 = { ...(op || {}) };
  const at = { symbol: op0.symbol || null, strategy: op0.strategy || null };
  if (!OPS.includes(op0.type)) return { ...at, type: op0.type, verdict: 'error', reason: `unknown operation "${op0.type}"` };
  if (!op0.symbol || !op0.strategy) return { ...at, type: op0.type, verdict: 'error', reason: 'the operation is missing symbol or strategy' };
  const strat = registry.get(op0.strategy);
  if (!strat) return { ...at, type: op0.type, verdict: 'error', reason: `unknown strategy "${op0.strategy}"` };

  if (op0.type === 'unbind') {
    const scope = inScopeIds(settings, op0.symbol, registry);
    if (!scope.raw.includes(op0.strategy)) return { ...at, type: 'unbind', verdict: 'noop', reason: `${op0.strategy} is not bound to ${op0.symbol}` };
    if (scope.source !== 'explicit') {
      return {
        ...at, type: 'unbind', verdict: 'held',
        reason: `removing one strategy from ${op0.symbol} requires pinning it to its own scope list (it currently inherits the ${scope.source === 'default_key' ? "'others' entry" : 'global enabled list'}), which also stops it following future global changes - a policy change, so it stays human`,
      };
    }
    return { ...at, type: 'unbind', verdict: 'tightening', reason: `${op0.strategy} would stop trading ${op0.symbol}`, nextScope: scope.raw.filter((x) => x !== op0.strategy) };
  }

  // bind - put an out-of-scope pair IN SCOPE.
  if (op0.type === 'bind') {
    const scope = inScopeIds(settings, op0.symbol, registry);
    if (scope.raw.includes(op0.strategy)) return { ...at, type: 'bind', verdict: 'noop', reason: `${op0.strategy} is already in scope for ${op0.symbol}` };
    // A track-bound strategy declares the instruments it may run on. Putting it anywhere else is not a
    // widening to weigh, it is an impossibility, and it has to be an ERROR rather than a held decision.
    if (Array.isArray(strat.symbols) && strat.symbols.length && !strat.symbols.includes(op0.symbol)) {
      return { ...at, type: 'bind', verdict: 'error', reason: `"${op0.strategy}" is track-bound to ${JSON.stringify(strat.symbols)}; a binding on ${op0.symbol} can never run` };
    }
    const from = scope.source === 'explicit'
      ? 'its own scope list'
      : `the ${scope.source === 'default_key' ? "'others' entry" : 'global enabled list'}`;
    return {
      ...at, type: 'bind', verdict: 'widening',
      reason: `${op0.strategy} would START trading ${op0.symbol}, which it does not trade today (permission comes from ${from})`,
      nextScope: [...scope.raw, op0.strategy],
      params: { ...(op0.params || {}) },
    };
  }

  // setParams
  const scope = inScopeIds(settings, op0.symbol, registry);
  if (!scope.ids.includes(op0.strategy)) {
    return { ...at, type: 'setParams', verdict: 'inert', reason: `${op0.strategy} is not in scope for ${op0.symbol}, so moving its values changes nothing` };
  }
  const current = resolveBinding(settings, op0.symbol, op0.strategy, registry) || { tuned: {} };
  const changes = Object.keys(op0.params || {}).map((k) => judgeParam(strat, k, current.tuned ? current.tuned[k] : undefined, op0.params[k]));
  if (!changes.length) return { ...at, type: 'setParams', verdict: 'noop', reason: 'no parameters proposed', changes };
  const widening = changes.filter((c) => c.verdict === 'widening');
  const unsure = changes.filter((c) => c.verdict === 'undeclared' || c.verdict === 'addition');
  const tightening = changes.filter((c) => c.verdict === 'tightening');
  let verdict = 'noop'; let reason = 'no change';
  if (widening.length) { verdict = 'widening'; reason = `refused: ${widening.map((c) => c.reason).join('; ')}`; }
  else if (unsure.length) { verdict = 'undeclared'; reason = `refused, not provably a narrowing: ${unsure.map((c) => c.reason).join('; ')}`; }
  else if (tightening.length) { verdict = 'tightening'; reason = tightening.map((c) => c.reason).join('; '); }
  return { ...at, type: 'setParams', verdict, reason, changes, tighteningKeys: tightening.map((c) => c.key) };
}

// Classify a whole operation set. Returns every op WITH its verdict, and the tightenable subset.
function classifyOps(settings, ops = [], registry = null) {
  const reg = registry || require('./strategies');
  const rows = (ops || []).map((op) => judgeOp(settings, op, reg));
  const pick = (v) => rows.filter((r) => r.verdict === v);
  return {
    ops: rows,
    tightening: pick('tightening'),
    held: rows.filter((r) => ['undeclared', 'addition', 'inert', 'held'].includes(r.verdict)),
    widening: pick('widening'),
    noop: pick('noop'),
    errors: pick('error'),
  };
}

// The ONLY thing an automatic apply may write: the tightening ops, expressed as a settings patch.
// Anything not in here cannot reach the writer.
function tightenPatch(classification) {
  const symbolParams = {};
  const symbolScope = {};
  for (const op of (classification && classification.tightening) || []) {
    if (op.type === 'unbind') {
      if (Array.isArray(op.nextScope)) symbolScope[op.symbol] = op.nextScope;
    } else if (op.type === 'setParams') {
      symbolParams[op.symbol] = symbolParams[op.symbol] || {};
      const only = {};
      for (const k of op.tighteningKeys || []) only[k] = op.changes.find((c) => c.key === k).to;
      symbolParams[op.symbol][op.strategy] = only;
    }
  }
  const strategies = {};
  if (Object.keys(symbolParams).length) strategies.symbolParams = symbolParams;
  if (Object.keys(symbolScope).length) strategies.symbolScope = symbolScope;
  // NESTED UNDER `strategies` DELIBERATELY. The settings shape is `settings.strategies.symbolParams`.
  // A FLAT patch is accepted by the writer and lands on a top-level key nobody reads: "applied" and
  // inert at the same time, which is the defect class this workstream exists to remove. The first
  // version of this function returned a flat patch, and the test blessed it because the test asserted
  // the shape the function produced instead of the shape the SETTINGS use. The pin is in the test.
  return Object.keys(strategies).length ? { strategies } : {};
}

// The ONLY thing a SCOPE apply may write: the `bind` operations, expressed as a settings patch.
//
// Sibling of tightenPatch and deliberately NOT merged with it. The two writers have different guards,
// different switches and different consequences, and one function serving both would let a widening reach
// the tighten-only path through a code change nobody would read as a permission change. The `widening`
// list is also the wrong list for tightenPatch to consult by accident: it is filtered to `bind` here and
// to `tightening` there, so neither can pick up the other's operations.
function scopePatch(classification) {
  const symbolScope = {};
  const symbolParams = {};
  for (const op of (classification && classification.widening) || []) {
    if (op.type !== 'bind') continue;
    if (Array.isArray(op.nextScope)) symbolScope[op.symbol] = op.nextScope;
    // The values the reviewer proposed for the new pairing. They were checked for declared key, numeric
    // type and min/max by validate() on the MERGED settings, so they are not raw model output here.
    if (op.params && Object.keys(op.params).length) {
      symbolParams[op.symbol] = symbolParams[op.symbol] || {};
      symbolParams[op.symbol][op.strategy] = { ...op.params };
    }
  }
  const strategies = {};
  if (Object.keys(symbolScope).length) strategies.symbolScope = symbolScope;
  if (Object.keys(symbolParams).length) strategies.symbolParams = symbolParams;
  // NESTED UNDER `strategies`, for the reason spelled out on tightenPatch: a flat patch is accepted by
  // the writer and lands on a top-level key nobody reads.
  return Object.keys(strategies).length ? { strategies } : {};
}

// The operation set a proposal implies. Its `bindings` are value changes on pairs that ALREADY run, and
// SCOPE ADDITIONS on pairs that do not; its `unbound` list is the removal channel.
//
// ★ WHY THE SETTINGS ARGUMENT EXISTS (2026-09-15). The same binding means two different things depending
// on whether the pair is already permitted, and only the settings can say which. Before this, EVERY
// binding became `setParams`, so a proposal for a symbol with no strategy in scope was judged `inert`
// ("moving its values changes nothing") and dropped - the reviewer could not widen, and since `scope` was
// also presented to it as a constraint, every symbol but Gold and Oil came back `unbound` with the
// reason "scope explicitly permits no strategy". Both halves had to change together; fixing only the
// prompt would have produced bindings that were silently discarded, which is worse than proposing
// nothing, because it looks like it worked.
//
// Called with no settings it keeps its original meaning exactly (every binding is a value change), so
// existing callers and tests are unaffected.
function opsFromProposal(proposal, settings = null, registry = null) {
  const reg = registry || require('./strategies');
  const ops = [];
  for (const b of (proposal && proposal.bindings) || []) {
    if (!b || !b.symbol || !b.strategy) continue;
    const alreadyInScope = settings
      ? inScopeIds(settings, b.symbol, reg).raw.includes(b.strategy)
      : true;
    if (!alreadyInScope) {
      ops.push({ type: 'bind', symbol: b.symbol, strategy: b.strategy, params: { ...(b.params || {}) }, reason: b.rationale || null });
    } else {
      ops.push({ type: 'setParams', symbol: b.symbol, strategy: b.strategy, params: { ...(b.params || {}) } });
    }
  }
  for (const u of (proposal && proposal.unbound) || []) {
    if (u && u.symbol && u.strategy) ops.push({ type: 'unbind', symbol: u.symbol, strategy: u.strategy, reason: u.reason || null });
  }
  return ops;
}

module.exports = {
  DEFAULT_KEYS, eligibleOn, applicableIds, inScopeIds, resolveBinding, bindingTable, validate,
  OPS, directionOf, judgeParam, judgeOp, classifyOps, tightenPatch, scopePatch, opsFromProposal,
};
