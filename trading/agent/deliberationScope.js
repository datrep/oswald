// trading/agent/deliberationScope.js — WHICH SIGNALS THE CHAIRS ARE ASKED ABOUT.
//
// WHY THIS IS ITS OWN MODULE. `aggregator.decide` opens a DB pool, so nothing inside it can be required from a
// unit test — `test/_source.js` exists for exactly that reason and says so. A rule that decides whether to SPEND
// MONEY (a chair call is ~3 LLM calls per proposal) therefore cannot live inline in `decide` and also be pinned
// by behaviour. Same argument that put `settingsDiff` in its own module (`TradingSettings` writes were
// unreconstructible), `scopeResolution` (`enabled` vs `symbolScope` confused two readers) and `stopPolicy` (two
// copies of a rule that must agree is how declared-vs-capped drifted). Pure, no store, no logger.
//
// ★★ WHAT IT FIXES — TRD-TRL-1 defect 1(b), measured 2026-09-30.
//
// `wakePipeline.exitWithinTolerance` defers an exit whose floating loss sits inside `maxLossAtR x ATR`. That rule
// was evaluated ONLY in the execution step, i.e. AFTER the chairs had voted and been paid for. Measured over the
// 23 trailing-stop fires in the record:
//
//   12 placed  ·  10 deferred by the tolerance gate  ·  1 already closed
//
// and the 10 deferrals each carried `chairVote: "yes"` (confidence 0.69–0.82) while the executor then refused to
// place the order. On 7 of them the deferred exit was the wake's ONLY signal, so the whole three-call
// deliberation bought a decision that could never be placed. The fix is ORDERING: evaluate the same rule before
// the deliberation and hand the symbols here, so the chair is never convened on them.
//
// ⚠ THREE THINGS THIS IS NOT, because each would be a different (and wrong) change:
//   1. NOT a safety gate. The pre-check and the execution-step check are the same function over the same
//      wake-start book, so the deferral VERDICT is identical. The execution-step check is untouched and still
//      runs, so an exit that becomes placeable seconds later is still placed.
//   2. NOT a signal skip. The desk's stated policy is that every signal gets a chair vote. This suppresses only
//      the class where the vote CANNOT change the outcome — the executor refuses the order regardless of what
//      the chairs say.
//   3. NOT a deletion. The suppressed symbols are still reported: the wake's `action` stays `exit` with the
//      reason `deferred_before_deliberation` (see aggregator.decide), and the deferral is written into
//      `executions[]` in the same shape the execution step uses, plus `preDeliberation: true` so a reader can
//      tell a gate that SAVED a chair call from one that wasted it.
//
// The residual difference, stated because it is real: if the loss grows past the band DURING the ~10s
// deliberation, the old ordering would have placed the exit on this wake and the new one places it on the next
// (~5 min later). That is the same trade-off the advisory gate already carries, and it is bounded by one wake.

'use strict';

// Returns the symbol rows that should reach the chairs, in the desk's order: EXITS FIRST, then entries.
//
// `blocked` is the existing session/kill/bridge/micro lock — when set, NO entry is proposed (the lock's own
// contract: `pickProposal` still returns an exit before the block check, so proximity exits keep working).
// `suppressedExits` is the new pre-deliberation tolerance gate, by SYMBOL.
function deliberationSymbols(quantResult, { blocked = null, suppressedExits = null } = {}) {
  const suppression = new Set(Array.isArray(suppressedExits) ? suppressedExits : []);
  const okSyms = ((quantResult && quantResult.symbols) || []).filter((s) => s.status === 'ok' && s.signal);
  const exitSyms = okSyms.filter((s) => s.signal.type === 'exit' && !suppression.has(s.symbol));
  const entrySyms = blocked ? [] : okSyms.filter((s) => s.signal.type === 'entry');
  return [...exitSyms, ...entrySyms];
}

// The count of suppressed symbols, for the wake's honest action/reason. Kept here so the "was anything
// suppressed?" question has ONE definition rather than a `length` check repeated at the call site.
const suppressedCount = (suppressedExits) => (Array.isArray(suppressedExits) ? suppressedExits.length : 0);

module.exports = { deliberationSymbols, suppressedCount };
