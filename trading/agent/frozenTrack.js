// trading/agent/frozenTrack.js — ★ S5 (2026-10-01): WHICH STRATEGIES ARE A FROZEN FORWARD TRACK, AND WHO SAYS SO.
//
// WHY THIS MODULE EXISTS. EXE-14 and EXE-15 both MOVE A STOP LEVEL, and the live forward-validation candidate
// (TRD-29) must not have its levels moved. Both changes therefore need a gate. Writing that gate twice, from two
// inline lists in two files, is how a gate becomes two gates that disagree — so there is one implementation here
// and both call it.
//
// ★★ THE SEARCH FOR AN EXISTING MARKER, AND WHAT IT FOUND. The plan for EXE-14 predicted this exactly:
//
//   "an empty params array is a COINCIDENCE of two strategies, not a contract ... if a future maintainer adds a
//    param to a frozen strategy for an unrelated reason, a `params: []`-based gate stops protecting the track
//    SILENTLY."
//
// ⚠ THAT WAS NOT A HYPOTHETICAL, AND IT IS ALREADY TRUE — MEASURED, NOT PREDICTED:
//
//   `trading/agent/strategies/survGold.js`      symbols: ['Gold'],  params: []   // frozen
//   `trading/agent/strategies/survReplicas.js`  symbols: [symbol],  params: []   // "frozen — no editable
//                                                                                 parameters by design"
//
// `params: []` is TRUE OF ALL 18. It is not a property of the frozen pair; it is a property of the GENERATOR that
// produces both the survivors and the replicas. The closest thing to a marker that the code actually uses today is
// `binding.js`'s `tunable: Array.isArray(strat.params) && strat.params.length > 0`, which therefore reports
// **18 strategies as not-tunable, not two**.
//
// ⚠ AND THE ERROR DIRECTION MATTERS, WHICH IS WHY THIS IS A DEFECT AND NOT A PEDANTRY. A gate keyed on
// `params: []` fails by EXCLUDING, so it would look safe — but it would exclude the 16 `surva*`/`survc*` REPLICAS,
// which the plan establishes are non-frozen, distinct contracts, and legitimately in scope. The measured §1c split
// (`survgold`/`survoil` 54.6% vs the rest 45.4%) is computed BY NAME, so a `params: []` gate would not reproduce
// it — it would quietly reduce EXE-14's coverage from 45.4% of fills to almost nothing, and report success.
//
// ★ OTHER CANDIDATES CONSIDERED AND REJECTED, so the next reader does not repeat the search:
//   · `symbols: [one]` (binding.js's `trackBound`) — true of all 18; the replicas are track-bound BY DESIGN.
//   · `name` containing "(frozen)" — true of all 18: survivors are "… survivor A (frozen)", replicas are
//     "… replica (frozen)". The WORD is used for two different things.
//   · `replicates` — ★ THIS IS THE ONLY STRUCTURAL DIFFERENCE between the two families, and it points the WRONG
//     WAY: the replicas carry it (`replicates: 'survgold'`) and the originals do not. It identifies the DERIVED
//     set, which is the complement of the frozen set.
//   · `trading/agent/lab/*` and `LabCandidates.status='frozen'` (sql/migrations/032) — a DIFFERENT sense of
//     "frozen" entirely: a lab candidate's lifecycle status, and `mFrozen` counts frozen pairs at a release.
//     Nothing there names `survgold`/`survoil` as the live track.
//   · `shadowGate.js`'s FROZEN `GATE` block — also a different sense: a frozen GATE DEFINITION, not a frozen set
//     of strategies.
//
// ⭐ CONCLUSION: no marker exists. Freeze-ness is expressed ONLY in prose — module comments, a local
// `const FROZEN` that is never exported, and documents (rule-L, review doc §16.9, TRD-29). So the marker is the
// thing to CREATE, which is what this module and the `forwardFrozen` field below are.
//
// ⚠ AND THE FIELD IS ADDED TO THE STRATEGIES' OWN MODULES RATHER THAN TO A LIST HERE, because a list kept beside
// the registry is exactly the artefact that drifts from it. A strategy declares its own freeze; this module only
// reads the declaration. Adding a non-functional declarative field does NOT retune a frozen candidate: `DEFAULTS`,
// `FROZEN` and `params` are untouched, and no code path reads `forwardFrozen` except this gate.
'use strict';

// The track a strategy belongs to when it is frozen. A string rather than `true` so the marker names WHAT is
// being protected — a reader of the error message learns which pre-registration they were about to disturb.
const TRACK_TRD29 = 'TRD-29';

// ⚠ THE FAIL-CLOSED RULE, STATED BECAUSE IT IS NOT THE OBVIOUS ONE.
//
// There are three cases and they do NOT all resolve the same way:
//
//   1. NO STRATEGY ID AT ALL (`null`/`''`) — an owner/dashboard order, or a path with no strategy. ALLOWED.
//      It cannot be part of a frozen track because it is not part of the track: there is no candidate whose
//      record it could contaminate. Refusing here would disable the fix for the owner's own orders while
//      protecting nothing.
//
//   2. AN ID THAT DOES NOT RESOLVE (unknown, typo'd, or a retired strategy) — REFUSED. This is the fail-closed
//      case, and it is the one the plan demands: an id the desk cannot look up is an id whose freeze status is
//      UNKNOWN, and "unknown" must never read as "in scope". A strategy renamed or retired while a stale config
//      still names it is precisely how a gate would stop protecting the track without anyone noticing.
//
//   3. AN ID THAT RESOLVES — its own declaration decides.
//
// ⚠ NOTE THE ASYMMETRY IS DELIBERATE AND IS THE OPPOSITE OF THE FAIL-OPEN DIRECTION USED ELSEWHERE ON THIS DESK.
// `sessionPrime` defaults ON because its default failure is a wasted navigation; `staleTickForDecision` returns
// false on unknown because a tick is not a session. Here the default failure is A LEVEL MOVED ON THE FORWARD
// TRACK, which is unrecoverable, so unknown refuses.
function isFrozenStrategy(id, registry = null) {
  const key = id == null ? '' : String(id).trim();
  if (!key) return false; // (1) no strategy — cannot be track-bound; see the rule above
  let reg = registry;
  if (!reg) {
    try { reg = require('./strategies'); } catch { reg = null; }
  }
  const strat = reg && typeof reg.get === 'function' ? reg.get(key) : null;
  if (!strat) return true; // (2) unresolvable — fail CLOSED
  return typeof strat.forwardFrozen === 'string' && strat.forwardFrozen.length > 0; // (3) declared
}

// Why an id was refused, for the event payload. The executor records the reason, because "refused" without a
// reason is indistinguishable from "the gate is broken" — the defect class this whole workstream keeps finding.
function frozenReason(id, registry = null) {
  const key = id == null ? '' : String(id).trim();
  if (!key) return { frozen: false, reason: 'no_strategy_id' };
  let reg = registry;
  if (!reg) {
    try { reg = require('./strategies'); } catch { reg = null; }
  }
  const strat = reg && typeof reg.get === 'function' ? reg.get(key) : null;
  if (!strat) return { frozen: true, reason: 'strategy_unresolved' };
  const track = typeof strat.forwardFrozen === 'string' && strat.forwardFrozen.length > 0 ? strat.forwardFrozen : null;
  return { frozen: !!track, reason: track ? `frozen_${track}` : 'not_frozen', track };
}

module.exports = { isFrozenStrategy, frozenReason, TRACK_TRD29 };
