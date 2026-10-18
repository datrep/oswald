// trading/agent/lab/eligibility.js — what a lab verdict actually PERMITS (TRD-74).
//
// WHY THIS FILE EXISTS
// The lab computed PASS / FAIL / INSUFFICIENT-DATA and printed them, and nothing consumed them as
// permission. scoreboard.js deferred the promotion pipeline (eligibility -> paper-forward -> owner
// approval) to "TRD-21", and no TRD-21 module was ever written, so the MEANING of the verdict states
// lived nowhere. Two measured consequences (2026-09-15):
//   * LabCandidates ids 20/21/22 (turtle/Gold, turtle/Oil x2) hold status='archived' with verdict
//     NULL, and NO code in trading/ writes 'archived' - the status was applied out of band, and
//     archivedAt was never set either.
//   * So "may this strategy trade" had no answer in code at all, and the only control was a settings
//     write with no interlock.
//
// This module is that answer, as a PURE function, so the gate (TRD-71) consults something that cannot
// drift away from its tests. It reads a candidate; it never writes and never calls out.
//
// THE RULES — every one of them fail-closed, because the cost of a wrong "eligible" is a live trade:
//   PASS              -> eligible. The only state that grants scope.
//   FAIL              -> not eligible.
//   INSUFFICIENT-DATA -> not eligible. The lockbox never reached the trade floor, so the pair has no
//                        p-value. "Not yet testable" is not evidence of edge.
//   no verdict        -> not eligible. A candidate nobody scored grants nothing.
//   archived          -> not eligible WITHOUT an explicit override, and this is checked FIRST, so a
//                        PASS cannot be smuggled out of a withdrawal. archived means "withdrawn from
//                        the frozen family"; it carries no verdict of its own, and re-enabling one is
//                        an owner decision rather than an inference from the row.
//   an override with no reason -> still not eligible. An override must say why, or it is a silent
//                        bypass wearing the word "override".
'use strict';

const PASS = 'PASS';
const FAIL = 'FAIL';
const INSUFFICIENT = 'INSUFFICIENT-DATA';
const ARCHIVED = 'archived';
const FROZEN = 'frozen';
const REGISTERED = 'registered';

// The only two states the desk treats as a finished judgement (trd26.js TERMINAL).
const TERMINAL = [PASS, FAIL];
const CANDIDATE_STATUSES = [REGISTERED, FROZEN, ARCHIVED];

const verdictOf = (cand) => (cand && cand.verdict ? String(cand.verdict).toUpperCase() : null);
const statusOf = (cand) => String((cand && cand.status) || '').toLowerCase();
const isArchived = (cand) => statusOf(cand) === ARCHIVED;
const isTerminal = (cand) => TERMINAL.includes(verdictOf(cand));

// The decision. Returns a reason for BOTH outcomes, because a gate that refuses without saying why
// produces exactly the kind of unexplained silence this file was written to end.
function liveEligible(cand, { override = null } = {}) {
  const verdict = verdictOf(cand);
  const archived = isArchived(cand);
  const base = { verdict, archived, status: statusOf(cand) || null };

  // archived FIRST: a withdrawal outranks any verdict the row may also carry.
  if (archived) {
    if (!override) {
      return {
        ...base, eligible: false, needsOverride: true, overrideUsed: false,
        reason: 'archived: withdrawn from the frozen family and carries no verdict of its own - '
          + 'enabling it is an owner decision, so it requires an explicit override',
      };
    }
    const why = String((override && override.reason) || '').trim();
    if (!why) {
      return {
        ...base, eligible: false, needsOverride: true, overrideUsed: false,
        reason: 'archived with an override that gives no reason - an override must say why, '
          + 'otherwise it is a silent bypass',
      };
    }
    return {
      ...base, eligible: true, needsOverride: false, overrideUsed: true,
      reason: `archived, enabled by explicit override: ${why}`,
    };
  }

  if (verdict === PASS) {
    return { ...base, eligible: true, needsOverride: false, overrideUsed: false, reason: 'lockbox PASS' };
  }
  if (verdict === FAIL) {
    return { ...base, eligible: false, needsOverride: false, overrideUsed: false, reason: 'lockbox FAIL' };
  }
  if (verdict === INSUFFICIENT) {
    return {
      ...base, eligible: false, needsOverride: false, overrideUsed: false,
      reason: 'INSUFFICIENT-DATA: the lockbox never reached the trade floor, so there is no p-value '
        + 'to pass - untestable is not evidence',
    };
  }
  if (verdict == null) {
    return {
      ...base, eligible: false, needsOverride: false, overrideUsed: false,
      reason: 'no verdict: no release has ever scored this candidate',
    };
  }
  return {
    ...base, eligible: false, needsOverride: false, overrideUsed: false,
    reason: `unrecognised verdict "${verdict}" - an unknown state is never a pass`,
  };
}

// Convenience for a gate that has a list of in-scope candidates for one symbol.
function eligibleAmong(cands, { override = null } = {}) {
  return (cands || []).filter((c) => liveEligible(c, { override }).eligible);
}

module.exports = {
  PASS, FAIL, INSUFFICIENT, ARCHIVED, FROZEN, REGISTERED,
  TERMINAL, CANDIDATE_STATUSES,
  verdictOf, statusOf, isArchived, isTerminal,
  liveEligible, eligibleAmong,
};
