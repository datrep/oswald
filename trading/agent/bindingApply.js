'use strict';
// trading/agent/bindingApply.js — the ONE writer that may change a binding without a human (B5, A+B).
//
// Everything it can write comes from `binding.tightenPatch()`, which is derived from operations that
// were each classified as a NARROWING. It cannot widen, because a widening op never reaches the patch.
//
// FOUR GUARDS, ALL FAIL-CLOSED. Any one of them returning false means NOTHING is written:
//   1. `settings.bindingProposer.autoTighten === true` literally. Off by default, and the `=== true`
//      comparison is deliberate: a truthy string out of a settings round-trip must not arm a writer.
//   2. the proposal was ACCEPTED (no error-level reasons). A refused proposal is the useful one - it is
//      the one a human should read, not one a machine should half-apply.
//   3. NO override requests. An override is a human asking for something the gate refused; that request
//      is by definition not a narrowing the desk decided for itself.
//   4. at least one op actually classifies as tightening. "Nothing to do" is not "done".
//
// The applied event records BOTH halves - what was written and what was held - because the interesting
// artefact is the held list: it is the queue of decisions the desk declined to make alone.
const store = require('../store');

const REASON = {
  off: 'autoTighten is off',
  unaccepted: 'the proposal was not accepted, so it is a human decision',
  override: 'the proposal carries an override request, which is a human decision by definition',
  nothing: 'no operation classified as a narrowing, so there is nothing to apply',
  scopeOff: 'autoScope is off',
  scopeNothing: 'no operation classified as a scope addition, so there is nothing to apply',
  scopeRetired: 'every scope addition names a strategy a previous retire removed deliberately (TRD-91)',
};

// TRD-91 (2026-09-20): the ids a retire removed ON PURPOSE. Read here and nowhere else that matters,
// because this is the only writer that may widen unattended.
function retiredIds(settings) {
  const r = settings && settings.strategies && settings.strategies.retired;
  return Array.isArray(r) ? r.map(String) : [];
}

async function applyTightening(userId, { settings, ops = [], registry = null, accepted = false, overrideRequests = [], now = new Date(), reason = null } = {}) {
  const proposer = (settings && settings.bindingProposer) || {};
  const binding = require('./binding');

  const refuse = (why) => ({ applied: false, reason: why, wrote: null, held: ops });

  if (proposer.autoTighten !== true) return refuse(REASON.off);
  if (accepted !== true) return refuse(REASON.unaccepted);
  if ((overrideRequests || []).length) return refuse(REASON.override);

  const classification = binding.classifyOps(settings, ops, registry);
  if (!classification.tightening.length) {
    return { applied: false, reason: REASON.nothing, wrote: null, held: classification.held.map((h) => ({ symbol: h.symbol, strategy: h.strategy, type: h.type, verdict: h.verdict, reason: h.reason })) };
  }

  const patch = binding.tightenPatch(classification);
  const wrote = await store.saveSettings(userId, patch);

  const held = classification.held.map((h) => ({ symbol: h.symbol, strategy: h.strategy, type: h.type, verdict: h.verdict, reason: h.reason }));
  await store.logEvent(userId, 'binding_applied', {
    applied: true,
    source: reason || 'binding_proposer',
    patch,
    ops: classification.tightening.map((t) => ({ symbol: t.symbol, strategy: t.strategy, type: t.type, reason: t.reason })),
    held,
    declined: classification.widening.map((w) => ({ symbol: w.symbol, strategy: w.strategy, reason: w.reason })),
    at: now.toISOString(),
  }).catch(() => {});

  return { applied: true, reason: null, wroteSettings: !!wrote, patch, held, tightening: classification.tightening };
}

// ---------------------------------------------------------------------------
// applyScope - the ONE writer that may put a pair INTO scope without a human.
// ---------------------------------------------------------------------------
//
// WHY A SEPARATE FUNCTION AND NOT A WIDER applyTightening. Putting a pair in scope is a WIDENING by
// construction: the desk starts trading an instrument it did not trade. The tighten-only writer exists so
// the desk can narrow itself unattended and can NEVER widen itself unattended, and that property is worth
// more than the convenience of one writer. So widening gets its own switch, its own reason vocabulary and
// its own event; applyTightening still cannot do it.
//
// WHY THE OVERRIDE GUARD IS ABSENT HERE, though it is the third of four guards there. The two writers are
// asked DIFFERENT QUESTIONS. applyTightening refuses a proposal carrying an override request because an
// override is a human asking for something the gate refused, so it cannot also be a narrowing the desk
// decided for itself. A scope addition is the opposite case: the eligibility gate will not return `allow`
// for a pair that has no lab case, so an overrideReason is the MECHANISM by which a data-collection
// pairing is justified - not evidence that a human intervened. Refusing on it would make this writer
// unable to do the one thing it exists for.
//
// THREE GUARDS, ALL FAIL-CLOSED:
//   1. `settings.bindingProposer.autoScope === true` literally. Off by default, and the `=== true`
//      comparison is deliberate: a truthy string out of a settings round-trip must not arm a writer.
//   2. the proposal was ACCEPTED. A refused proposal has already been told its pairing is impossible
//      (track-bound, unknown strategy) or unjustified, so it stays a human decision.
//   3. at least one operation actually classifies as a `bind`. "Nothing to do" is not "done".
//
// A bind op that classified as `error` can never reach the writer: only the `widening` list is read, and
// an error is not in it.
async function applyScope(userId, { settings, ops = [], registry = null, accepted = false, now = new Date(), reason = null, inputSig = null } = {}) {
  const proposer = (settings && settings.bindingProposer) || {};
  const binding = require('./binding');
  const describe = (list) => (list || []).map((o) => ({ symbol: o.symbol, strategy: o.strategy, type: o.type, verdict: o.verdict, reason: o.reason }));
  const refuse = (why) => ({ applied: false, reason: why, wrote: null, held: describe(ops) });

  if (proposer.autoScope !== true) return refuse(REASON.scopeOff);
  if (accepted !== true) return refuse(REASON.unaccepted);

  const classification = binding.classifyOps(settings, ops, registry);
  const allBinds = classification.widening.filter((o) => o.type === 'bind');
  // ★ TRD-91: THE WIDENER MUST RESPECT THE RETIREMENT.
  //
  // A retire strips the lists but used to leave no trace, so a later proposal could put the same pair
  // back — and did: rsi2 was re-added twelve minutes after a human removed it (TRD-103). Holding the
  // retired ops rather than refusing the whole proposal keeps the rest of a good proposal applyable,
  // and every hold is recorded in `held` on the `binding_scoped` event, so a drop is visible in the
  // record instead of silently absent from `added`.
  const retired = retiredIds(settings);
  const retiredOps = allBinds.filter((o) => retired.includes(String(o.strategy)))
    .map((o) => ({ ...o, verdict: 'retired', reason: `retired deliberately on an earlier pass — a scope addition naming it is refused (TRD-91)` }));
  const binds = allBinds.filter((o) => !retired.includes(String(o.strategy)));
  const notApplied = [
    ...describe(classification.ops.filter((o) => o.type === 'bind' && o.verdict !== 'widening')),
    ...describe(retiredOps),
  ];
  if (!binds.length) return { applied: false, reason: retiredOps.length ? REASON.scopeRetired : REASON.scopeNothing, wrote: null, held: notApplied };

  // ⚠ THE FILTERED LIST GOES TO THE PATCH BUILDER, and that is not cosmetic. `scopePatch` iterates
  // `classification.widening`, so handing it the raw classification would write the retired pairs back
  // while `added` and `held` both reported them refused — a guard that changes the log and not the
  // settings, which is the exact failure mode TRD-91 was opened for (a retire that reports success and
  // changes nothing). Pass only what survived the guard.
  const patch = binding.scopePatch({ widening: binds });
  const wrote = await store.saveSettings(userId, patch);

  await store.logEvent(userId, 'binding_scoped', {
    applied: true,
    source: reason || 'binding_proposer',
    // WHICH PROPOSAL this applied, so the proposal can be RETIRED. Without it the reviewer's last accepted
    // proposal stays "unapplied" and is re-offered on every wake.
    inputSig,
    patch,
    added: binds.map((b) => ({ symbol: b.symbol, strategy: b.strategy, reason: b.reason })),
    // The interesting artefact is what the reviewer wanted and did NOT get: an `error` is a pairing it got
    // wrong (track-bound, unknown strategy) and a `noop` is one it proposed without knowing what was
    // already in scope. Both are worth reading, and neither is visible from the applied list.
    held: notApplied,
    at: now.toISOString(),
  }).catch(() => {});

  return {
    applied: true, reason: null, wroteSettings: !!wrote, patch,
    added: binds.map((b) => ({ symbol: b.symbol, strategy: b.strategy })), held: notApplied,
  };
}

module.exports = { applyTightening, applyScope, retiredIds, REASON };
