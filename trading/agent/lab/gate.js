// trading/agent/lab/gate.js — the live-eligibility gate (TRD-71).
//
// THE MODULE THAT WAS MISSING. scoreboard.js:12 says the promotion pipeline
// (eligibility -> paper-forward -> owner approval) is "TRD-21's concern". No TRD-21 module was ever
// written, so the lab computed PASS / FAIL / INSUFFICIENT-DATA, printed them, and nothing consumed
// them as permission: a strategy went live by a settings write with no interlock.
//
// MODE: OBSERVE FIRST. The owner's call (2026-09-15, demo desk): collect the data, see which pairs
// are eligible, and let the answer follow the data as it changes. So this module RECORDS a decision
// and only ever blocks when config.enforce is true. Observing is on by default; enforcing is not.
// An observation that cannot block anything is the only safe first move here, because a literal
// "refuse unless PASS" gate would refuse EVERY pair the desk currently trades - see below.
//
// WHY THE MAPPING IS DECLARED, NOT INFERRED (the same reason as GATE_OWNERS in quant.js):
//   * survgold's id contains neither "turtle" nor "dc20", yet the Gold survivor IS the frozen
//     dc20/gate-0 turtle variant - i.e. the params of LabCandidates id 20.
//   * survoil IS the frozen dc5/gate-20 Oil variant - the params of id 22.
// A name-based mapping would strip the only two instruments the desk trades. So the mapping is
// written down here, and a coverage test asserts every registered strategy is either mapped or
// explicitly declared UNCOVERED, so a new strategy must make this decision deliberately.
//
// THE TWO FACTS THAT FORCE OBSERVE MODE, measured 2026-09-15:
//   1. LabCandidates 20/21/22 (turtle/Gold, turtle/Oil x2) are status=archived with verdict=NULL,
//      so every turtle-family pair has NO verdict to present.
//   2. "No candidate at all" is a DIFFERENT state from "a candidate that failed". meanrev, macd,
//      rsi2, multi and congress have never been through the lab. Refusing them is a policy choice;
//      exempting them is a different policy choice. Observe mode records which is which instead of
//      guessing, which is exactly what makes the enforcement decision decidable later.
'use strict';

const elig = require('./eligibility');

// ---------------------------------------------------------------------------
// DECLARED mapping: which lab candidate(s) speak for a live strategy id.
// ---------------------------------------------------------------------------
const LAB_SPEAKERS = {
  turtle: ['turtle'],      // the registry strategy and its lab candidate share the id
  regturtle: ['regturtle'],
  squeezerev: ['squeezerev'],
  mtftrend: ['mtftrend'],
};

// Strategies with NO lab candidate of their own.
//
// ★ OWNER DECISION 2026-09-15: "exempt but recorded". A strategy with no lab case at all is EXEMPT
// from the gate - not refused - and the exemption is RECORDED so that "how much of the desk runs on an
// exemption rather than a lab case" is a visible number instead of an implication.
//
// ★★ THE WRAPPERS ARE HERE, NOT IN LAB_SPEAKERS, AND THAT IS THE B1 DECISION.
// survgold/survoil used to be mapped onto the `turtle` candidates, which made a wrapper INHERIT its
// parent's verdict. The owner resolved that semantic to INDEPENDENT, and the argument is decisive:
// the turtle candidates were archived PRECISELY SO THE WRAPPERS COULD RUN - the archival IS the
// promotion. Under "inherits", the gate reads that archival as a refusal, so the design decision that
// created the wrappers becomes the reason the wrappers are blocked. A wrapper whose parent was
// archived-for-supersession could never be authorised, and every wrapper is that by construction. A
// self-blocking rule is not a rule, so the inheritance mapping is removed rather than reinterpreted.
//
// ★ `survgoldstruct` (S3, 2026-09-23) IS HERE FOR THE SAME REASON, one level deeper: it is a GATED WRAPPER
// of `survgold`, which is itself a wrapper. Mapping it onto the `turtle` candidates would make it inherit a
// verdict that belongs to a different strategy — precisely the defect this list exists to prevent. It is a
// WRAPPER, so it is declared UNCOVERED until it has lab evidence OF ITS OWN, and the exemption is RECORDED
// rather than silent (the owner's 2026-09-15 "exempt but recorded" decision). Note this is a different
// question from `quant.GATE_OWNERS`, where the same strategy IS mapped to `donchian`/`adx` — that answers
// "whose gate notes may explain a flat symbol", not "whose lab verdict does it inherit".
const UNCOVERED = ['meanrev', 'macd', 'rsi2', 'multi', 'congress', 'survgold', 'survoil', 'survgoldstruct'];

const lower = (v) => String(v == null ? '' : v).toLowerCase();
const speakersFor = (strategyId) => LAB_SPEAKERS[lower(strategyId)] || null;
const isUncovered = (strategyId) => UNCOVERED.includes(lower(strategyId));

// The candidates that speak for one (strategy, symbol) pair.
// Returns null when the STRATEGY is unmapped (a different thing from a pair with no rows).
function candidatesFor(candidates, strategyId, symbol) {
  const speakers = speakersFor(strategyId);
  if (!speakers) return null;
  const want = new Set(speakers.map(lower));
  return (candidates || []).filter((c) => want.has(lower(c && c.strategy)) && c && c.symbol === symbol);
}

// ---------------------------------------------------------------------------
// The observation. PURE: takes the candidate rows as data, returns a decision.
// ---------------------------------------------------------------------------
function observe(config = {}, { strategyId, symbol } = {}) {
  const enforce = config.enforce === true;
  const pair = `${strategyId}:${symbol}`;
  const rawOverride = (config.overrides || {})[pair] || (config.overrides || {})[`${lower(strategyId)}:${lower(symbol)}`] || null;
  const override = rawOverride
    ? { reason: typeof rawOverride === 'string' ? rawOverride : String(rawOverride.reason || '') }
    : null;

  const base = { strategyId, symbol, enforce, overrideApplied: !!override };
  const declared = isUncovered(strategyId);

  // 1. DECLARED UNCOVERED -> EXEMPT, first, and regardless of any mapping.
  //    This MUST precede the mapping lookup: candidatesFor() returns null for any strategy absent from
  //    LAB_SPEAKERS, so a declared-UNCOVERED strategy would otherwise fall into the `unmapped` branch
  //    and be reported as a mapping DEFECT - the exact opposite of a policy decision. Found by this
  //    test failing with exempt=0 where 2 was expected.
  if (declared) {
    return {
      ...base, action: 'exempt', outcome: 'exempt', candidates: [], needsMapping: false,
      basis: `declared UNCOVERED - no lab case exists for "${strategyId}"`,
      reason: `exempt: "${strategyId}" is declared UNCOVERED - no lab case of its own, exemption recorded (this is NOT a pass)`,
    };
  }

  const mine = candidatesFor(config.candidates, strategyId, symbol);

  if (mine == null) {
    // IN NEITHER LIST: a mapping DEFECT (a new strategy nobody classified), not a policy outcome.
    // Kept distinct from `exempt` on purpose - an unclassified strategy must not become exempt by
    // accident, or the coverage test's whole point disappears.
    return {
      ...base, action: 'unmapped', outcome: 'unmapped', candidates: [],
      reason: `no lab candidate speaks for "${strategyId}" - unmapped in lab/gate.js LAB_SPEAKERS, and not declared UNCOVERED either`,
      needsMapping: true,
    };
  }
  if (!mine.length) {
    // 2. MAPPED but no candidate for THIS symbol -> exempt, with its own basis.
    //    Not a pass and not a refusal: the ledger counts it separately. No special handling is needed
    //    in apply(), because apply() blocks only on `would_refuse` - an exemption is non-blocking by
    //    construction rather than by an extra branch that could be got wrong.
    return {
      ...base, action: 'exempt', outcome: 'exempt', candidates: [], needsMapping: false,
      basis: `mapped, but no lab candidate for ${symbol}`,
      reason: `exempt: no lab candidate for ${symbol} - no lab case of its own, exemption recorded (this is NOT a pass)`,
    };
  }

  const rows = mine.map((c) => {
    const e = elig.liveEligible(c, { override });
    return { id: c.id, status: c.status || null, verdict: c.verdict || null, eligible: e.eligible, overrideUsed: e.overrideUsed, needsOverride: !!e.needsOverride, reason: e.reason };
  });

  const ok = rows.find((r) => r.eligible);
  if (ok) {
    return {
      ...base, action: 'allow', candidates: rows,
      outcome: ok.overrideUsed ? 'override' : (ok.verdict === 'PASS' ? 'pass' : 'eligible'),
      reason: ok.reason,
    };
  }
  return {
    ...base, action: 'would_refuse', candidates: rows,
    outcome: rows.some((r) => r.verdict === 'FAIL') ? 'failed'
      : rows.some((r) => r.needsOverride) ? 'archived'
        : rows.some((r) => r.verdict === 'INSUFFICIENT-DATA') ? 'insufficient_data' : 'unverdicted',
    reason: rows.map((r) => r.reason).join(' · '),
  };
}

// One ledger row per in-scope (strategy, symbol) pair, so the desk collects coverage for EVERY pair
// it could trade - not only the ones that happened to fire. This is the "see which ones are
// eligible" artefact, and it is recomputed from current rows on every call, so it follows the data.
function ledger(config = {}, pairs = []) {
  return (pairs || []).map((p) => observe(config, p));
}

// ---------------------------------------------------------------------------
// APPLY a decision to a signal. PURE. This is where enforcement lives, and it is deliberately a
// separate function from observe() so the two safety properties can be tested directly:
//   1. OBSERVE MODE CANNOT BLOCK. With enforce=false the signal is returned untouched, however
//      damning the decision is. That is the whole point of collecting data first.
//   2. AN EXIT IS NEVER GATED. Refusing a stop, a take-profit or a desk exit to prove a point about
//      eligibility would trap a position. Exits are returned untouched and the decision is dropped
//      (null), so nothing downstream can act on it either.
// Returns { signal, decision, flat?, note? } - never mutates its argument.
function apply(signal, decision) {
  if (!signal) return { signal: null, decision: decision || null };
  if (signal.type !== 'entry') return { signal, decision: null, note: 'exits are never gated' };
  if (!decision) return { signal, decision: null };
  if (!decision.enforce || decision.action !== 'would_refuse') return { signal, decision };
  return { signal: null, decision: { ...decision, blocked: true }, flat: `gated: ${decision.reason}` };
}

// A stable fingerprint of a ledger, so the desk can log the decision set ONCE PER CHANGE instead of
// once per wake. Sorted, so pair ordering cannot fake a change. This is what makes "will adapt to
// change of data" observable rather than a claim.
function signature(rows) {
  return (rows || [])
    .map((r) => `${r.strategyId}:${r.symbol}:${r.action}:${r.outcome}`)
    .sort()
    .join('|');
}

function summarise(rows) {
  const out = { total: 0, would_refuse: 0, allow: 0, exempt: 0, unmapped: 0, byOutcome: {}, enforced: false, exemptSharePct: 0 };
  for (const r of rows || []) {
    out.total += 1;
    out.enforced = out.enforced || r.enforce === true;
    out.byOutcome[r.outcome] = (out.byOutcome[r.outcome] || 0) + 1;
    if (r.action === 'would_refuse') out.would_refuse += 1;
    else if (r.action === 'allow') out.allow += 1;
    else if (r.action === 'exempt') out.exempt += 1;
    else out.unmapped += 1;
  }
  // The number the ledger exists to make visible: what share of the desk is running on an exemption
  // rather than on a lab case. A gate that reported only "refused" would hide this entirely.
  out.exemptSharePct = out.total ? Math.round((out.exempt / out.total) * 100) : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Loading. This is the ONLY impure part, and it can never throw: an observe-mode read failure must
// not be able to break a wake. A failed read is reported as candidatesUnavailable, never as "refuse".
// ---------------------------------------------------------------------------
async function loadCandidates(userId) {
  try {
    const rows = await require('../../store').listLabCandidates(userId);
    return { candidates: rows || [], candidatesUnavailable: false };
  } catch (e) {
    return { candidates: [], candidatesUnavailable: true, error: String((e && e.message) || e).slice(0, 160) };
  }
}

// Config from settings. Observing unless explicitly disabled; enforcing only when asked for.
function configFrom(settings, candidates, extra = {}) {
  const g = (settings && settings.gate) || {};
  return {
    observe: g.observe !== false,
    enforce: g.enforce === true,
    overrides: g.overrides || {},
    candidates: candidates || [],
    ...extra,
  };
}

module.exports = {
  LAB_SPEAKERS, UNCOVERED,
  speakersFor, isUncovered, candidatesFor,
  observe, apply, ledger, summarise, signature,
  loadCandidates, configFrom,
};
